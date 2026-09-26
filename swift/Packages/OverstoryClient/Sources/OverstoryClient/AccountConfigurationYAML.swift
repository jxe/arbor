import Foundation
import Overstory
import Yams

public enum AccountAccessSubject: Hashable, Sendable {
    case everyone
    case profile(tree: String)
    case link(digest: String)
}

extension AccountAccessSubject: Codable {
    private enum CodingKeys: String, CodingKey { case kind, tree, digest }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        switch try values.decode(String.self, forKey: .kind) {
        case "everyone": self = .everyone
        case "profile": self = .profile(tree: try values.decode(String.self, forKey: .tree))
        case "link": self = .link(digest: try values.decode(String.self, forKey: .digest))
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .kind,
                in: values,
                debugDescription: "Unknown access subject"
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .everyone:
            try values.encode("everyone", forKey: .kind)
        case .profile(let tree):
            try values.encode("profile", forKey: .kind)
            try values.encode(tree, forKey: .tree)
        case .link(let digest):
            try values.encode("link", forKey: .kind)
            try values.encode(digest, forKey: .digest)
        }
    }
}

public struct AccountAccessRule: Codable, Hashable, Sendable {
    public var subject: AccountAccessSubject
    public var access: String

    public init(subject: AccountAccessSubject, access: String) {
        self.subject = subject
        self.access = access
    }
}

public extension AccountAccessRule {
    /// This read/write grant as an `access.yaml` rule.
    func resourceRule() throws -> ProtocolResourceAccessRule { try HostedTreeDeclaration.resourceRule(self) }
}

/// The sharing view of one tree's `access.yaml`. `resourceAccess` is the
/// tree's complete rule list, administrators included; `access` projects its
/// unscoped read/write rules for the ordinary sharing UI, which edits only
/// those. Other rules (administrators, scoped and app rules) are never
/// flattened, and the list is always written back as resource rules.
public struct HostedTreeDeclaration: Hashable, Sendable {
    public var canonical: String
    private var ordinaryAccess: [AccountAccessRule]
    public var resourceAccess: [ProtocolResourceAccessRule]
    public var access: [AccountAccessRule] {
        get { ordinaryAccess }
        set { ordinaryAccess = newValue }
    }
    public func completeResourceAccess() throws -> [ProtocolResourceAccessRule] {
        if resourceAccess.compactMap(Self.ordinaryRule) == ordinaryAccess { return resourceAccess }
        var retained = resourceAccess.filter { Self.ordinaryRule($0) == nil }
        for rule in try ordinaryAccess.map(Self.resourceRule) {
            if let index = retained.firstIndex(where: { $0.sameConsentKey(as: rule) }) {
                let previous = retained[index]
                let combined = ProtocolResourceOperation.allCases.filter { previous.allow.contains($0) || rule.allow.contains($0) }
                retained[index] = try ProtocolResourceAccessRule(who: previous.who, app: previous.app,
                    allow: combined.contains(.write) ? [.write] : combined, within: previous.within)
            } else { retained.append(rule) }
        }
        return retained
    }
    /// A new entry from the sharing controls' read/write rules.
    public init(canonical: String, access: [AccountAccessRule]) {
        self.canonical = canonical; self.ordinaryAccess = access; self.resourceAccess = []
    }
    public init(canonical: String, resourceAccess: [ProtocolResourceAccessRule]) {
        self.canonical = canonical; self.ordinaryAccess = resourceAccess.compactMap(Self.ordinaryRule); self.resourceAccess = resourceAccess
    }
    static func ordinaryRule(_ rule: ProtocolResourceAccessRule) -> AccountAccessRule? {
        guard rule.app == nil, rule.within == nil || rule.within == "/",
              rule.allow == [.read] || rule.allow == [.write] else { return nil }
        let subject: AccountAccessSubject
        switch rule.who {
        case .everyone: subject = .everyone
        case .profile(let tree): subject = .profile(tree: tree)
        case .link(let digest): subject = .link(digest: digest)
        case .me, .members: return nil
        }
        return AccountAccessRule(subject: subject, access: rule.allow[0].rawValue)
    }
    static func resourceRule(_ rule: AccountAccessRule) throws -> ProtocolResourceAccessRule {
        guard rule.access == "read" || rule.access == "write" else { throw ResourcePolicyError.invalid }
        let who: ProtocolResourceWho
        switch rule.subject {
        case .everyone: who = .everyone
        case .profile(let tree): who = .profile(tree)
        case .link(let digest): who = .link(digest)
        }
        // Rules produced by the sharing controls have validated subjects/access.
        return try ProtocolResourceAccessRule(who: who, allow: [rule.access == "write" ? .write : .read])
    }
}

