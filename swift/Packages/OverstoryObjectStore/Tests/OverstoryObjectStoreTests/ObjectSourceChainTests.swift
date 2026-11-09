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
}
