import CanopyAppKit
import Foundation
import Overstory
import OverstoryClient

private struct DirectoryOriginCache: Codable, Sendable, Equatable {
    var fetchedAt: Date
    var entries: [WireProfileDirectoryEntry]
}

private struct DirectoryCacheDocument: Codable, Sendable, Equatable {
    var version = 1
    var origins: [String: DirectoryOriginCache]
}

actor DirectoryStore {
    private let url: URL

    init(url: URL = ArborSupportDirectories.directory) { self.url = url }

    nonisolated static func load(at url: URL = ArborSupportDirectories.directory) throws -> [DirectoryPerson] {
        let document = try Self.document(at: url)
        let people = document.origins.reduce(into: [DirectoryPerson]()) { result, pair in
            guard let origin = URL(string: pair.key) else { return }
            result.append(contentsOf: pair.value.entries.map { DirectoryPerson(origin: origin, entry: $0) })
        }
        return DirectoryPerson.merged(people)
    }

    func load() throws -> [DirectoryPerson] {
        try Self.load(at: url)
    }

    func save(origin: URL, entries: [WireProfileDirectoryEntry], fetchedAt: Date = .now) throws {
        var document = try loadDocument()
        document.origins[origin.absoluteString] = DirectoryOriginCache(fetchedAt: fetchedAt, entries: entries)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder.directory.encode(document).write(to: url, options: .atomic)
    }

    func fetchedAt(origin: URL) throws -> Date? { try loadDocument().origins[origin.absoluteString]?.fetchedAt }

    private func loadDocument() throws -> DirectoryCacheDocument {
        try Self.document(at: url)
    }

    private nonisolated static func document(at url: URL) throws -> DirectoryCacheDocument {
        guard FileManager.default.fileExists(atPath: url.path) else { return DirectoryCacheDocument(origins: [:]) }
        let document = try JSONDecoder.directory.decode(DirectoryCacheDocument.self, from: Data(contentsOf: url))
        guard document.version == 1 else { throw ArborWireValidationError.invalidValue("Unsupported directory cache") }
        return document
    }
}

actor AvatarCache {
    static let maximumBytes = 2 * 1024 * 1024
    static let maximumSizeDescription = "\(maximumBytes / (1024 * 1024)) MB"
    private let directory: URL

    init(directory: URL = ArborSupportDirectories.avatars) { self.directory = directory }

    nonisolated static func fileName(for hash: String) throws -> String {
        guard hash.range(of: #"^sha256:[a-f0-9]{64}$"#, options: .regularExpression) != nil else {
            throw ArborWireValidationError.invalidHash(hash)
        }
        return String(hash.dropFirst("sha256:".count))
    }

    func data(for avatar: WireDirectoryAvatar, fetch: @Sendable () async throws -> Data) async throws -> Data {
        let url = directory.appending(path: try Self.fileName(for: avatar.hash))
        if let data = try? Data(contentsOf: url), data.count <= Self.maximumBytes { return data }
        let data = try await fetch()
        guard data.count <= Self.maximumBytes else { throw ArborWireValidationError.invalidValue("Avatar is larger than \(Self.maximumSizeDescription)") }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try data.write(to: url, options: .atomic)
        return data
    }
}

private extension JSONEncoder {
    static let directory: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }()
}

private extension JSONDecoder {
    static let directory: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }()
}

/// The small, authored profile schema stored in a tree root's frontmatter.
/// Edits preserve the Markdown body and every unrelated frontmatter line.
struct ArborProfileDocument: Equatable {
    enum Kind: String, Equatable { case person, group }

    /// One `members` entry in authored order: a structured `profile:` entry
    /// or a legacy scalar locator.
    struct Member: Equatable, Identifiable {
        let profile: String
        let handle: String?
        var id: String { profile }

        /// The Profile TreeID a structured `arbor://<TreeID>/` locator names.
        var treeID: String? {
            guard profile.range(of: #"^arbor://tr_[a-z2-7]+/?$"#, options: .regularExpression) != nil else { return nil }
            return String(profile.dropFirst("arbor://".count).prefix { $0 != "/" })
        }
    }