public struct AccountDeviceDeclaration: Codable, Hashable, Sendable {
    public var label: String
    public var administrator: Bool?
}

public struct NativeTreeAccessEntry: Identifiable, Hashable, Sendable {
    public var subject: AccountAccessSubject
    public var locator: String?
    public var displayName: String?
    public var access: String
    public var isCurrentUser: Bool

    public init(
        subject: AccountAccessSubject,
        locator: String? = nil,
        displayName: String? = nil,
        access: String,
        isCurrentUser: Bool = false
    ) {
        self.subject = subject
        self.locator = locator
        self.displayName = displayName
        self.access = access
        self.isCurrentUser = isCurrentUser
    }

    public var id: String {
        switch subject {
        case .everyone: "everyone"
        case .profile(let tree): "profile:\(tree)"
        case .link(let digest): "link:\(digest)"
        }
    }
}

public struct NativeTreeAccessPresentation: Hashable, Sendable {
    public var tree: String
    public var canonical: String
    public var entries: [NativeTreeAccessEntry]
    public var canEdit: Bool
    public var resourceRules: [ProtocolResourceAccessRule]

    public init(tree: String, canonical: String, entries: [NativeTreeAccessEntry], canEdit: Bool, resourceRules: [ProtocolResourceAccessRule] = []) {
        self.tree = tree
        self.canonical = canonical
        self.entries = entries
        self.canEdit = canEdit
        self.resourceRules = resourceRules
    }
}

public enum NativeTreeAccessTarget: Hashable, Sendable {
    case everyone
    case profile(locator: String)
    case existing(AccountAccessSubject)
}

/// The files of a tree configuration (`tree-config-v1`): `access.yaml` for
/// every tree, `mounts.yaml` for every tree, `apps.yaml` for a profile and
/// `devices.yaml` for a person. A person's own configuration is their account
/// checkout; every other configuration is edited through the host.
public enum TreeConfigurationYAML {
    /// `access.yaml`: resource rules (`who` / `app` / `allow` / `within`),
    /// at least one of which grants `admin`.
    public static func access(from source: String) throws -> [ProtocolResourceAccessRule] {
        try validateAccessYAML(source)
        let rules = try YAMLDecoder().decode([ProtocolResourceAccessRule].self, from: source)
        guard rules.contains(where: \.isAdministrator) else {
            throw ProtocolValidationError.invalidValue("access.yaml must grant admin to at least one profile")
        }
        return rules
    }

    /// The sharing view of `access.yaml` for a tree at `canonical`.
    public static func declaration(canonical: String, source: String) throws -> HostedTreeDeclaration {
        HostedTreeDeclaration(canonical: canonical, resourceAccess: try access(from: source))
    }

    /// Rewrite `access.yaml` after `change` edits its sharing view. Administrators
    /// and every rule the sharing controls do not show are kept exactly.
    public static func replacingAccess(
        in source: String,
        canonical: String = "",
        with change: (inout HostedTreeDeclaration) throws -> Void
    ) throws -> String {
        var declaration = try declaration(canonical: canonical, source: source)
        let original = declaration
        try change(&declaration)
        if declaration == original { return source }
        let rules = try declaration.completeResourceAccess()
        let next = try encodeAccess(rules)
        _ = try access(from: next)
        return next
    }

    /// `access.yaml` in canonical form: administrators first.
    public static func encodeAccess(_ rules: [ProtocolResourceAccessRule]) throws -> String {
        let ordered = rules.filter(\.isAdministrator) + rules.filter { !$0.isAdministrator }
        return try YAMLEncoder().encode(ordered)
    }

