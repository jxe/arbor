import Foundation
import Overstory
import Yams

public enum ArborAccountAccessSubject: Hashable, Sendable {
    case everyone
    case profile(tree: String)
    case link(digest: String)
}

extension ArborAccountAccessSubject: Codable {
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
                debugDescription: "Unknown Arbor access subject"
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

public struct ArborAccountAccessRule: Codable, Hashable, Sendable {
    public var subject: ArborAccountAccessSubject
    public var access: String

    public init(subject: ArborAccountAccessSubject, access: String) {
        self.subject = subject
        self.access = access
    }
}

/// Hosting view retains the complete new policy while the ordinary sharing UI
/// edits only unscoped read/write rules. Other rules are never flattened.
public struct ArborHostedTreeDeclaration: Codable, Hashable, Sendable {
    public var canonical: String
    private var legacyAccess: [ArborAccountAccessRule]
    public var resourceAccess: [WireResourceAccessRule]?
    public var access: [ArborAccountAccessRule] {
        get { legacyAccess }
        set { legacyAccess = newValue }
    }
    public func completeResourceAccess() throws -> [WireResourceAccessRule] {
        if let resourceAccess, resourceAccess.compactMap(Self.ordinaryRule) == legacyAccess { return resourceAccess }
        var retained = (resourceAccess ?? []).filter { Self.ordinaryRule($0) == nil }
        for rule in try legacyAccess.map(Self.resourceRule) {
            if let index = retained.firstIndex(where: { $0.sameConsentKey(as: rule) }) {
                let previous = retained[index]
                let combined = WireResourceOperation.allCases.filter { previous.allow.contains($0) || rule.allow.contains($0) }
                retained[index] = try WireResourceAccessRule(who: previous.who, via: previous.via,
                    allow: combined.contains(.write) ? [.write] : combined, within: previous.within)
            } else { retained.append(rule) }
        }
        return retained
    }
    public init(canonical: String, access: [ArborAccountAccessRule]) {
        self.canonical = canonical; self.legacyAccess = access; self.resourceAccess = nil
    }
    public init(canonical: String, resourceAccess: [WireResourceAccessRule]) {
        self.canonical = canonical; self.legacyAccess = resourceAccess.compactMap(Self.ordinaryRule); self.resourceAccess = resourceAccess
    }
    private enum CodingKeys: String, CodingKey { case canonical, access }
    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        canonical = try values.decode(String.self, forKey: .canonical)
        if let rules = try? values.decode([ArborAccountAccessRule].self, forKey: .access) {
            legacyAccess = rules; resourceAccess = nil
        } else {
            resourceAccess = try values.decode([WireResourceAccessRule].self, forKey: .access)
            legacyAccess = resourceAccess!.compactMap(Self.ordinaryRule)
        }
    }
    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(canonical, forKey: .canonical)
        if resourceAccess != nil { try values.encode(completeResourceAccess(), forKey: .access) }
        else { try values.encode(legacyAccess, forKey: .access) }
    }
    static func ordinaryRule(_ rule: WireResourceAccessRule) -> ArborAccountAccessRule? {
        guard rule.via == nil, rule.within == nil || rule.within == "/",
              rule.allow == [.read] || rule.allow == [.write] else { return nil }
        let subject: ArborAccountAccessSubject
        switch rule.who {
        case .everyone: subject = .everyone
        case .profile(let tree): subject = .profile(tree: tree)
        case .link(let digest): subject = .link(digest: digest)
        case .me: return nil
        }
        return ArborAccountAccessRule(subject: subject, access: rule.allow[0].rawValue)
    }
    static func resourceRule(_ rule: ArborAccountAccessRule) throws -> WireResourceAccessRule {
        guard rule.access == "read" || rule.access == "write" else { throw ResourcePolicyError.invalid }
        let who: WireResourceWho
        switch rule.subject {
        case .everyone: who = .everyone
        case .profile(let tree): who = .profile(tree)
        case .link(let digest): who = .link(digest)
        }
        // Rules produced by the sharing controls have validated subjects/access.
        return try WireResourceAccessRule(who: who, allow: [rule.access == "write" ? .write : .read])
    }
}

public struct ArborResourceDeclaration: Codable, Hashable, Sendable {
    public var canonical: String?
    public var access: [WireResourceAccessRule]
}

