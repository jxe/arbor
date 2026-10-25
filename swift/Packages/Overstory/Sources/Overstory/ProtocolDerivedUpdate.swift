import Foundation

/// A derived candidate (source intent §2.2): operations whose resulting roots
/// the host computes. Story sends collection row changes this way, because it
/// never encodes a collection's tables. Each frame states no roots; the first
/// executes on the request's base (or the preceding element's candidate) and
/// each later one on its predecessor's result.
public struct ProtocolDerivedUpdate: Sendable, Equatable {
    public var change: String
    public var frames: [[ProtocolSourceOperation]]
    public var resolves: [ProtocolResolutionDeclaration]
    public var ifCurrent: String?

    public init(change: String = UUID().uuidString, frames: [[ProtocolSourceOperation]],
                resolves: [ProtocolResolutionDeclaration] = [], ifCurrent: String? = nil) throws {
        self.change = change; self.frames = frames; self.resolves = resolves; self.ifCurrent = ifCurrent
        try ProtocolAuthoredRequestIntent.validateCandidate(semantic)
    }

    var semantic: [String: ProtocolSemanticValue] {
        var fields: [String: ProtocolSemanticValue] = [
            "change": .string(change), "candidate": .null,
            "trace": .array(frames.map { .object(["operations": .array($0.map { .object($0.fields) })]) }),
            "resolves": .array(resolves.map(\.semantic)),
        ]
        if let ifCurrent { fields["ifCurrent"] = .string(ifCurrent) }
        return fields
    }
}

/// A request string of derived elements on one accepted base.
public struct ProtocolDerivedUpdateRequest: Encodable, Sendable, Equatable {
    public var base: String
    public var updates: [ProtocolDerivedUpdate]
    public init(base: String, updates: [ProtocolDerivedUpdate]) { self.base = base; self.updates = updates }

    func authored() throws -> ProtocolAuthoredUpdateRequest {
        try ProtocolAuthoredUpdateRequest(base: base, updates: updates.map {
            try ProtocolAuthoredCandidate(intent: $0.semantic, payload: .init(objects: [], deltas: []))
        })
    }
    public func encode(to encoder: Encoder) throws { try authored().encode(to: encoder) }
}

public func derivedUpdateRequestDigests(tree: String, base: String, updates: [ProtocolDerivedUpdate]) -> [String] {
    updateRequestIdentities(tree: tree, base: base, elements: updates.map(\.semantic)).map(\.digest)
}

extension ProtocolClient {
    /// Fix a derived request's body; every retry sends these bytes. Its
    /// results carry the candidates the host derived.
    public func prepareDerivedUpdates(tree: String, base: ProtocolUpdateBase, updates: [ProtocolDerivedUpdate]) throws -> PreparedProtocolUpdate {
        guard !tree.isEmpty, !base.update.isEmpty, !updates.isEmpty else {
            throw ProtocolValidationError.invalidValue("Update string identity is empty")
        }
        let request = ProtocolDerivedUpdateRequest(base: base.update, updates: updates)
        return PreparedProtocolUpdate(
            tree: tree,
            body: try wireEncoding.encode(request.authored()),
            requestDigests: derivedUpdateRequestDigests(tree: tree, base: base.update, updates: updates),
            contentType: wireEncoding.storedContentType
        )
    }
}

/// A row operation's target (source intent §4.1): the collection directory as
/// basis material, the model and the row's canonical stable key.
public struct ProtocolRowTarget: Sendable, Equatable {
    public var path: String
    public var object: String
    public var model: String
    public var row: String
    public init(path: String, object: String, model: String, row: String) {
        self.path = path; self.object = object; self.model = model; self.row = row
    }
    var fields: [String: ProtocolSemanticValue] {
        ["collection": .object(["material": .object(["kind": .string("basis"), "path": .string(path), "object": .string(object)])]),
         "model": .string(model), "row": .string(row)]
    }
}

extension ProtocolSourceOperation {
    private static func row(_ key: String, _ kind: String, _ target: ProtocolRowTarget, at: Date?, _ extra: [String: ProtocolSemanticValue]) throws -> Self {
        var fields = target.fields.merging(extra) { $1 }
        fields["key"] = .string(key); fields["kind"] = .string(kind)
        if let at { fields["at"] = .string(rowTime(at)) }
        return try ProtocolSourceOperation(fields)
    }
    /// A row operation's time: UTC ISO 8601 with milliseconds.
    public static func rowTime(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        formatter.timeZone = TimeZone(identifier: "UTC")
        return formatter.string(from: date)
    }
    public static func rowCreate(key: String, _ target: ProtocolRowTarget, values: [String: ProtocolSemanticValue], at: Date? = nil) throws -> Self {
        try row(key, "rowCreate", target, at: at, ["values": .object(values)])
    }
    public static func rowDelete(key: String, _ target: ProtocolRowTarget) throws -> Self {
        try row(key, "rowDelete", target, at: nil, [:])
    }
    /// `before` is the value the author saw; `.null` means absent, and a `.null` value removes it.
    public static func rowSet(key: String, _ target: ProtocolRowTarget, field: String, before: ProtocolSemanticValue, value: ProtocolSemanticValue, at: Date? = nil) throws -> Self {
        try row(key, "rowSet", target, at: at, ["field": .string(field), "before": before, "value": value])
    }
    public static func rowConnect(key: String, _ target: ProtocolRowTarget, field: String, member: ProtocolSemanticValue, at: Date? = nil) throws -> Self {
        try row(key, "rowConnect", target, at: at, ["field": .string(field), "member": member])
    }
    public static func rowDisconnect(key: String, _ target: ProtocolRowTarget, field: String, member: ProtocolSemanticValue, at: Date? = nil) throws -> Self {
        try row(key, "rowDisconnect", target, at: at, ["field": .string(field), "member": member])
    }
    /// `after` is the member it follows, or `.null` for the first place.
    public static func rowMove(key: String, _ target: ProtocolRowTarget, field: String, member: ProtocolSemanticValue, after: ProtocolSemanticValue, at: Date? = nil) throws -> Self {
        try row(key, "rowMove", target, at: at, ["field": .string(field), "member": member, "after": after])
    }
}