    /// `mounts.yaml`: child trees by logical path below this tree.
    public static func mounts(from source: String) throws -> [String: String] {
        let value = try YAMLDecoder().decode([String: String]?.self, from: source) ?? [:]
        for (path, tree) in value {
            guard tree.range(of: #"^tr_[a-z2-7]+$"#, options: .regularExpression) != nil,
                  !path.isEmpty, !path.hasPrefix("/"), !path.hasSuffix("/"),
                  !path.split(separator: "/", omittingEmptySubsequences: false).contains(where: { $0.isEmpty || $0 == "." || $0 == ".." }) else {
                throw ProtocolValidationError.invalidValue("Invalid mount \(path)")
            }
        }
        guard Set(value.values).count == value.count else { throw ProtocolValidationError.invalidValue("mounts.yaml mounts a tree twice") }
        return value
    }

    /// Rewrite `mounts.yaml`, replacing only the entries `change` touches.
    public static func replacingMounts(in source: String, with change: (inout [String: String]) throws -> Void) throws -> String {
        let original = try mounts(from: source)
        var changed = original
        try change(&changed)
        let keys = Set(original.keys).union(changed.keys).filter { original[$0] != changed[$0] }
        if keys.isEmpty { return source }
        if original.isEmpty || changed.isEmpty { return changed.isEmpty ? "{}\n" : try YAMLEncoder().encode(changed) }
        var result = source
        for key in keys.sorted() {
            let replacement = try changed[key].map { try YAMLEncoder().encode([key: $0]) } ?? ""
            if let range = topLevelYAMLBlock(named: key, in: result) {
                result = result.replacingCharacters(in: range, with: replacement)
            } else {
                result += (result.hasSuffix("\n") || result.isEmpty ? "" : "\n") + replacement
            }
        }
        _ = try mounts(from: result)
        return result
    }

    /// `apps.yaml`: the rules each app may use, keyed by app TreeID.
    public static func apps(from source: String) throws -> [String: [ProtocolAppAccessRule]] {
        try YAMLDecoder().decode([String: [ProtocolAppAccessRule]]?.self, from: source) ?? [:]
    }

    /// Rewrite `apps.yaml` after `change`, replacing only the apps it touches.
    public static func replacingApps(in source: String, with change: (inout [String: [ProtocolAppAccessRule]]) throws -> Void) throws -> String {
        let original = try apps(from: source)
        var changed = original
        try change(&changed)
        changed = changed.filter { !$0.value.isEmpty }
        let keys = Set(original.keys).union(changed.keys).filter { original[$0] != changed[$0] }
        if keys.isEmpty { return source }
        if original.isEmpty || changed.isEmpty { return changed.isEmpty ? "{}\n" : try YAMLEncoder().encode(changed) }
        var result = source
        for key in keys.sorted() {
            let replacement = try changed[key].map { try YAMLEncoder().encode([key: $0]) } ?? ""
            if let range = topLevelYAMLBlock(named: key, in: result) {
                result = result.replacingCharacters(in: range, with: replacement)
            } else {
                result += (result.hasSuffix("\n") || result.isEmpty ? "" : "\n") + replacement
            }
        }
        _ = try apps(from: result)
        return result
    }

    /// The first files of a person's configuration, which a claim submits and
    /// installs as the account checkout: the person administers it from one
    /// administrator device, and everyone may read the profile.
    public static func initialPersonFiles(profileTree: String, deviceID: String, label: String) throws -> [String: String] {
        let access = try encodeAccess([
            ProtocolResourceAccessRule(who: .profile(profileTree), allow: [.admin]),
            ProtocolResourceAccessRule(who: .everyone, allow: [.read]),
        ])
        let devices = try YAMLEncoder().encode([deviceID: AccountDeviceDeclaration(label: label, administrator: true)])
        return ["access.yaml": access, "apps.yaml": "{}\n", "devices.yaml": devices, "mounts.yaml": "{}\n"]
    }
}

public enum AccountConfigurationYAML {
    public static func devices(from source: String) throws -> [String: AccountDeviceDeclaration] {
        try YAMLDecoder().decode([String: AccountDeviceDeclaration].self, from: source)
    }

    public static func replacingDevices(
        in source: String,
        with change: (inout [String: AccountDeviceDeclaration]) throws -> Void
    ) throws -> String {
        let original = try devices(from: source)
        var changed = original
        try change(&changed)
        let keys = Set(original.keys).union(changed.keys).filter { original[$0] != changed[$0] }
        guard keys.count == 1, let key = keys.first else {
            return try YAMLEncoder().encode(changed)
        }
        if let range = topLevelYAMLBlock(named: key, in: source) {
            let replacement = try changed[key].map { value in
                try YAMLEncoder().encode([key: value])
            } ?? ""
            return source.replacingCharacters(in: range, with: replacement)
        }
        guard let value = changed[key], original[key] == nil else {
            return try YAMLEncoder().encode(changed)
        }
        let prefix = source.isEmpty || source.hasSuffix("\n") ? source : source + "\n"
        return prefix + (try YAMLEncoder().encode([key: value]))
    }

    public static func isAdministrator(deviceID: String?, devicesSource: String) throws -> Bool {
        guard let deviceID else { return false }
        return try devices(from: devicesSource)[deviceID]?.administrator == true
    }

