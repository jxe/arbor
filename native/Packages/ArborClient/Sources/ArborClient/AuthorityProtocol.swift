import Foundation

public struct AuthorityTreeDescriptor: Codable, Sendable, Equatable {
    public var id: String
    public var canonicalPath: String
    public var parentTree: String?
    public var kind: String
    public var ref: String
    public var publicAccess: String
    public var access: String
    public var httpURL: String
    public var arborURL: String
    public var update: String?
}

public struct AuthorityMergeSummary: Codable, Sendable, Equatable {
    public var version: String
    public var approximatePlacements: Int
}

public struct AuthorityAcceptedUpdate: Codable, Sendable, Equatable {
    public var id: String
    public var tree: String
    public var root: String
    public var previousRoot: String?
    public var kind: String
    public var acceptedAt: Double
    public var subject: String?
    public var baseRoot: String?
    public var candidateRoot: String?
    public var remoteRoot: String?
    public var merge: AuthorityMergeSummary?
}

public struct AuthorityObject: Codable, Sendable, Equatable {
    public var hash: String
    public var bytes: Data

    public init(hash: String, bytes: Data) {
        self.hash = hash
        self.bytes = bytes
    }
}

public struct AuthoritySnapshot: Codable, Sendable, Equatable {
    public var root: String
    public var objects: [AuthorityObject]

    public init(root: String, objects: [AuthorityObject]) {
        self.root = root
        self.objects = objects
    }
}

public struct AuthorityUpdateBase: Codable, Sendable, Equatable {
    public var root: String
    public var update: String

    public init(root: String, update: String) {
        self.root = root
        self.update = update
    }
}

public struct AuthorityUpdateRequest: Codable, Sendable, Equatable {
    public var base: AuthorityUpdateBase
    public var candidate: String
    public var objects: [AuthorityObject]

    public init(base: AuthorityUpdateBase, candidate: String, objects: [AuthorityObject]) {
        self.base = base
        self.candidate = candidate
        self.objects = objects
    }
}

public struct PreparedAuthorityUpdate: Sendable, Equatable {
    public var tree: String
    public var body: Data

    public init(tree: String, body: Data) {
        self.tree = tree
        self.body = body
    }
}

public struct AuthorityConflictReason: Codable, Sendable, Equatable {
    public var path: String
    public var reason: String
}

public struct AuthorityUpdateConflict: Codable, Sendable, Equatable {
    public var error: String
    public var message: String
    public var retryable: Bool
    public var current: AuthorityAcceptedUpdate
    public var base: String
    public var candidate: String
    public var draft: AuthoritySnapshot
    public var conflicts: [AuthorityConflictReason]
}

public enum AuthorityUpdateResult: Sendable, Equatable {
    case current(AuthorityAcceptedUpdate)
    case accepted(AuthorityAcceptedUpdate)
    case merged(AuthorityAcceptedUpdate, AuthorityMergeSummary)
}

extension AuthorityUpdateResult: Decodable {
    private enum CodingKeys: String, CodingKey { case outcome, current, update, merge }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        switch try values.decode(String.self, forKey: .outcome) {
        case "current":
            self = .current(try values.decode(AuthorityAcceptedUpdate.self, forKey: .current))
        case "accepted":
            self = .accepted(try values.decode(AuthorityAcceptedUpdate.self, forKey: .update))
        case "merged":
            self = .merged(
                try values.decode(AuthorityAcceptedUpdate.self, forKey: .update),
                try values.decode(AuthorityMergeSummary.self, forKey: .merge)
            )
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .outcome,
                in: values,
                debugDescription: "Unknown authority update outcome"
            )
        }
    }
}

public struct AuthorityDevice: Codable, Sendable, Equatable {
    public var id: String
    public var account: String
    public var label: String
    public var createdAt: Double
    public var lastUsedAt: Double?
    public var revokedAt: Double?
}

public struct AuthorityPairingOffer: Codable, Sendable, Equatable {
    public var id: String
    public var secret: String
    public var confirmationCode: String
    public var expiresAt: Double
}

public struct AuthorityPairingClaim: Codable, Sendable, Equatable {
    public var deviceToken: String
    public var device: AuthorityDevice
}

public struct AuthorityUpdateConflictError: Error, Sendable, Equatable {
    public var conflict: AuthorityUpdateConflict
}

public struct AuthorityHTTPError: Error, Sendable, Equatable {
    public var status: Int
    public var code: String
    public var message: String?
    public var retryable: Bool
}
