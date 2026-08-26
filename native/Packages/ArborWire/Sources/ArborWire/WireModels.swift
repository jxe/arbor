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

public struct WireCanonicalDescriptor: Codable, Sendable, Equatable {
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

public struct WireTreeDescriptor: Codable, Sendable, Equatable {
    public var id: String
    public var kind: String
    public var access: String
    public var canonical: WireCanonicalDescriptor?
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
        canonical: WireCanonicalDescriptor?,
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

public struct WireSnapshotEnvelope<Value: Codable & Sendable & Equatable>: Codable, Sendable, Equatable {
    public var snapshot: Value
    public var observedThrough: String

    public init(snapshot: Value, observedThrough: String) {
        self.snapshot = snapshot
        self.observedThrough = observedThrough
    }
}

public struct WireAccountDescriptor: Codable, Sendable, Equatable {
    public struct Device: Codable, Sendable, Equatable {
        public var id: String
        public var label: String
    }

    public var id: String
    public var handle: String
    public var profileTree: String?
    public var profileURL: String?
    public var community: WireTreeDescriptor
    public var configuration: WireTreeDescriptor
    public var writableProfiles: [WireTreeDescriptor]
    public var device: Device? = nil
}

public struct WireAccountSnapshot: Codable, Sendable, Equatable {
    public var account: WireAccountDescriptor
    public var observedThrough: String
}

public struct WireResolvedNodeRef: Codable, Sendable, Equatable {
    public var tree: String
    public var path: String
    public var pageID: String?
}

public struct WireLocatorResolution: Codable, Sendable, Equatable {
    public var ref: WireResolvedNodeRef
    public var enclosingTree: WireTreeDescriptor
    public var historical: Bool
    public var observedThrough: String
}

public struct WireMergeSummary: Codable, Sendable, Equatable {
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

public struct WireAcceptedUpdate: Codable, Sendable, Equatable {
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
    public var merge: WireMergeSummary?

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
        merge: WireMergeSummary? = nil
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

public struct WireObjectEnvelope: Codable, Sendable, Equatable {
    public var hash: String
    public var bytes: Data

    public init(hash: String, bytes: Data) {
        self.hash = hash
        self.bytes = bytes
    }
}

public struct WireSnapshot: Codable, Sendable, Equatable {
    public var root: String
    public var objects: [WireObjectEnvelope]

    public init(root: String, objects: [WireObjectEnvelope]) {
        self.root = root
        self.objects = objects
    }
}

public struct WireCurrentSnapshot: Codable, Sendable, Equatable {
    public var tree: WireTreeDescriptor
    public var snapshot: WireSnapshot
    public var observedThrough: String

