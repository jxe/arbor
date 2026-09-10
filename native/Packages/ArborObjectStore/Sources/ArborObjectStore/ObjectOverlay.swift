import ArborWire
import Foundation

/// A working tree's own object layer: the objects it has produced locally and
/// keeps until they are reachable only from roots nobody cares about. Every
/// directory and Markdown object the tree materializes lives here; file objects
/// it imported live here until an accepted update makes the platform store the
/// authority for them.
///
/// Writes are synchronous so a working-tree transaction can store its objects
/// without suspending; the actor that owns the tree serializes callers.
public protocol ObjectOverlay: ObjectStore {
    /// Store canonical object bytes keyed by their hash. Storing a hash that is
    /// already present with identical bytes is a no-op; different bytes for the
    /// same hash are a corruption and throw.
    func store(_ objects: [String: Data]) throws

    /// Every hash this overlay currently holds.
    func hashes() throws -> Set<String>

    /// Whether the overlay holds `hash` without reading its bytes.
    func contains(_ hash: String) -> Bool

    /// The bytes for `hash` without suspending, or `nil` when absent. Verified.
    func storedBytes(_ hash: String) throws -> Data?

    /// Drop every object not reachable from `roots`, walking the directory
    /// objects held in this overlay. Directory objects are always materialized
    /// by the working tree, so the walk sees the complete spine; a reachable
    /// hash the overlay does not hold is a platform-served file and is skipped.
    ///
    /// **Overlay GC invariant.** The overlay is a cache for the working tree,
    /// never the source for resubmission. A durable `UpdateAttempt` body (and,
    /// in Phase 3, the `UpdateHead`) is self-contained: resubmission reads
    /// envelopes only from that record. Therefore retaining what is reachable
    /// from `{materializedRoot, acceptedRoot}` after an accepted update is
    /// sufficient, and a later local edit that drops a file can never break an
    /// in-flight resubmission.
    func retain(reachableFrom roots: Set<String>) throws

    /// The hashes reachable from `roots` through the directory objects this
    /// overlay holds. Missing objects terminate the walk at that hash.
    func reachableHashes(from roots: Set<String>) throws -> Set<String>
}

extension ObjectOverlay {
    public func reachableHashes(from roots: Set<String>) throws -> Set<String> {
        var pending = Array(roots)
        var visited = Set<String>()
        while let hash = pending.popLast() {
            guard visited.insert(hash).inserted else { continue }
            guard let bytes = try storedBytes(hash) else { continue }
            guard WireObjectCodec.kind(ofPrefix: bytes.prefix(WireObjectCodec.kindPrefixLength)) == .directory else { continue }
            if case let .directory(entries, _) = try WireObjectCodec.decode(bytes) {
                for entry in entries {
                    if let child = entry.hash { pending.append(child) }
                }
            }
        }
        return visited
    }
}

/// Dictionary-backed overlay for working trees that keep no state on disk.
public final class InMemoryObjectOverlay: ObjectOverlay, @unchecked Sendable {
    private let lock = NSLock()
    private var objects: [String: Data] = [:]

    public init() {}

    public func bytes(_ hash: String) async throws -> Data {
        guard let bytes = try storedBytes(hash) else { throw ObjectStoreError.missing(hash) }
        return bytes
    }

    public func store(_ objects: [String: Data]) throws {
        lock.lock()
        defer { lock.unlock() }
        for (hash, bytes) in objects {
            _ = try verifyObject(bytes, hash: hash)
            if let existing = self.objects[hash] {
                guard existing == bytes else { throw ObjectStoreError.hashMismatch(expected: hash, actual: WireObjectCodec.hash(existing)) }
            } else {
                self.objects[hash] = bytes
            }
        }
    }

    public func hashes() throws -> Set<String> {
        lock.lock()
        defer { lock.unlock() }
        return Set(objects.keys)
    }

    public func contains(_ hash: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return objects[hash] != nil
    }

    public func storedBytes(_ hash: String) throws -> Data? {
        lock.lock()
        let bytes = objects[hash]
        lock.unlock()
        return try bytes.map { try verifyObject($0, hash: hash) }
    }

    public func retain(reachableFrom roots: Set<String>) throws {
        let reachable = try reachableHashes(from: roots)
        lock.lock()
        defer { lock.unlock() }
        objects = objects.filter { reachable.contains($0.key) }
    }
}
