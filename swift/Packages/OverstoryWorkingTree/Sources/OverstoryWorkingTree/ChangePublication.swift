import StoryKit
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

extension LocalChange {
    /// Transport a branch across the remainder of a frozen publication only
    /// when both sides read and write disjoint existing files. Operation history,
    /// not equal bytes, proves this commutation. Retained records stay unchanged.
    static func branchPublications(_ group: ChangePublication, shared: Int, branch: [LocalChange], records: [String: LocalChange]) throws -> [ChangePublication]? {
        let members = group.changes.compactMap { records[$0] }
        guard members.count == group.changes.count, shared > 0, shared < members.count,
              let first = branch.first, first.graph.root == members[shared - 1].candidate.root else { return nil }
        func paths(_ record: LocalChange) -> Set<String>? {
            guard let trace = record.update.trace, !trace.isEmpty, record.update.resolves.isEmpty, record.update.ifCurrent == nil else { return nil }
            var result = Set<String>()
            func visit(_ value: ProtocolSemanticValue) -> Bool {
                switch value {
                case let .object(fields):
                    if let material = fields["material"] {
                        guard case let .object(reference) = material, reference["kind"] == .string("basis"),
                              case let .string(path)? = reference["path"], fields["range"] != nil else { return false }
                        result.insert(path)
                    }
                    return fields.values.allSatisfy(visit)
                case let .array(values): return values.allSatisfy(visit)
                default: return true
                }
            }
            for operation in trace.flatMap(\.operations) {
                guard ["editSource", "moveSource", "copySource"].contains(operation.kind), visit(.object(operation.fields)) else { return nil }
            }
            return result.isEmpty ? nil : result
        }
        var crossed = Set<String>()
        for record in members.dropFirst(shared) {
            guard let footprint = paths(record) else { return nil }
            crossed.formUnion(footprint)
        }
        for record in branch {
            guard let footprint = paths(record), footprint.isDisjoint(with: crossed) else { return nil }
        }
        let end = members.last!, split = members[shared - 1]
        var objects = Dictionary((members + branch).flatMap { ($0.graph.objects + $0.candidate.objects).map { ($0.hash, $0.bytes) } }, uniquingKeysWith: { first, _ in first })
        func directory(_ hash: String) throws -> ([ProtocolDirectoryEntry], ProtocolCollectionFileDescriptor?) {
            guard let bytes = objects[hash], case let .directory(entries, source) = try ProtocolObjectCodec.decode(bytes, kind: .directory) else {
                throw ProtocolValidationError.invalidValue("Missing publication branch directory")
            }
            return (entries, source)
        }
        func file(_ root: String, _ path: String) throws -> String {
            let parts = path.dropFirst().split(separator: "/").map(String.init)
            var hash = root
            for (index, part) in parts.enumerated() {
                let entries = try directory(hash).0
                guard let entry = entries.first(where: { $0.name == part }) else { throw ProtocolValidationError.invalidValue("Missing publication branch file") }
                if index == parts.count - 1, let file = entry.file { return file }
                guard let child = entry.directory else { throw ProtocolValidationError.invalidValue("Publication branch requires existing files") }
                hash = child
            }
            throw ProtocolValidationError.invalidValue("Invalid publication branch path")
        }
        let replacements = try crossed.sorted().map { (path: $0, before: try file(split.candidate.root, $0), after: try file(end.candidate.root, $0)) }
        var result: [ChangePublication] = []
        for record in branch {
            var supplied = Dictionary(record.update.objects.map { ($0.hash, $0) }, uniquingKeysWith: { first, _ in first })
            for delta in record.update.deltas {
                guard let object = record.candidate.objects.first(where: { $0.hash == delta.result }) else { return nil }
                supplied[object.hash] = object
            }
            func lift(_ original: String) throws -> String {
                var root = original
                for replacement in replacements {
                    guard try file(root, replacement.path) == replacement.before else { throw ProtocolValidationError.invalidValue("Publication branch changed crossed material") }
                    let parts = replacement.path.dropFirst().split(separator: "/").map(String.init)
                    func replace(_ hash: String, _ depth: Int) throws -> String {
                        let (entries, source) = try directory(hash)
                        let changed = try entries.map { entry -> ProtocolDirectoryEntry in
                            guard entry.name == parts[depth] else { return entry }
                            if depth == parts.count - 1 { return .init(name: entry.name, file: replacement.after) }
                            guard let child = entry.directory else { throw ProtocolValidationError.invalidValue("Publication branch crosses file") }
                            return .init(name: entry.name, directory: try replace(child, depth + 1))
                        }
                        let object = try ProtocolObjectCodec.object(.directory(changed, childrenSource: source))
                        objects[object.hash] = object.bytes; supplied[object.hash] = object
                        return object.hash
                    }
                    root = try replace(root, 0)
                }
                return root
            }
            let trace = try (record.update.trace ?? []).map { try ProtocolTraceFrame(before: lift($0.before), after: lift($0.after), operations: $0.operations) }
            let identity = "continuation-" + ProtocolObjectCodec.hash(try sortedKeysJSON([group.update.change, record.change])).replacingOccurrences(of: "sha256:", with: "")
            let names = Dictionary(uniqueKeysWithValues: trace.flatMap(\.operations).map { ($0.key, $0.key) })
            result.append(ChangePublication(changes: [record.change], update: ProtocolCandidateUpdate(candidate: trace.last!.after, change: identity,
                trace: trace, objects: supplied.values.sorted { $0.hash < $1.hash }), operations: [record.change: names]))
        }
        guard result.first?.update.trace?.first?.before == group.update.candidate else { return nil }
        return result
    }
}
