import Overstory
import Foundation

/// The client library's object sources (Clients 003, module 2): stores tried
/// in order (memory, disk cache, placed folder, Story Sync, host). Every
/// answer is checked against its hash, so the order is only about speed: a
/// store that has no object (`missing`) or hands back wrong bytes
/// (`hashMismatch`) is passed over for the next one.
public struct ObjectSourceChain: ObjectStore {
    public let sources: [any ObjectStore]

    public init(_ sources: [any ObjectStore]) {
        self.sources = sources
    }

    public func bytes(_ hash: String) async throws -> Data {
        var mismatch: ObjectStoreError?
        for source in sources {
            do {
                return try verifyObject(try await source.bytes(hash), hash: hash)
            } catch ObjectStoreError.missing {
                continue
            } catch let error as ObjectStoreError {
                guard case .hashMismatch = error else { throw error }
                mismatch = error
                continue
            }
        }
        throw mismatch ?? ObjectStoreError.missing(hash)
    }
}
