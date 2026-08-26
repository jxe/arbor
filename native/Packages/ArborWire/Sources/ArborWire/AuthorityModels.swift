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

public struct AuthorityCanonicalDescriptor: Codable, Sendable, Equatable {
    public var locator: String
    public var path: String
    public var endpoint: String
    public var httpURL: String
    public var parentTree: String?

    public init(locator: String, path: String, endpoint: String, httpURL: String, parentTree: String? = nil) {
        self.locator = locator
        self.path = path
        self.endpoint = endpoint
        self.httpURL = httpURL
        self.parentTree = parentTree
    }
}

public struct AuthorityTreeDescriptor: Codable, Sendable, Equatable {
    public var id: String
    public var kind: String
    public var access: String
    public var canonical: AuthorityCanonicalDescriptor?
    public var ref: String
    public var update: String

    public var canonicalPath: String? { canonical?.path }
    public var parentTree: String? { canonical?.parentTree }
    public var httpURL: String? { canonical?.httpURL }
    public var arborURL: String? { canonical?.locator }

    public init(
        id: String,
        kind: String,
        ref: String,
        access: String,
        canonical: AuthorityCanonicalDescriptor?,
        update: String
    ) {
        self.id = id
        self.kind = kind
        self.access = access
        self.canonical = canonical
        self.ref = ref
        self.update = update
    }

    public func validated() throws -> Self {
        guard !id.isEmpty else { throw ArborWireValidationError.invalidValue("Tree ID is empty") }
        try validateObjectHash(ref)
        guard ["community-profile", "person-profile", "group-profile", "shared-subtree", "account-configuration"].contains(kind) else {
            throw ArborWireValidationError.invalidValue("Unknown tree kind")
        }
        guard ["none", "read", "write"].contains(access) else {
            throw ArborWireValidationError.invalidValue("Unknown access level")
        }
        if kind == "account-configuration" {
            guard canonical == nil else { throw ArborWireValidationError.invalidValue("Account configuration must be noncanonical") }
        } else {
            guard let canonical, canonical.path.hasPrefix("/"), URL(string: canonical.httpURL) != nil,
                  URL(string: canonical.locator) != nil, URL(string: canonical.endpoint) != nil else {
                throw ArborWireValidationError.invalidValue("Malformed canonical descriptor")
            }
        }
        return self
    }
}

public struct AuthoritySnapshotEnvelope<Value: Codable & Sendable & Equatable>: Codable, Sendable, Equatable {
    public var snapshot: Value
    public var observedThrough: String

    public init(snapshot: Value, observedThrough: String) {
        self.snapshot = snapshot
        self.observedThrough = observedThrough
    }
}

public struct AuthorityAccountDescriptor: Codable, Sendable, Equatable {
    public struct Device: Codable, Sendable, Equatable {
        public var id: String
        public var label: String
    }

    public var id: String
    public var handle: String
    public var profileTree: String?
    public var profileURL: String?
    public var community: AuthorityTreeDescriptor
    public var configuration: AuthorityTreeDescriptor
    public var writableProfiles: [AuthorityTreeDescriptor]
    public var device: Device? = nil
}

public struct AuthorityAccountSnapshot: Codable, Sendable, Equatable {
    public var account: AuthorityAccountDescriptor
    public var observedThrough: String
}

public struct AuthorityResolvedNodeRef: Codable, Sendable, Equatable {
    public var tree: String
    public var path: String
    public var pageID: String?
}

public struct AuthorityLocatorResolution: Codable, Sendable, Equatable {
    public var ref: AuthorityResolvedNodeRef
    public var enclosingTree: AuthorityTreeDescriptor
    public var historical: Bool
    public var observedThrough: String
}

public struct AuthorityMergeSummary: Codable, Sendable, Equatable {
    public var version: String
    public var approximatePlacements: Int?
    public var mergedFields: Int?

    public init(version: String, approximatePlacements: Int? = nil, mergedFields: Int? = nil) {
        self.version = version
        self.approximatePlacements = approximatePlacements
        self.mergedFields = mergedFields
    }

