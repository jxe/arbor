import Foundation

public enum ProtocolValidationError: Error, Equatable, Sendable {
    case invalidValue(String)
    case invalidHash(String)
    case invalidCBOR(String)
    case objectHashMismatch(expected: String, actual: String)
    case incompleteGraph(String)
    case cyclicGraph(String)
    case unreachableObject(String)
    case malformedSSE(String)
}

public struct ProtocolCanonicalDescriptor: Codable, Sendable, Equatable {
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
private func canonicalHTTPURL(endpoint: String, path: String) -> String {
    guard let origin = endpointOrigin(endpoint) else { return endpoint + encodedCanonicalPath(path) }
    return "\(origin.scheme)://\(origin.authority)\(encodedCanonicalPath(path))"
}

/// The `arbor://` locator of a canonical tree, derived from its endpoint and decoded path.
private func canonicalArborLocator(endpoint: String, path: String) -> String {
    guard let origin = endpointOrigin(endpoint) else { return "arbor://" + encodedCanonicalPath(path) }
    return "arbor://\(origin.authority)\(encodedCanonicalPath(path))"
}

public struct ProtocolTreeDescriptor: Codable, Sendable, Equatable {
    public var conflicted: Bool
    public var id: String
    public var kind: String
    public var access: String
    public var canonical: ProtocolCanonicalDescriptor?
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
        canonical: ProtocolCanonicalDescriptor?,
        update: String,
        conflicted: Bool = false
    ) {
        self.id = id
        self.kind = kind
        self.access = access
        self.canonical = canonical
        self.root = root
        self.update = update
        self.conflicted = conflicted
    }

    private enum CodingKeys: String, CodingKey {
        case conflicted, id, kind, access, canonical, root, update
    }

    /// `conflicted` arrived after early placements were saved on disk; a
    /// descriptor stored without it is not conflicted. The host always sends it.
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        conflicted = try container.decodeIfPresent(Bool.self, forKey: .conflicted) ?? false
        id = try container.decode(String.self, forKey: .id)
        kind = try container.decode(String.self, forKey: .kind)
        access = try container.decode(String.self, forKey: .access)
        canonical = try container.decodeIfPresent(ProtocolCanonicalDescriptor.self, forKey: .canonical)
        root = try container.decode(String.self, forKey: .root)
        update = try container.decode(String.self, forKey: .update)
    }

    public func validated() throws -> Self {
        guard !id.isEmpty else { throw ProtocolValidationError.invalidValue("Tree ID is empty") }
        try validateObjectHash(root)
        guard ["ordinary", "tree-configuration"].contains(kind) else {
            throw ProtocolValidationError.invalidValue("Unknown tree kind")
        }
        guard ["none", "read", "write"].contains(access) else {
            throw ProtocolValidationError.invalidValue("Unknown access level")
        }
        if kind == "tree-configuration" {
            guard canonical == nil else { throw ProtocolValidationError.invalidValue("A tree configuration must be noncanonical") }
        } else if let canonical {
            // An ordinary tree mounted nowhere has no canonical descriptor.
            guard canonical.path.hasPrefix("/"), URL(string: canonical.endpoint) != nil else {
                throw ProtocolValidationError.invalidValue("Malformed canonical descriptor")
            }
        }
        return self
    }
}

/// `GET /.arbor/trees/{id}/entry-metadata`: file entries of the current root,
/// keyed by entry path (`/Trips/_index.md`), with the accepted update they
/// describe. Unknown fields inside an entry are ignored.
public struct ProtocolEntryMetadata: Decodable, Sendable, Equatable {
    public struct Entry: Decodable, Sendable, Equatable {
        /// Unix milliseconds of the accepted update that last wrote the entry.
        public var modifiedAt: Double?
        public init(modifiedAt: Double? = nil) { self.modifiedAt = modifiedAt }
    }
    public var update: String
    public var entries: [String: Entry]
    public init(update: String, entries: [String: Entry]) { self.update = update; self.entries = entries }
}

public struct ProtocolSnapshotEnvelope<Value: Codable & Sendable & Equatable>: Codable, Sendable, Equatable {
    public var snapshot: Value
    public var observedThrough: String

    public init(snapshot: Value, observedThrough: String) {
        self.snapshot = snapshot
        self.observedThrough = observedThrough
    }
}

public struct ProtocolAccountDescriptor: Codable, Sendable, Equatable {
    public struct Device: Codable, Sendable, Equatable {
        public var id: String
        public var label: String
    }

    public var id: String
    /// Optional Canopy-specific presentation hint; never account identity.
    public var handle: String?
    public var profileTree: String?
    public var profileURL: String?
    public var community: ProtocolTreeDescriptor
    public var configuration: ProtocolTreeDescriptor
    public var writableProfiles: [ProtocolTreeDescriptor]
    public var device: Device? = nil
}

public struct ProtocolAccountSnapshot: Codable, Sendable, Equatable {
    public var account: ProtocolAccountDescriptor
    public var observedThrough: String
}

