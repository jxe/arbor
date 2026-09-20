import Foundation
import Overstory
import Yams

/// An immutable, account-bound review. Applying it requires the exact reviewed
/// trees.yaml and a fresh administrator check. It contains no execution token.
public struct NativeResourceConsent: Sendable {
    public let configurationTree: String
    public let tree: String
    public let rule: WireResourceAccessRule
    public let removing: Bool
    public let previous: WireResourceAccessRule?
    public let before: String
    public let after: String
}

public extension WireResourceAccessRule {
    var consentDescription: String {
        let caller: String
        switch who {
        case .me: caller = "Me"
        case .everyone: caller = "Everyone"
        case .profile(let tree): caller = "Profile or group \(tree)"
        case .link: caller = "Access-link holders"
        }
        let operations = allow.map { operation -> String in
            switch operation {
            case .read: "read"
            case .write: "write (all changes)"
            case .createChild: "create children"
            case .updateContent: "update content"
            case .updateProperties: "update properties"
            case .delete: "delete"
            }
        }.joined(separator: ", ")
        return "\(caller)\(via.map { " via " + $0 } ?? " using ordinary access, including through code"): \(operations) within \(within ?? "/") (excluding nested trees)."
    }
    func sameConsentKey(as other: WireResourceAccessRule) -> Bool {
        who == other.who && via == other.via && (within ?? "/") == (other.within ?? "/")
    }
}

public extension ArborAccountConfigurationYAML {
    static func prepareResourceConsent(
        configurationTree: String, tree: String, rule: WireResourceAccessRule,
        removing: Bool = false, source: String
    ) throws -> NativeResourceConsent {
        // No implicit conversion while the coordinated migration is pending.
        try validatePolicyYAML(source)
        var resources = try YAMLDecoder().decode([String: ArborResourceDeclaration].self, from: source)
        guard tree.range(of: #"^tr_[a-z2-7]+$"#, options: .regularExpression) != nil,
              tree != configurationTree else { throw ResourcePolicyError.invalid }
        let wasEmpty = resources.isEmpty
        let existed = resources[tree] != nil
        let prior = resources[tree]?.access ?? []
        guard prior.filter({ $0.sameConsentKey(as: rule) }).count <= 1 else { throw ResourcePolicyError.invalid }
        let previous = prior.first { $0.sameConsentKey(as: rule) }
        var declaration = resources[tree] ?? ArborResourceDeclaration(canonical: nil, access: [])
        declaration.access.removeAll { $0.sameConsentKey(as: rule) }
        if !removing { declaration.access.append(rule) }
        resources[tree] = declaration
        let replacement = try YAMLEncoder().encode([tree: declaration])
        let after: String
        if wasEmpty {
            after = try YAMLEncoder().encode(resources)
        } else if let range = arborTopLevelBlock(named: tree, in: source) {
            after = source.replacingCharacters(in: range, with: replacement)
        } else {
            guard !existed else {
                throw ArborWireValidationError.invalidValue("Cannot preserve this YAML layout; edit trees.yaml directly")
            }
            after = source + (source.isEmpty || source.hasSuffix("\n") ? "" : "\n") + replacement
        }
        try validatePolicyYAML(after)
        _ = try YAMLDecoder().decode([String: ArborResourceDeclaration].self, from: after)
        return NativeResourceConsent(configurationTree: configurationTree, tree: tree, rule: rule,
            removing: removing, previous: previous, before: source, after: after)
    }

    static func applyingResourceConsent(_ review: NativeResourceConsent, to source: String,
                                       deviceID: String?, devicesSource: String) throws -> String {
        guard try isAdministrator(deviceID: deviceID, devicesSource: devicesSource) else {
            throw ArborWireValidationError.invalidValue("Only an administrator may change resource permissions")
        }
        guard source == review.before else {
            throw ArborWireValidationError.invalidValue("Configuration changed; review permissions again")
        }
        return review.after
    }
}

/// YAMLDecoder otherwise collapses duplicate mappings and expands aliases before
/// Codable sees them. Validate those source-level ambiguities before any edit.
func validatePolicyYAML(_ source: String) throws {
    let parser = try Yams.Parser(yaml: source)
    defer { withExtendedLifetime(parser) {} }
    guard let root = try parser.singleRoot(), let resources = root.mapping else { throw ResourcePolicyError.invalid }
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
    for (_, declaration) in resources {
        guard let fields = declaration.mapping,
              fields.allSatisfy({ ["canonical", "access"].contains($0.key.string ?? "") }) else { throw ResourcePolicyError.invalid }
        if let access = fields.first(where: { $0.key.string == "access" })?.value.sequence,
           access.contains(where: { $0.mapping?.contains(where: { $0.key.string == "who" }) == true }) {
            let rules = try access.map { try YAMLDecoder().decode(WireResourceAccessRule.self, from: Yams.serialize(node: $0)) }
            // Legacy policy uses a different rule type and is checked on decode.
            for (i, rule) in rules.enumerated() where rules.prefix(i).contains(where: { $0.sameConsentKey(as: rule) }) {
                throw ResourcePolicyError.invalid
            }
        }
    }
}