public struct ArborAccountDeviceDeclaration: Codable, Hashable, Sendable {
    public var label: String
    public var administrator: Bool?
}

public struct NativeTreeAccessEntry: Identifiable, Hashable, Sendable {
    public var subject: ArborAccountAccessSubject
    public var locator: String?
    public var displayName: String?
    public var access: String
    public var isCurrentUser: Bool

    public init(
        subject: ArborAccountAccessSubject,
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
    public var resourceRules: [WireResourceAccessRule]

    public init(tree: String, canonical: String, entries: [NativeTreeAccessEntry], canEdit: Bool, resourceRules: [WireResourceAccessRule] = []) {
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
    case existing(ArborAccountAccessSubject)
}

public enum ArborAccountConfigurationYAML {
    private enum TreesSource {
        case resources([String: ArborResourceDeclaration])
        case legacy([String: ArborHostedTreeDeclaration])

        var trees: [String: ArborHostedTreeDeclaration] {
            switch self {
            case .resources(let resources):
                resources.compactMapValues { value in
                    value.canonical.map { ArborHostedTreeDeclaration(canonical: $0, resourceAccess: value.access) }
                }
            case .legacy(let trees): trees
            }
        }
    }

    /// Parse trees.yaml in the resource format, falling back to the legacy
    /// hosted-tree format; a file that is neither reports the resource-format error.
    private static func parseTrees(_ source: String) throws -> TreesSource {
        try validatePolicyYAML(source)
        do {
            return .resources(try YAMLDecoder().decode([String: ArborResourceDeclaration].self, from: source))
        } catch {
            guard let legacy = try? YAMLDecoder().decode([String: ArborHostedTreeDeclaration].self, from: source) else { throw error }
            return .legacy(legacy)
        }
    }

    public static func trees(from source: String) throws -> [String: ArborHostedTreeDeclaration] {
        try parseTrees(source).trees
    }

    public static func replacingTrees(
        in source: String,
        with change: (inout [String: ArborHostedTreeDeclaration]) throws -> Void
    ) throws -> String {
        let parsed = try parseTrees(source)
        let original = parsed.trees
        var changed = original
        try change(&changed)
        if case var .resources(resources) = parsed {
            let wasEmpty = resources.isEmpty
            let keys = Set(original.keys).union(changed.keys).filter { original[$0] != changed[$0] }
            for key in keys {
                if let tree = changed[key] {
                    resources[key] = ArborResourceDeclaration(canonical: tree.canonical,
                        access: try tree.completeResourceAccess())
                } else { resources[key] = nil }
            }
            if keys.isEmpty { return source }
            // Adding the first entry/removing the last requires changing the
            // empty mapping representation itself, not appending another root.
            if wasEmpty || resources.isEmpty { return try YAMLEncoder().encode(resources) }
            var result = source
            for key in keys.sorted() {
                let replacement = try resources[key].map { try YAMLEncoder().encode([key: $0]) } ?? ""
                if let range = arborTopLevelBlock(named: key, in: result) {
                    result = result.replacingCharacters(in: range, with: replacement)
                } else {
                    guard original[key] == nil else {
                        throw ArborWireValidationError.invalidValue("Cannot preserve this YAML layout; edit trees.yaml directly")
                    }
                    result += (result.hasSuffix("\n") || result.isEmpty ? "" : "\n") + replacement
                }
            }
            try validatePolicyYAML(result)
            _ = try YAMLDecoder().decode([String: ArborResourceDeclaration].self, from: result)
            return result
        }
        let keys = Set(original.keys).union(changed.keys).filter { original[$0] != changed[$0] }
        guard keys.count == 1, let key = keys.first else {
            return try YAMLEncoder().encode(changed)
        }
        if let range = arborTopLevelBlock(named: key, in: source) {
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

    public static func devices(from source: String) throws -> [String: ArborAccountDeviceDeclaration] {
        try YAMLDecoder().decode([String: ArborAccountDeviceDeclaration].self, from: source)
    }

    public static func replacingDevices(
        in source: String,
        with change: (inout [String: ArborAccountDeviceDeclaration]) throws -> Void
    ) throws -> String {
        let original = try devices(from: source)
        var changed = original
        try change(&changed)
        let keys = Set(original.keys).union(changed.keys).filter { original[$0] != changed[$0] }
        guard keys.count == 1, let key = keys.first else {
            return try YAMLEncoder().encode(changed)
        }
        if let range = arborTopLevelBlock(named: key, in: source) {
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
        devices: [String: ArborAccountDeviceDeclaration],
        currentDeviceID: String?,
        targetDeviceID: String,
        administrator: Bool
    ) throws {
        guard let currentDeviceID,
              devices[currentDeviceID]?.administrator == true else {
            throw ArborWireValidationError.invalidValue("Only an administrator can change device roles")
        }
        guard devices[targetDeviceID] != nil else {
            throw ArborWireValidationError.invalidValue("The device is no longer active")
        }
        guard targetDeviceID != currentDeviceID else {
            throw ArborWireValidationError.invalidValue("A device cannot change its own administrator role")
        }
        if !administrator,
           devices.values.filter({ $0.administrator == true }).count == 1,
           devices[targetDeviceID]?.administrator == true {
            throw ArborWireValidationError.invalidValue("The last administrator cannot be removed")
        }
    }

    public static func validateDeviceRemoval(
        devices: [String: ArborAccountDeviceDeclaration],
        currentDeviceID: String?,
        targetDeviceID: String
    ) throws {
        guard let currentDeviceID,
              devices[currentDeviceID]?.administrator == true else {
            throw ArborWireValidationError.invalidValue("Only an administrator can deauthorize a device")
        }
        guard let target = devices[targetDeviceID] else {
            throw ArborWireValidationError.invalidValue("The device is no longer active")
        }
        if target.administrator == true,
           devices.values.filter({ $0.administrator == true }).count == 1 {
            throw ArborWireValidationError.invalidValue("The last administrator cannot be deauthorized")
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
        rules: [ArborAccountAccessRule],
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
        subject: ArborAccountAccessSubject,
        access: String,
        currentProfileTree: String?
    ) throws {
        guard access == "none" || access == "read" || access == "write" else {
            throw ArborWireValidationError.invalidValue("Unknown access level")
        }
        if access == "none",
           case let .profile(tree) = subject,
           tree == currentProfileTree {
            throw ArborWireValidationError.invalidValue("You cannot remove your own access")
        }
    }

}

public enum ArborAccountConfigurationFileError: Error, LocalizedError, Sendable, Equatable {
    case notUTF8(String)

    public var errorDescription: String? {
        switch self {
        case let .notUTF8(path): "\(path) is not UTF-8"
        }
    }
}

public extension ArborAccountConfigurationYAML {
    /// The on-disk checkout of one account-configuration tree beneath a data
    /// home: `<dataHome>/accounts/<configurationTree>/`.
    static func checkoutURL(dataHome: URL, configurationTree: String) -> URL {
        dataHome
            .appending(path: "accounts", directoryHint: .isDirectory)
            .appending(path: configurationTree, directoryHint: .isDirectory)
    }

    /// Read one file of an account-configuration checkout as strict UTF-8.
    static func readFile(named filename: String, in checkout: URL) throws -> String {
        let url = checkout.appending(path: filename)
        let data = try Data(contentsOf: url)
        guard let source = String(data: data, encoding: .utf8) else {
            throw ArborAccountConfigurationFileError.notUTF8(url.path)
        }
        return source
    }

    /// Edit one file of an account-configuration checkout on disk.
    ///
    /// Swift twin of `editAccountConfigurationFile` in `@arbor/stores`
    /// (`packages/stores/src/account-config-v2.ts`); the contract is shared:
    /// - The file lives at `checkoutURL(dataHome:configurationTree:)/<filename>`
    ///   and is read as strict UTF-8.
    /// - `change` rewrites only what it touches (`replacingTrees` and
    ///   `replacingDevices` replace one top-level block and leave comments,
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

public enum ArborLocalPlacementsYAML {
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
            throw ArborWireValidationError.invalidValue("Another tree is already placed at \(path)")
        }
        if let existing = placements.values.flatMap(\.values).first(where: { $0 == tree }), existing == tree,
           placements[configurationTree]?[path] != tree {
            throw ArborWireValidationError.invalidValue("Tree \(tree) already has a local placement")
        }
        if placements[configurationTree] != nil {
            if let range = arborTopLevelBlock(named: configurationTree, in: source),
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

func arborTopLevelBlock(named key: String, in source: String) -> Range<String.Index>? {
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
