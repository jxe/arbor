import CryptoKit
import Foundation

public protocol AuthorityCredentialProvider: Sendable {
    func credential() async throws -> String?
}

public struct StaticAuthorityCredential: AuthorityCredentialProvider, Sendable {
    private let value: String?

    public init(_ value: String?) { self.value = value }
    public func credential() async throws -> String? { value }
}

public actor ArborAuthorityClient {
    public typealias RetryDelay = @Sendable (_ attempt: Int) async throws -> Void

    private let origin: URL
    private let credentialProvider: any AuthorityCredentialProvider
    private let session: URLSession
    private let retryDelay: RetryDelay
    private let encoder = JSONEncoder()
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
        self.credentialProvider = StaticAuthorityCredential(credential)
        self.session = session
        self.retryDelay = retryDelay
    }

    public init(
        origin: URL,
        credentialProvider: any AuthorityCredentialProvider,
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

    public func account() async throws -> AuthorityAccountDescriptor {
        let value: AuthorityAccountDescriptor = try await get(path: "/.arbor/account")
        _ = try value.community.validated()
        for profile in value.writableProfiles { _ = try profile.validated() }
        guard !value.id.isEmpty, !value.handle.isEmpty else { throw ArborWireValidationError.invalidValue("Malformed account") }
        return value
    }

    public func trees() async throws -> [AuthorityTreeDescriptor] {
        let values: [AuthorityTreeDescriptor] = try await get(path: "/.arbor/trees")
        return try values.map { try $0.validated() }
    }

    public func ref(tree: String) async throws -> AuthorityTreeDescriptor {
        let value: AuthorityTreeDescriptor = try await get(path: "/.arbor/trees/\(component(tree))/ref")
        return try value.validated()
    }

    public func resolve(path: String) async throws -> AuthorityTreeDescriptor {
        let encoded = path == "/" ? "" : "/" + path.split(separator: "/").map { component(String($0)) }.joined(separator: "/")
        let value: AuthorityTreeDescriptor = try await get(path: "/.well-known/arbor\(encoded)")
        return try value.validated()
    }

    public func createTree(
        canonicalPath: String,
        snapshot: AuthoritySnapshot,
        kind: String = "shared-subtree",
        publicAccess: String = "none"
    ) async throws -> AuthorityTreeDescriptor {
        _ = try WireObjectGraph.validate(snapshot)
        let value: AuthorityTreeDescriptor = try await post(
            path: "/.arbor/trees",
            body: CreateTreeBody(
                canonicalPath: canonicalPath,
                root: snapshot.root,
                objects: snapshot.objects,
                kind: kind,
                publicAccess: publicAccess,
                profileAccess: []
            )
        )
        return try value.validated()
    }

    public func object(hash: String) async throws -> Data {
        try validateObjectHash(hash)
        var request = try await authorizedRequest(path: "/.arbor/objects/\(component(hash))")
        request.setValue("application/vnd.ipld.dag-cbor", forHTTPHeaderField: "Accept")
        let (data, response) = try await session.data(for: request)
        let status = try statusCode(response)
        try validate(data: data, status: status)
        let actual = WireObjectCodec.hash(data)
        guard actual == hash else { throw ArborWireValidationError.objectHashMismatch(expected: hash, actual: actual) }
        _ = try WireObjectCodec.decode(data)
        return data
    }

    public func snapshot(root: String) async throws -> AuthoritySnapshot {
        try validateObjectHash(root)
        var pending = [root]
        var loaded: [String: AuthorityObject] = [:]
        while let hash = pending.popLast() {
            if loaded[hash] != nil { continue }
            let bytes = try await object(hash: hash)
            let object = try WireObjectCodec.decode(bytes)
            loaded[hash] = AuthorityObject(hash: hash, bytes: bytes)
            if case let .directory(entries) = object { pending.append(contentsOf: entries.compactMap(\.hash)) }
        }
        let value = AuthoritySnapshot(root: root, objects: loaded.values.sorted { $0.hash < $1.hash })
        _ = try WireObjectGraph.validate(value)
        return value
    }

    public func prepareUpdate(
        tree: String,
        base: AuthorityUpdateBase,
        snapshot: AuthoritySnapshot,
        returnSnapshot: Bool = false
    ) throws -> PreparedAuthorityUpdate {
        guard !tree.isEmpty, !base.update.isEmpty else { throw ArborWireValidationError.invalidValue("Update identity is empty") }
        try validateObjectHash(base.root)
        _ = try WireObjectGraph.validate(snapshot)
        let request = AuthorityUpdateRequest(
            base: base,
            candidate: snapshot.root,
            objects: snapshot.objects,
            returnSnapshot: returnSnapshot
        )
        return PreparedAuthorityUpdate(
            tree: tree,
            body: try encoder.encode(request),
            requestDigest: updateRequestDigest(tree: tree, base: base, candidate: snapshot.root)
        )
    }

    public func submitUpdate(_ prepared: PreparedAuthorityUpdate) async throws -> AuthorityUpdateResult {
        (try await submitUpdateResponse(prepared)).result
    }

    public func submitUpdateResponse(_ prepared: PreparedAuthorityUpdate) async throws -> AuthorityUpdateResponse {
        var request = try await authorizedRequest(path: "/.arbor/trees/\(component(prepared.tree))/updates")
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = prepared.body

        var lastError: Error = URLError(.unknown)
        for attempt in 0..<3 {
            do {
                let (data, response) = try await session.data(for: request)
                let status = try statusCode(response)
                if status == 409, let conflict = try? decoder.decode(AuthorityUpdateConflict.self, from: data), conflict.error == "conflict" {
                    throw AuthorityUpdateConflictError(conflict: try conflict.validated())
                }
                if status >= 500 {
                    lastError = decodeHTTPError(data: data, status: status)
                    throw RetryableAuthorityError()
                }
                try validate(data: data, status: status)
                return try decoder.decode(AuthorityUpdateResponse.self, from: data)
            } catch let error as AuthorityUpdateConflictError {
                throw error
            } catch let error as AuthorityHTTPError {
                throw error
            } catch {
                if !(error is RetryableAuthorityError) { lastError = error }
                if attempt < 2 { try await retryDelay(attempt + 1) }
            }
        }
        throw lastError
    }

    public func createPairing() async throws -> AuthorityPairingOffer {
        let value: AuthorityPairingOffer = try await post(path: "/.arbor/pairings", body: EmptyBody())
        return try value.validated()
    }

    public func claimPairing(id: String, secret: String, label: String) async throws -> AuthorityPairingClaim {
        let value: AuthorityPairingClaim = try await post(
            path: "/.arbor/pairings/\(component(id))/claim",
            body: PairingClaimBody(secret: secret, label: label),
            authorized: false
        )
        return try value.validated()
    }

    public func devices() async throws -> [AuthorityDevice] {
        let values: [AuthorityDevice] = try await get(path: "/.arbor/devices")
        return try values.map { try $0.validated() }
    }

    public func revokeDevice(id: String) async throws -> AuthorityDevice {
        var request = try await authorizedRequest(path: "/.arbor/devices/\(component(id))")
        request.httpMethod = "DELETE"
        let value: AuthorityDevice = try await perform(request)
        return try value.validated()
    }

    public func watch(tree: String, lastEventID: String? = nil) async throws -> AsyncThrowingStream<AuthorityWatchEvent, Error> {
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
                            guard frame.event == nil || frame.event == "ref" else { continue }
                            guard let id = frame.id, !id.isEmpty else { throw ArborWireValidationError.malformedSSE("Ref event has no ID") }
                            let descriptor = try JSONDecoder().decode(AuthorityTreeDescriptor.self, from: Data(frame.data.utf8)).validated()
                            continuation.yield(AuthorityWatchEvent(id: id, tree: descriptor))
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

    private func decodeHTTPError(data: Data, status: Int) -> AuthorityHTTPError {
        Self.httpError(data: data, status: status)
    }

    private static func httpError(data: Data, status: Int) -> AuthorityHTTPError {
        let envelope = try? JSONDecoder().decode(AuthorityErrorEnvelope.self, from: data)
        return AuthorityHTTPError(
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

public func canonicalUpdateIntent(tree: String, base: AuthorityUpdateBase, candidate: String) -> String {
    func quoted(_ value: String) -> String {
        let data = try! JSONEncoder().encode(value)
        return String(decoding: data, as: UTF8.self)
    }
    return "{\"base\":{\"root\":\(quoted(base.root)),\"update\":\(quoted(base.update))},\"candidate\":\(quoted(candidate)),\"tree\":\(quoted(tree)),\"version\":\"updates-v1\"}"
}

public func updateRequestDigest(tree: String, base: AuthorityUpdateBase, candidate: String) -> String {
    let data = Data(canonicalUpdateIntent(tree: tree, base: base, candidate: candidate).utf8)
    return "sha256:" + SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

private struct EmptyBody: Encodable {}
private struct PairingClaimBody: Encodable { var secret: String; var label: String }
private struct CreateTreeBody: Encodable {
    var canonicalPath: String
    var root: String
    var objects: [AuthorityObject]
    var kind: String
    var publicAccess: String
    var profileAccess: [String]
}
private struct AuthorityErrorEnvelope: Decodable {
    var error: String
    var message: String
    var retryable: Bool
}
private struct RetryableAuthorityError: Error {}