    let kind: Kind
    let displayName: String?
    let description: String?
    let avatarPath: String?
    let memberProfiles: Set<String>
    let memberHandles: Set<String>
    let memberHandlesByProfile: [String: String]
    let members: [Member]

    /// Whether a person has filled out any of their profile.
    var hasPersonalDetails: Bool {
        displayName?.isEmpty == false || description?.isEmpty == false || avatarPath != nil
    }

    static func parse(_ source: String) -> ArborProfileDocument? {
        guard let envelope = Frontmatter(source) else { return nil }
        let lines = envelope.lines
        guard let kindValue = scalar(named: "type", in: lines),
              let kind = Kind(rawValue: kindValue) else { return nil }
        var handlesByProfile: [String: String] = [:]
        var currentMemberProfile: String?
        let members = Set(lines.compactMap { line -> String? in
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            let field = trimmed.hasPrefix("- ") ? String(trimmed.dropFirst(2)) : trimmed
            guard field.hasPrefix("profile:") else { return nil }
            let value = decodeScalar(String(field.dropFirst("profile:".count)))
            currentMemberProfile = value
            return value
        })
        currentMemberProfile = nil
        let handles = Set(lines.compactMap { line -> String? in
            guard line.first?.isWhitespace == true else { return nil }
            let field = line.trimmingCharacters(in: .whitespaces)
            if field.hasPrefix("- profile:") {
                currentMemberProfile = decodeScalar(String(field.dropFirst("- profile:".count)))
                return nil
            }
            guard field.hasPrefix("handle:") else { return nil }
            let value = decodeScalar(String(field.dropFirst("handle:".count)))
            if let currentMemberProfile, let value { handlesByProfile[currentMemberProfile] = value }
            return value
        })
        return ArborProfileDocument(
            kind: kind,
            displayName: scalar(named: "displayName", in: lines),
            description: scalar(named: "description", in: lines),
            avatarPath: scalar(named: "avatar", in: lines).flatMap(validAvatarPath),
            memberProfiles: members,
            memberHandles: handles,
            memberHandlesByProfile: handlesByProfile,
            members: envelope.memberEntries()?.entries.map(\.member) ?? []
        )
    }

    /// The root Markdown of a new group profile tree.
    static func newGroupSource(displayName: String, description: String, memberTrees: [String]) throws -> String {
        let name = displayName.trimmingCharacters(in: .whitespacesAndNewlines)
        let detail = description.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, name.unicodeScalars.count <= 80, !name.contains(where: \.isNewline) else {
            throw ArborWireValidationError.invalidValue("A group name must be 1 to 80 characters on one line")
        }
        guard detail.unicodeScalars.count <= 500 else {
            throw ArborWireValidationError.invalidValue("A group description must be at most 500 characters")
        }
        var lines = ["---", "type: group", "displayName: \(try Frontmatter.quoted(name))"]
        if !detail.isEmpty { lines.append("description: \(try Frontmatter.quoted(detail))") }
        var seen = Set<String>()
        let trees = memberTrees.filter { seen.insert($0).inserted }
        for tree in trees where !TreeID.isWellFormed(tree) {
            throw ArborWireValidationError.invalidValue("\(tree) is not a Profile TreeID")
        }
        if trees.isEmpty {
            lines.append("members: []")
        } else {
            lines.append("members:")
            for tree in trees { lines.append(contentsOf: try Frontmatter.memberLines(profile: "arbor://\(tree)/", handle: nil)) }
        }
        lines += ["---", "", "# \(name)", ""]
        return lines.joined(separator: "\n")
    }

    /// Remove the one `members` entry naming `profile` (an authored locator),
    /// leaving every other line as written.
    static func removingMember(profile: String, from source: String) throws -> String {
        guard let document = parse(source), document.kind == .group else {
            throw ArborWireValidationError.invalidValue("This document is not a group profile")
        }
        var envelope = try requiredFrontmatter(source)
        guard let block = envelope.memberEntries() else {
            throw ArborWireValidationError.invalidValue("This group has no members")
        }
        let matches = block.entries.filter { $0.member.profile == profile }
        guard let entry = matches.first else {
            throw ArborWireValidationError.invalidValue("\(profile) is not a member")
        }
        guard matches.count == 1 else {
            throw ArborWireValidationError.invalidValue("\(profile) is listed more than once; edit the members by hand")
        }
        envelope.lines.removeSubrange(entry.lines)
        if block.entries.count == 1 { envelope.lines[block.header] = "members: []" }
        return envelope.source
    }

