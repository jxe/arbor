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
    public var path: String
    public var endpoint: String
    public var parentTree: String?

    public init(path: String, endpoint: String, parentTree: String? = nil) {
        self.path = path
        self.endpoint = endpoint
        self.parentTree = parentTree
    }

    /// The public HTTP URL: the endpoint's origin followed by the encoded canonical path.
    public var httpURL: String { canonicalHTTPURL(endpoint: endpoint, path: path) }
    /// The `arbor://` locator: the endpoint's host followed by the encoded canonical path.
    public var arborURL: String { canonicalArborLocator(endpoint: endpoint, path: path) }
}

/// Characters `encodeURIComponent` leaves unencoded; every other byte is percent-encoded.
private let canonicalSegmentAllowed = CharacterSet(
    charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()"
)

/// Percent-encode a decoded canonical path segment by segment; the root encodes as `/`.
private func encodedCanonicalPath(_ path: String) -> String {
    let segments = path.split(separator: "/").map { segment in
        String(segment).addingPercentEncoding(withAllowedCharacters: canonicalSegmentAllowed) ?? String(segment)
    }
    return segments.isEmpty ? "/" : "/" + segments.joined(separator: "/")
}

/// The endpoint's scheme and authority as a WHATWG origin would render them
/// (lowercase host, default port omitted), or nil when the endpoint has no host.
private func endpointOrigin(_ endpoint: String) -> (scheme: String, authority: String)? {
    guard let components = URLComponents(string: endpoint),
          let scheme = components.scheme?.lowercased(),
          let host = components.host?.lowercased(), !host.isEmpty else { return nil }
    let defaultPort: Int? = scheme == "https" ? 443 : scheme == "http" ? 80 : nil
    let port = components.port.flatMap { $0 == defaultPort ? nil : ":\($0)" } ?? ""
    return (scheme, host + port)
}

/// The public HTTP URL of a canonical tree, derived from its endpoint and decoded path.
public func canonicalHTTPURL(endpoint: String, path: String) -> String {
    guard let origin = endpointOrigin(endpoint) else { return endpoint + encodedCanonicalPath(path) }
    return "\(origin.scheme)://\(origin.authority)\(encodedCanonicalPath(path))"
}

/// The `arbor://` locator of a canonical tree, derived from its endpoint and decoded path.
public func canonicalArborLocator(endpoint: String, path: String) -> String {
    guard let origin = endpointOrigin(endpoint) else { return "arbor://" + encodedCanonicalPath(path) }
    return "arbor://\(origin.authority)\(encodedCanonicalPath(path))"
}

public struct WireTreeDescriptor: Codable, Sendable, Equatable {
    public var id: String
    public var kind: String
    public var access: String
    public var canonical: WireCanonicalDescriptor?
    /// The bytes hash of the current accepted tree state: the wire root.
    public var root: String
    public var update: String

    public var canonicalPath: String? { canonical?.path }
    public var parentTree: String? { canonical?.parentTree }
    public var httpURL: String? { canonical?.httpURL }
    public var arborURL: String? { canonical?.arborURL }

    public init(
        id: String,
        kind: String,
        root: String,
        access: String,
        canonical: WireCanonicalDescriptor?,
        update: String
    ) {
        self.id = id
        self.kind = kind
        self.access = access
        self.canonical = canonical
        self.root = root
        self.update = update
    }

