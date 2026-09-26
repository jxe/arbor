import Foundation

/// An operation a rule allows. `admin` names a tree's administrators; it is
/// valid only in a tree configuration's `access.yaml` and implies every other
/// operation.
public enum ProtocolResourceOperation: String, Codable, Sendable, CaseIterable {
    case read, write, createChild = "create-child", updateContent = "update-content"
    case updateProperties = "update-properties", delete, admin
}

/// Who a rule names. `me` and `members` name the profile whose `apps.yaml`
/// holds the rule (`me` for a person, `members` for a group) and are invalid
/// in `access.yaml`.
public enum ProtocolResourceWho: Hashable, Sendable, Codable {
    case everyone, me, members, profile(String), link(String)

    public init(from decoder: Decoder) throws {
        let single = try decoder.singleValueContainer()
        if let value = try? single.decode(String.self) {
            switch value {
            case "everyone": self = .everyone
            case "me": self = .me
            case "members": self = .members
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
        case .members: try value.encode("members")
        case .profile(let id): try value.encode(["profile": id])
        case .link(let hash): try value.encode(["link": hash])
        }
    }
}

public enum ResourcePolicyError: Error { case invalid }
func validResourceTree(_ value: String) -> Bool {
    value.range(of: #"^tr_[a-z2-7]+$"#, options: .regularExpression) != nil
}
func validResourcePath(_ value: String) -> Bool {
    value.hasPrefix("/") && !value.contains("\\") && !value.contains("//")
        && (value == "/" || !value.hasSuffix("/"))
        && !value.split(separator: "/").contains(where: { $0 == "." || $0 == ".." })
        && !value.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 })
}
private struct ResourceKey: CodingKey {
    let stringValue: String
    var intValue: Int? { nil }
    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { return nil }
}

/// One `access.yaml` rule: `who` / `app` / `allow` / `within`. `admin` may be
/// granted only to a profile, in a rule with no `app` and no `within`.
public struct ProtocolResourceAccessRule: Codable, Sendable, Hashable {
    public let who: ProtocolResourceWho
    public let app: String?
    public let allow: [ProtocolResourceOperation]
    public let within: String?
    private enum CodingKeys: String, CodingKey { case who, app, allow, within }

    public init(who: ProtocolResourceWho, app: String? = nil, allow: [ProtocolResourceOperation], within: String? = nil) throws {
        guard !allow.isEmpty, Set(allow).count == allow.count,
              app.map(validResourceTree) ?? true else { throw ResourcePolicyError.invalid }
        switch who {
        case .profile(let id): guard validResourceTree(id) else { throw ResourcePolicyError.invalid }
        case .link(let digest): guard digest.range(of: #"^sha256:[a-f0-9]{64}$"#, options: .regularExpression) != nil else { throw ResourcePolicyError.invalid }
        case .me, .members: throw ResourcePolicyError.invalid
        case .everyone: break
        }
        if let within { guard validResourcePath(within) else { throw ResourcePolicyError.invalid } }
        if allow.contains(.admin) {
            guard case .profile = who, app == nil, within == nil else { throw ResourcePolicyError.invalid }
        }
        self.who = who; self.app = app; self.allow = allow; self.within = within
    }
    public init(from decoder: Decoder) throws {
        let all = try decoder.container(keyedBy: ResourceKey.self)
        guard all.allKeys.allSatisfy({ CodingKeys(rawValue: $0.stringValue) != nil }) else { throw ResourcePolicyError.invalid }
        let values = try decoder.container(keyedBy: CodingKeys.self)
        // Explicit null is not omission in the shared grammar.
        for key in [CodingKeys.app, .within] {
            if values.contains(key), try values.decodeNil(forKey: key) { throw ResourcePolicyError.invalid }
        }
        try self.init(who: values.decode(ProtocolResourceWho.self, forKey: .who),
                      app: values.decodeIfPresent(String.self, forKey: .app),
                      allow: values.decode([ProtocolResourceOperation].self, forKey: .allow),
                      within: values.decodeIfPresent(String.self, forKey: .within))
    }

    /// Whether this rule names the tree's administrators.
    public var isAdministrator: Bool { allow.contains(.admin) }
}

/// One `apps.yaml` rule: the access a profile lets one app use. `who`
/// defaults to the profile itself (`me` for a person, `members` for a group);
/// any other `who` lends the access to the app's other callers.
public struct ProtocolAppAccessRule: Codable, Sendable, Hashable {
    public let resource: String
    public let who: ProtocolResourceWho
    public let allow: [ProtocolResourceOperation]
    public let within: String?
    private enum CodingKeys: String, CodingKey { case resource, who, allow, within }