    static func updatingPerson(
        _ source: String,
        displayName: String,
        description: String,
        avatarPath: String? = nil
    ) throws -> String {
        guard let profile = parse(source), profile.kind == .person else {
            throw ArborWireValidationError.invalidValue("This document is not a person profile")
        }
        let name = displayName.trimmingCharacters(in: .whitespacesAndNewlines)
        let detail = description.trimmingCharacters(in: .whitespacesAndNewlines)
        guard name.unicodeScalars.count <= 80, !name.contains(where: \.isNewline) else {
            throw ArborWireValidationError.invalidValue("A profile name must be at most 80 characters on one line")
        }
        guard detail.unicodeScalars.count <= 500 else {
            throw ArborWireValidationError.invalidValue("A profile description must be at most 500 characters")
        }
        var envelope = try requiredFrontmatter(source)
        try envelope.setScalar(name.isEmpty ? nil : name, named: "displayName")
        try envelope.setScalar(detail.isEmpty ? nil : detail, named: "description")
        if let avatarPath {
            guard let avatarPath = validAvatarPath(avatarPath) else {
                throw ArborWireValidationError.invalidValue("A profile photo must be an image inside the profile tree")
            }
            try envelope.setScalar(avatarPath, named: "avatar")
        }
        return envelope.source
    }

    private static func validAvatarPath(_ value: String) -> String? {
        guard !value.isEmpty, !value.hasPrefix("/"), !value.contains("\\") else { return nil }
        let components = value.split(separator: "/", omittingEmptySubsequences: false)
        guard !components.contains(where: { $0.isEmpty || $0 == "." || $0 == ".." }),
              let name = components.last,
              name.range(of: #"\.(?:png|jpe?g|gif|webp)$"#, options: [.regularExpression, .caseInsensitive]) != nil else {
            return nil
        }
        return value
    }

    static func addingMember(
        profileTree: String,
        handle: String?,
        reservesCanopyHandle: Bool = false,
        to source: String
    ) throws -> String {
        guard let profile = parse(source), profile.kind == .group else {
            throw ArborWireValidationError.invalidValue("This document is not a group profile")
        }
        let tree = profileTree.trimmingCharacters(in: .whitespacesAndNewlines)
        var localHandle = handle?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if localHandle.hasPrefix("~") { localHandle.removeFirst() }
        guard TreeID.isWellFormed(tree) else {
            throw ArborWireValidationError.invalidValue("Enter a TreeID such as tr_abc234")
        }
        if reservesCanopyHandle,
           tree.range(of: #"^tr_[a-z2-7]{52}$"#, options: .regularExpression) == nil {
            throw ArborWireValidationError.invalidValue(
                "A Canopy member must use a self-certifying person Profile TreeID"
            )
        }
        guard !reservesCanopyHandle || localHandle.range(
            of: #"^[a-z0-9](?:[a-z0-9-]{0,62})$"#,
            options: .regularExpression
        ) != nil else {
            throw ArborWireValidationError.invalidValue(
                "Enter a handle using lowercase letters, numbers, and hyphens"
            )
        }
        let locator = "arbor://\(tree)/"
        guard !profile.memberProfiles.contains(locator) else {
            let label = localHandle.isEmpty ? tree : "~\(localHandle)"
            throw ArborWireValidationError.invalidValue("\(label) is already a member")
        }
        if reservesCanopyHandle, profile.memberHandles.contains(localHandle) {
            throw ArborWireValidationError.invalidValue("~\(localHandle) is already reserved on this Canopy")
        }
        var envelope = try requiredFrontmatter(source)
        try envelope.appendMember(profile: locator, handle: reservesCanopyHandle ? localHandle : nil)
        return envelope.source
    }