public struct ProtocolResolvedNodeRef: Codable, Sendable, Equatable {
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

public struct ProtocolLocatorResolution: Codable, Sendable, Equatable {
    public var ref: ProtocolResolvedNodeRef
    public var enclosingTree: ProtocolTreeDescriptor
    public var historical: Bool
    public var observedThrough: String
}

public struct ProtocolAcceptedLink: Codable, Sendable, Equatable {
    public var id: String
    public var root: String
    public init(id: String, root: String) { self.id = id; self.root = root }
}

public struct ProtocolAcceptedUpdate: Codable, Sendable, Equatable {
    public var id: String
    public var tree: String
    public var root: String
    public var previous: ProtocolAcceptedLink?
    public var acceptedAt: Double
    public var subject: String?
    public var conflicted: Bool
    public init(id: String, tree: String, root: String, previous: ProtocolAcceptedLink? = nil,
                acceptedAt: Double, subject: String? = nil, conflicted: Bool = false) {
        self.id=id; self.tree=tree; self.root=root; self.previous=previous
        self.acceptedAt=acceptedAt; self.subject=subject; self.conflicted=conflicted
    }
    private enum CodingKeys: String, CodingKey { case id, tree, root, previous, acceptedAt, subject, conflicted }
    public init(from decoder: Decoder) throws {
        let c=try decoder.container(keyedBy:CodingKeys.self)
        // `previous` and `subject` are required even when null.
        guard c.contains(.previous), c.contains(.subject) else { throw ProtocolValidationError.invalidValue("Invalid accepted-state contract") }
        id=try c.decode(String.self,forKey:.id); tree=try c.decode(String.self,forKey:.tree); root=try c.decode(String.self,forKey:.root)
        previous=try c.decodeIfPresent(ProtocolAcceptedLink.self,forKey:.previous)
        acceptedAt=try c.decode(Double.self,forKey:.acceptedAt)
        subject=try c.decodeIfPresent(String.self,forKey:.subject)
        conflicted=try c.decode(Bool.self,forKey:.conflicted)
        _ = try validated()
    }
    public func encode(to encoder: Encoder) throws {
        var c=encoder.container(keyedBy:CodingKeys.self)
        try c.encode(id,forKey:.id); try c.encode(tree,forKey:.tree); try c.encode(root,forKey:.root)
        try c.encode(previous,forKey:.previous); try c.encode(acceptedAt,forKey:.acceptedAt)
        try c.encode(subject,forKey:.subject); try c.encode(conflicted,forKey:.conflicted)
    }
    /// `updates` extend `previous` one by one and end at `head`; identities
    /// compare by UTF-8 bytes and none repeats.
    public static func validateChain(tree: String, previous: ProtocolAcceptedLink?, updates: [ProtocolAcceptedUpdate], head: ProtocolAcceptedLink) throws {
        var prior = previous
        var seen = Set<Data>()
        if let previous { seen.insert(Data(previous.id.utf8)) }
        try AcceptedReadValidation.check(!updates.isEmpty)
        for update in updates {
            try AcceptedReadValidation.check(update.tree.utf8.elementsEqual(tree.utf8) && seen.insert(Data(update.id.utf8)).inserted)
            if let prior {
                try AcceptedReadValidation.check(update.previous?.id.utf8.elementsEqual(prior.id.utf8) == true && update.previous?.root == prior.root)
            } else {
                try AcceptedReadValidation.check(update.previous == nil)
            }
            prior = ProtocolAcceptedLink(id: update.id, root: update.root)
        }
        try AcceptedReadValidation.check(prior?.id.utf8.elementsEqual(head.id.utf8) == true && prior?.root == head.root)
    }

    public func validated() throws -> Self {
        try AcceptedReadValidation.state([
            "id": .string(id), "tree": .string(tree), "root": .string(root),
            "previous": previous.map { .object(["id": .string($0.id), "root": .string($0.root)]) } ?? .null,
            "acceptedAt": .number(acceptedAt), "subject": subject.map(ProtocolReadValue.string) ?? .null,
            "conflicted": .bool(conflicted),
        ])
        return self
    }
}

public struct ProtocolObjectEnvelope: Codable, Sendable, Equatable {
    public var hash: String
    public var bytes: Data

    public init(hash: String, bytes: Data) {
        self.hash = hash
        self.bytes = bytes
    }

    private enum CodingKeys: String, CodingKey { case hash, bytes }

    /// Object bytes are a CBOR byte string, or in JSON standard padded base64
    /// with nothing to normalize (tree operations §4.4).
    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        hash = try values.decode(String.self, forKey: .hash)
        bytes = try decodeProtocolBytes(values, forKey: .bytes, from: decoder, invalid: "Noncanonical object base64")
    }
}

public struct ProtocolSnapshot: Codable, Sendable, Equatable {
    public var root: String
    public var objects: [ProtocolObjectEnvelope]

    public init(root: String, objects: [ProtocolObjectEnvelope]) {
        self.root = root
        self.objects = objects
    }
}

/// The tree resource: its current descriptor and the cursor to watch after.
public struct ProtocolCurrentTree: Codable, Sendable, Equatable {
    public var tree: ProtocolTreeDescriptor
    public var observedThrough: String

    public init(tree: ProtocolTreeDescriptor, observedThrough: String) {
        self.tree = tree
        self.observedThrough = observedThrough
    }

    public func validated(expectedTree: String? = nil) throws -> Self {
        let tree = try tree.validated()
        guard !tree.update.isEmpty, !observedThrough.isEmpty, expectedTree == nil || tree.id == expectedTree else {
            throw ProtocolValidationError.invalidValue("Tree descriptor does not match its tree")
        }
        return self
    }
}

public struct ProtocolUpdateBase: Codable, Sendable, Equatable {
    public var root: String
    public var update: String

    public init(root: String, update: String) {
        self.root = root
        self.update = update
    }
}

public enum ProtocolObjectDeltaInstruction: Sendable, Equatable, Codable {
    case copy(offset: Int, length: Int)
    case insert(Data)

    static let maxSafeInteger = 9_007_199_254_740_991

