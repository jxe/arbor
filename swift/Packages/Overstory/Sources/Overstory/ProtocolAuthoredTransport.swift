import Foundation

/// Complete consolidated request used by the active protocol request model.
public struct ProtocolAuthoredUpdateRequest: Codable, Sendable, Equatable {
    public let base: String?
    public let updates: [ProtocolAuthoredCandidate]

    public init(base: String?, updates: [ProtocolAuthoredCandidate]) throws {
        self.base = base
        self.updates = updates
        _ = try intent()
        if base == nil, !updates[0].payload.deltas.isEmpty {
            throw ProtocolValidationError.invalidValue("Activation has no delta basis")
        }
    }
    public func intent() throws -> ProtocolAuthoredRequestIntent {
        try ProtocolAuthoredRequestIntent([
            "base": base.map(ProtocolSemanticValue.string) ?? .null,
            "updates": .array(updates.map { .object($0.intentFields) })
        ])
    }
    private enum CodingKeys: String, CodingKey { case base, updates }
    public init(from decoder: Decoder) throws {
        try validateSemanticFields(decoder, allowed: ["base", "updates"])
        let c = try decoder.container(keyedBy: CodingKeys.self)
        guard c.contains(.base) else { throw ProtocolValidationError.invalidValue("Missing base") }
        try self.init(base: c.decodeIfPresent(String.self, forKey: .base), updates: c.decode([ProtocolAuthoredCandidate].self, forKey: .updates))
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(base, forKey: .base)
        try c.encode(updates, forKey: .updates)
    }
}

public struct ProtocolAuthoredCandidate: Codable, Sendable, Equatable {
    public let intentFields: [String: ProtocolSemanticValue]
    public let payload: ProtocolTransitionPayload

    public init(intent: [String: ProtocolSemanticValue], payload: ProtocolTransitionPayload) throws {
        try ProtocolAuthoredRequestIntent.validateCandidate(intent)
        self.intentFields = intent
        self.payload = try payload.validated()
        var instructions = 0, inserted = 0
        for delta in payload.deltas {
            instructions += delta.instructions.count
            for instruction in delta.instructions {
                if case .insert(let bytes) = instruction { inserted += bytes.count }
            }
        }
        guard payload.deltas.count <= 10_000, instructions <= 100_000, inserted <= 64 * 1024 * 1024 else {
            throw ProtocolValidationError.invalidValue("Object deltas exceed transport quotas")
        }
    }
    private enum CodingKeys: String, CodingKey, CaseIterable {
        case change, at, candidate, trace, resolves, ifCurrent, objects, deltas
    }
    public init(from decoder: Decoder) throws {
        try validateSemanticFields(decoder, allowed: Set(CodingKeys.allCases.map(\.rawValue)))
        let c = try decoder.container(keyedBy: CodingKeys.self)
        var intent: [String: ProtocolSemanticValue] = [:]
        for key in [CodingKeys.change, .at, .candidate, .trace, .resolves, .ifCurrent] where c.contains(key) {
            intent[key.rawValue] = try c.decode(ProtocolSemanticValue.self, forKey: key)
        }
        // Objects travel as their bytes, read by the decoder's encoding: JSON's
        // base64 is validated as canonical before Foundation could normalize it.
        let payload = ProtocolTransitionPayload(objects: try ProtocolWirePayload.objects(c, forKey: .objects),
                                                deltas: try ProtocolWirePayload.deltas(c, forKey: .deltas))
        try self.init(intent: intent, payload: payload)
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        for (name, value) in intentFields { try c.encode(value, forKey: CodingKeys(rawValue: name)!) }
        try ProtocolWirePayload.encode(objects: payload.objects, deltas: payload.deltas, into: &c, objectsKey: .objects, deltasKey: .deltas)
    }
}