    private static func scalar(named name: String, in lines: [String]) -> String? {
        let matches = lines.compactMap { line -> String? in
            guard !(line.first?.isWhitespace ?? false),
                  line.hasPrefix(name + ":") else { return nil }
            return decodeScalar(String(line.dropFirst(name.count + 1)))
        }
        return matches.count == 1 ? matches[0] : nil
    }

    private static func decodeScalar(_ raw: String) -> String? {
        let value = raw.trimmingCharacters(in: .whitespaces)
        guard !value.isEmpty else { return nil }
        if value.first == "\"", value.last == "\"",
           let data = value.data(using: .utf8),
           let decoded = try? JSONDecoder().decode(String.self, from: data) { return decoded }
        if value.first == "'", value.last == "'" {
            return String(value.dropFirst().dropLast()).replacingOccurrences(of: "''", with: "'")
        }
        return value
    }

    private static func requiredFrontmatter(_ source: String) throws -> Frontmatter {
        guard let value = Frontmatter(source) else {
            throw ArborWireValidationError.invalidValue("The profile has no frontmatter")
        }
        return value
    }

    private struct Frontmatter {
        let newline: String
        var lines: [String]
        let suffix: String

        init?(_ source: String) {
            let newline = source.contains("\r\n") ? "\r\n" : "\n"
            guard source.hasPrefix("---" + newline),
                  let closing = source.range(of: newline + "---", range: source.index(source.startIndex, offsetBy: 3 + newline.count)..<source.endIndex) else { return nil }
            let header = String(source[..<closing.lowerBound])
            let values = header.components(separatedBy: newline)
            guard values.first == "---" else { return nil }
            self.newline = newline
            self.lines = Array(values.dropFirst())
            self.suffix = String(source[closing.lowerBound...])
        }

        var source: String { (["---"] + lines).joined(separator: newline) + suffix }

        mutating func setScalar(_ value: String?, named name: String) throws {
            let matches = lines.indices.filter { index in
                let line = lines[index]
                return !(line.first?.isWhitespace ?? false) && line.hasPrefix(name + ":")
            }
            guard matches.count <= 1 else {
                throw ArborWireValidationError.invalidValue("The profile contains more than one \(name) field")
            }
            var line: String?
            if let value {
                let quotedValue = try Self.quoted(value)
                line = "\(name): \(quotedValue)"
            }
            if let index = matches.first {
                if let line { lines[index] = line }
                else { lines.remove(at: index) }
            } else if let line {
                let insertion = (lines.firstIndex { $0.hasPrefix("type:") } ?? -1) + 1
                lines.insert(line, at: insertion)
            }
        }

        /// The top-level `members:` line and each indented entry beneath it,
        /// with the lines it spans. Nil without exactly one block list.
        func memberEntries() -> (header: Int, entries: [(lines: Range<Int>, member: Member)])? {
            let headers = lines.indices.filter { !(lines[$0].first?.isWhitespace ?? false) && lines[$0].hasPrefix("members:") }
            guard headers.count == 1, let header = headers.first else { return nil }
            var end = header + 1
            while end < lines.count, lines[end].isEmpty || lines[end].first?.isWhitespace == true { end += 1 }
            var starts: [Int] = []
            var dashIndent: Int?
            for index in (header + 1)..<end {
                let line = lines[index]
                let indent = line.prefix(while: \.isWhitespace).count
                let trimmed = line.dropFirst(indent)
                guard trimmed == "-" || trimmed.hasPrefix("- ") else { continue }
                if dashIndent == nil { dashIndent = indent }
                if indent == dashIndent { starts.append(index) }
            }
            let entries = starts.enumerated().compactMap { offset, start -> (lines: Range<Int>, member: Member)? in
                var stop = offset + 1 < starts.count ? starts[offset + 1] : end
                while stop > start + 1, lines[stop - 1].trimmingCharacters(in: .whitespaces).isEmpty { stop -= 1 }
                var fields: [String: String] = [:]
                var scalar: String?
                for index in start..<stop {
                    var field = lines[index].trimmingCharacters(in: .whitespaces)
                    if index == start { field = String(field.dropFirst()).trimmingCharacters(in: .whitespaces) }
                    guard !field.isEmpty else { continue }
                    // A `key: value` field; a scalar locator's `arbor:` has no space after it.
                    if let colon = field.firstIndex(of: ":"),
                       field[field.startIndex..<colon].allSatisfy({ $0.isLetter }),
                       field.index(after: colon) == field.endIndex || field[field.index(after: colon)] == " " {
                        fields[String(field[..<colon])] = ArborProfileDocument.decodeScalar(String(field[field.index(after: colon)...]))
                    } else if index == start {
                        scalar = ArborProfileDocument.decodeScalar(field)
                    }
                }
                guard let profile = fields["profile"] ?? scalar else { return nil }
                return (start..<stop, Member(profile: profile, handle: fields["handle"]))
            }
            return (header, entries)
        }