    private enum CodingKeys: String, CodingKey { case copy, insert }
    private enum CopyKeys: String, CodingKey { case offset, length }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        guard values.contains(.copy) != values.contains(.insert) else {
            throw ProtocolValidationError.invalidValue("Object delta instruction requires exactly one operation")
        }
        if values.contains(.copy) {
            let copy = try values.nestedContainer(keyedBy: CopyKeys.self, forKey: .copy)
            let offset = try copy.decode(Int.self, forKey: .offset)
            let length = try copy.decode(Int.self, forKey: .length)
            guard Self.validCopy(offset: offset, length: length) else {
                throw ProtocolValidationError.invalidValue("Invalid object delta copy")
            }
            self = .copy(offset: offset, length: length)
        } else {
            let bytes = try decodeProtocolBytes(values, forKey: .insert, from: decoder, invalid: "Invalid object delta insert")
            guard !bytes.isEmpty else { throw ProtocolValidationError.invalidValue("Invalid object delta insert") }
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
            // Padded base64 in JSON (JSONEncoder's default for `Data`), a byte string in CBOR.
            try values.encode(bytes, forKey: .insert)
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
public struct ProtocolObjectDelta: Codable, Sendable, Equatable {
    public var base: String
    public var result: String
    public var instructions: [ProtocolObjectDeltaInstruction]

    public init(base: String, result: String, instructions: [ProtocolObjectDeltaInstruction]) {
        self.base = base
        self.result = result
        self.instructions = instructions
    }

    public func validated() throws -> Self {
        try validateObjectHash(base)
        try validateObjectHash(result)
        guard !instructions.isEmpty else { throw ProtocolValidationError.invalidValue("Object delta instructions are empty") }
        for instruction in instructions {
            switch instruction {
            case let .copy(offset, length):
                guard ProtocolObjectDeltaInstruction.validCopy(offset: offset, length: length) else {
                    throw ProtocolValidationError.invalidValue("Invalid object delta copy")
                }
            case let .insert(bytes):
                guard !bytes.isEmpty else { throw ProtocolValidationError.invalidValue("Object delta insert is empty") }
            }
        }
        return self
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        base = try values.decode(String.self, forKey: .base)
        result = try values.decode(String.self, forKey: .result)
        instructions = try values.decode([ProtocolObjectDeltaInstruction].self, forKey: .instructions)
        _ = try validated()
    }

    /// Reconstruct the canonical bytes of `result` from the canonical bytes of `base`.
    public func apply(to baseBytes: Data) throws -> Data {
        var output = Data()
        for instruction in instructions {
            switch instruction {
            case let .copy(offset, length):
                guard offset <= baseBytes.count, length <= baseBytes.count - offset else {
                    throw ProtocolValidationError.invalidValue("Object delta copy is out of bounds")
                }
                let start = baseBytes.startIndex + offset
                output.append(baseBytes[start ..< start + length])
            case let .insert(bytes):
                output.append(bytes)
            }
            guard output.count <= 1_000_000_000 else {
                throw ProtocolValidationError.invalidValue("Object delta result exceeds the storage quota")
            }
        }
        let actual = ProtocolObjectCodec.hash(output)
        guard actual == result else {
            throw ProtocolValidationError.objectHashMismatch(expected: result, actual: actual)
        }
        return output
    }
}

public struct ProtocolAcceptedTransition: Codable, Sendable, Equatable {
    public var from: ProtocolAcceptedLink?
    public var transportBasis: ProtocolAcceptedLink? { from ?? update.previous }
    public var update: ProtocolAcceptedUpdate
    public var objects: [ProtocolObjectEnvelope]
    public var deltas: [ProtocolObjectDelta]
    public var requestDigest: String?

    public init(
        update: ProtocolAcceptedUpdate,
        objects: [ProtocolObjectEnvelope],
        deltas: [ProtocolObjectDelta] = [],
        requestDigest: String? = nil,
        from: ProtocolAcceptedLink? = nil
    ) {
        self.from = from
        self.update = update
        self.objects = objects
        self.deltas = deltas
        self.requestDigest = requestDigest
    }

    private enum CodingKeys: String, CodingKey { case update, objects, deltas, requestDigest, from }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        if values.contains(.from) { from = try values.decode(ProtocolAcceptedLink.self, forKey: .from) }
        else { from = nil }
        update = try values.decode(ProtocolAcceptedUpdate.self, forKey: .update)
        let payload = try ProtocolTransitionPayload(from: decoder)
        objects = payload.objects
        deltas = payload.deltas
        requestDigest = try values.decodeIfPresent(String.self, forKey: .requestDigest)
        // Decoding `update` already validated it against the accepted-state contract.
        try validateTransition()
    }

    public func validated() throws -> Self {
        _ = try update.validated()
        try validateTransition()
        return self
    }

    private func validateTransition() throws {
        guard update.previous != nil else {
            throw ProtocolValidationError.invalidValue("Initial accepted update cannot be replayed as a transition")
        }
        if let from {
            try validateObjectHash(from.root)
            guard !from.id.isEmpty, from.id.utf8.count <= 1024,
                  !from.id.utf8.elementsEqual(update.id.utf8) else {
                throw ProtocolValidationError.invalidValue("Invalid transition basis")
            }
        }
        if let requestDigest { try validateObjectHash(requestDigest) }
        _ = try ProtocolTransitionPayload(objects: objects, deltas: deltas).validated()
    }
}

public struct ProtocolResolutionDeclaration: Codable, Sendable, Equatable {
    public var state: String
    public var conflict: String
    public var alternatives: [String]
    public init(state: String, conflict: String, alternatives: [String]) {
        self.state = state; self.conflict = conflict; self.alternatives = alternatives
    }
    var semantic: ProtocolSemanticValue {
        .object(["state": .string(state), "conflict": .string(conflict), "alternatives": .array(alternatives.map(ProtocolSemanticValue.string))])
    }
}

/// One tree-root to tree-root step of a change's authored evidence. Basis
/// references inside a frame name objects in that frame's `before` tree, and
/// operation references name an earlier key in the same change.
public struct ProtocolTraceFrame: Sendable, Equatable {
    public var before: String
    public var after: String
    public var operations: [ProtocolSourceOperation]
    public init(before: String, after: String, operations: [ProtocolSourceOperation]) {
        self.before = before; self.after = after; self.operations = operations
    }
    var semantic: ProtocolSemanticValue {
        .object(["before": .string(before), "after": .string(after),
                 "operations": .array(operations.map { .object($0.fields) })])
    }
    init(_ raw: ProtocolSemanticValue) throws {
        guard let f = raw.fields, let before = f["before"]?.text, let after = f["after"]?.text,
              let ops = f["operations"]?.items else {
            throw ProtocolValidationError.invalidValue("Expected trace frame")
        }
        self.init(before: before, after: after, operations: try ops.map { try ProtocolSourceOperation(ProtocolSemanticValue.fields($0)) })
    }
}

public struct ProtocolCandidateUpdate: Codable, Sendable, Equatable {
    public var change: String
    /// `nil` is a snapshot: exact bytes with no authored evidence. A trace is
    /// evidence the authority checks, never a hint it may skip.
    public var trace: [ProtocolTraceFrame]?
    public var candidate: String
    public var resolves: [ProtocolResolutionDeclaration]
    public var ifCurrent: String?
    public var objects: [ProtocolObjectEnvelope]
    public var deltas: [ProtocolObjectDelta]

