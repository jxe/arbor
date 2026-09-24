import Overstory
import Foundation

enum WireGraph {
    /// The graph reachable from `root` through the directory objects in
    /// `objects`, in hash order. Nested trees are boundaries and are not
    /// entered. An object absent from `objects` is reported to `missing`, which
    /// throws to reject the graph or returns to leave the object out.
    static func reachable(
        from root: String,
        in objects: [String: Data],
        missing: (String, WireEntryKind) throws -> Void = { _, _ in }
    ) throws -> WireSnapshot {
        var reachable = Set<String>()
        var pending: [(hash: String, kind: WireEntryKind)] = [(root, .directory)]
        while let next = pending.popLast() {
            guard reachable.insert(next.hash).inserted else { continue }
            guard let bytes = objects[next.hash] else {
                try missing(next.hash, next.kind)
                continue
            }
            guard next.kind == .directory, case let .directory(entries, _) = try WireObjectCodec.decode(bytes, kind: .directory) else { continue }
            for entry in entries { if let hash = entry.hash, let kind = entry.kind { pending.append((hash, kind)) } }
        }
        return WireSnapshot(root: root, objects: reachable.sorted().compactMap { hash in
            objects[hash].map { WireObjectEnvelope(hash: hash, bytes: $0) }
        })
    }

    /// Whether `name` can be one component of a Wire path: nonempty, not a
    /// dot segment, free of separators and NUL, and NFC as Wire names must be.
    static func isPathComponent(_ name: String) -> Bool {
        !name.isEmpty && name != "." && name != ".." && !name.contains("\\") && !name.contains("\0")
            && Data(name.utf8) == Data(name.precomposedStringWithCanonicalMapping.utf8)
    }
}