        mutating func appendMember(profile: String, handle: String?) throws {
            let matches = lines.indices.filter { index in
                let line = lines[index]
                return !(line.first?.isWhitespace ?? false) && line.hasPrefix("members:")
            }
            guard matches.count <= 1 else {
                throw ArborWireValidationError.invalidValue("The profile contains more than one members field")
            }
            let memberLines = try Self.memberLines(profile: profile, handle: handle)
            guard let index = matches.first else {
                lines.append("members:")
                lines.append(contentsOf: memberLines)
                return
            }
            let inline = String(lines[index].dropFirst("members:".count)).trimmingCharacters(in: .whitespaces)
            if inline == "[]" {
                lines.replaceSubrange(index...index, with: ["members:"] + memberLines)
                return
            }
            guard inline.isEmpty else {
                throw ArborWireValidationError.invalidValue("This members layout cannot be edited safely")
            }
            var insertion = index + 1
            while insertion < lines.count {
                let line = lines[insertion]
                if !line.isEmpty, !(line.first?.isWhitespace ?? false) { break }
                insertion += 1
            }
            lines.insert(contentsOf: memberLines, at: insertion)
        }

        static func memberLines(profile: String, handle: String?) throws -> [String] {
            let quotedProfile = try quoted(profile)
            var result = ["  - profile: \(quotedProfile)"]
            if let handle, !handle.isEmpty {
                let quotedHandle = try quoted(handle)
                result.append("    handle: \(quotedHandle)")
            }
            return result
        }

        private static let scalarEncoder: JSONEncoder = {
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.withoutEscapingSlashes]
            return encoder
        }()

        /// A double-quoted YAML scalar: JSON string syntax is valid YAML.
        static func quoted(_ value: String) throws -> String {
            String(decoding: try scalarEncoder.encode(value), as: UTF8.self)
        }
    }
}

/// The canonical path segment a new group takes from its name.
enum ArborGroupSlug {
    static func make(from name: String) -> String {
        let folded = name.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil).lowercased()
        var slug = ""
        for scalar in folded.unicodeScalars {
            if ("a"..."z").contains(scalar) || ("0"..."9").contains(scalar) {
                slug.unicodeScalars.append(scalar)
            } else if !slug.isEmpty, !slug.hasSuffix("-") {
                slug.append("-")
            }
        }
        while slug.hasSuffix("-") { slug.removeLast() }
        return String(slug.prefix(63)).trimmingCharacters(in: CharacterSet(charactersIn: "-"))
    }

    static func isValid(_ slug: String) -> Bool {
        slug.range(of: #"^[a-z0-9](?:[a-z0-9-]{0,62})$"#, options: .regularExpression) != nil
    }
}

/// Where New Group puts a group, as the canonical path before its slug.
/// These are Canopy's conventions; the Canopy decides which it allows.
enum ArborGroupPlacement: String, CaseIterable, Identifiable {
    case groupsFolder, canopy
    var id: Self { self }

    var label: String {
        switch self {
        case .groupsFolder: "In my groups folder"
        case .canopy: "On the Canopy"
        }
    }

    func prefix(handle: String) -> String {
        switch self {
        case .groupsFolder: "/~\(handle)/groups/"
        case .canopy: "/~"
        }
    }
}

extension DirectoryPerson {
    /// The Canopy's own membership profile: the group hosted at its root.
    var isCommunityProfile: Bool {
        entry.kind == "group" && entry.locator.flatMap(URL.init(string:)).map { ["", "/"].contains($0.path) } == true
    }
}
