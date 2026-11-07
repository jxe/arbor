import Overstory
import Foundation
import Testing
@testable import OverstoryObjectStore

private struct FixedStore: ObjectStore {
    var objects: [String: Data]
    func bytes(_ hash: String) async throws -> Data {
        guard let bytes = objects[hash] else { throw ObjectStoreError.missing(hash) }
        return bytes
    }
}

/// Answers every hash with the same wrong bytes, as a stale folder file would.
private struct LyingStore: ObjectStore {
    func bytes(_ hash: String) async throws -> Data { Data("stale".utf8) }
}

/// Counts reads, so a test can see how many objects a fetch touched.
private actor ReadCounter {
    var reads: [String] = []
    func note(_ hash: String) { reads.append(hash) }
}

private struct CountingStore: ObjectStore {
    let inner: FixedStore
    let counter: ReadCounter
    func bytes(_ hash: String) async throws -> Data {
        await counter.note(hash)
        return try await inner.bytes(hash)
    }
}

@Suite("Object source chain")
struct ObjectSourceChainTests {
    @Test("Each source is tried in order; a missing or wrong answer falls through")
    func fallsThrough() async throws {
        let object = try ProtocolObjectCodec.object(.file(Data("page".utf8)))
        let host = FixedStore(objects: [object.hash: object.bytes])
        #expect(try await ObjectSourceChain([FixedStore(objects: [:]), host]).bytes(object.hash) == object.bytes)
        #expect(try await ObjectSourceChain([LyingStore(), host]).bytes(object.hash) == object.bytes)
        await #expect(throws: ObjectStoreError.missing(object.hash)) {
            _ = try await ObjectSourceChain([FixedStore(objects: [:])]).bytes(object.hash)
        }
        await #expect(throws: ObjectStoreError.self) {
            _ = try await ObjectSourceChain([LyingStore()]).bytes(object.hash)
        }
    }

    @Test("A spine holds every directory and Markdown body, and no other file")
    func spine() async throws {
        let note = try ProtocolObjectCodec.object(.file(Data("# Note\n".utf8)))
        let photo = try ProtocolObjectCodec.object(.file(Data([1, 2, 3])))
        let child = try ProtocolObjectCodec.object(.file(Data("Child\n".utf8)))
        let sub = try ProtocolObjectCodec.object(.directory([
            .init(name: "child.md", file: child.hash),
            .init(name: "data.bin", file: photo.hash),
        ]))
        let root = try ProtocolObjectCodec.object(.directory([
            .init(name: "note.md", file: note.hash),
            .init(name: "photo.bin", file: photo.hash),
            .init(name: "sub", directory: sub.hash),
        ]))
        let store = FixedStore(objects: [note, photo, child, sub, root].reduce(into: [:]) { $0[$1.hash] = $1.bytes })
        let counter = ReadCounter()
        let spine = try await SpineFetch.spine(root: root.hash, from: CountingStore(inner: store, counter: counter), width: 2)
        #expect(Set(spine.objects.map(\.hash)) == [root.hash, sub.hash, note.hash, child.hash])
        #expect(await counter.reads.count == 4)
    }
}