    public init(candidate: String, change: String = UUID().uuidString, trace: [ProtocolTraceFrame]? = nil,
                resolves: [ProtocolResolutionDeclaration] = [], ifCurrent: String? = nil,
                objects: [ProtocolObjectEnvelope], deltas: [ProtocolObjectDelta] = []) {
        self.candidate = candidate; self.change = change; self.trace = trace
        self.resolves = resolves; self.ifCurrent = ifCurrent; self.objects = objects; self.deltas = deltas
    }
    var semantic: [String: ProtocolSemanticValue] {
        var fields: [String: ProtocolSemanticValue] = ["change": .string(change), "candidate": .string(candidate),
            "trace": trace.map { .array($0.map(\.semantic)) } ?? .null,
            "resolves": .array(resolves.map(\.semantic))]
        if let ifCurrent { fields["ifCurrent"] = .string(ifCurrent) }
        return fields
    }
    func authored() throws -> ProtocolAuthoredCandidate {
        try ProtocolAuthoredCandidate(intent: semantic, payload: .init(objects: objects, deltas: deltas))
    }
    init(_ decoded: ProtocolAuthoredCandidate) throws {
        let fields = decoded.intentFields
        typealias Value = ProtocolSemanticValue
        guard let trace = fields["trace"] else { throw ProtocolValidationError.invalidValue("Missing trace") }
        self.init(candidate: try Value.text(fields["candidate"]), change: try Value.text(fields["change"]),
            trace: try trace.items.map { try $0.map(ProtocolTraceFrame.init) },
            resolves: try Value.items(fields["resolves"]).map { raw in
                let r = try Value.fields(raw)
                return ProtocolResolutionDeclaration(state: try Value.text(r["state"]), conflict: try Value.text(r["conflict"]),
                    alternatives: try Value.items(r["alternatives"]).map(Value.text))
            }, ifCurrent: fields["ifCurrent"]?.text, objects: decoded.payload.objects, deltas: decoded.payload.deltas)
    }
    public init(from decoder: Decoder) throws { try self.init(ProtocolAuthoredCandidate(from: decoder)) }
    public func encode(to encoder: Encoder) throws { try authored().encode(to: encoder) }

    /// The activation element of a tree's first snapshot: snapshot semantics,
    /// no resolutions, every object complete and no deltas. A claim carries
    /// its configuration in this shape (accounts §1.2).
    public static func activation(_ snapshot: ProtocolSnapshot, change: String) -> ProtocolCandidateUpdate {
        ProtocolCandidateUpdate(candidate: snapshot.root, change: change, objects: snapshot.objects)
    }
}

public struct ProtocolUpdateRequest: Codable, Sendable, Equatable {
    public var base: String?
    public var updates: [ProtocolCandidateUpdate]
    public init(base: String?, updates: [ProtocolCandidateUpdate]) { self.base = base; self.updates = updates }
    public init(base: String?, candidate: String, ifCurrent: String? = nil,
                objects: [ProtocolObjectEnvelope], deltas: [ProtocolObjectDelta] = []) {
        self.init(base: base, updates: [ProtocolCandidateUpdate(candidate: candidate, ifCurrent: ifCurrent, objects: objects, deltas: deltas)])
    }
    public init(base: ProtocolUpdateBase, candidate: String, ifCurrent: String? = nil,
                objects: [ProtocolObjectEnvelope], deltas: [ProtocolObjectDelta] = []) {
        self.init(base: base.update, candidate: candidate, ifCurrent: ifCurrent, objects: objects, deltas: deltas)
    }
    public var candidate: String { updates[0].candidate }
    public var ifCurrent: String? { updates[0].ifCurrent }
    public var objects: [ProtocolObjectEnvelope] { updates[0].objects }
    public var deltas: [ProtocolObjectDelta] { updates[0].deltas }
    public init(from decoder: Decoder) throws {
        let request = try ProtocolAuthoredUpdateRequest(from: decoder)
        self.init(base: request.base, updates: try request.updates.map(ProtocolCandidateUpdate.init))
    }
    public func encode(to encoder: Encoder) throws {
        try ProtocolAuthoredUpdateRequest(base: base, updates: updates.map { try $0.authored() }).encode(to: encoder)
    }
}

public struct PreparedProtocolUpdate: Sendable, Equatable {
    public var tree: String
    public var body: Data
    public var requestDigests: [String]
    /// The body's encoding as stored: `application/cbor`, or nil for JSON
    /// (tree operations §4.4). A body keeps its encoding across every retry.
    public var contentType: String?
    public var requestDigest: String { requestDigests[0] }
    public var encoding: ProtocolWireEncoding { ProtocolWireEncoding(contentType: contentType) }

