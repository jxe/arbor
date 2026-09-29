import CanopyAppKit
import Overstory
import Foundation

/// An immutable publication and the local records it represents. Kept while
/// any retained descendant may need to repeat this exact authored prefix.
struct ChangePublication: Codable, Equatable, Sendable {
    var changes: [String]
    var update: ProtocolCandidateUpdate
    /// Original operation-result names mapped to their published names.
    var operations: [String: [String: String]]
}

extension LocalChange {
    var isMoveSequence: Bool {
        guard let trace = update.trace, !trace.isEmpty, update.resolves.isEmpty else { return false }
        return trace.allSatisfy { !$0.operations.isEmpty && $0.operations.allSatisfy { $0.kind == "moveSource" } }
    }

    /// Compose repeated relocation of the same original span. Coordinates are
    /// transported through explicit moves, never recovered by matching text.
    /// Mixed edits, copies, multiple selections and operation-result references
    /// keep their original frames in the general publication compiler.
    static func movePublication(_ records: [LocalChange]) throws -> ChangePublication? {
        guard let first = records.first, let last = records.last,
              records.allSatisfy(\.isMoveSequence) else { return nil }
        let frames = records.flatMap { $0.update.trace ?? [] }
        guard frames.count > 1, frames.allSatisfy({ $0.operations.count == 1 }) else { return nil }
        struct Reference {
            var path: String
            var object: String
            var range: Range<Int>
        }
        func ref(_ value: ProtocolSemanticValue?) -> Reference? {
            guard case let .object(fields)? = value,
                  case let .object(material)? = fields["material"],
                  material["kind"] == .string("basis"),
                  case let .string(path)? = material["path"],
                  case let .string(object)? = material["object"],
                  case let .array(range)? = fields["range"], range.count == 2,
                  case let .integer(start) = range[0], case let .integer(end) = range[1],
                  start >= 0, end > start else { return nil }
            return Reference(path: path, object: object, range: start..<end)
        }
        guard let original = ref(frames[0].operations[0].fields["source"]),
              let bytes = first.graph.objects.first(where: { $0.hash == original.object })?.bytes,
              original.range.upperBound <= bytes.count else { return nil }
        var pieces = [0..<bytes.count]
        func selection(_ range: Range<Int>, in pieces: [Range<Int>]) -> [Range<Int>] {
            var offset = 0, result: [Range<Int>] = []
            for piece in pieces {
                let a = max(range.lowerBound, offset), b = min(range.upperBound, offset + piece.count)
                if a < b { result.append((piece.lowerBound + a - offset)..<(piece.lowerBound + b - offset)) }
                offset += piece.count
            }
            return result
        }
        func contiguous(_ ranges: [Range<Int>]) -> Range<Int>? {
            guard let first = ranges.first, let last = ranges.last,
                  zip(ranges, ranges.dropFirst()).allSatisfy({ $0.upperBound == $1.lowerBound }) else { return nil }
            return first.lowerBound..<last.upperBound
        }
        func rendered(_ pieces: [Range<Int>]) -> Data { pieces.reduce(into: Data()) { $0.append(bytes[$1]) } }
        var anchor: Range<Int>?, side: WorkspaceSourceMove.Side?
        var root = first.graph.root
        for frame in frames {
            let operation = frame.operations[0]
            guard frame.before == root,
                  let source = ref(operation.fields["source"]), let target = ref(operation.fields["at"]),
                  source.path == original.path, target.path == original.path, target.object == source.object,
                  source.range.upperBound <= bytes.count, target.range.upperBound <= bytes.count,
                  ProtocolObjectCodec.hash(rendered(pieces)) == source.object,
                  contiguous(selection(source.range, in: pieces)) == original.range,
                  let mappedAnchor = contiguous(selection(target.range, in: pieces)),
                  !mappedAnchor.overlaps(original.range),
                  case let .string(sideValue)? = operation.fields["side"],
                  let placement = WorkspaceSourceMove.Side(rawValue: sideValue) else { return nil }
            let at = placement == .before ? target.range.lowerBound : target.range.upperBound
            guard at <= source.range.lowerBound || at >= source.range.upperBound else { return nil }
            let moved = selection(source.range, in: pieces)
            let rest = selection(0..<source.range.lowerBound, in: pieces) + selection(source.range.upperBound..<bytes.count, in: pieces)
            let destination = at >= source.range.upperBound ? at - source.range.count : at
            pieces = selection(0..<destination, in: rest) + moved + selection(destination..<(bytes.count - source.range.count), in: rest)
            anchor = mappedAnchor; side = placement; root = frame.after
        }
        guard let anchor, let side, root == last.candidate.root else { return nil }
        let finalBytes = rendered(pieces)
        let finalHash = ProtocolObjectCodec.hash(finalBytes)
        guard last.candidate.objects.contains(where: { $0.hash == finalHash && $0.bytes == finalBytes }),
              try WorkspaceSourceArrangement.apply(files: [original.path: bytes], moves: [
                .init(source: .init(file: original.path, range: original.range), anchor: .init(file: original.path, range: anchor), side: side)
              ], edits: [])[original.path] == finalBytes else { return nil }
        func reference(_ range: Range<Int>) -> ProtocolSemanticValue {
            .object(["material": .object(["kind": .string("basis"), "path": .string(original.path), "object": .string(original.object)]),
                     "range": .array([.integer(range.lowerBound), .integer(range.upperBound)])])
        }
        let changes = records.map(\.change)
        let identity = "moves-" + ProtocolObjectCodec.hash(try sortedKeysJSON(changes)).replacingOccurrences(of: "sha256:", with: "")
        let operation = try ProtocolSourceOperation(["key": .string("move"), "kind": .string("moveSource"),
            "source": reference(original.range), "at": reference(anchor), "side": .string(side.rawValue)])
        let known = Set(first.graph.objects.map(\.hash))
        let update = ProtocolCandidateUpdate(candidate: root, change: identity,
            trace: [ProtocolTraceFrame(before: first.graph.root, after: root, operations: [operation])],
            objects: last.candidate.objects.filter { !known.contains($0.hash) })
        let names = Dictionary(uniqueKeysWithValues: records.map { record in
            (record.change, Dictionary(uniqueKeysWithValues: (record.update.trace ?? []).flatMap(\.operations).map { ($0.key, "move") }))
        })
        return ChangePublication(changes: changes, update: update, operations: names)
    }
}

