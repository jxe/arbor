import Foundation
import Overstory

extension LocalChange {
    /// Transport compression is independent of authored intent. Only final
    /// reachable envelopes may become deltas, and every base is in the request's
    /// accepted graph (never an unpublished intermediate frame).
    static func compactTransport(_ update: ProtocolCandidateUpdate, basis: ProtocolSnapshot, candidate: ProtocolSnapshot) throws -> ProtocolCandidateUpdate {
        guard !update.objects.isEmpty else { return update }
        var result = update
        var envelopes = Dictionary(update.objects.map { ($0.hash, $0) }, uniquingKeysWith: { first, _ in first })
        let before = Dictionary(basis.objects.map { ($0.hash, $0.bytes) }, uniquingKeysWith: { first, _ in first })
        let after = Dictionary(candidate.objects.map { ($0.hash, $0.bytes) }, uniquingKeysWith: { first, _ in first })
        var visited = Set<String>()
        func visit(_ old: String?, _ new: String, directory: Bool) throws {
            guard visited.insert(new).inserted else { return }
            if before[new] != nil { envelopes[new] = nil; return }
            if let old, let base = before[old], let envelope = envelopes[new],
               base.count <= 64 * 1024 * 1024, envelope.bytes.count <= 64 * 1024 * 1024,
               let delta = try? ProtocolObjectDelta(base: old, result: new, instructions: transportInstructions(base: base, target: envelope.bytes)).validated(),
               try delta.apply(to: base) == envelope.bytes,
               try ProtocolWireEncoding.cbor.encode(delta).count < ProtocolWireEncoding.cbor.encode(envelope).count {
                envelopes[new] = nil
                result.deltas.append(delta)
            }
            guard directory, let bytes = after[new], case let .directory(entries, _) = try ProtocolObjectCodec.decode(bytes, kind: .directory) else { return }
            var prior: [String: ProtocolDirectoryEntry] = [:]
            if let old, let bytes = before[old], case let .directory(entries, _) = try ProtocolObjectCodec.decode(bytes, kind: .directory) {
                prior = Dictionary(uniqueKeysWithValues: entries.map { ($0.name, $0) })
            }
            for entry in entries {
                if let file = entry.file { try visit(prior[entry.name]?.file, file, directory: false) }
                else if let child = entry.directory { try visit(prior[entry.name]?.directory, child, directory: true) }
            }
        }
        try visit(basis.root, candidate.root, directory: true)
        result.objects = envelopes.values.sorted { $0.hash < $1.hash }
        return result
    }

    /// The protocol's rolling-block delta algorithm. Matching bytes here only
    /// encode transport; they never establish a move, copy, or material origin.
    static func transportInstructions(base: Data, target: Data) -> [ProtocolObjectDeltaInstruction] {
        let base = Array(base), target = Array(target)
        var result: [ProtocolObjectDeltaInstruction] = []
        func copy(_ offset: Int, _ length: Int) {
            guard length > 0 else { return }
            if case let .copy(old, count)? = result.last, old + count == offset { result[result.count - 1] = .copy(offset: old, length: count + length) }
            else { result.append(.copy(offset: offset, length: length)) }
        }
        func insert(_ start: Int, _ end: Int) {
            guard end > start else { return }
            let bytes = Data(target[start..<end])
            if case let .insert(old)? = result.last { result[result.count - 1] = .insert(old + bytes) }
            else { result.append(.insert(bytes)) }
        }
        var prefix = 0, suffix = 0
        while prefix < min(base.count, target.count), base[prefix] == target[prefix] { prefix += 1 }
        while suffix < min(base.count, target.count) - prefix, base[base.count - 1 - suffix] == target[target.count - 1 - suffix] { suffix += 1 }
        copy(0, prefix)
        let baseEnd = base.count - suffix, targetEnd = target.count - suffix
        var block = 32
        while (baseEnd - prefix) / block > 16_384 { block *= 2 }
        if baseEnd - prefix >= block, targetEnd - prefix >= block {
            let multiplier: UInt32 = 0x01000193
            func hash(_ bytes: [UInt8], _ offset: Int) -> UInt32 {
                bytes[offset..<(offset + block)].reduce(0) { ($0 &* multiplier) &+ UInt32($1) }
            }
            var index: [UInt32: [Int]] = [:]
            for offset in stride(from: prefix, through: baseEnd - block, by: block) { index[hash(base, offset), default: []].append(offset) }
            var power: UInt32 = 1
            for _ in 1..<block { power = power &* multiplier }
            var position = prefix, inserted = prefix, rolling = hash(target, prefix)
            while position + block <= targetEnd {
                if let matched = index[rolling]?.first(where: { base[$0..<($0 + block)].elementsEqual(target[position..<(position + block)]) }) {
                    var old = matched, start = position
                    while start > inserted, old > prefix, base[old - 1] == target[start - 1] { old -= 1; start -= 1 }
                    var length = position + block - start
                    while old + length < baseEnd, start + length < targetEnd, base[old + length] == target[start + length] { length += 1 }
                    insert(inserted, start); copy(old, length)
                    position = start + length; inserted = position
                    if position + block <= targetEnd { rolling = hash(target, position) }
                } else {
                    if position + block < targetEnd { rolling = ((rolling &- (UInt32(target[position]) &* power)) &* multiplier) &+ UInt32(target[position + block]) }
                    position += 1
                }
            }
            insert(inserted, targetEnd)
        } else { insert(prefix, targetEnd) }
        copy(baseEnd, suffix)
        return result
    }
}