    public init(tree: String, body: Data, requestDigest: String, contentType: String? = nil) {
        self.init(tree: tree, body: body, requestDigests: [requestDigest], contentType: contentType)
    }

    public init(tree: String, body: Data, requestDigests: [String], contentType: String? = nil) {
        self.tree = tree
        self.body = body
        self.requestDigests = requestDigests
        self.contentType = contentType
    }

    /// The request the body carries, read in its own encoding.
    public func decodedRequest() throws -> ProtocolUpdateRequest {
        try encoding.decode(ProtocolUpdateRequest.self, from: body)
    }
}

public struct ProtocolConflictReason: Codable, Sendable, Equatable {
    public var path: String
    public var reason: String

    public init(path: String, reason: String) { self.path = path; self.reason = reason }
}

/// The one payload shape for a transition between two roots: complete objects
/// plus deltas against objects reachable from the starting root.
public struct ProtocolTransitionPayload: Codable, Sendable, Equatable {
    public var objects: [ProtocolObjectEnvelope]
    public var deltas: [ProtocolObjectDelta]

    public init(objects: [ProtocolObjectEnvelope], deltas: [ProtocolObjectDelta] = []) {
        self.objects = objects
        self.deltas = deltas
    }

    private enum CodingKeys: String, CodingKey { case objects, deltas }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        objects = try values.decode([ProtocolObjectEnvelope].self, forKey: .objects)
        deltas = try values.decode([ProtocolObjectDelta].self, forKey: .deltas)
        _ = try validated()
    }

    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(objects, forKey: .objects)
        try values.encode(deltas, forKey: .deltas)
    }

    public func validated() throws -> Self {
        var instructions = 0, inserted = 0
        for delta in deltas {
            instructions += delta.instructions.count
            for instruction in delta.instructions { if case .insert(let bytes) = instruction { inserted += bytes.count } }
        }
        guard deltas.count <= 10_000, instructions <= 100_000, inserted <= 64 * 1024 * 1024 else {
            throw ProtocolValidationError.invalidValue("Transition deltas exceed their limits")
        }
        var results = Set<String>()
        for envelope in objects {
            try validateObjectHash(envelope.hash)
            guard ProtocolObjectCodec.hash(envelope.bytes) == envelope.hash else {
                throw ProtocolValidationError.objectHashMismatch(expected: envelope.hash, actual: ProtocolObjectCodec.hash(envelope.bytes))
            }
            guard results.insert(envelope.hash).inserted else { throw ProtocolValidationError.invalidValue("Duplicate transition result") }
        }
        for delta in deltas {
            _ = try delta.validated()
            guard results.insert(delta.result).inserted else {
                throw ProtocolValidationError.invalidValue("Transition result supplied more than once")
            }
        }
        return self
    }
}

public struct ProtocolConflictDetails: Codable, Sendable, Equatable {
    public var kind: String
    public var completed: [ProtocolUpdateElementResult]
    public var failedIndex: Int
    public var current: ProtocolAcceptedUpdate
    public var conflicts: [ProtocolConflictReason]

    private enum CodingKeys: String, CodingKey {
        case kind, completed, failedIndex, current, conflicts
    }

    public init(
        kind: String,
        completed: [ProtocolUpdateElementResult],
        failedIndex: Int,
        current: ProtocolAcceptedUpdate,
        conflicts: [ProtocolConflictReason]
    ) {
        self.kind = kind
        self.completed = completed
        self.failedIndex = failedIndex
        self.current = current
        self.conflicts = conflicts
    }

}

public struct ProtocolUpdateConflict: Codable, Sendable, Equatable {
    public var error: String
    public var message: String
    public var retryable: Bool
    public var tree: String?
    public var details: ProtocolConflictDetails

    public var current: ProtocolAcceptedUpdate { details.current }
    public var conflicts: [ProtocolConflictReason] { details.conflicts }

    public init(
        error: String = "conflict",
        message: String,
        retryable: Bool = false,
        tree: String? = nil,
        kind: String = "server-update",
        completed: [ProtocolUpdateElementResult] = [],
        failedIndex: Int = 0,
        current: ProtocolAcceptedUpdate,
        conflicts: [ProtocolConflictReason]
    ) {
        self.error = error
        self.message = message
        self.retryable = retryable
        self.tree = tree
        self.details = ProtocolConflictDetails(
            kind: kind,
            completed: completed,
            failedIndex: failedIndex,
            current: current,
            conflicts: conflicts
        )
    }

    public func validated() throws -> Self {
        guard error == "conflict", !retryable else { throw ProtocolValidationError.invalidValue("Malformed conflict envelope") }
        guard ["server-update", "tree-configuration"].contains(details.kind) else {
            throw ProtocolValidationError.invalidValue("Unknown conflict detail kind")
        }
        _ = try details.current.validated()
        guard details.failedIndex == details.completed.count else {
            throw ProtocolValidationError.invalidValue("Conflict prefix does not match its failed index")
        }
        guard details.conflicts.allSatisfy({ $0.path.hasPrefix("/") && !$0.reason.isEmpty }) else {
            throw ProtocolValidationError.invalidValue("Malformed conflict reason")
        }
        return self
    }
}

public enum ProtocolUpdateResult: Sendable, Equatable {
    case unchanged(ProtocolAcceptedUpdate)
    case accepted(ProtocolAcceptedUpdate)
}