    public static func validateAdministratorChange(
        devices: [String: AccountDeviceDeclaration],
        currentDeviceID: String?,
        targetDeviceID: String,
        administrator: Bool
    ) throws {
        guard let currentDeviceID,
              devices[currentDeviceID]?.administrator == true else {
            throw ProtocolValidationError.invalidValue("Only an administrator can change device roles")
        }
        guard devices[targetDeviceID] != nil else {
            throw ProtocolValidationError.invalidValue("The device is no longer active")
        }
        guard targetDeviceID != currentDeviceID else {
            throw ProtocolValidationError.invalidValue("A device cannot change its own administrator role")
        }
        if !administrator,
           devices.values.filter({ $0.administrator == true }).count == 1,
           devices[targetDeviceID]?.administrator == true {
            throw ProtocolValidationError.invalidValue("The last administrator cannot be removed")
        }
    }

    public static func validateDeviceRemoval(
        devices: [String: AccountDeviceDeclaration],
        currentDeviceID: String?,
        targetDeviceID: String
    ) throws {
        guard let currentDeviceID,
              devices[currentDeviceID]?.administrator == true else {
            throw ProtocolValidationError.invalidValue("Only an administrator can deauthorize a device")
        }
        guard let target = devices[targetDeviceID] else {
            throw ProtocolValidationError.invalidValue("The device is no longer active")
        }
        if target.administrator == true,
           devices.values.filter({ $0.administrator == true }).count == 1 {
            throw ProtocolValidationError.invalidValue("The last administrator cannot be deauthorized")
        }
    }

    public static func profileDisplayName(locator: String?, handle: String? = nil) -> String? {
        if let handle, !handle.isEmpty { return handle.hasPrefix("~") ? handle : "~\(handle)" }
        guard let locator,
              let url = URL(string: locator),
              let component = url.pathComponents.last,
              component.hasPrefix("~"),
              component.count > 1 else { return nil }
        return component.removingPercentEncoding ?? component
    }

    public static func presentedAccessEntries(
        rules: [AccountAccessRule],
        profileLocators: [String: String],
        currentProfileTree: String?,
        currentHandle: String?
    ) -> [NativeTreeAccessEntry] {
        var entries = rules.map { rule in
            let profileTree: String? = if case let .profile(tree) = rule.subject { tree } else { nil }
            let locator = profileTree.flatMap { profileLocators[$0] }
            let isCurrentUser = profileTree != nil && profileTree == currentProfileTree
            return NativeTreeAccessEntry(
                subject: rule.subject,
                locator: locator,
                displayName: profileDisplayName(
                    locator: locator,
                    handle: isCurrentUser ? currentHandle : nil
                ),
                access: isCurrentUser ? "write" : rule.access,
                isCurrentUser: isCurrentUser
            )
        }
        guard let currentProfileTree else { return entries }
        if let index = entries.firstIndex(where: { $0.isCurrentUser }) {
            entries.insert(entries.remove(at: index), at: 0)
        } else {
            let locator = profileLocators[currentProfileTree]
            entries.insert(NativeTreeAccessEntry(
                subject: .profile(tree: currentProfileTree),
                locator: locator,
                displayName: profileDisplayName(locator: locator, handle: currentHandle),
                access: "write",
                isCurrentUser: true
            ), at: 0)
        }
        return entries
    }

    public static func validateAccessChange(
        subject: AccountAccessSubject,
        access: String,
        currentProfileTree: String?
    ) throws {
        guard access == "none" || access == "read" || access == "write" else {
            throw ProtocolValidationError.invalidValue("Unknown access level")
        }
        if access == "none",
           case let .profile(tree) = subject,
           tree == currentProfileTree {
            throw ProtocolValidationError.invalidValue("You cannot remove your own access")
        }
    }

}

public enum AccountConfigurationFileError: Error, LocalizedError, Sendable, Equatable {
    case notUTF8(String)

    public var errorDescription: String? {
        switch self {
        case let .notUTF8(path): "\(path) is not UTF-8"
        }
    }
}

public extension AccountConfigurationYAML {
    /// The on-disk checkout of a person's tree configuration beneath a data
    /// home: `<dataHome>/accounts/<configurationTree>/`.
    static func checkoutURL(dataHome: URL, configurationTree: String) -> URL {
        dataHome
            .appending(path: "accounts", directoryHint: .isDirectory)
            .appending(path: configurationTree, directoryHint: .isDirectory)
    }

    /// Read one file of an account checkout as strict UTF-8.
    static func readFile(named filename: String, in checkout: URL) throws -> String {
        let url = checkout.appending(path: filename)
        let data = try Data(contentsOf: url)
        guard let source = String(data: data, encoding: .utf8) else {
            throw AccountConfigurationFileError.notUTF8(url.path)
        }
        return source
    }

