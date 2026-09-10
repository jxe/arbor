import ArborObjectStore
import ArborWire
import Foundation

/// The daemon's stored Canopy credential as a `WireCredentialProvider`.
///
/// Fetched from `GET /v1/credential` on first use and cached for the life of the
/// provider. A caller that sees Canopy answer 401/403 calls `invalidate()` so the
/// next request re-reads the daemon's (possibly rotated) token instead of retrying
/// the stale one. Concurrent first uses share one fetch.
public actor ArborSyncCredentialProvider: WireCredentialProvider {
    private let client: ArborSyncRESTClient
    private let configurationTree: String?
    private var cached: String?
    private var inFlight: Task<String, Error>?

    public init(client: ArborSyncRESTClient, configurationTree: String? = nil) {
        self.client = client
        self.configurationTree = configurationTree
    }

    public func credential() async throws -> String? {
        if let cached { return cached }
        if let inFlight { return try await inFlight.value }
        let client = self.client
        let configurationTree = self.configurationTree
        let task = Task { try await client.credential(configurationTree: configurationTree) }
        inFlight = task
        defer { inFlight = nil }
        let value = try await task.value
        cached = value
        return value
    }

    /// Forget the cached token so the next `credential()` asks the daemon again.
    public func invalidate() {
        cached = nil
        inFlight?.cancel()
        inFlight = nil
    }

    /// Whether a token is currently cached; for diagnostics and tests.
    public var isCached: Bool { cached != nil }
}

/// The daemon's `/v1/objects` route as a platform `ObjectStore`.
///
/// The daemon already verifies every body it serves; this store verifies again on
/// the client side so a corrupted loopback hop can never hand out wrong bytes.
/// A `404` becomes `ObjectStoreError.missing` so a layered store can fall through.
public struct DaemonObjectStore: ObjectStore {
    public let client: ArborSyncRESTClient
    public let tree: String
    /// The Canopy origin for a tree the daemon has no placement for (a visit).
    public let origin: URL?

    public init(client: ArborSyncRESTClient, tree: String, origin: URL? = nil) {
        self.client = client
        self.tree = tree
        self.origin = origin
    }

    public func bytes(_ hash: String) async throws -> Data {
        do {
            return try verifyObject(try await client.object(tree: tree, hash: hash, origin: origin), hash: hash)
        } catch let error as ArborSyncServerError where error.status == 404 {
            throw ObjectStoreError.missing(hash)
        } catch let error as ArborWireValidationError {
            if case let .objectHashMismatch(expected, actual) = error {
                throw ObjectStoreError.hashMismatch(expected: expected, actual: actual)
            }
            throw error
        }
    }
}
