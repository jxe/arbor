import ArborWire
import Foundation

/// Canopy's per-tree object route as a platform store.
public struct CanopyObjectStore: ObjectStore {
    public let client: ArborWireClient
    public let tree: String

    public init(client: ArborWireClient, tree: String) {
        self.client = client
        self.tree = tree
    }

    public func bytes(_ hash: String) async throws -> Data {
        do {
            return try verifyObject(try await client.object(tree: tree, hash: hash), hash: hash)
        } catch let error as WireHTTPError where error.status == 404 {
            throw ObjectStoreError.missing(hash)
        } catch let error as ArborWireValidationError {
            if case let .objectHashMismatch(expected, actual) = error {
                throw ObjectStoreError.hashMismatch(expected: expected, actual: actual)
            }
            throw error
        }
    }
}
