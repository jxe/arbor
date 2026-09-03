import CryptoKit
import Foundation

public protocol WireCredentialProvider: Sendable {
    func credential() async throws -> String?
}

public struct StaticWireCredential: WireCredentialProvider, Sendable {
    private let value: String?

    public init(_ value: String?) { self.value = value }
    public func credential() async throws -> String? { value }
}

public actor ArborWireClient {
    public typealias RetryDelay = @Sendable (_ attempt: Int) async throws -> Void

    private let origin: URL
    private let credentialProvider: any WireCredentialProvider
    private let session: URLSession
    private let retryDelay: RetryDelay
    private let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        // Wire retries are byte-stable as well as semantically identical.
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }()
    private let decoder = JSONDecoder()

    public init(
        origin: URL,
        credential: String? = nil,
        session: URLSession = .shared,
        retryDelay: @escaping RetryDelay = { attempt in
            try await Task.sleep(for: .milliseconds(attempt == 1 ? 100 : 500))
        }
    ) {
        self.origin = origin
        self.credentialProvider = StaticWireCredential(credential)
        self.session = session
        self.retryDelay = retryDelay
    }

    public init(
        origin: URL,
        credentialProvider: any WireCredentialProvider,
        session: URLSession = .shared,
        retryDelay: @escaping RetryDelay = { attempt in
            try await Task.sleep(for: .milliseconds(attempt == 1 ? 100 : 500))
        }
    ) {
        self.origin = origin
        self.credentialProvider = credentialProvider
        self.session = session
        self.retryDelay = retryDelay
    }

    public func account() async throws -> WireAccountSnapshot {
        let value: WireAccountSnapshot = try await get(path: "/.arbor/account")
        _ = try value.account.community.validated()
        _ = try value.account.configuration.validated()
        for profile in value.account.writableProfiles { _ = try profile.validated() }
        guard !value.account.id.isEmpty, !value.observedThrough.isEmpty else {
            throw ArborWireValidationError.invalidValue("Malformed account snapshot")
        }
        return value
    }

    public func trees() async throws -> WireSnapshotEnvelope<[WireTreeDescriptor]> {
        let value: WireSnapshotEnvelope<[WireTreeDescriptor]> = try await get(path: "/.arbor/trees")
        return WireSnapshotEnvelope(snapshot: try value.snapshot.map { try $0.validated() }, observedThrough: value.observedThrough)
    }

    /// The tree resource itself: its current descriptor and the cursor to watch after.
    public func descriptor(tree: String) async throws -> WireCurrentTree {
        let value: WireCurrentTree = try await get(path: "/.arbor/trees/\(component(tree))")
        return try value.validated(expectedTree: tree)
    }

    public func currentSnapshot(tree: String) async throws -> WireCurrentSnapshot {
        let value: WireCurrentSnapshot = try await get(
            path: "/.arbor/trees/\(component(tree))/snapshot"
        )
        return try value.validated(expectedTree: tree)
    }

    public func resolve(path: String) async throws -> WireLocatorResolution {
        let encoded = path == "/" ? "" : "/" + path.split(separator: "/").map { component(String($0)) }.joined(separator: "/")
        let value: WireLocatorResolution = try await get(path: "/.well-known/arbor\(encoded)")
        _ = try value.enclosingTree.validated()
        guard value.ref.tree == value.enclosingTree.id, !value.observedThrough.isEmpty else {
            throw ArborWireValidationError.invalidValue("Malformed locator resolution")
        }
        return value
    }

    public func object(tree: String, hash: String) async throws -> Data {
        try validateObjectHash(hash)
        var request = try await authorizedRequest(path: "/.arbor/trees/\(component(tree))/objects/\(component(hash))")
        request.setValue("application/cbor", forHTTPHeaderField: "Accept")
        let (data, response) = try await session.data(for: request)
        let status = try statusCode(response)
        try validate(data: data, status: status)
        let actual = WireObjectCodec.hash(data)
        guard actual == hash else { throw ArborWireValidationError.objectHashMismatch(expected: hash, actual: actual) }
        _ = try WireObjectCodec.decode(data)
        return data
    }

    public func snapshot(tree: String, root: String) async throws -> WireSnapshot {
        try validateObjectHash(root)
        var pending = [root]
        var loaded: [String: WireObjectEnvelope] = [:]
        while let hash = pending.popLast() {
            if loaded[hash] != nil { continue }
            let bytes = try await object(tree: tree, hash: hash)
            let object = try WireObjectCodec.decode(bytes)
            loaded[hash] = WireObjectEnvelope(hash: hash, bytes: bytes)
            if case let .directory(entries, _) = object {
                for entry in entries {
                    if let hash = entry.hash { pending.append(hash) }
                }
            }
        }
        let value = WireSnapshot(root: root, objects: loaded.values.sorted { $0.hash < $1.hash })
        _ = try WireObjectGraph.validate(value)
        return value
    }

    public func prepareUpdate(
        tree: String,
        base: WireUpdateBase,
        snapshot: WireSnapshot,
        ifMatch: String = "modelHash",
        onConflict: String? = nil
    ) throws -> PreparedWireUpdate {
        guard !tree.isEmpty, !base.update.isEmpty else { throw ArborWireValidationError.invalidValue("Update identity is empty") }
        try validateObjectHash(base.root)
        _ = try WireObjectGraph.validate(snapshot)
        let request = WireUpdateRequest(
            base: base,
            candidate: snapshot.root,
            ifMatch: ifMatch,
            onConflict: onConflict,
            objects: snapshot.objects
        )
        return PreparedWireUpdate(
            tree: tree,
            body: try encoder.encode(request),
            requestDigest: updateRequestDigest(tree: tree, base: base, candidate: snapshot.root, ifMatch: ifMatch, onConflict: onConflict)
        )
    }

    public func submitUpdate(_ prepared: PreparedWireUpdate) async throws -> WireUpdateResult {
        (try await submitUpdateResponse(prepared)).result
    }

    public func submitUpdateResponse(_ prepared: PreparedWireUpdate) async throws -> WireUpdateResponse {
        var request = try await authorizedRequest(path: "/.arbor/trees/\(component(prepared.tree))/updates")
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = prepared.body

        var lastError: Error = URLError(.unknown)
        for attempt in 0..<3 {
            do {
                let (data, response) = try await session.data(for: request)
                let status = try statusCode(response)
                if status == 409, let conflict = try? decoder.decode(WireUpdateConflict.self, from: data), conflict.error == "conflict" {
                    throw WireUpdateConflictError(conflict: try conflict.validated())
                }
                if status >= 500 {
                    lastError = decodeHTTPError(data: data, status: status)
                    throw RetryableWireError()
                }
                try validate(data: data, status: status)
                let decoded = try decoder.decode(WireUpdateResponse.self, from: data)
                guard decoded.requestDigest == prepared.requestDigest else {
                    throw ArborWireValidationError.invalidValue("Server response request digest mismatch")
                }
                return decoded
            } catch let error as WireUpdateConflictError {
                throw error
            } catch let error as WireHTTPError {
                throw error
            } catch {
                if !(error is RetryableWireError) { lastError = error }
                if attempt < 2 { try await retryDelay(attempt + 1) }
            }
        }
        throw lastError
    }

    public func createPairing() async throws -> WirePairingOffer {
        let value: WirePairingOffer = try await post(path: "/.arbor/pairings", body: EmptyBody())
        return try value.validated()
    }

    public func claimPairing(
        id: String,
        secret: String,
        device: WirePairingDevice,
        placements: [String: WirePlacement] = [:]
    ) async throws -> WirePairingClaim {
        try validateObjectHash(device.credentialDigest)
        let value: WirePairingClaim = try await put(
            path: "/.arbor/pairings/\(component(id))/claim",
            body: PairingClaimBody(secret: secret, device: device, placements: placements),
            authorized: false
        )
        return try value.validated()
    }

    public func claim(handle: String, request value: WireClaimRequest) async throws -> WireClaimResult {
        try validateObjectHash(value.device.credentialDigest)
        _ = try WireObjectGraph.validate(value.profile)
        _ = try WireObjectGraph.validate(value.configuration)
        let result: WireClaimResult = try await put(
            path: "/.arbor/claims/\(component(handle))",
            body: value,
            authorized: false
        )
        _ = try result.tree.validated()
        _ = try result.configuration.validated()
        return result
    }

    public func access(tree: String) async throws -> WireSnapshotEnvelope<[WireAccessEntry]> {
        try await get(path: "/.arbor/trees/\(component(tree))/access")
    }

    public func watch(tree: String, lastEventID: String? = nil) async throws -> AsyncThrowingStream<WireWatchEvent, Error> {
        var request = try await authorizedRequest(path: "/.arbor/trees/\(component(tree))/watch")
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        if let lastEventID { request.setValue(lastEventID, forHTTPHeaderField: "Last-Event-ID") }
        let session = session
        let finalRequest = request
        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let (bytes, response) = try await session.bytes(for: finalRequest)
                    guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
                    guard http.statusCode < 400 else {
                        var body = Data()
                        for try await byte in bytes { body.append(byte) }
                        throw Self.httpError(data: body, status: http.statusCode)
                    }
                    guard http.value(forHTTPHeaderField: "Content-Type")?.lowercased().hasPrefix("text/event-stream") == true else {
                        throw ArborWireValidationError.malformedSSE("Watch response is not an event stream")
                    }
                    var parser = ArborSSEParser()
                    for try await byte in bytes {
                        for frame in try parser.append(Data([byte])) {
                            guard let id = frame.id, !id.isEmpty, let kind = frame.event, !kind.isEmpty else {
                                throw ArborWireValidationError.malformedSSE("Observation event has no ID or kind")
                            }
                            if kind == "resync-required" {
                                let event = try JSONDecoder().decode(WireResyncObservation.self, from: Data(frame.data.utf8))
                                guard event.cursor == id, event.kind == kind else {
                                    throw ArborWireValidationError.malformedSSE("Resync frame fields disagree")
                                }
                                throw WireHTTPError(status: 409, code: "resync-required", message: event.change.reason, retryable: true)
                            }
                            guard kind == "tree.update" else { continue }
                            let event = try JSONDecoder().decode(WireTreeRefObservation.self, from: Data(frame.data.utf8))
                            guard event.cursor == id, event.kind == kind, event.tree == tree else {
                                throw ArborWireValidationError.malformedSSE("Observation frame fields disagree")
                            }
                            let descriptor = try event.change.descriptor.validated()
                            let transitions = event.change.transitions
                            guard !transitions.isEmpty,
                                  transitions.last?.update.id == descriptor.update,
                                  transitions.last?.update.root == descriptor.root else {
                                throw ArborWireValidationError.malformedSSE("Tree ref transition batch does not end at its descriptor")
                            }
                            for (index, transition) in transitions.enumerated() {
                                _ = try transition.validated()
                                guard transition.update.tree == tree else {
                                    throw ArborWireValidationError.malformedSSE("Tree ref transition belongs to another tree")
                                }
                                if index > 0 {
                                    let previous = transitions[index - 1].update
                                    guard transition.update.previousRoot == previous.root else {
                                        throw ArborWireValidationError.malformedSSE("Tree ref transition batch is not contiguous")
                                    }
                                }
                            }
                            if let outerDigest = event.change.requestDigest,
                               let finalDigest = transitions.last?.requestDigest,
                               outerDigest != finalDigest {
                                throw ArborWireValidationError.malformedSSE("Tree ref request digests disagree")
                            }
                            continuation.yield(WireWatchEvent(
                                cursor: event.cursor,
                                treeID: event.tree,
                                kind: event.kind,
                                tree: descriptor,
                                requestDigest: event.change.requestDigest ?? transitions.last?.requestDigest,
                                transitions: transitions
                            ))
                        }
                    }
                    _ = try parser.finish()
                    continuation.finish()
                } catch is CancellationError {
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private func get<T: Decodable>(path: String) async throws -> T {
        try await perform(authorizedRequest(path: path))
    }

    private func post<T: Decodable, Body: Encodable>(path: String, body: Body, authorized: Bool = true) async throws -> T {
        var request = authorized ? try await authorizedRequest(path: path) : URLRequest(url: url(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoder.encode(body)
        return try await perform(request)
    }

    private func put<T: Decodable, Body: Encodable>(path: String, body: Body, authorized: Bool = true) async throws -> T {
        var request = authorized ? try await authorizedRequest(path: path) : URLRequest(url: url(path))
        request.httpMethod = "PUT"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoder.encode(body)
        return try await perform(request)
    }

    private func perform<T: Decodable>(_ request: URLRequest) async throws -> T {
        let (data, response) = try await session.data(for: request)
        let status = try statusCode(response)
        try validate(data: data, status: status)
        return try decoder.decode(T.self, from: data)
    }

    private func validate(data: Data, status: Int) throws {
        guard status >= 400 else { return }
        throw decodeHTTPError(data: data, status: status)
    }

    private func decodeHTTPError(data: Data, status: Int) -> WireHTTPError {
        Self.httpError(data: data, status: status)
    }

    private static func httpError(data: Data, status: Int) -> WireHTTPError {
        let envelope = try? JSONDecoder().decode(WireErrorEnvelope.self, from: data)
        return WireHTTPError(
            status: status,
            code: envelope?.error ?? "http-error",
            message: envelope?.message,
            retryable: envelope?.retryable ?? (status >= 500)
        )
    }

    private func statusCode(_ response: URLResponse) throws -> Int {
        guard let response = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        return response.statusCode
    }

    private func authorizedRequest(path: String) async throws -> URLRequest {
        var request = URLRequest(url: url(path))
        if let credential = try await credentialProvider.credential() {
            guard !credential.isEmpty else { throw ArborWireValidationError.invalidValue("Credential is empty") }
            request.setValue("Bearer \(credential)", forHTTPHeaderField: "Authorization")
        }
        return request
    }

    private func url(_ path: String) -> URL { URL(string: path, relativeTo: origin)!.absoluteURL }

    private func component(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/")))!
    }
}

/// The semantic identity of an update request as canonical CBOR bytes; the
/// same encoding that addresses wire objects, so every Arbor identity uses one
/// hash rule.
public func canonicalUpdateIntent(
    tree: String,
    base: WireUpdateBase,
    candidate: String,
    ifMatch: String = "modelHash",
    onConflict: String? = nil
) -> Data {
    CanonicalCBOR.encode(.map([
        ("version", .text("updates-v1")),
        ("tree", .text(tree)),
        ("base", .text(base.update)),
        ("candidate", .text(candidate)),
        ("ifMatch", .text(ifMatch)),
        ("onConflict", .text(onConflict ?? "merge")),
    ]))
}

public func updateRequestDigest(
    tree: String,
    base: WireUpdateBase,
    candidate: String,
    ifMatch: String = "modelHash",
    onConflict: String? = nil
) -> String {
    canonicalCBORHash(canonicalUpdateIntent(tree: tree, base: base, candidate: candidate, ifMatch: ifMatch, onConflict: onConflict))
}

/// `sha256:<hex>` of already canonical CBOR bytes.
func canonicalCBORHash(_ encoded: Data) -> String {
    "sha256:" + SHA256.hash(data: encoded).map { String(format: "%02x", $0) }.joined()
}

private struct EmptyBody: Encodable {}
private struct PairingClaimBody: Encodable {
    var secret: String
    var device: WirePairingDevice
    var placements: [String: WirePlacement]
}
private struct WireErrorEnvelope: Decodable {
    var error: String
    var message: String
    var retryable: Bool
}
private struct RetryableWireError: Error {}