    public func validated() throws -> Self {
        if version == "markdown-additive-v1" {
            guard let approximatePlacements, approximatePlacements >= 0 else {
                throw ArborWireValidationError.invalidValue("Malformed merge summary")
            }
        } else if version == "account-config-v1" {
            guard let mergedFields, mergedFields >= 0 else {
                throw ArborWireValidationError.invalidValue("Malformed account configuration merge summary")
            }
        } else { throw ArborWireValidationError.invalidValue("Unknown merge summary") }
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

    public init(
        id: String,
        tree: String,
        root: String,
        previousRoot: String? = nil,
        kind: String,
        acceptedAt: Double,
        subject: String? = nil,
        baseRoot: String? = nil,
        candidateRoot: String? = nil,
        remoteRoot: String? = nil,
        merge: AuthorityMergeSummary? = nil
    ) {
        self.id = id
        self.tree = tree
        self.root = root
        self.previousRoot = previousRoot
        self.kind = kind
        self.acceptedAt = acceptedAt
        self.subject = subject
        self.baseRoot = baseRoot
        self.candidateRoot = candidateRoot
        self.remoteRoot = remoteRoot
        self.merge = merge
    }

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

public struct AuthorityCurrentSnapshot: Codable, Sendable, Equatable {
    public var tree: AuthorityTreeDescriptor
    public var snapshot: AuthoritySnapshot
    public var observedThrough: String

    public init(tree: AuthorityTreeDescriptor, snapshot: AuthoritySnapshot, observedThrough: String) {
        self.tree = tree
        self.snapshot = snapshot
        self.observedThrough = observedThrough
    }

    public func validated(expectedTree: String? = nil) throws -> Self {
        let tree = try tree.validated()
        _ = try WireObjectGraph.validate(snapshot)
        guard tree.ref == snapshot.root,
              !tree.update.isEmpty,
              !observedThrough.isEmpty,
              expectedTree == nil || tree.id == expectedTree else {
            throw ArborWireValidationError.invalidValue("Current snapshot descriptor does not match its graph")
        }
        return self
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

public struct AuthorityFilePatchEdit: Codable, Sendable, Equatable {
    public var offset: Int
    public var length: Int
    public var bytes: Data

    public init(offset: Int, length: Int, bytes: Data) {
        self.offset = offset
        self.length = length
        self.bytes = bytes
    }

    private enum CodingKeys: String, CodingKey { case offset, length, bytes }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        offset = try values.decode(Int.self, forKey: .offset)
        length = try values.decode(Int.self, forKey: .length)
        let encoded = try values.decode(String.self, forKey: .bytes)
        guard offset >= 0, length >= 0,
              offset <= 9_007_199_254_740_991, length <= 9_007_199_254_740_991,
              let decoded = Data(base64Encoded: encoded),
              decoded.base64EncodedString() == encoded else {
            throw ArborWireValidationError.invalidValue("Invalid file patch edit")
        }
        bytes = decoded
    }

    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(offset, forKey: .offset)
        try values.encode(length, forKey: .length)
        try values.encode(bytes.base64EncodedString(), forKey: .bytes)
    }
}

public struct AuthorityFilePatch: Codable, Sendable, Equatable {
    public var base: String
    public var result: String
    public var edits: [AuthorityFilePatchEdit]

    public init(base: String, result: String, edits: [AuthorityFilePatchEdit]) {
        self.base = base
        self.result = result
        self.edits = edits
    }

    public func validated() throws -> Self {
        try validateObjectHash(base)
        try validateObjectHash(result)
        guard !edits.isEmpty else { throw ArborWireValidationError.invalidValue("File patch edits are empty") }
        var previousEnd = 0
        for edit in edits {
            guard edit.offset >= previousEnd, edit.length >= 0,
                  edit.offset <= Int.max - edit.length else {
                throw ArborWireValidationError.invalidValue("File patch edits overlap or overflow")
            }
            previousEnd = edit.offset + edit.length
        }
        return self
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        base = try values.decode(String.self, forKey: .base)
        result = try values.decode(String.self, forKey: .result)
        edits = try values.decode([AuthorityFilePatchEdit].self, forKey: .edits)
        _ = try validated()
    }
}

public enum AuthoritySnapshotReturn: Sendable, Equatable, Codable {
    case always
    case ifResultDiffers

    public init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if let boolean = try? value.decode(Bool.self), boolean { self = .always; return }
        if let string = try? value.decode(String.self), string == "if-result-differs" { self = .ifResultDiffers; return }
        throw ArborWireValidationError.invalidValue("Invalid returnSnapshot mode")
    }

    public func encode(to encoder: Encoder) throws {
        var value = encoder.singleValueContainer()
        switch self {
        case .always: try value.encode(true)
        case .ifResultDiffers: try value.encode("if-result-differs")
        }
    }
}

public struct AuthorityUpdateRequest: Codable, Sendable, Equatable {
    public var base: AuthorityUpdateBase
    public var candidate: String
    public var objects: [AuthorityObject]
    public var filePatches: [AuthorityFilePatch]?
    public var returnSnapshot: AuthoritySnapshotReturn?

