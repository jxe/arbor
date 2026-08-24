import Foundation

public enum ArborWireValidationError: Error, Equatable, Sendable {
    case invalidValue(String)
    case invalidHash(String)
    case invalidCBOR(String)
    case objectHashMismatch(expected: String, actual: String)
    case incompleteGraph(String)
    case cyclicGraph(String)
    case unreachableObject(String)
    case malformedSSE(String)
}

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
    public var path: String?

    public init(
        id: String,
        canonicalPath: String,
        parentTree: String? = nil,
        kind: String,
        ref: String,
        publicAccess: String,
        access: String,
        httpURL: String,
        arborURL: String,
        update: String? = nil,
        path: String? = nil
    ) {
        self.id = id
        self.canonicalPath = canonicalPath
        self.parentTree = parentTree
        self.kind = kind
        self.ref = ref
        self.publicAccess = publicAccess
        self.access = access
        self.httpURL = httpURL
        self.arborURL = arborURL
        self.update = update
        self.path = path
    }

    public func validated() throws -> Self {
        guard !id.isEmpty else { throw ArborWireValidationError.invalidValue("Tree ID is empty") }
        guard canonicalPath.hasPrefix("/") else { throw ArborWireValidationError.invalidValue("Canonical path is not absolute") }
        try validateObjectHash(ref)
        guard ["community-profile", "person-profile", "group-profile", "shared-subtree"].contains(kind) else {
            throw ArborWireValidationError.invalidValue("Unknown tree kind")
        }
        guard ["none", "read", "write"].contains(publicAccess), ["read", "write"].contains(access) else {
            throw ArborWireValidationError.invalidValue("Unknown access level")
        }
        guard URL(string: httpURL) != nil, URL(string: arborURL) != nil else {
            throw ArborWireValidationError.invalidValue("Malformed descriptor URL")
        }
        return self
    }
}

public struct AuthorityAccountDescriptor: Codable, Sendable, Equatable {
    public var id: String
    public var handle: String
    public var profileTree: String?
    public var profileURL: String?
    public var community: AuthorityTreeDescriptor
    public var writableProfiles: [AuthorityTreeDescriptor]
}

public struct AuthorityMergeSummary: Codable, Sendable, Equatable {
    public var version: String
    public var approximatePlacements: Int

    public init(version: String, approximatePlacements: Int) {
        self.version = version
        self.approximatePlacements = approximatePlacements
    }

    public func validated() throws -> Self {
        guard version == "markdown-additive-v1", approximatePlacements >= 0 else {
            throw ArborWireValidationError.invalidValue("Malformed merge summary")
        }
        return self
    }
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

    public func validated() throws -> Self {
        guard !id.isEmpty, !tree.isEmpty, acceptedAt.isFinite else {
            throw ArborWireValidationError.invalidValue("Malformed accepted update identity")
        }
        try validateObjectHash(root)
        for hash in [previousRoot, baseRoot, candidateRoot, remoteRoot].compactMap({ $0 }) { try validateObjectHash(hash) }
        guard ["initial", "accepted", "merged", "restored"].contains(kind) else {
            throw ArborWireValidationError.invalidValue("Unknown accepted update kind")
        }
        if let merge { _ = try merge.validated() }
        return self
    }
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
    public var requestDigest: String

    public init(tree: String, body: Data, requestDigest: String) {
        self.tree = tree
        self.body = body
        self.requestDigest = requestDigest
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

    public func validated() throws -> Self {
        guard error == "conflict", !retryable else { throw ArborWireValidationError.invalidValue("Malformed conflict envelope") }
        _ = try current.validated()
        try validateObjectHash(base)
        try validateObjectHash(candidate)
        _ = try WireObjectGraph.validate(draft)
        guard conflicts.allSatisfy({ $0.path.hasPrefix("/") && !$0.reason.isEmpty }) else {
            throw ArborWireValidationError.invalidValue("Malformed conflict reason")
        }
        return self
    }
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
        case "current": self = .current(try values.decode(AuthorityAcceptedUpdate.self, forKey: .current).validated())
        case "accepted": self = .accepted(try values.decode(AuthorityAcceptedUpdate.self, forKey: .update).validated())
        case "merged": self = .merged(
            try values.decode(AuthorityAcceptedUpdate.self, forKey: .update).validated(),
            try values.decode(AuthorityMergeSummary.self, forKey: .merge).validated()
        )
        default:
            throw DecodingError.dataCorruptedError(forKey: .outcome, in: values, debugDescription: "Unknown authority update outcome")
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

    public func validated() throws -> Self {
        guard !id.isEmpty, !account.isEmpty, !label.isEmpty, createdAt.isFinite,
              lastUsedAt?.isFinite != false, revokedAt?.isFinite != false else {
            throw ArborWireValidationError.invalidValue("Malformed device")
        }
        return self
    }
}

public struct AuthorityPairingOffer: Codable, Sendable, Equatable {
    public var id: String
    public var secret: String
    public var confirmationCode: String
    public var expiresAt: Double

    public func validated() throws -> Self {
        guard !id.isEmpty, !secret.isEmpty, !confirmationCode.isEmpty, expiresAt.isFinite else {
            throw ArborWireValidationError.invalidValue("Malformed pairing offer")
        }
        return self
    }
}

public struct AuthorityPairingClaim: Codable, Sendable, Equatable {
    public var deviceToken: String
    public var device: AuthorityDevice

    public func validated() throws -> Self {
        guard !deviceToken.isEmpty else { throw ArborWireValidationError.invalidValue("Missing paired device token") }
        _ = try device.validated()
        return self
    }
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

func validateObjectHash(_ value: String) throws {
    guard value.range(of: #"^sha256:[a-f0-9]{64}$"#, options: .regularExpression) != nil else {
        throw ArborWireValidationError.invalidHash(value)
    }
}
