import Foundation

public enum WireResourceOperation: String, Codable, Sendable, CaseIterable {
    case read, write, createChild = "create-child", updateContent = "update-content"
    case updateProperties = "update-properties", delete
}

public enum WireResourceWho: Hashable, Sendable, Codable {
    case everyone, me, profile(String), link(String)

    public init(from decoder: Decoder) throws {
        let single = try decoder.singleValueContainer()
        if let value = try? single.decode(String.self) {
            switch value {
            case "everyone": self = .everyone
            case "me": self = .me
            default: throw ResourcePolicyError.invalid
            }
            return
        }
        let value = try single.decode([String: String].self)
        guard value.count == 1 else { throw ResourcePolicyError.invalid }
        if let profile = value["profile"], validResourceTree(profile) { self = .profile(profile) }
        else if let link = value["link"], link.range(of: #"^sha256:[a-f0-9]{64}$"#, options: .regularExpression) != nil { self = .link(link) }
        else { throw ResourcePolicyError.invalid }
    }
    public func encode(to encoder: Encoder) throws {
        var value = encoder.singleValueContainer()
        switch self {
        case .everyone: try value.encode("everyone")
        case .me: try value.encode("me")
        case .profile(let id): try value.encode(["profile": id])
        case .link(let hash): try value.encode(["link": hash])
        }
    }
}

public enum ResourcePolicyError: Error { case invalid }
private func validResourceTree(_ value: String) -> Bool {
    value.range(of: #"^tr_[a-z2-7]+$"#, options: .regularExpression) != nil
}
private struct ResourceKey: CodingKey {
    let stringValue: String
    var intValue: Int? { nil }
    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { return nil }
}

public struct WireResourceAccessRule: Codable, Sendable, Hashable {
    public let who: WireResourceWho
    public let via: String?
    public let allow: [WireResourceOperation]
    public let within: String?
    private enum CodingKeys: String, CodingKey { case who, via, allow, within }

    public init(who: WireResourceWho, via: String? = nil, allow: [WireResourceOperation], within: String? = nil) throws {
        guard !allow.isEmpty, Set(allow).count == allow.count,
              via.map(validResourceTree) ?? true else { throw ResourcePolicyError.invalid }
        switch who {
        case .profile(let id): guard validResourceTree(id) else { throw ResourcePolicyError.invalid }
        case .link(let digest): guard digest.range(of: #"^sha256:[a-f0-9]{64}$"#, options: .regularExpression) != nil else { throw ResourcePolicyError.invalid }
        default: break
        }
        if let within {
            guard within.hasPrefix("/"), !within.contains("\\"), !within.contains("//"),
                  within == "/" || !within.hasSuffix("/"),
                  !within.split(separator: "/").contains(where: { $0 == "." || $0 == ".." }),
                  !within.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else { throw ResourcePolicyError.invalid }
        }
        self.who = who; self.via = via; self.allow = allow; self.within = within
    }
    public init(from decoder: Decoder) throws {
        let all = try decoder.container(keyedBy: ResourceKey.self)
        guard all.allKeys.allSatisfy({ CodingKeys(rawValue: $0.stringValue) != nil }) else { throw ResourcePolicyError.invalid }
        let values = try decoder.container(keyedBy: CodingKeys.self)
        // Explicit null is not omission in the shared grammar.
        for key in [CodingKeys.via, .within] {
            if values.contains(key), try values.decodeNil(forKey: key) { throw ResourcePolicyError.invalid }
        }
        try self.init(who: values.decode(WireResourceWho.self, forKey: .who),
                      via: values.decodeIfPresent(String.self, forKey: .via),
                      allow: values.decode([WireResourceOperation].self, forKey: .allow),
                      within: values.decodeIfPresent(String.self, forKey: .within))
    }
}

/// Administrative policy projection; a link is redacted rather than a usable digest.
public enum WireSafeResourceWho: Hashable, Sendable, Codable {
    case everyone, me, profile(String), link
    public init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if let redacted = try? value.decode([String: Bool].self), redacted == ["link": true] { self = .link; return }
        switch try WireResourceWho(from: decoder) {
        case .everyone: self = .everyone
        case .me: self = .me
        case .profile(let id): self = .profile(id)
        case .link: throw ResourcePolicyError.invalid
        }
    }
    public func encode(to encoder: Encoder) throws {
        switch self {
        case .everyone: try WireResourceWho.everyone.encode(to: encoder)
        case .me: try WireResourceWho.me.encode(to: encoder)
        case .profile(let id): try WireResourceWho.profile(id).encode(to: encoder)
        case .link:
            var value = encoder.singleValueContainer()
            try value.encode(["link": true])
        }
    }
}
public struct WireSafeResourceAccessRule: Codable, Sendable, Hashable {
    public var who: WireSafeResourceWho
    public var via: String?
    public var allow: [WireResourceOperation]
    public var within: String?
}
public struct WireTreeAccessSnapshot: Codable, Sendable {
    public var snapshot: [WireAccessEntry]
    public var policy: [WireSafeResourceAccessRule]?
    public var observedThrough: String
}
