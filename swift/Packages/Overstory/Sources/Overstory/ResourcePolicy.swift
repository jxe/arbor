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
///
/// A profile subject names a profile this host holds by its TreeID, or a
/// profile another host holds by its canonical locator there
/// (`https://home.example/~crew`, `ProfileLocator`), which the host pins to
/// the TreeID it first resolved to (locators §1, access control §1).
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
        if let profile = value["profile"], let subject = validResourceProfile(profile) { self = .profile(subject) }
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

    /// A locator subject's locator, for a profile another host holds.
    public var profileLocator: ProfileLocator? {
        if case .profile(let id) = self { ProfileLocator(id) } else { nil }
    }
}

/// A profile named by its canonical locator at another host (locators §1):
/// `https://host/path`, `arbor://host/path`, or `http://` for a loopback
/// host. `locator` is its canonical spelling, the subject's merge key
/// (`arbor://` becomes the HTTP locator it resolves through, the host is
/// lowercase, and no port the scheme implies is written); `origin` is where
/// the profile is read. Nil for anything else, a TreeID included.
public struct ProfileLocator: Hashable, Sendable {
    public let locator: String
    public let origin: String

    public init?(_ value: String) {
        guard !value.hasPrefix("tr_"),
              value.range(of: #"/\.{1,2}(/|$)"#, options: .regularExpression) == nil,
              let components = URLComponents(string: value), let scheme = components.scheme?.lowercased(),
              components.user == nil, components.password == nil,
              components.percentEncodedQuery == nil, components.fragment == nil,
              var host = components.percentEncodedHost?.lowercased(), !host.isEmpty else { return nil }
        if host.contains(":") && !host.hasPrefix("[") { host = "[\(host)]" }
        guard !host.hasPrefix("tr_") else { return nil }
        let loopback = ["127.0.0.1", "localhost", "[::1]"].contains(host)
        let output: String
        switch scheme {
        case "https": output = "https"
        case "http" where loopback: output = "http"
        case "arbor": output = loopback ? "http" : "https"
        default: return nil
        }
        let implied = output == "https" ? 443 : 80
        let port = components.port.flatMap { $0 == implied ? nil : ":\($0)" } ?? ""
        var path = components.percentEncodedPath
        while path.hasSuffix("/") { path.removeLast() }
        guard !path.isEmpty, !path.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }),
              path.split(separator: "/", omittingEmptySubsequences: false).dropFirst().allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." })
        else { return nil }
        origin = "\(output)://\(host)\(port)"
        locator = origin + path
    }
}

/// A profile subject as written, validated: a TreeID, or a locator in its canonical spelling.
func validResourceProfile(_ value: String) -> String? {
    validResourceTree(value) ? value : ProfileLocator(value)?.locator
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
        case .profile(let id): guard validResourceProfile(id) == id else { throw ResourcePolicyError.invalid }
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
        if case .profile(let id) = who, validResourceProfile(id) != id { throw ResourcePolicyError.invalid }
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

public extension ProtocolResourceAccessRule {
    /// Whether two rules share the merge key `(who, app, within)`, a locator
    /// subject compared in its canonical spelling.
    func sameMergeKey(as other: ProtocolResourceAccessRule) -> Bool {
        who == other.who && app == other.app && (within ?? "/") == (other.within ?? "/")
    }
    /// One `access.yaml`'s rules: no two share a merge key.
    static func validateFile(_ rules: [ProtocolResourceAccessRule]) throws {
        for (index, rule) in rules.enumerated() where rules.prefix(index).contains(where: { $0.sameMergeKey(as: rule) }) {
            throw ResourcePolicyError.invalid
        }
    }
}

public extension ProtocolAppAccessRule {
    /// Whether two rules of one app share the merge key `(resource, who,
    /// within)`, a locator subject compared in its canonical spelling.
    func sameMergeKey(as other: ProtocolAppAccessRule) -> Bool {
        resource == other.resource && who == other.who && (within ?? "/") == (other.within ?? "/")
    }
    /// One `apps.yaml`'s rules by app: no two rules of an app share a merge key.
    static func validateFile(_ apps: [String: [ProtocolAppAccessRule]]) throws {
        for rules in apps.values {
            for (index, rule) in rules.enumerated() where rules.prefix(index).contains(where: { $0.sameMergeKey(as: rule) }) {
                throw ResourcePolicyError.invalid
            }
        }
    }
}

/// Administrative policy projection; a link is redacted rather than a usable
/// digest. A profile's locator is not secret and is kept.
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