    public init(
        base: AuthorityUpdateBase,
        candidate: String,
        objects: [AuthorityObject],
        filePatches: [AuthorityFilePatch] = [],
        returnSnapshot: AuthoritySnapshotReturn? = nil
    ) {
        self.base = base
        self.candidate = candidate
        self.objects = objects
        self.filePatches = filePatches.isEmpty ? nil : filePatches
        self.returnSnapshot = returnSnapshot
    }

    public init(base: AuthorityUpdateBase, candidate: String, objects: [AuthorityObject], returnSnapshot: Bool) {
        self.init(
            base: base,
            candidate: candidate,
            objects: objects,
            returnSnapshot: returnSnapshot ? .always : nil
        )
    }

    private enum CodingKeys: String, CodingKey { case base, candidate, objects, filePatches, returnSnapshot }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        base = try values.decode(AuthorityUpdateBase.self, forKey: .base)
        candidate = try values.decode(String.self, forKey: .candidate)
        objects = try values.decode([AuthorityObject].self, forKey: .objects)
        filePatches = try values.decodeIfPresent([AuthorityFilePatch].self, forKey: .filePatches)
        returnSnapshot = try values.decodeIfPresent(AuthoritySnapshotReturn.self, forKey: .returnSnapshot)
        if let filePatches {
            guard filePatches.count <= 10_000,
                  filePatches.reduce(0, { $0 + $1.edits.count }) <= 100_000,
                  filePatches.reduce(0, { partial, patch in
                      partial + patch.edits.reduce(0, { $0 + $1.bytes.count })
                  }) <= 64 * 1024 * 1024 else {
                throw ArborWireValidationError.invalidValue("File patches exceed transport quotas")
            }
            let results = filePatches.map(\.result)
            guard Set(results).count == results.count else {
                throw ArborWireValidationError.invalidValue("Duplicate file patch result")
            }
            let complete = Set(objects.map(\.hash))
            guard results.allSatisfy({ !complete.contains($0) }) else {
                throw ArborWireValidationError.invalidValue("File patch result also supplied as complete object")
            }
        }
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

    public init(path: String, reason: String) { self.path = path; self.reason = reason }
}

public struct AuthorityConflictDetails: Codable, Sendable, Equatable {
    public var kind: String
    public var current: AuthorityAcceptedUpdate
    public var base: String
    public var candidate: String
    public var draft: AuthoritySnapshot
    public var currentSnapshot: AuthoritySnapshot?
    public var conflicts: [AuthorityConflictReason]
}

public struct AuthorityUpdateConflict: Codable, Sendable, Equatable {
    public var error: String
    public var message: String
    public var retryable: Bool
    public var tree: String?
    public var details: AuthorityConflictDetails

    public var current: AuthorityAcceptedUpdate { details.current }
    public var base: String { details.base }
    public var candidate: String { details.candidate }
    public var draft: AuthoritySnapshot { details.draft }
    public var currentSnapshot: AuthoritySnapshot? { details.currentSnapshot }
    public var conflicts: [AuthorityConflictReason] { details.conflicts }

    public init(
        error: String = "conflict",
        message: String,
        retryable: Bool = false,
        tree: String? = nil,
        kind: String = "authority-update",
        current: AuthorityAcceptedUpdate,
        base: String,
        candidate: String,
        draft: AuthoritySnapshot,
        currentSnapshot: AuthoritySnapshot? = nil,
        conflicts: [AuthorityConflictReason]
    ) {
        self.error = error
        self.message = message
        self.retryable = retryable
        self.tree = tree
        self.details = AuthorityConflictDetails(
            kind: kind,
            current: current,
            base: base,
            candidate: candidate,
            draft: draft,
            currentSnapshot: currentSnapshot,
            conflicts: conflicts
        )
    }

