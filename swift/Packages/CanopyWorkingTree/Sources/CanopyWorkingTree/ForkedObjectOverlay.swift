import Overstory
import OverstoryObjectStore
import Foundation

/// A fork's overlay: its own objects in memory, reading through to the overlay
/// of the tree it was forked from. Stores and collection touch only the fork's
/// own objects, so a fork never drops or adds bytes in its parent.
final class ForkedObjectOverlay: ObjectOverlay, @unchecked Sendable {
    private let parent: any ObjectOverlay
    private let lock = NSLock()
    private var objects: [String: Data] = [:]

    init(parent: any ObjectOverlay) {
        self.parent = parent
    }

    func bytes(_ hash: String) async throws -> Data {
        guard let bytes = try storedBytes(hash) else { throw ObjectStoreError.missing(hash) }
        return bytes
    }

    func store(_ objects: [String: Data]) throws {
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

    func hashes() throws -> Set<String> {
        lock.lock()
        let own = Set(objects.keys)
        lock.unlock()
        return own.union(try parent.hashes())
    }

    func contains(_ hash: String) -> Bool {
        lock.lock()
        let own = objects[hash] != nil
        lock.unlock()
        return own || parent.contains(hash)
    }

    func storedBytes(_ hash: String) throws -> Data? {
        lock.lock()
        let own = objects[hash]
        lock.unlock()
        if let own { return try verifyObject(own, hash: hash) }
        return try parent.storedBytes(hash)
    }

    /// Reachability walks through the parent's directories; only the fork's
    /// own objects are dropped.
    func retain(reachableFrom roots: Set<String>, files: Set<String>) throws {
        let reachable = try reachableHashes(from: roots).union(files)
        lock.lock()
        defer { lock.unlock() }
        objects = objects.filter { reachable.contains($0.key) }
    }
}