    public func validated() throws -> Self {
        guard !id.isEmpty else { throw ArborWireValidationError.invalidValue("Tree ID is empty") }
        try validateObjectHash(root)
        guard ["ordinary", "account-configuration"].contains(kind) else {
            throw ArborWireValidationError.invalidValue("Unknown tree kind")
        }
        guard ["none", "read", "write"].contains(access) else {
            throw ArborWireValidationError.invalidValue("Unknown access level")
        }
        if kind == "account-configuration" {
            guard canonical == nil else { throw ArborWireValidationError.invalidValue("Account configuration must be noncanonical") }
        } else {
            guard let canonical, canonical.path.hasPrefix("/"), URL(string: canonical.endpoint) != nil else {
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
    /// Optional Canopy-specific presentation hint; never account identity.
    public var handle: String?
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
    public var stableKey: String?

    public init(tree: String, path: String, stableKey: String? = nil) {
        self.tree = tree
        self.path = path
        self.stableKey = stableKey
    }

    private enum CodingKeys: String, CodingKey { case tree, path, stableKey, pageID, pathHint }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        guard values.contains(.stableKey), !values.contains(.pageID), !values.contains(.pathHint) else {
            throw DecodingError.dataCorruptedError(
                forKey: .stableKey,
                in: values,
                debugDescription: "Wire node refs require explicit stableKey and reject PageID references"
            )
        }
        tree = try values.decode(String.self, forKey: .tree)
        path = try values.decode(String.self, forKey: .path)
        stableKey = try values.decodeIfPresent(String.self, forKey: .stableKey)
        guard !tree.isEmpty, path.hasPrefix("/"), stableKey?.isEmpty != true else {
            throw DecodingError.dataCorruptedError(
                forKey: .stableKey,
                in: values,
                debugDescription: "Wire node refs require a tree, absolute path, and nonempty stable key"
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(tree, forKey: .tree)
        try values.encode(path, forKey: .path)
        if let stableKey { try values.encode(stableKey, forKey: .stableKey) }
        else { try values.encodeNil(forKey: .stableKey) }
    }
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
    public var mergedRows: Int?

    public init(version: String, approximatePlacements: Int? = nil, mergedFields: Int? = nil, mergedRows: Int? = nil) {
        self.version = version
        self.approximatePlacements = approximatePlacements
        self.mergedFields = mergedFields
        self.mergedRows = mergedRows
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
        } else if version == "collection-file-rows-v1" {
            guard let mergedRows, mergedRows >= 0 else {
                throw ArborWireValidationError.invalidValue("Malformed collection-file merge summary")
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

/// The tree resource: its current descriptor and the cursor to watch after.
public struct WireCurrentTree: Codable, Sendable, Equatable {
    public var tree: WireTreeDescriptor
    public var observedThrough: String

    public init(tree: WireTreeDescriptor, observedThrough: String) {
        self.tree = tree
        self.observedThrough = observedThrough
    }

    public func validated(expectedTree: String? = nil) throws -> Self {
        let tree = try tree.validated()
        guard !tree.update.isEmpty, !observedThrough.isEmpty, expectedTree == nil || tree.id == expectedTree else {
            throw ArborWireValidationError.invalidValue("Tree descriptor does not match its tree")
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

public enum WireObjectDeltaInstruction: Sendable, Equatable, Codable {
    case copy(offset: Int, length: Int)
    case insert(Data)

    static let maxSafeInteger = 9_007_199_254_740_991

    private enum CodingKeys: String, CodingKey { case copy, insert }
    private enum CopyKeys: String, CodingKey { case offset, length }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        guard values.contains(.copy) != values.contains(.insert) else {
            throw ArborWireValidationError.invalidValue("Object delta instruction requires exactly one operation")
        }
        if values.contains(.copy) {
            let copy = try values.nestedContainer(keyedBy: CopyKeys.self, forKey: .copy)
            let offset = try copy.decode(Int.self, forKey: .offset)
            let length = try copy.decode(Int.self, forKey: .length)
            guard Self.validCopy(offset: offset, length: length) else {
                throw ArborWireValidationError.invalidValue("Invalid object delta copy")
            }
            self = .copy(offset: offset, length: length)
        } else {
            let encoded = try values.decode(String.self, forKey: .insert)
            guard let bytes = Data(base64Encoded: encoded), !bytes.isEmpty,
                  bytes.base64EncodedString() == encoded else {
                throw ArborWireValidationError.invalidValue("Invalid object delta insert")
            }
            self = .insert(bytes)
        }
    }

    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .copy(offset, length):
            var copy = values.nestedContainer(keyedBy: CopyKeys.self, forKey: .copy)
            try copy.encode(offset, forKey: .offset)
            try copy.encode(length, forKey: .length)
        case let .insert(bytes):
            try values.encode(bytes.base64EncodedString(), forKey: .insert)
        }
    }

    static func validCopy(offset: Int, length: Int) -> Bool {
        offset >= 0 && length > 0
            && offset <= maxSafeInteger && length <= maxSafeInteger
            && offset <= maxSafeInteger - length
    }
}

/// Sparse representation of one canonical object against a base object that is
/// reachable in the relevant basis graph. Instructions address the base's
/// exact canonical CBOR bytes, so files and directories use the same rule.
public struct WireObjectDelta: Codable, Sendable, Equatable {
    public var base: String
    public var result: String
    public var instructions: [WireObjectDeltaInstruction]

    public init(base: String, result: String, instructions: [WireObjectDeltaInstruction]) {
        self.base = base
        self.result = result
        self.instructions = instructions
    }

    public func validated() throws -> Self {
        try validateObjectHash(base)
        try validateObjectHash(result)
        guard !instructions.isEmpty else { throw ArborWireValidationError.invalidValue("Object delta instructions are empty") }
        for instruction in instructions {
            switch instruction {
            case let .copy(offset, length):
                guard WireObjectDeltaInstruction.validCopy(offset: offset, length: length) else {
                    throw ArborWireValidationError.invalidValue("Invalid object delta copy")
                }
            case let .insert(bytes):
                guard !bytes.isEmpty else { throw ArborWireValidationError.invalidValue("Object delta insert is empty") }
            }
        }
        return self
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        base = try values.decode(String.self, forKey: .base)
        result = try values.decode(String.self, forKey: .result)
        instructions = try values.decode([WireObjectDeltaInstruction].self, forKey: .instructions)
        _ = try validated()
    }

    /// Reconstruct the canonical bytes of `result` from the canonical bytes of `base`.
    public func apply(to baseBytes: Data) throws -> Data {
        var output = Data()
        for instruction in instructions {
            switch instruction {
            case let .copy(offset, length):
                guard offset <= baseBytes.count, length <= baseBytes.count - offset else {
                    throw ArborWireValidationError.invalidValue("Object delta copy is out of bounds")
                }
                let start = baseBytes.startIndex + offset
                output.append(baseBytes[start ..< start + length])
            case let .insert(bytes):
                output.append(bytes)
            }
            guard output.count <= 1_000_000_000 else {
                throw ArborWireValidationError.invalidValue("Object delta result exceeds the storage quota")
            }
        }
        let actual = WireObjectCodec.hash(output)
        guard actual == result else {
            throw ArborWireValidationError.objectHashMismatch(expected: result, actual: actual)
        }
        return output
    }
}

public struct WireAcceptedTransition: Codable, Sendable, Equatable {
    public var update: WireAcceptedUpdate
    public var objects: [WireObjectEnvelope]
    public var deltas: [WireObjectDelta]
    public var requestDigest: String?

    public init(
        update: WireAcceptedUpdate,
        objects: [WireObjectEnvelope],
        deltas: [WireObjectDelta] = [],
        requestDigest: String? = nil
    ) {
        self.update = update
        self.objects = objects
        self.deltas = deltas
        self.requestDigest = requestDigest
    }

    private enum CodingKeys: String, CodingKey { case update, objects, deltas, requestDigest }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        update = try values.decode(WireAcceptedUpdate.self, forKey: .update)
        objects = try values.decode([WireObjectEnvelope].self, forKey: .objects)
        deltas = try values.decode([WireObjectDelta].self, forKey: .deltas)
        requestDigest = try values.decodeIfPresent(String.self, forKey: .requestDigest)
        _ = try validated()
    }

    public func validated() throws -> Self {
        _ = try update.validated()
        guard update.previousRoot != nil else {
            throw ArborWireValidationError.invalidValue("Initial accepted update cannot be replayed as a transition")
        }
        if let requestDigest { try validateObjectHash(requestDigest) }
        var results = Set<String>()
        for envelope in objects {
            try validateObjectHash(envelope.hash)
            guard WireObjectCodec.hash(envelope.bytes) == envelope.hash else {
                throw ArborWireValidationError.objectHashMismatch(expected: envelope.hash, actual: WireObjectCodec.hash(envelope.bytes))
            }
            _ = try WireObjectCodec.decode(envelope.bytes)
            guard results.insert(envelope.hash).inserted else {
                throw ArborWireValidationError.invalidValue("Duplicate transition result")
            }
        }
        for delta in deltas {
            _ = try delta.validated()
            guard results.insert(delta.result).inserted else {
                throw ArborWireValidationError.invalidValue("Transition result supplied more than once")
            }
        }
        return self
    }
}

public struct WireUpdateRequest: Codable, Sendable, Equatable {
    /// The accepted update id the candidate derives from; nil activates a reserved tree.
    public var base: String?
    public var candidate: String
    /// Which hash must still match its value at base: "bytesHash" or "modelHash".
    public var ifMatch: String
    /// Under modelHash, what to do with a node changed in both places; nil means merge.
    public var onConflict: String?
    public var objects: [WireObjectEnvelope]
    public var deltas: [WireObjectDelta]

    public init(
        base: String?,
        candidate: String,
        ifMatch: String? = nil,
        onConflict: String? = nil,
        objects: [WireObjectEnvelope],
        deltas: [WireObjectDelta] = []
    ) {
        self.base = base
        self.candidate = candidate
        self.ifMatch = ifMatch ?? (base == nil ? "bytesHash" : "modelHash")
        self.onConflict = onConflict
        self.objects = objects
        self.deltas = deltas
    }

    public init(
        base: WireUpdateBase,
        candidate: String,
        ifMatch: String? = nil,
        onConflict: String? = nil,
        objects: [WireObjectEnvelope],
        deltas: [WireObjectDelta] = []
    ) {
        self.init(base: base.update, candidate: candidate, ifMatch: ifMatch, onConflict: onConflict, objects: objects, deltas: deltas)
    }

    private enum CodingKeys: String, CodingKey { case base, candidate, ifMatch, onConflict, objects, deltas }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        base = try values.decodeIfPresent(String.self, forKey: .base)
        candidate = try values.decode(String.self, forKey: .candidate)
        ifMatch = try values.decode(String.self, forKey: .ifMatch)
        onConflict = try values.decodeIfPresent(String.self, forKey: .onConflict)
        guard ifMatch == "bytesHash" || ifMatch == "modelHash" else {
            throw ArborWireValidationError.invalidValue("Update requires ifMatch of bytesHash or modelHash")
        }
        if let onConflict, onConflict != "reject", onConflict != "merge" {
            throw ArborWireValidationError.invalidValue("onConflict must be reject or merge")
        }
        if ifMatch == "bytesHash", onConflict == "merge" {
            throw ArborWireValidationError.invalidValue("A bytesHash match cannot merge")
        }
        if base == nil, ifMatch != "bytesHash" {
            throw ArborWireValidationError.invalidValue("Activation matches on bytesHash")
        }
        objects = try values.decode([WireObjectEnvelope].self, forKey: .objects)
        deltas = try values.decode([WireObjectDelta].self, forKey: .deltas)
        if base == nil, !deltas.isEmpty {
            throw ArborWireValidationError.invalidValue("Activation has no base to apply deltas against")
        }
        let instructionCount = deltas.reduce(0) { $0 + $1.instructions.count }
        let insertedBytes = deltas.reduce(0) { partial, delta in
            partial + delta.instructions.reduce(0) { total, instruction in
                if case let .insert(bytes) = instruction { return total + bytes.count }
                return total
            }
        }
        guard deltas.count <= 10_000, instructionCount <= 100_000, insertedBytes <= 64 * 1024 * 1024 else {
            throw ArborWireValidationError.invalidValue("Object deltas exceed transport quotas")
        }
        let results = deltas.map(\.result)
        guard Set(results).count == results.count else {
            throw ArborWireValidationError.invalidValue("Duplicate object delta result")
        }
        let complete = Set(objects.map(\.hash))
        guard results.allSatisfy({ !complete.contains($0) }) else {
            throw ArborWireValidationError.invalidValue("Object delta result also supplied as complete object")
        }
    }

    /// A nil base is written as an explicit JSON null: activation is a request, not an omission.
    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(base, forKey: .base)
        try values.encode(candidate, forKey: .candidate)
        try values.encode(ifMatch, forKey: .ifMatch)
        try values.encodeIfPresent(onConflict, forKey: .onConflict)
        try values.encode(objects, forKey: .objects)
        try values.encode(deltas, forKey: .deltas)
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

/// The one payload shape for a transition between two roots: complete objects
/// plus deltas against objects reachable from the starting root.
public struct WireTransitionPayload: Codable, Sendable, Equatable {
    public var objects: [WireObjectEnvelope]
    public var deltas: [WireObjectDelta]

    public init(objects: [WireObjectEnvelope], deltas: [WireObjectDelta] = []) {
        self.objects = objects
        self.deltas = deltas
    }

    private enum CodingKeys: String, CodingKey { case objects, deltas }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        objects = try values.decode([WireObjectEnvelope].self, forKey: .objects)
        deltas = try values.decode([WireObjectDelta].self, forKey: .deltas)
        _ = try validated()
    }

    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(objects, forKey: .objects)
        try values.encode(deltas, forKey: .deltas)
    }

    public func validated() throws -> Self {
        var results = Set<String>()
        for envelope in objects {
            try validateObjectHash(envelope.hash)
            guard WireObjectCodec.hash(envelope.bytes) == envelope.hash else {
                throw ArborWireValidationError.objectHashMismatch(expected: envelope.hash, actual: WireObjectCodec.hash(envelope.bytes))
            }
            guard results.insert(envelope.hash).inserted else { throw ArborWireValidationError.invalidValue("Duplicate transition result") }
        }
        for delta in deltas {
            _ = try delta.validated()
            guard results.insert(delta.result).inserted else {
                throw ArborWireValidationError.invalidValue("Transition result supplied more than once")
            }
        }
        return self
    }
}

/// The transition from the candidate root to the draft root a conflict leaves the client with.
public struct WireConflictDraft: Codable, Sendable, Equatable {
    public var root: String
    public var objects: [WireObjectEnvelope]
    public var deltas: [WireObjectDelta]

    public init(root: String, objects: [WireObjectEnvelope] = [], deltas: [WireObjectDelta] = []) {
        self.root = root
        self.objects = objects
        self.deltas = deltas
    }

    private enum CodingKeys: String, CodingKey { case root, objects, deltas }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        root = try values.decode(String.self, forKey: .root)
        objects = try values.decode([WireObjectEnvelope].self, forKey: .objects)
        deltas = try values.decode([WireObjectDelta].self, forKey: .deltas)
    }

    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(root, forKey: .root)
        try values.encode(objects, forKey: .objects)
        try values.encode(deltas, forKey: .deltas)
    }

    public var payload: WireTransitionPayload { WireTransitionPayload(objects: objects, deltas: deltas) }
}

public struct WireConflictDetails: Codable, Sendable, Equatable {
    public var kind: String
    public var current: WireAcceptedUpdate
    public var base: String
    public var candidate: String
    public var draft: WireConflictDraft
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
    public var draft: WireConflictDraft { details.draft }
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
        draft: WireConflictDraft,
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
        try validateObjectHash(details.draft.root)
        _ = try details.draft.payload.validated()
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
    /// The transition from the candidate root to the accepted root, present whenever they differ.
    public var reconciliation: WireTransitionPayload?
    public var observedThrough: String

    private enum CodingKeys: String, CodingKey { case requestDigest, reconciliation, observedThrough }

    public init(result: WireUpdateResult, requestDigest: String, reconciliation: WireTransitionPayload? = nil, observedThrough: String) {
        self.result = result
        self.requestDigest = requestDigest
        self.reconciliation = reconciliation
        self.observedThrough = observedThrough
    }

    public init(from decoder: Decoder) throws {
        result = try WireUpdateResult(from: decoder)
        let values = try decoder.container(keyedBy: CodingKeys.self)
        requestDigest = try values.decode(String.self, forKey: .requestDigest)
        try validateObjectHash(requestDigest)
        observedThrough = try values.decode(String.self, forKey: .observedThrough)
        guard !observedThrough.isEmpty else { throw ArborWireValidationError.invalidValue("Missing observation boundary") }
        reconciliation = try values.decodeIfPresent(WireTransitionPayload.self, forKey: .reconciliation)
    }
}

extension WireUpdateResult: Decodable {
    private enum CodingKeys: String, CodingKey { case outcome, update }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        let update = try values.decode(WireAcceptedUpdate.self, forKey: .update).validated()
        switch try values.decode(String.self, forKey: .outcome) {
        case "current": self = .current(update)
        case "accepted": self = .accepted(update)
        case "merged":
            guard let merge = update.merge else {
                throw DecodingError.dataCorruptedError(forKey: .update, in: values, debugDescription: "Merged update carries no merge summary")
            }
            self = .merged(update, merge)
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

public struct WireAccountChallenge: Codable, Sendable, Equatable {
    public var version: Int
    public var id: String
    public var origin: String
    public var account: String
    public var profileTree: String
    public var configurationTree: String
    public var nonce: String
    public var issuedAt: Int
    public var expiresAt: Int

    public func validated() throws -> Self {
        guard version == 1, !id.isEmpty, !origin.isEmpty, !account.isEmpty,
              !profileTree.isEmpty, !configurationTree.isEmpty, !nonce.isEmpty,
              expiresAt > issuedAt else {
            throw ArborWireValidationError.invalidValue("Malformed account challenge")
        }
        return self
    }
}

public struct WireExistingProfileClaimRequest: Codable, Sendable, Equatable {
    public var account: String
    public var profileTree: String
    public var configurationTree: String
    public var challenge: WireAccountChallenge
    public var publicKey: String
    public var signature: String
    public var device: WirePairingDevice
    public var configuration: WireSnapshot

    public init(
        account: String,
        profileTree: String,
        configurationTree: String,
        challenge: WireAccountChallenge,
        publicKey: String,
        signature: String,
        device: WirePairingDevice,
        configuration: WireSnapshot
    ) {
        self.account = account
        self.profileTree = profileTree
        self.configurationTree = configurationTree
        self.challenge = challenge
        self.publicKey = publicKey
        self.signature = signature
        self.device = device
        self.configuration = configuration
    }
}

public struct WireAccountClaimResult: Codable, Sendable, Equatable {
    public var account: WireAccountDescriptor
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