public struct ProtocolUpdateElementResult: Sendable, Equatable, Codable {
    public var result: ProtocolUpdateResult
    public var requestDigest: String
    /// The transition from the candidate root to the accepted root, present whenever they differ.
    public var reconciliation: ProtocolTransitionPayload?

    private enum CodingKeys: String, CodingKey { case requestDigest, reconciliation }

    public init(result: ProtocolUpdateResult, requestDigest: String, reconciliation: ProtocolTransitionPayload? = nil) {
        self.result = result
        self.requestDigest = requestDigest
        self.reconciliation = reconciliation
    }

    public init(from decoder: Decoder) throws {
        result = try ProtocolUpdateResult(from: decoder)
        let values = try decoder.container(keyedBy: CodingKeys.self)
        requestDigest = try values.decode(String.self, forKey: .requestDigest)
        try validateObjectHash(requestDigest)
        if values.contains(.reconciliation) {
            reconciliation = try values.decode(ProtocolTransitionPayload.self, forKey: .reconciliation)
        } else { reconciliation = nil }
    }

    public func encode(to encoder: Encoder) throws {
        try result.encode(to: encoder)
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(requestDigest, forKey: .requestDigest)
        try values.encodeIfPresent(reconciliation, forKey: .reconciliation)
    }
}

/// The server's current head as of an accepted update response.
public struct ProtocolUpdateHead: Sendable, Equatable, Codable {
    public var update: String
    public var root: String
    public var conflicted: Bool
    public var observedThrough: String
    public init(update: String, root: String, conflicted: Bool, observedThrough: String) {
        self.update = update; self.root = root; self.conflicted = conflicted; self.observedThrough = observedThrough
    }
}

public struct ProtocolUpdateResponse: Sendable, Equatable, Codable {
    public var results: [ProtocolUpdateElementResult]
    public var observedThrough: String
    /// Present when the server reported its head; lets the client skip a descriptor read.
    public var head: ProtocolUpdateHead?

    public var result: ProtocolUpdateResult { results[0].result }
    public var requestDigest: String { results[0].requestDigest }
    public var reconciliation: ProtocolTransitionPayload? { results[0].reconciliation }

    public init(result: ProtocolUpdateResult, requestDigest: String, reconciliation: ProtocolTransitionPayload? = nil, observedThrough: String) {
        self.results = [ProtocolUpdateElementResult(result: result, requestDigest: requestDigest, reconciliation: reconciliation)]
        self.observedThrough = observedThrough
    }

    public init(results: [ProtocolUpdateElementResult], observedThrough: String) {
        self.results = results
        self.observedThrough = observedThrough
    }

    private enum CodingKeys: String, CodingKey { case results, observedThrough, head }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        results = try values.decode([ProtocolUpdateElementResult].self, forKey: .results)
        guard !results.isEmpty else { throw ProtocolValidationError.invalidValue("Update response has no results") }
        observedThrough = try values.decode(String.self, forKey: .observedThrough)
        guard !observedThrough.isEmpty else { throw ProtocolValidationError.invalidValue("Missing observation boundary") }
        head = try values.decodeIfPresent(ProtocolUpdateHead.self, forKey: .head)
        if let head {
            guard !head.update.isEmpty, !head.observedThrough.isEmpty else { throw ProtocolValidationError.invalidValue("Invalid update head") }
            try validateObjectHash(head.root)
        }
    }

    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(results, forKey: .results)
        try values.encode(observedThrough, forKey: .observedThrough)
        try values.encodeIfPresent(head, forKey: .head)
    }
}

extension ProtocolUpdateResult: Codable {
    private enum CodingKeys: String, CodingKey { case outcome, update }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        let update = try values.decode(ProtocolAcceptedUpdate.self, forKey: .update)
        switch try values.decode(String.self, forKey: .outcome) {
        case "unchanged": self = .unchanged(update)
        case "accepted": self = .accepted(update)
        default:
            throw DecodingError.dataCorruptedError(forKey: .outcome, in: values, debugDescription: "Unknown server update outcome")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .unchanged(update):
            try values.encode("unchanged", forKey: .outcome)
            try values.encode(update, forKey: .update)
        case let .accepted(update):
            try values.encode("accepted", forKey: .outcome)
            try values.encode(update, forKey: .update)
        }
    }
}

public struct ProtocolDevice: Codable, Sendable, Equatable {
    public var id: String
    public var account: String
    public var label: String
    public var createdAt: Double
    public var lastUsedAt: Double?
    public var revokedAt: Double?

    public func validated() throws -> Self {
        guard !id.isEmpty, !account.isEmpty, !label.isEmpty, createdAt.isFinite,
              lastUsedAt?.isFinite != false, revokedAt?.isFinite != false else {
            throw ProtocolValidationError.invalidValue("Malformed device")
        }
        return self
    }
}

public struct ProtocolPairingOffer: Codable, Sendable, Equatable {
    public var id: String
    public var secret: String
    public var confirmationCode: String
    public var expiresAt: Double

    public func validated() throws -> Self {
        guard !id.isEmpty, !secret.isEmpty, !confirmationCode.isEmpty, expiresAt.isFinite else {
            throw ProtocolValidationError.invalidValue("Malformed pairing offer")
        }
        return self
    }
}

public struct ProtocolPairingClaim: Codable, Sendable, Equatable {
    public var device: ProtocolDevice
    public var confirmationCode: String

    public func validated() throws -> Self {
        guard !confirmationCode.isEmpty else {
            throw ProtocolValidationError.invalidValue("Missing pairing confirmation code")
        }
        _ = try device.validated()
        return self
    }
}

/// A device a claim or pairing adds: its DeviceID, label and public `key`
/// (accounts §5).
public struct ProtocolPairingDevice: Codable, Sendable, Equatable {
    public var id: String
    public var label: String
    public var key: String

