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
        case change, candidate, trace, resolves, ifCurrent, objects, deltas
    }
    public init(from decoder: Decoder) throws {
        try validateSemanticFields(decoder, allowed: Set(CodingKeys.allCases.map(\.rawValue)))
        let c = try decoder.container(keyedBy: CodingKeys.self)
        var intent: [String: ProtocolSemanticValue] = [:]
        for key in [CodingKeys.change, .candidate, .trace, .resolves, .ifCurrent] where c.contains(key) {
            intent[key.rawValue] = try c.decode(ProtocolSemanticValue.self, forKey: key)
        }
        // Validate canonical base64 before Foundation's Data decoder can normalize it.
        let envelopes = try c.decode([EncodedEnvelope].self, forKey: .objects)
        let payload = ProtocolTransitionPayload(objects: envelopes.map(\.object), deltas: try c.decode([ProtocolObjectDelta].self, forKey: .deltas))
        try self.init(intent: intent, payload: payload)
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        for (name, value) in intentFields { try c.encode(value, forKey: CodingKeys(rawValue: name)!) }
        try c.encode(payload.objects, forKey: .objects)
        try c.encode(payload.deltas, forKey: .deltas)
    }
    private struct EncodedEnvelope: Decodable {
        let object: ProtocolObjectEnvelope
        private enum CodingKeys: String, CodingKey { case hash, bytes }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            let hash = try c.decode(String.self, forKey: .hash)
            let text = try c.decode(String.self, forKey: .bytes)
            guard let bytes = Data(base64Encoded: text), bytes.base64EncodedString() == text else {
                throw ProtocolValidationError.invalidValue("Object bytes must use canonical padded base64")
            }
            object = ProtocolObjectEnvelope(hash: hash, bytes: bytes)
        }
    }
}
