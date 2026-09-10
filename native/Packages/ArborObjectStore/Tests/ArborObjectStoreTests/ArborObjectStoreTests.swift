import ArborWire
import Foundation
import Testing
@testable import ArborObjectStore

private final class RecordingStore: ObjectStore, @unchecked Sendable {
    private let lock = NSLock()
    private var objects: [String: Data]
    private(set) var requests: [String] = []

    init(_ objects: [String: Data]) { self.objects = objects }

    func bytes(_ hash: String) async throws -> Data {
        let found: Data? = lock.withLock {
            requests.append(hash)
            return objects[hash]
        }
        guard let found else { throw ObjectStoreError.missing(hash) }
        return found
    }

    var requestCount: Int { lock.withLock { requests.count } }
}

@Suite("Object stores")
struct ObjectStoreTests {
    @Test("Layered lookup serves the overlay first and falls through to the platform")
    func layeredOrder() async throws {
        let local = try WireObjectCodec.object(.file(Data("local".utf8)))
        let remote = try WireObjectCodec.object(.file(Data("remote".utf8)))
        let overlay = InMemoryObjectOverlay()
        try overlay.store([local.hash: local.bytes])
        let platform = RecordingStore([remote.hash: remote.bytes, local.hash: Data("would be wrong".utf8)])
        let layered = LayeredObjectStore(overlay: overlay, platform: platform)

        #expect(try await layered.bytes(local.hash) == local.bytes)
        #expect(platform.requestCount == 0)
        #expect(try await layered.bytes(remote.hash) == remote.bytes)
        #expect(platform.requestCount == 1)
        #expect(!overlay.contains(remote.hash), "fetch-through never fills the overlay")
        let missing = "sha256:" + String(repeating: "0", count: 64)
        await #expect(throws: ObjectStoreError.missing(missing)) { _ = try await layered.bytes(missing) }
    }

    @Test("Every store verifies the bytes it hands out")
    func hashVerification() async throws {
        let honest = try WireObjectCodec.object(.file(Data("honest".utf8)))
        let lying = RecordingStore([honest.hash: Data("tampered".utf8)])
        let layered = LayeredObjectStore(overlay: InMemoryObjectOverlay(), platform: lying)
        await #expect(throws: ObjectStoreError.hashMismatch(expected: honest.hash, actual: WireObjectCodec.hash(Data("tampered".utf8)))) {
            _ = try await layered.bytes(honest.hash)
        }

        let overlay = InMemoryObjectOverlay()
        #expect(throws: ObjectStoreError.self) { try overlay.store([honest.hash: Data("tampered".utf8)]) }
        try overlay.store([honest.hash: honest.bytes])
        #expect(throws: ObjectStoreError.self) { try overlay.store([honest.hash: Data("other".utf8)]) }

        try await withTemporaryDirectory { directory in
            let disk = try DirectoryObjectStore(directory: directory)
            try disk.store([honest.hash: honest.bytes])
            #expect(try await disk.bytes(honest.hash) == honest.bytes)
            try Data("damaged".utf8).write(to: disk.objectURL(hash: honest.hash))
            await #expect(throws: ObjectStoreError.self) { _ = try await disk.bytes(honest.hash) }
            #expect(throws: ObjectStoreError.self) { _ = try disk.storedBytes(honest.hash) }
            #expect(disk.contains(honest.hash))
        }
    }

    @Test("Retention walks directory objects and drops everything the roots do not reach")
    func retention() async throws {
        let kept = try WireObjectCodec.object(.file(Data("kept".utf8)))
        let orphan = try WireObjectCodec.object(.file(Data("orphan".utf8)))
        let lazy = "sha256:" + String(repeating: "b", count: 64)
        let inner = try WireObjectCodec.object(.directory([
            .init(name: "kept.bin", hash: kept.hash),
            .init(name: "lazy.bin", hash: lazy),
        ]))
        let root = try WireObjectCodec.object(.directory([.init(name: "dir", hash: inner.hash)]))
        let oldRoot = try WireObjectCodec.object(.directory([.init(name: "orphan.bin", hash: orphan.hash)]))
        let leaf = try WireObjectCodec.object(.file(Data("leaf root".utf8)))
        let all = [kept, orphan, inner, root, oldRoot, leaf].reduce(into: [String: Data]()) { $0[$1.hash] = $1.bytes }

        for overlay in [InMemoryObjectOverlay(), try DirectoryObjectStore(directory: temporaryDirectory())] as [any ObjectOverlay] {
            try overlay.store(all)
            #expect(try overlay.hashes() == Set(all.keys))
            // A file hash given as a root is a leaf that is retained itself.
            try overlay.retain(reachableFrom: [root.hash, leaf.hash])
            #expect(try overlay.hashes() == [root.hash, inner.hash, kept.hash, leaf.hash])
            #expect(try overlay.reachableHashes(from: [root.hash]) == [root.hash, inner.hash, kept.hash, lazy])
            try overlay.retain(reachableFrom: [])
            #expect(try overlay.hashes().isEmpty)
        }
    }
}

private func temporaryDirectory() -> URL {
    FileManager.default.temporaryDirectory.appending(path: "arbor-object-store-\(UUID().uuidString)", directoryHint: .isDirectory)
}

private func withTemporaryDirectory(_ body: (URL) async throws -> Void) async throws {
    let directory = temporaryDirectory()
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    try await body(directory)
}