    public init(id: String, label: String, key: ProtocolDeviceKey) {
        self.id = id
        self.label = label
        self.key = key.value
    }

    /// A well-formed device key.
    public func validated() throws -> Self {
        _ = try ProtocolDeviceKey(key)
        return self
    }
}

public struct ProtocolAccountChallenge: Codable, Sendable, Equatable {
    public var version: Int
    public var id: String
    public var origin: String
    public var account: String
    public var profileTree: String
    public var configurationTree: String
    public var nonce: String
    public var issuedAt: Int
    public var expiresAt: Int
    /// A placement claim's home host (accounts §1.3): the origin whose
    /// published device keys the placement host will trust for this profile.
    /// The profile key signs it with the rest of the challenge; a home
    /// claim's challenge has none, so neither stands in for the other.
    public var homeHost: String? = nil

    public func validated() throws -> Self {
        guard version == 1, !id.isEmpty, !origin.isEmpty, !account.isEmpty,
              !profileTree.isEmpty, !configurationTree.isEmpty, !nonce.isEmpty,
              expiresAt > issuedAt else {
            throw ProtocolValidationError.invalidValue("Malformed account challenge")
        }
        if let homeHost, !isHomeHostOrigin(homeHost) || homeHost == origin {
            throw ProtocolValidationError.invalidValue("Malformed account challenge")
        }
        return self
    }
}

/// Whether `value` is an origin a placement host may read device keys from
/// (accounts §1.3): exactly an HTTPS origin, or plain HTTP on a loopback
/// address for local hosts. Matches `isHomeHostOrigin` in `@overstory/protocol`.
public func isHomeHostOrigin(_ value: String) -> Bool {
    guard let url = URL(string: value), let origin = webOrigin(url), origin == value else { return false }
    switch url.scheme?.lowercased() {
    case "https": return true
    case "http": return ["127.0.0.1", "localhost", "::1", "[::1]"].contains(url.host()?.lowercased() ?? "")
    default: return false
    }
}

/// A profile's placement root on a placement host (accounts §1.3): the
/// ordinary tree the claim declares where the host allocates the account, as
/// the parent of the person's trees there.
public struct ProtocolPlacementRoot: Codable, Sendable, Equatable {
    public var id: String
    /// The canonical path the host mounts it at (canopyd: `/~handle`).
    public var path: String
    /// Its descriptor once its first snapshot activated it; nil until then.
    public var tree: ProtocolTreeDescriptor?

    public init(id: String, path: String, tree: ProtocolTreeDescriptor? = nil) {
        self.id = id
        self.path = path
        self.tree = tree
    }
}

/// The account descriptor a placement host returns (accounts §1.3). It has
/// no `configuration`: the profile's configuration lives only at `homeHost`.
public struct ProtocolPlacementAccountDescriptor: Codable, Sendable, Equatable {
    public var id: String
    /// Optional Canopy-specific presentation hint; never account identity.
    public var handle: String?
    public var profileTree: String?
    public var profileURL: String?
    public var community: ProtocolTreeDescriptor
    public var writableProfiles: [ProtocolTreeDescriptor]
    public var device: ProtocolAccountDescriptor.Device? = nil
    /// The origin of the profile's home host, whose device keys this host reads.
    public var homeHost: String
    public var placementRoot: ProtocolPlacementRoot

    public func validated() throws -> Self {
        _ = try community.validated()
        for profile in writableProfiles { _ = try profile.validated() }
        _ = try placementRoot.tree?.validated()
        guard !id.isEmpty, isHomeHostOrigin(homeHost), placementRoot.id.hasPrefix("tr_"), placementRoot.id.count > 3,
              placementRoot.path.hasPrefix("/"), placementRoot.tree.map({ $0.id == placementRoot.id }) != false else {
            throw ProtocolValidationError.invalidValue("Malformed placement account")
        }
        return self
    }
}

public struct ProtocolPlacementAccountSnapshot: Codable, Sendable, Equatable {
    public var account: ProtocolPlacementAccountDescriptor
    public var observedThrough: String
}

/// `GET /.arbor/account` as a host sends it: a home host's account, with its
/// configuration, or a placement host's (accounts §1.3), told apart by
/// `homeHost` as `isPlacementAccountDescriptor` does in TypeScript.
public enum ProtocolAnyAccountDescriptor: Codable, Sendable, Equatable {
    case home(ProtocolAccountDescriptor)
    case placement(ProtocolPlacementAccountDescriptor)

    private enum CodingKeys: String, CodingKey { case homeHost }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        if (try? values.decodeIfPresent(String.self, forKey: .homeHost)) != nil {
            self = .placement(try ProtocolPlacementAccountDescriptor(from: decoder))
        } else {
            self = .home(try ProtocolAccountDescriptor(from: decoder))
        }
    }

    public func encode(to encoder: Encoder) throws {
        switch self {
        case let .home(account): try account.encode(to: encoder)
        case let .placement(account): try account.encode(to: encoder)
        }
    }

    public var id: String {
        switch self {
        case let .home(account): account.id
        case let .placement(account): account.id
        }
    }

    public var profileTree: String? {
        switch self {
        case let .home(account): account.profileTree
        case let .placement(account): account.profileTree
        }
    }
}

public struct ProtocolAnyAccountSnapshot: Codable, Sendable, Equatable {
    public var account: ProtocolAnyAccountDescriptor
    public var observedThrough: String
}

/// A placement claim (accounts §1.3): the profile-key proof, with no device
/// and no configuration. Its challenge names `homeHost`.
public struct ProtocolPlacementClaimRequest: Codable, Sendable, Equatable {
    public var account: String
    public var profileTree: String
    public var configurationTree: String
    public var challenge: ProtocolAccountChallenge
    public var publicKey: String
    public var signature: String
    public var inviteCode: String?