    public func validated() throws -> Self {
        guard error == "conflict", !retryable else { throw ArborWireValidationError.invalidValue("Malformed conflict envelope") }
        guard ["authority-update", "account-configuration"].contains(details.kind) else {
            throw ArborWireValidationError.invalidValue("Unknown conflict detail kind")
        }
        _ = try details.current.validated()
        try validateObjectHash(details.base)
        try validateObjectHash(details.candidate)
        _ = try WireObjectGraph.validate(details.draft)
        if let currentSnapshot = details.currentSnapshot {
            _ = try WireObjectGraph.validate(currentSnapshot)
            guard currentSnapshot.root == details.current.root else {
                throw ArborWireValidationError.invalidValue("Conflict current snapshot root mismatch")
            }
        }
        guard details.conflicts.allSatisfy({ $0.path.hasPrefix("/") && !$0.reason.isEmpty }) else {
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

public struct AuthorityUpdateResponse: Sendable, Equatable, Decodable {
    public var result: AuthorityUpdateResult
    public var requestDigest: String
    public var snapshot: AuthoritySnapshot?
    public var observedThrough: String

    private enum CodingKeys: String, CodingKey { case requestDigest, snapshot, observedThrough }

    public init(result: AuthorityUpdateResult, requestDigest: String, snapshot: AuthoritySnapshot?, observedThrough: String) {
        self.result = result
        self.requestDigest = requestDigest
        self.snapshot = snapshot
        self.observedThrough = observedThrough
    }

    public init(from decoder: Decoder) throws {
        result = try AuthorityUpdateResult(from: decoder)
        let values = try decoder.container(keyedBy: CodingKeys.self)
        requestDigest = try values.decode(String.self, forKey: .requestDigest)
        try validateObjectHash(requestDigest)
        observedThrough = try values.decode(String.self, forKey: .observedThrough)
        guard !observedThrough.isEmpty else { throw ArborWireValidationError.invalidValue("Missing observation boundary") }
        snapshot = try values.decodeIfPresent(AuthoritySnapshot.self, forKey: .snapshot)
        if let snapshot {
            _ = try WireObjectGraph.validate(snapshot)
            let acceptedRoot: String
            switch result {
            case let .current(update), let .accepted(update): acceptedRoot = update.root
            case let .merged(update, _): acceptedRoot = update.root
            }
            guard snapshot.root == acceptedRoot else {
                throw ArborWireValidationError.invalidValue("Returned snapshot root mismatch")
            }
        }
    }
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
    public var device: AuthorityDevice
    public var confirmationCode: String

    public func validated() throws -> Self {
        guard !confirmationCode.isEmpty else {
            throw ArborWireValidationError.invalidValue("Missing pairing confirmation code")
        }
        _ = try device.validated()
        return self
    }
}

public struct AuthorityPairingDevice: Codable, Sendable, Equatable {
    public var id: String
    public var label: String
    public var credentialDigest: String

    public init(id: String, label: String, credentialDigest: String) {
        self.id = id
        self.label = label
        self.credentialDigest = credentialDigest
    }
}

public struct AuthorityPlacement: Codable, Sendable, Equatable {
    public var authority: String
    public var path: String?

    public init(authority: String, path: String? = nil) {
        self.authority = authority
        self.path = path
    }
}

public struct AuthorityClaimRequest: Codable, Sendable, Equatable {
    public var profileTree: String
    public var configurationTree: String
    public var device: AuthorityPairingDevice
    public var profile: AuthoritySnapshot
    public var configuration: AuthoritySnapshot
}

public struct AuthorityClaimResult: Codable, Sendable, Equatable {
    public var account: AuthorityAccountDescriptor
    public var tree: AuthorityTreeDescriptor
    public var configuration: AuthorityTreeDescriptor
}

public enum AuthoritySafeAccessSubject: Codable, Sendable, Equatable {
    case everyone
    case profile(tree: String, locator: String?)
    case link

    private enum CodingKeys: String, CodingKey { case kind, tree, locator }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        switch try values.decode(String.self, forKey: .kind) {
        case "everyone": self = .everyone
        case "profile": self = .profile(
            tree: try values.decode(String.self, forKey: .tree),
            locator: try values.decodeIfPresent(String.self, forKey: .locator)
        )
        case "link": self = .link
        default: throw ArborWireValidationError.invalidValue("Unknown access subject")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .everyone: try values.encode("everyone", forKey: .kind)
        case let .profile(tree, locator):
            try values.encode("profile", forKey: .kind)
            try values.encode(tree, forKey: .tree)
            try values.encodeIfPresent(locator, forKey: .locator)
        case .link: try values.encode("link", forKey: .kind)
        }
    }
}

public struct AuthorityAccessEntry: Codable, Sendable, Equatable {
    public var id: String
    public var subject: AuthoritySafeAccessSubject
    public var access: String
}

public struct AuthorityUpdateConflictError: Error, Sendable, Equatable {
    public var conflict: AuthorityUpdateConflict

    public init(conflict: AuthorityUpdateConflict) { self.conflict = conflict }
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