    /// Edit one file of an account checkout on disk.
    ///
    /// Swift twin of `editAccountConfigurationFile` in `@overstory/protocol`
    /// (`packages/protocol/src/config/account-config.ts`); the contract is shared:
    /// - The file lives at `checkoutURL(dataHome:configurationTree:)/<filename>`
    ///   and is read as strict UTF-8.
    /// - `change` rewrites only what it touches (`replacingMounts`, `replacingApps`
    ///   and `replacingDevices` replace one top-level block and leave comments,
    ///   ordering, and unrelated formatting alone).
    /// - `validate` runs against the new source before anything is written;
    ///   when it throws, the file on disk is untouched.
    /// - The new source replaces the file atomically (temporary file + rename),
    ///   so the daemon's checkout watcher only ever observes complete files.
    /// - Nothing here talks to the daemon. The checkout is a placed folder: Arbor
    ///   Sync watches it and pushes the edit like any other placement, and a
    ///   caller that needs it pushed promptly asks the daemon to synchronize
    ///   afterwards.
    ///
    /// Returns the source that was written.
    @discardableResult
    static func editFile(
        named filename: String,
        in checkout: URL,
        change: (String) throws -> String,
        validate: ((String) throws -> Void)? = nil
    ) throws -> String {
        let url = checkout.appending(path: filename)
        let previous = try readFile(named: filename, in: checkout)
        let next = try change(previous)
        try validate?(next)
        let temporary = url.deletingLastPathComponent()
            .appending(path: ".\(filename).\(UUID().uuidString).tmp")
        do {
            try Data(next.utf8).write(to: temporary, options: [])
            try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: temporary.path)
            _ = try FileManager.default.replaceItemAt(url, withItemAt: temporary)
        } catch {
            try? FileManager.default.removeItem(at: temporary)
            throw error
        }
        return next
    }
}

public enum LocalPlacementsYAML {
    public static func placements(from source: String) throws -> [String: [String: String]] {
        try YAMLDecoder().decode([String: [String: String]].self, from: source)
    }

    public static func adding(
        configurationTree: String,
        path: String,
        tree: String,
        to source: String
    ) throws -> String {
        var placements = try placements(from: source)
        if placements[configurationTree]?[path] == tree { return source }
        if let occupied = placements.values.first(where: { $0[path] != nil })?[path], occupied != tree {
            throw ProtocolValidationError.invalidValue("Another tree is already placed at \(path)")
        }
        if let existing = placements.values.flatMap(\.values).first(where: { $0 == tree }), existing == tree,
           placements[configurationTree]?[path] != tree {
            throw ProtocolValidationError.invalidValue("Tree \(tree) already has a local placement")
        }
        if placements[configurationTree] != nil {
            if let range = topLevelYAMLBlock(named: configurationTree, in: source),
               source[range].hasPrefix("\(configurationTree):\n") {
                let quotedPath = String(decoding: try JSONEncoder().encode(path), as: UTF8.self)
                let newline = source[..<range.upperBound].hasSuffix("\n") ? "" : "\n"
                return source.replacingCharacters(
                    in: range.upperBound..<range.upperBound,
                    with: "\(newline)  \(quotedPath): \(tree)\n"
                )
            }
            placements[configurationTree]![path] = tree
            return try YAMLEncoder().encode(placements)
        }
        placements[configurationTree, default: [:]][path] = tree
        if placements.count == 1 {
            return try YAMLEncoder().encode(placements)
        }
        let prefix = source.hasSuffix("\n") ? source : source + "\n"
        return prefix + (try YAMLEncoder().encode([configurationTree: [path: tree]]))
    }
}

func topLevelYAMLBlock(named key: String, in source: String) -> Range<String.Index>? {
    var cursor = source.startIndex
    var start: String.Index?
    var trailing: String.Index?
    while cursor < source.endIndex {
        let newline = source[cursor...].firstIndex(of: "\n")
        let lineEnd = newline ?? source.endIndex
        let next = newline.map { source.index(after: $0) } ?? source.endIndex
        let line = source[cursor..<lineEnd].trimmingCharacters(in: CharacterSet(charactersIn: "\r"))
        if start == nil {
            if [key, "'\(key)'", "\"\(key)\""].contains(where: { line == "\($0):" || line.hasPrefix("\($0): ") }) {
                start = cursor
            }
        } else if line.isEmpty || line.hasPrefix("#") {
            if trailing == nil { trailing = cursor }
        } else if line.first?.isWhitespace == true {
            trailing = nil
        } else {
            return start!..<(trailing ?? cursor)
        }
        cursor = next
    }
    return start.map { $0..<(trailing ?? source.endIndex) }
}