    public init(
        account: String,
        profileTree: String,
        configurationTree: String,
        challenge: ProtocolAccountChallenge,
        publicKey: String,
        signature: String,
        inviteCode: String? = nil
    ) {
        self.account = account
        self.profileTree = profileTree
        self.configurationTree = configurationTree
        self.challenge = challenge
        self.publicKey = publicKey
        self.signature = signature
        self.inviteCode = inviteCode
    }
}

public struct ProtocolPlacementClaimResult: Codable, Sendable, Equatable {
    public var account: ProtocolPlacementAccountDescriptor
}

public struct ProtocolExistingProfileClaimRequest: Codable, Sendable, Equatable {
    public var account: String
    public var profileTree: String
    public var configurationTree: String
    public var challenge: ProtocolAccountChallenge
    public var publicKey: String
    public var signature: String
    public var inviteCode: String?
    public var device: ProtocolPairingDevice
    /// The configuration tree's activation element (accounts §1.2).
    public var configuration: ProtocolCandidateUpdate

    public init(
        account: String,
        profileTree: String,
        configurationTree: String,
        challenge: ProtocolAccountChallenge,
        publicKey: String,
        signature: String,
        inviteCode: String? = nil,
        device: ProtocolPairingDevice,
        configuration: ProtocolCandidateUpdate
    ) {
        self.account = account
        self.profileTree = profileTree
        self.configurationTree = configurationTree
        self.challenge = challenge
        self.publicKey = publicKey
        self.signature = signature
        self.inviteCode = inviteCode
        self.device = device
        self.configuration = configuration
    }
}

public struct ProtocolAccountClaimResult: Codable, Sendable, Equatable {
    public var account: ProtocolAccountDescriptor
    public var configuration: ProtocolTreeDescriptor
}

public enum ProtocolSafeAccessSubject: Codable, Sendable, Equatable {
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
        default: throw ProtocolValidationError.invalidValue("Unknown access subject")
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

public struct ProtocolAccessEntry: Codable, Sendable, Equatable {
    public var id: String
    public var subject: ProtocolSafeAccessSubject
    public var access: String
}

public struct ProtocolDirectoryAvatar: Codable, Sendable, Equatable, Hashable {
    public var tree: String
    public var path: String
    public var hash: String

    public init(tree: String, path: String, hash: String) {
        self.tree = tree
        self.path = path
        self.hash = hash
    }
}

public struct ProtocolProfileDirectoryEntry: Codable, Sendable, Equatable, Hashable, Identifiable {
    public var profile: String
    public var kind: String
    public var handle: String?
    public var locator: String?
    public var displayName: String?
    public var summary: String?
    public var avatar: ProtocolDirectoryAvatar?
    public var sources: [String]

    public var id: String { profile }

    private enum CodingKeys: String, CodingKey {
        case profile, kind, handle, locator, displayName, avatar, sources
        case summary = "description"
    }

    public init(profile: String, kind: String, handle: String? = nil, locator: String? = nil,
                displayName: String? = nil, summary: String? = nil,
                avatar: ProtocolDirectoryAvatar? = nil, sources: [String]) {
        self.profile = profile
        self.kind = kind
        self.handle = handle
        self.locator = locator
        self.displayName = displayName
        self.summary = summary
        self.avatar = avatar
        self.sources = sources
    }
}

public struct ProtocolUpdateConflictError: Error, Sendable, Equatable {
    public var conflict: ProtocolUpdateConflict

    public init(conflict: ProtocolUpdateConflict) { self.conflict = conflict }
}

public struct ProtocolHTTPError: Error, Sendable, Equatable {
    public var status: Int
    public var code: String
    public var message: String?
    public var retryable: Bool
    /// `details.homeHost`: the profile's home host, which a placement host
    /// names when it refuses a route that is the home host's (403
    /// `permission-denied`), or cannot refresh the profile's device keys from
    /// it (503, retryable) (accounts §1.3, §5.4).
    public var homeHost: String? = nil
    /// `details.challenge`: `expired` when a signed challenge outlived its
    /// window, and the client asks for a fresh one and signs again.
    public var challenge: String? = nil

    public init(status: Int, code: String, message: String?, retryable: Bool, homeHost: String? = nil, challenge: String? = nil) {
        self.status = status
        self.code = code
        self.message = message
        self.retryable = retryable
        self.homeHost = homeHost
        self.challenge = challenge
    }

    /// Whether the host refused a signed challenge as expired.
    public var isExpiredChallenge: Bool { challenge == "expired" }

    /// What to tell the person when a placement host refused because of its
    /// home host; nil for every other error.
    public var placementDescription: String? {
        guard let homeHost else { return nil }
        let url = URL(string: homeHost)
        let home = url?.host().map { host in url?.port.map { "\(host):\($0)" } ?? host } ?? homeHost
        if status == 403 {
            return "This account is a placement. Its devices and settings are managed at its home host, \(home)."
        }
        if status == 503 || retryable {
            return "This host can't reach the account's home host, \(home), to check this device. Try again in a minute."
        }
        return message.map { "\($0) (home host \(home))" }
    }
}

extension ProtocolValidationError: LocalizedError {
    /// An `invalidValue` carries a sentence for a person; the other cases
    /// name protocol faults and keep the system's description.
    public var errorDescription: String? {
        if case let .invalidValue(message) = self { return message }
        return nil
    }
}

extension ProtocolHTTPError: LocalizedError {
    public var errorDescription: String? { placementDescription ?? message }
}

func validateObjectHash(_ value: String) throws {
    guard value.range(of: #"^sha256:[a-f0-9]{64}$"#, options: .regularExpression) != nil else {
        throw ProtocolValidationError.invalidHash(value)
    }
}
