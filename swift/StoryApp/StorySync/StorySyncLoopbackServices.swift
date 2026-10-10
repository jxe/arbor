#if os(macOS)
import OverstoryObjectStore
import Overstory
import Foundation
import Synchronization

/// A host session the daemon's device key opened, as a `ProtocolCredentialProvider`.
///
/// Fetched from `GET /v1/credential` on first use and cached for the life of the
/// provider. A caller that sees the host answer 401/403 calls `invalidate()` so the
/// next request asks the daemon for a fresh session instead of retrying
/// the stale one. Concurrent first uses share one fetch.
///
/// With `origin`, the sessions are for one of the account's placement hosts
/// (accounts §1.3), which the daemon opens there with the same device key
/// (`GET /v1/credential?configurationTree=…&origin=…`). A nil origin is the
/// account's home host.
actor StorySyncCredentialProvider: ProtocolCredentialProvider {
    /// One provider per account and host for the connected daemon, so the
    /// app's clients share one token instead of each asking the daemon for it.
    private static let providers = Mutex<[String: StorySyncCredentialProvider]>([:])

    static func shared(client: StorySyncRESTClient, configurationTree: String, origin: String? = nil) -> StorySyncCredentialProvider {
        let key = configurationTree + (origin.map { "\u{0}" + $0 } ?? "")
        return providers.withLock { providers in
            // A reconnected daemon is a new client; its providers start fresh.
            if let provider = providers[key], provider.client === client { return provider }
            let provider = StorySyncCredentialProvider(client: client, configurationTree: configurationTree, origin: origin)
            providers[key] = provider
            return provider
        }
    }

    private let client: StorySyncRESTClient
    private let configurationTree: String?
    /// The placement host these sessions are for; nil for the home host.
    nonisolated let origin: String?
    private var cached: String?
    private var inFlight: Task<String, Error>?

    init(client: StorySyncRESTClient, configurationTree: String? = nil, origin: String? = nil) {
        self.client = client
        self.configurationTree = configurationTree
        self.origin = origin
    }

    func credential() async throws -> String? {
        if let cached { return cached }
        if let inFlight { return try await inFlight.value }
        let client = self.client
        let configurationTree = self.configurationTree
        let origin = self.origin
        let task = Task {
            do { return try await client.credential(configurationTree: configurationTree, origin: origin) }
            catch let error as StorySyncServerError where error.status == 409 || error.status == 503 { throw error.credentialRefusal }
        }
        inFlight = task
        let result = await task.result
        // An `invalidate()` during the fetch may have started a newer one; this
        // older result must neither clear that fetch nor be cached over it.
        if inFlight == task {
            inFlight = nil
            if case let .success(value) = result { cached = value }
        }
        return try result.get()
    }

    /// Forget the cached token so the next `credential()` asks the daemon again.
    func invalidate() {
        cached = nil
        inFlight?.cancel()
        inFlight = nil
    }

    /// Whether a token is currently cached; for diagnostics and tests.
    var isCached: Bool { cached != nil }
}

/// The daemon's `/v1/objects` route as a platform `ObjectStore`.
///
/// The daemon already verifies every body it serves; `StorySyncRESTClient.object`
/// verifies again on the client side so a corrupted loopback hop can never hand out wrong bytes.
/// A `404` becomes `ObjectStoreError.missing` so a layered store can fall through.
struct DaemonObjectStore: ObjectStore {
    let client: StorySyncRESTClient
    let tree: String
    /// The host origin for a tree the daemon has no placement for (a visit).
    let origin: URL?

    init(client: StorySyncRESTClient, tree: String, origin: URL? = nil) {
        self.client = client
        self.tree = tree
        self.origin = origin
    }

    func bytes(_ hash: String) async throws -> Data {
        do {
            return try await client.object(tree: tree, hash: hash, origin: origin)
        } catch let error as StorySyncServerError where error.status == 404 {
            throw ObjectStoreError.missing(hash)
        } catch let error as ProtocolValidationError {
            if case let .objectHashMismatch(expected, actual) = error {
                throw ObjectStoreError.hashMismatch(expected: expected, actual: actual)
            }
            throw error
        }
    }
}
#endif