    public init(resource: String, who: ProtocolResourceWho, allow: [ProtocolResourceOperation], within: String? = nil) throws {
        guard validResourceTree(resource), !allow.isEmpty, Set(allow).count == allow.count, !allow.contains(.admin) else { throw ResourcePolicyError.invalid }
        if case .profile(let id) = who, !validResourceTree(id) { throw ResourcePolicyError.invalid }
        if let within { guard validResourcePath(within) else { throw ResourcePolicyError.invalid } }
        self.resource = resource; self.who = who; self.allow = allow; self.within = within
    }
    public init(from decoder: Decoder) throws {
        let all = try decoder.container(keyedBy: ResourceKey.self)
        guard all.allKeys.allSatisfy({ CodingKeys(rawValue: $0.stringValue) != nil }) else { throw ResourcePolicyError.invalid }
        let values = try decoder.container(keyedBy: CodingKeys.self)
        for key in [CodingKeys.who, .within] {
            if values.contains(key), try values.decodeNil(forKey: key) { throw ResourcePolicyError.invalid }
        }
        // The owner's own spelling is decided by the file; callers check `me` against a person's and `members` against a group's.
        try self.init(resource: values.decode(String.self, forKey: .resource),
                      who: values.decodeIfPresent(ProtocolResourceWho.self, forKey: .who) ?? .me,
                      allow: values.decode([ProtocolResourceOperation].self, forKey: .allow),
                      within: values.decodeIfPresent(String.self, forKey: .within))
    }
    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(resource, forKey: .resource)
        if who != .me && who != .members { try values.encode(who, forKey: .who) }
        try values.encode(allow, forKey: .allow)
        if let within, within != "/" { try values.encode(within, forKey: .within) }
    }
}

/// Administrative policy projection; a link is redacted rather than a usable digest.
public enum ProtocolSafeResourceWho: Hashable, Sendable, Codable {
    case everyone, me, members, profile(String), link
    public init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if let redacted = try? value.decode([String: Bool].self), redacted == ["link": true] { self = .link; return }
        switch try ProtocolResourceWho(from: decoder) {
        case .everyone: self = .everyone
        case .me: self = .me
        case .members: self = .members
        case .profile(let id): self = .profile(id)
        case .link: throw ResourcePolicyError.invalid
        }
    }
    public func encode(to encoder: Encoder) throws {
        switch self {
        case .everyone: try ProtocolResourceWho.everyone.encode(to: encoder)
        case .me: try ProtocolResourceWho.me.encode(to: encoder)
        case .members: try ProtocolResourceWho.members.encode(to: encoder)
        case .profile(let id): try ProtocolResourceWho.profile(id).encode(to: encoder)
        case .link:
            var value = encoder.singleValueContainer()
            try value.encode(["link": true])
        }
    }
}
public struct ProtocolSafeResourceAccessRule: Codable, Sendable, Hashable {
    public var who: ProtocolSafeResourceWho
    public var app: String?
    public var allow: [ProtocolResourceOperation]
    public var within: String?
}
public struct ProtocolTreeAccessSnapshot: Codable, Sendable {
    public var snapshot: [ProtocolAccessEntry]
    public var policy: [ProtocolSafeResourceAccessRule]?
    public var observedThrough: String
}
