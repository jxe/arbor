import CanopyAppKit
import Foundation
import Overstory
import Yams

/// Where a resource consent is written: an app approval in a profile's
/// `apps.yaml` (the person's own, or a group's the person administers), or the
/// tree's own rule through an app in the `access.yaml` of a tree the person
/// administers, which needs no lender behind it.
public enum NativeResourceConsentTarget: Hashable, Sendable {
    case profileApps(profile: String, group: Bool)
    case treeAccess(tree: String)

    /// The configuration the consent edits.
    public var configurationTree: String {
        switch self {
        case .profileApps(let profile, _): treeConfigurationID(profile)
        case .treeAccess(let tree): treeConfigurationID(tree)
        }
    }
    public var file: String {
        switch self {
        case .profileApps: "apps.yaml"
        case .treeAccess: "access.yaml"
        }
    }
}

/// An immutable review. Applying it requires the exact reviewed file and a
/// fresh administrator check. It contains no execution token.
public struct NativeResourceConsent: Sendable {
    public let target: NativeResourceConsentTarget
    public let tree: String
    public let app: String
    public let rule: ProtocolAppAccessRule
    public let removing: Bool
    public let previous: ProtocolAppAccessRule?
    public let before: String
    public let after: String
    /// Whether the consent lends write to callers other than the approver,
    /// which the consent sheet warns about before it is applied.
    public var lendsWrite: Bool {
        guard !removing, rule.allow.contains(.write) || rule.allow.contains(.delete) else { return false }
        return rule.who != .me && rule.who != .members
    }
    public var configurationTree: String { target.configurationTree }
}

private func caller(_ who: ProtocolResourceWho) -> String {
    switch who {
    case .me: "Me"
    case .members: "The group's members"
    case .everyone: "Everyone"
    case .profile(let tree): "Profile or group \(tree)"
    case .link: "Access-link holders"
    }
}

private func operations(_ allow: [ProtocolResourceOperation]) -> String {
    allow.map { operation -> String in
        switch operation {
        case .read: "read"
        case .write: "write (all changes)"
        case .createChild: "create children"
        case .updateContent: "update content"
        case .updateProperties: "update properties"
        case .delete: "delete"
        case .admin: "administer"
        }
    }.joined(separator: ", ")
}

public extension ProtocolResourceAccessRule {
    var consentDescription: String {
        "\(caller(who))\(app.map { " through app " + $0 } ?? " using ordinary access, including through code"): \(operations(allow)) within \(within ?? "/") (excluding nested trees)."
    }
    func sameConsentKey(as other: ProtocolResourceAccessRule) -> Bool {
        who == other.who && app == other.app && (within ?? "/") == (other.within ?? "/")
    }
}

public extension ProtocolAppAccessRule {
    func consentDescription(app: String) -> String {
        "\(caller(who)) through app \(app): \(operations(allow)) of \(resource) within \(within ?? "/") (excluding nested trees)."
    }
    func sameConsentKey(as other: ProtocolAppAccessRule) -> Bool {
        resource == other.resource && who == other.who && (within ?? "/") == (other.within ?? "/")
    }
}

public extension AccountConfigurationYAML {
    /// Review one app approval in a profile's `apps.yaml`. A person's own entry
    /// is `who: me`; a group's `who: members`; any other `who` lends the access.
    static func prepareAppConsent(
        profile: String, group: Bool, app: String, rule: ProtocolAppAccessRule,
        removing: Bool = false, source: String
    ) throws -> NativeResourceConsent {
        guard TreeID.isWellFormed(app), TreeID.isWellFormed(profile) else { throw ResourcePolicyError.invalid }
        guard rule.who != (group ? .me : .members) else { throw ResourcePolicyError.invalid }
        let prior = try TreeConfigurationYAML.apps(from: source, group: group)[app] ?? []
        let previous = prior.first { $0.sameConsentKey(as: rule) }
        let after = try TreeConfigurationYAML.replacingApps(in: source, group: group) { apps in
            var rules = (apps[app] ?? []).filter { !$0.sameConsentKey(as: rule) }
            if !removing { rules.append(rule) }
            apps[app] = rules
        }
        return NativeResourceConsent(target: .profileApps(profile: profile, group: group), tree: rule.resource, app: app, rule: rule,
            removing: removing, previous: previous, before: source, after: after)
    }

    /// Review the tree's own rule through an app, for a tree the person administers.
    static func prepareTreeAppConsent(
        tree: String, app: String, rule: ProtocolAppAccessRule,
        removing: Bool = false, source: String
    ) throws -> NativeResourceConsent {
        guard TreeID.isWellFormed(app), rule.resource == tree, rule.who != .me, rule.who != .members else { throw ResourcePolicyError.invalid }
        let accessRule = try ProtocolResourceAccessRule(who: rule.who, app: app, allow: rule.allow, within: rule.within)
        let rules = try TreeConfigurationYAML.access(from: source)
        let previous = rules.first { $0.sameConsentKey(as: accessRule) }
        var next = rules.filter { !$0.sameConsentKey(as: accessRule) }
        if !removing { next.append(accessRule) }
        let after = try TreeConfigurationYAML.encodeAccess(next)
        return NativeResourceConsent(target: .treeAccess(tree: tree), tree: tree, app: app, rule: rule, removing: removing,
            previous: try previous.map { try ProtocolAppAccessRule(resource: tree, who: $0.who, allow: $0.allow, within: $0.within) },
            before: source, after: after)
    }

    static func applyingResourceConsent(_ review: NativeResourceConsent, to source: String,
                                       deviceID: String?, devicesSource: String) throws -> String {
        guard try isAdministrator(deviceID: deviceID, devicesSource: devicesSource) else {
            throw ProtocolValidationError.invalidValue("Only an administrator device may change resource permissions")
        }
        guard source == review.before else {
            throw ProtocolValidationError.invalidValue("Configuration changed; review permissions again")
        }
        return review.after
    }
}

/// YAMLDecoder otherwise collapses duplicate mappings and expands aliases before
/// Codable sees them. Validate those source-level ambiguities before any edit.
func validateAccessYAML(_ source: String) throws {
    let parser = try Yams.Parser(yaml: source)
    defer { withExtendedLifetime(parser) {} }
    guard let root = try parser.singleRoot(), let rules = root.sequence else { throw ResourcePolicyError.invalid }
    var anchors = Set<String>()
    func visit(_ node: Node) throws {
        if let anchor = node.anchor, !anchors.insert(anchor.rawValue).inserted { throw ResourcePolicyError.invalid }
        switch node {
        case .alias: throw ResourcePolicyError.invalid
        case .mapping(let mapping):
            var seen = Set<String>()
            for (key, value) in mapping {
                guard let name = key.string, seen.insert(name).inserted else { throw ResourcePolicyError.invalid }
                try visit(value)
            }
        case .sequence(let sequence): for value in sequence { try visit(value) }
        case .scalar: break
        }
    }
    try visit(root)
    let decoded = try rules.map { try YAMLDecoder().decode(ProtocolResourceAccessRule.self, from: Yams.serialize(node: $0)) }
    for (i, rule) in decoded.enumerated() where decoded.prefix(i).contains(where: { $0.sameConsentKey(as: rule) }) {
        throw ResourcePolicyError.invalid
    }
}
