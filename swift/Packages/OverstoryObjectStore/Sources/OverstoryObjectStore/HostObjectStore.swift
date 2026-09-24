import Overstory
import Foundation

/// Canopy's per-tree object route as a platform store.
public struct HostObjectStore: ObjectStore {
    public let client: ProtocolClient
    public let tree: String

    public init(client: ProtocolClient, tree: String) {
        self.client = client
        self.tree = tree
    }

    public func bytes(_ hash: String) async throws -> Data {
        do {
            // `ProtocolClient.object` verifies the bytes against `hash`.
            return try await client.object(tree: tree, hash: hash)
        } catch let error as ProtocolHTTPError where error.status == 404 {
            throw ObjectStoreError.missing(hash)
        } catch let error as ProtocolValidationError {
            if case let .objectHashMismatch(expected, actual) = error {
                throw ObjectStoreError.hashMismatch(expected: expected, actual: actual)
            }
            throw error
        }
    }
}