    public init(tree: WireTreeDescriptor, snapshot: WireSnapshot, observedThrough: String) {
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

public struct WireUpdateBase: Codable, Sendable, Equatable {
    public var root: String
    public var update: String

    public init(root: String, update: String) {
        self.root = root
        self.update = update
    }
}

public struct WireFilePatchEdit: Codable, Sendable, Equatable {
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

public struct WireFilePatch: Codable, Sendable, Equatable {
    public var base: String
    public var result: String
    public var edits: [WireFilePatchEdit]

    public init(base: String, result: String, edits: [WireFilePatchEdit]) {
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
        edits = try values.decode([WireFilePatchEdit].self, forKey: .edits)
        _ = try validated()
    }
}

public enum WireSnapshotReturn: Sendable, Equatable, Codable {
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

public struct WireUpdateRequest: Codable, Sendable, Equatable {
    public var base: WireUpdateBase
    public var candidate: String
    public var objects: [WireObjectEnvelope]
    public var filePatches: [WireFilePatch]?
    public var returnSnapshot: WireSnapshotReturn?

    public init(
        base: WireUpdateBase,
        candidate: String,
        objects: [WireObjectEnvelope],
        filePatches: [WireFilePatch] = [],
        returnSnapshot: WireSnapshotReturn? = nil
    ) {
        self.base = base
        self.candidate = candidate
        self.objects = objects
        self.filePatches = filePatches.isEmpty ? nil : filePatches
        self.returnSnapshot = returnSnapshot
    }

    public init(base: WireUpdateBase, candidate: String, objects: [WireObjectEnvelope], returnSnapshot: Bool) {
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
        base = try values.decode(WireUpdateBase.self, forKey: .base)
        candidate = try values.decode(String.self, forKey: .candidate)
        objects = try values.decode([WireObjectEnvelope].self, forKey: .objects)
        filePatches = try values.decodeIfPresent([WireFilePatch].self, forKey: .filePatches)
        returnSnapshot = try values.decodeIfPresent(WireSnapshotReturn.self, forKey: .returnSnapshot)
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

public struct PreparedWireUpdate: Sendable, Equatable {
    public var tree: String
    public var body: Data
    public var requestDigest: String

    public init(tree: String, body: Data, requestDigest: String) {
        self.tree = tree
        self.body = body
        self.requestDigest = requestDigest
    }
}

public struct WireConflictReason: Codable, Sendable, Equatable {
    public var path: String
    public var reason: String

    public init(path: String, reason: String) { self.path = path; self.reason = reason }
}

public struct WireConflictDetails: Codable, Sendable, Equatable {
    public var kind: String
    public var current: WireAcceptedUpdate
    public var base: String
    public var candidate: String
    public var draft: WireSnapshot
    public var currentSnapshot: WireSnapshot?
    public var conflicts: [WireConflictReason]
}

public struct WireUpdateConflict: Codable, Sendable, Equatable {
    public var error: String
    public var message: String
    public var retryable: Bool
    public var tree: String?
    public var details: WireConflictDetails

    public var current: WireAcceptedUpdate { details.current }
    public var base: String { details.base }
    public var candidate: String { details.candidate }
    public var draft: WireSnapshot { details.draft }
    public var currentSnapshot: WireSnapshot? { details.currentSnapshot }
    public var conflicts: [WireConflictReason] { details.conflicts }

    public init(
        error: String = "conflict",
        message: String,
        retryable: Bool = false,
        tree: String? = nil,
        kind: String = "server-update",
        current: WireAcceptedUpdate,
        base: String,
        candidate: String,
        draft: WireSnapshot,
        currentSnapshot: WireSnapshot? = nil,
        conflicts: [WireConflictReason]
    ) {
        self.error = error
        self.message = message
        self.retryable = retryable
        self.tree = tree
        self.details = WireConflictDetails(
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
        guard ["server-update", "account-configuration"].contains(details.kind) else {
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

public enum WireUpdateResult: Sendable, Equatable {
    case current(WireAcceptedUpdate)
    case accepted(WireAcceptedUpdate)
    case merged(WireAcceptedUpdate, WireMergeSummary)
}

public struct WireUpdateResponse: Sendable, Equatable, Decodable {
    public var result: WireUpdateResult
    public var requestDigest: String
    public var snapshot: WireSnapshot?
    public var observedThrough: String

    private enum CodingKeys: String, CodingKey { case requestDigest, snapshot, observedThrough }

    public init(result: WireUpdateResult, requestDigest: String, snapshot: WireSnapshot?, observedThrough: String) {
        self.result = result
        self.requestDigest = requestDigest
        self.snapshot = snapshot
        self.observedThrough = observedThrough
    }

    public init(from decoder: Decoder) throws {
        result = try WireUpdateResult(from: decoder)
        let values = try decoder.container(keyedBy: CodingKeys.self)
        requestDigest = try values.decode(String.self, forKey: .requestDigest)
        try validateObjectHash(requestDigest)
        observedThrough = try values.decode(String.self, forKey: .observedThrough)
        guard !observedThrough.isEmpty else { throw ArborWireValidationError.invalidValue("Missing observation boundary") }
        snapshot = try values.decodeIfPresent(WireSnapshot.self, forKey: .snapshot)
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

extension WireUpdateResult: Decodable {
    private enum CodingKeys: String, CodingKey { case outcome, current, update, merge }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        switch try values.decode(String.self, forKey: .outcome) {
        case "current": self = .current(try values.decode(WireAcceptedUpdate.self, forKey: .current).validated())
        case "accepted": self = .accepted(try values.decode(WireAcceptedUpdate.self, forKey: .update).validated())
        case "merged": self = .merged(
            try values.decode(WireAcceptedUpdate.self, forKey: .update).validated(),
            try values.decode(WireMergeSummary.self, forKey: .merge).validated()
        )
        default:
            throw DecodingError.dataCorruptedError(forKey: .outcome, in: values, debugDescription: "Unknown server update outcome")
        }
    }
}

public struct WireDevice: Codable, Sendable, Equatable {
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

public struct WirePairingOffer: Codable, Sendable, Equatable {
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

public struct WirePairingClaim: Codable, Sendable, Equatable {
    public var device: WireDevice
    public var confirmationCode: String

    public func validated() throws -> Self {
        guard !confirmationCode.isEmpty else {
            throw ArborWireValidationError.invalidValue("Missing pairing confirmation code")
        }
        _ = try device.validated()
        return self
    }
}

public struct WirePairingDevice: Codable, Sendable, Equatable {
    public var id: String
    public var label: String
    public var credentialDigest: String

    public init(id: String, label: String, credentialDigest: String) {
        self.id = id
        self.label = label
        self.credentialDigest = credentialDigest
    }
}

public struct WirePlacement: Codable, Sendable, Equatable {
    public var server: String
    public var path: String?

    public init(server: String, path: String? = nil) {
        self.server = server
        self.path = path
    }
}

public struct WireClaimRequest: Codable, Sendable, Equatable {
    public var profileTree: String
    public var configurationTree: String
    public var device: WirePairingDevice
    public var profile: WireSnapshot
    public var configuration: WireSnapshot
}

public struct WireClaimResult: Codable, Sendable, Equatable {
    public var account: WireAccountDescriptor
    public var tree: WireTreeDescriptor
    public var configuration: WireTreeDescriptor
}

public enum WireSafeAccessSubject: Codable, Sendable, Equatable {
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

public struct WireAccessEntry: Codable, Sendable, Equatable {
    public var id: String
    public var subject: WireSafeAccessSubject
    public var access: String
}

public struct WireUpdateConflictError: Error, Sendable, Equatable {
    public var conflict: WireUpdateConflict

    public init(conflict: WireUpdateConflict) { self.conflict = conflict }
}

public struct WireHTTPError: Error, Sendable, Equatable {
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