extension LocalChange {
    /// One authored update may retain several frames. This combines edits,
    /// copies, moves and structural operations without discarding their history
    /// or inventing a one-frame explanation. Snapshots and resolutions are
    /// deliberate boundaries; trace limits split large batches.
    static func publication(_ records: [LocalChange], previous: [ChangePublication]) throws -> ChangePublication? {
        guard let first = records.first, let last = records.last,
              records.allSatisfy({ $0.tree == first.tree && $0.update.trace != nil && (records.count == 1 || ($0.update.resolves.isEmpty && $0.update.ifCurrent == nil)) }),
              zip(records, records.dropFirst()).allSatisfy({ $1.basis == .authored(change: $0.change) && $0.candidate.root == $1.graph.root }) else { return nil }
        if first.update.resolves.isEmpty, first.update.ifCurrent == nil, let moves = try movePublication(records) { return moves }
        let rawFrames = records.flatMap { $0.update.trace ?? [] }
        guard !rawFrames.isEmpty, rawFrames.count <= traceFrameLimit,
              rawFrames.reduce(0, { $0 + $1.operations.count }) <= traceOperationLimit else { return nil }
        let changes = records.map(\.change)
        let identity = "batch-" + ProtocolObjectCodec.hash(try sortedKeysJSON(changes)).replacingOccurrences(of: "sha256:", with: "")
        var names: [String: [String: String]] = [:], count = 0
        for record in records {
            for operation in (record.update.trace ?? []).flatMap(\.operations) {
                names[record.change, default: [:]][operation.key] = "op-\(count)"
                count += 1
            }
        }
        func rewritten(_ value: ProtocolSemanticValue) throws -> ProtocolSemanticValue {
            switch value {
            case let .object(fields):
                var output = fields
                if fields["kind"] == .string("operation"),
                   case let .string(change)? = fields["change"], case let .string(key)? = fields["operation"] {
                    if let name = names[change]?[key] {
                        output["change"] = .string(identity); output["operation"] = .string(name)
                    } else if let group = previous.first(where: { $0.changes.contains(change) }), let name = group.operations[change]?[key] {
                        output["change"] = .string(group.update.change); output["operation"] = .string(name)
                    }
                }
                return .object(try output.mapValues(rewritten))
            case let .array(values): return .array(try values.map(rewritten))
            default: return value
            }
        }
        var frames: [ProtocolTraceFrame] = []
        for record in records {
            for frame in record.update.trace ?? [] {
                let operations = try frame.operations.map { operation in
                    var fields = try operation.fields.mapValues(rewritten)
                    fields["key"] = .string(names[record.change]![operation.key]!)
                    return try ProtocolSourceOperation(fields)
                }
                frames.append(ProtocolTraceFrame(before: frame.before, after: frame.after, operations: operations))
            }
        }
        // Retain the original payload union, including the first record's
        // accepted-base deltas; batching must not expand them to full files.
        var objects = Dictionary(records.flatMap { $0.update.objects }.map { ($0.hash, $0) }, uniquingKeysWith: { first, _ in first })
        let finalObjects = Set(last.candidate.objects.map(\.hash))
        let deltas = first.update.deltas.filter { objects[$0.result] == nil && finalObjects.contains($0.result) }
        // The host requires delta results to reach the final candidate.
        for delta in first.update.deltas where !finalObjects.contains(delta.result) {
            guard let object = first.candidate.objects.first(where: { $0.hash == delta.result }) else { return nil }
            objects[object.hash] = object
        }
        let known = Set(first.graph.objects.map(\.hash))
        return ChangePublication(changes: changes, update: ProtocolCandidateUpdate(candidate: last.candidate.root, change: identity,
            trace: frames, resolves: first.update.resolves, ifCurrent: first.update.ifCurrent,
            objects: objects.values.filter { !known.contains($0.hash) }.sorted { $0.hash < $1.hash }, deltas: deltas), operations: names)
    }
}
