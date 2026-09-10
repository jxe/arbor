import ArborWire
import Foundation

public enum ObjectStoreError: Error, Equatable, Sendable {
    /// No store in the chain holds the object.
    case missing(String)
    /// A store returned bytes whose hash is not the requested hash.
    case hashMismatch(expected: String, actual: String)
    /// A store could not read or write its backing medium.
    case io(String)
}

/// Where accepted bytes come from. Content-addressed and immutable: the bytes
/// returned for a hash are always verified against it before they are handed out.
public protocol ObjectStore: Sendable {
    /// The canonical wire-object bytes for `hash`. Throws
    /// `ObjectStoreError.missing(hash)` when this store cannot serve it.
    func bytes(_ hash: String) async throws -> Data
}

/// Verifies that `bytes` are the object named by `hash`.
@inlinable
public func verifyObject(_ bytes: Data, hash: String) throws -> Data {
    let actual = WireObjectCodec.hash(bytes)
    guard actual == hash else { throw ObjectStoreError.hashMismatch(expected: hash, actual: actual) }
    return bytes
}

/// A store that never holds anything. Used as the platform layer of a working
/// tree that has no fetch-through (a fully local, offline tree).
public struct EmptyObjectStore: ObjectStore {
    public init() {}
    public func bytes(_ hash: String) async throws -> Data { throw ObjectStoreError.missing(hash) }
}
