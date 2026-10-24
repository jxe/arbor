import Overstory
import Foundation

enum ProtocolGraph {
    /// The graph reachable from `root` through the directory objects in
    /// `objects`, in hash order. Nested trees are boundaries and are not
    /// entered. An object absent from `objects` is reported to `missing`, which
    /// throws to reject the graph or returns to leave the object out.
    static func reachable(
        from root: String,
        in objects: [String: Data],
        missing: (String, ProtocolObjectKind) throws -> Void = { _, _ in }
    ) throws -> ProtocolSnapshot {
        var reachable = Set<String>()
        var pending: [(hash: String, kind: ProtocolObjectKind)] = [(root, .directory)]
        while let next = pending.popLast() {
            guard reachable.insert(next.hash).inserted else { continue }
            guard let bytes = objects[next.hash] else {
                try missing(next.hash, next.kind)
                continue
            }
            pending += try ProtocolObjectCodec.references(bytes, kind: next.kind)
        }
        return ProtocolSnapshot(root: root, objects: reachable.sorted().compactMap { hash in
            objects[hash].map { ProtocolObjectEnvelope(hash: hash, bytes: $0) }
        })
    }

    /// Whether `name` can be one component of a protocol path: nonempty, not a
    /// dot segment, free of separators and NUL, and NFC as protocol names must be.
    static func isPathComponent(_ name: String) -> Bool {
        !name.isEmpty && name != "." && name != ".." && !name.contains("\\") && !name.contains("\0")
            && Data(name.utf8) == Data(name.precomposedStringWithCanonicalMapping.utf8)
    }
}
