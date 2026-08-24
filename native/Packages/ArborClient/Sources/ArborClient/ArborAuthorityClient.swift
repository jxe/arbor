import Foundation

public actor ArborAuthorityClient {
    public typealias RetryDelay = @Sendable (_ attempt: Int) async throws -> Void

    private let origin: URL
    private let credential: String?
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
        self.credential = credential
        self.session = session
        self.retryDelay = retryDelay
    }

    public func ref(tree: String) async throws -> AuthorityTreeDescriptor {
        try await get(path: "/.arbor/trees/\(component(tree))/ref")
    }

    public func object(hash: String) async throws -> Data {
        var request = authorizedRequest(path: "/.arbor/objects/\(component(hash))")
        request.setValue("application/vnd.ipld.dag-cbor", forHTTPHeaderField: "Accept")
        let (data, response) = try await session.data(for: request)
        let status = try statusCode(response)
        try validate(data: data, status: status)
        return data
    }

    public func prepareUpdate(
        tree: String,
        base: AuthorityUpdateBase,
        snapshot: AuthoritySnapshot
    ) throws -> PreparedAuthorityUpdate {
        PreparedAuthorityUpdate(
            tree: tree,
            body: try encoder.encode(AuthorityUpdateRequest(
                base: base,
                candidate: snapshot.root,
                objects: snapshot.objects
            ))
        )
    }

    public func submitUpdate(_ prepared: PreparedAuthorityUpdate) async throws -> AuthorityUpdateResult {
        var request = authorizedRequest(path: "/.arbor/trees/\(component(prepared.tree))/updates")
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = prepared.body

        var lastError: Error = URLError(.unknown)
        for attempt in 0..<3 {
            do {
                let (data, response) = try await session.data(for: request)
                let status = try statusCode(response)
                if status == 409, let conflict = try? decoder.decode(AuthorityUpdateConflict.self, from: data), conflict.error == "conflict" {
                    throw AuthorityUpdateConflictError(conflict: conflict)
                }
                if status >= 500 {
                    lastError = decodeHTTPError(data: data, status: status)
                    throw RetryableAuthorityError()
                }
                try validate(data: data, status: status)
                return try decoder.decode(AuthorityUpdateResult.self, from: data)
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
        try await post(path: "/.arbor/pairings", body: EmptyBody())
    }

    public func claimPairing(id: String, secret: String, label: String) async throws -> AuthorityPairingClaim {
        try await post(
            path: "/.arbor/pairings/\(component(id))/claim",
            body: PairingClaimBody(secret: secret, label: label),
            authorized: false
        )
    }

    public func devices() async throws -> [AuthorityDevice] {
        try await get(path: "/.arbor/devices")
    }

    public func revokeDevice(id: String) async throws -> AuthorityDevice {
        var request = authorizedRequest(path: "/.arbor/devices/\(component(id))")
        request.httpMethod = "DELETE"
        return try await perform(request)
    }

    private func get<T: Decodable>(path: String) async throws -> T {
        try await perform(authorizedRequest(path: path))
    }

    private func post<T: Decodable, Body: Encodable>(
        path: String,
        body: Body,
        authorized: Bool = true
    ) async throws -> T {
        var request = authorized
            ? authorizedRequest(path: path)
            : URLRequest(url: url(path))
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
        let envelope = try? decoder.decode(AuthorityErrorEnvelope.self, from: data)
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

    private func authorizedRequest(path: String) -> URLRequest {
        authorizedRequest(url: url(path))
    }

    private func authorizedRequest(url: URL) -> URLRequest {
        var request = URLRequest(url: url)
        if let credential { request.setValue("Bearer \(credential)", forHTTPHeaderField: "Authorization") }
        return request
    }

    private func url(_ path: String) -> URL {
        URL(string: path, relativeTo: origin)!.absoluteURL
    }

    private func component(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/")))!
    }
}

private struct EmptyBody: Encodable {}
private struct PairingClaimBody: Encodable { var secret: String; var label: String }
private struct AuthorityErrorEnvelope: Decodable {
    var error: String
    var message: String
    var retryable: Bool
}
private struct RetryableAuthorityError: Error {}
