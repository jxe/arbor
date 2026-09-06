import Foundation
import ArborWire
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

public struct ArborHostedTreeDeclaration: Codable, Hashable, Sendable {
    public var canonical: String
    public var access: [ArborAccountAccessRule]

    public init(canonical: String, access: [ArborAccountAccessRule]) {
        self.canonical = canonical
        self.access = access
    }
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

    public init(tree: String, canonical: String, entries: [NativeTreeAccessEntry], canEdit: Bool) {
        self.tree = tree
        self.canonical = canonical
        self.entries = entries
        self.canEdit = canEdit
    }
}

public enum NativeTreeAccessTarget: Hashable, Sendable {
    case everyone
    case profile(locator: String)
    case existing(ArborAccountAccessSubject)
}

public struct NativeAccessLink: Hashable, Sendable {
    public var url: URL

    public init(url: URL) { self.url = url }
}

public enum ArborAccountConfigurationYAML {
    public static func trees(from source: String) throws -> [String: ArborHostedTreeDeclaration] {
        try YAMLDecoder().decode([String: ArborHostedTreeDeclaration].self, from: source)
    }

    public static func replacingTrees(
        in source: String,
        with change: (inout [String: ArborHostedTreeDeclaration]) throws -> Void
    ) throws -> String {
        let original = try trees(from: source)
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

private func arborTopLevelBlock(named key: String, in source: String) -> Range<String.Index>? {
    var cursor = source.startIndex
    var start: String.Index?
    while cursor < source.endIndex {
        let newline = source[cursor...].firstIndex(of: "\n")
        let lineEnd = newline ?? source.endIndex
        let next = newline.map { source.index(after: $0) } ?? source.endIndex
        let line = source[cursor..<lineEnd].trimmingCharacters(in: CharacterSet(charactersIn: "\r"))
        if start == nil {
            if line == "\(key):" || line.hasPrefix("\(key): ") {
                start = cursor
            }
        } else if line.isEmpty || line.first?.isWhitespace != true {
            return start!..<cursor
        }
        cursor = next
    }
    return start.map { $0..<source.endIndex }
}
