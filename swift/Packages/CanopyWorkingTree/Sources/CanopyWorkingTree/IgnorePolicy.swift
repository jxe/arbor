import Foundation

/// Filesystem membership for a folder: which local paths belong to its tree.
///
/// A port of `packages/fs/src/ignore-policy.ts`, which Arbor Sync applies to
/// every placed folder; `tests/fixtures/ignore-policy/cases.json` holds both
/// to the same answers. Mandatory exclusions are tooling and platform state
/// that is never tree content. User rules come from `.arborignore` and
/// `.gitignore` in the directory they apply from, in Git's pattern grammar;
/// Git itself, `.git/info/exclude` and machine-global ignore files are never
/// read. Rule files are read once, on first use beneath their directory.
/// Paths are tree paths (`/a/b`) relative to `root`.
public final class IgnorePolicy {
    public enum Membership: String, Sendable {
        case included, mandatory, ignored
    }

    public struct Decision: Equatable, Sendable {
        public var membership: Membership
        /// For `ignored`: the tree path of the ignore file whose rule decided.
        public var source: String?
        /// For `ignored`: that rule as written.
        public var pattern: String?
    }

    /// An ignore file whose rules do not apply. It names the file, never its contents.
    public struct Diagnostic: Equatable, Sendable {
        public var code: String
        public var path: String
        public var message: String
    }

    /// Directory names that are never tree content, wherever they appear.
    public static let mandatoryDirectoryNames: Set<String> = [".git", "node_modules", ".arbor", "Trash", ".build", "DerivedData"]
    /// Ignore-rule files, lowest precedence first: `.arborignore` wins over `.gitignore` beside it.
    public static let ignoreFileNames = [".gitignore", ".arborignore"]

    public let root: URL
    public private(set) var diagnostics: [Diagnostic] = []
    private let excluded: [String]
    private var files: [String: [RuleFile]] = [:]
    private var directories: [String: Decision] = [:]

    /// `excludedRoots` are nested tree mounts, whose content belongs to another tree.
    public init(root: URL, excludedRoots: [URL] = []) {
        let root = root.standardizedFileURL.resolvingSymlinksInPath()
        self.root = root
        excluded = excludedRoots.compactMap { url in
            let path = url.standardizedFileURL.resolvingSymlinksInPath().path
            guard path.hasPrefix(root.path + "/") else { return nil }
            return String(path.dropFirst(root.path.count))
        }
    }

    /// Whether `treePath` is tree content, never tree content, or kept out by a user rule.
    public func decision(_ treePath: String, isDirectory: Bool) -> Decision {
        let segments = Self.segments(treePath)
        if segments.isEmpty { return .included }
        if mandatory(segments, isDirectory: isDirectory) { return .mandatory }
        return ruled(segments, isDirectory: isDirectory)
    }

    static func isTransactionTemporaryName(_ name: String) -> Bool {
        name.contains(".arbor-write-") || name.contains(".arbor-txn-")
    }

    static func isCloudPlaceholderName(_ name: String) -> Bool {
        name.hasPrefix(".") && name.hasSuffix(".icloud") && name.count > ".icloud".count + 1
    }

    private func mandatory(_ segments: [String], isDirectory: Bool) -> Bool {
        let path = Self.treePath(segments)
        if excluded.contains(where: { path == $0 || path.hasPrefix($0 + "/") }) { return true }
        return segments.indices.contains { index in
            let name = segments[index]
            return Self.isTransactionTemporaryName(name)
                || Self.isCloudPlaceholderName(name)
                || ((index < segments.count - 1 || isDirectory) && Self.mandatoryDirectoryNames.contains(name))
        }
    }

    private func ruled(_ segments: [String], isDirectory: Bool) -> Decision {
        if segments.count > 1 {
            let parent = directory(Array(segments.dropLast()))
            if parent.membership != .included { return parent }
        }
        if !isDirectory, Self.ignoreFileNames.contains(segments[segments.count - 1]) { return .included }
        // Deeper files override shallower ones, and within a file the last matching rule wins.
        for depth in stride(from: segments.count - 1, through: 0, by: -1) {
            let relativePath = segments[depth...].joined(separator: "/")
            for file in rules(in: Array(segments[..<depth])).reversed() {
                for rule in file.rules.reversed() where rule.matches(relativePath, isDirectory: isDirectory) {
                    return rule.negative ? .included : Decision(membership: .ignored, source: file.source, pattern: rule.pattern)
                }
            }
        }
        return .included
    }

    private func directory(_ segments: [String]) -> Decision {
        let key = Self.treePath(segments)
        if let decision = directories[key] { return decision }
        let decision = ruled(segments, isDirectory: true)
        directories[key] = decision
        return decision
    }

    private func rules(in segments: [String]) -> [RuleFile] {
        let key = Self.treePath(segments)
        if let loaded = files[key] { return loaded }
        let loaded = Self.ignoreFileNames.compactMap { readRules(segments + [$0]) }
        files[key] = loaded
        return loaded
    }

    private func readRules(_ segments: [String]) -> RuleFile? {
        let source = Self.treePath(segments)
        let url = segments.reduce(root) { $0.appendingPathComponent($1) }
        // A symbolic link is not tree content, so its target contributes no rules.
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: url.path),
              attributes[.type] as? FileAttributeType == .typeRegular else { return nil }
        guard let data = try? Data(contentsOf: url) else {
            diagnostics.append(Diagnostic(code: "ignore-file-unreadable", path: source,
                                          message: "\(source) could not be read, so none of its ignore rules apply."))
            return nil
        }
        guard let text = String(data: data, encoding: .utf8) else {
            diagnostics.append(Diagnostic(code: "ignore-file-not-utf8", path: source,
                                          message: "\(source) is not valid UTF-8, so none of its ignore rules apply."))
            return nil
        }
        return RuleFile(source: source, rules: Rule.parse(text))
    }

    private static func segments(_ treePath: String) -> [String] {
        treePath.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
    }

    private static func treePath(_ segments: [String]) -> String {
        "/" + segments.joined(separator: "/")
    }
}

extension IgnorePolicy.Decision {
    static let included = IgnorePolicy.Decision(membership: .included)
    static let mandatory = IgnorePolicy.Decision(membership: .mandatory)
}

private struct RuleFile {
    var source: String
    var rules: [Rule]
}

/// One line of an ignore file, compiled to a regular expression with Git's
/// wildmatch semantics (`WM_PATHNAME`). The expression uses only syntax that
/// ICU and JavaScript read alike, so it matches what the TypeScript rule does.
private struct Rule {
    var pattern: String
    var negative: Bool
    var directoryOnly: Bool
    /// Match the basename at any depth, rather than the path from the rule's directory.
    var basename: Bool
    var regex: NSRegularExpression

    func matches(_ relativePath: String, isDirectory: Bool) -> Bool {
        if directoryOnly && !isDirectory { return false }
        let subject = basename ? String(relativePath.split(separator: "/", omittingEmptySubsequences: false).last ?? "") : relativePath
        let range = NSRange(subject.startIndex..<subject.endIndex, in: subject)
        return regex.firstMatch(in: subject, options: [.anchored], range: range) != nil
    }

    /// One ignore file's rules, in file order.
    static func parse(_ text: String) -> [Rule] {
        var text = text
        if text.unicodeScalars.first == "\u{FEFF}" { text.unicodeScalars.removeFirst() }
        var rules: [Rule] = []
        // By scalar: "\r\n" is one Character, so a Character split would miss it.
        for raw in text.unicodeScalars.split(separator: "\n", omittingEmptySubsequences: false) {
            var scalars = Array(raw)
            if scalars.last == "\r" { scalars.removeLast() }
            scalars = trimTrailingSpaces(scalars)
            if scalars.isEmpty || scalars[0] == "#" { continue }
            let line = string(scalars)
            var body = scalars
            let negative = body.first == "!"
            if negative { body.removeFirst() }
            let directoryOnly = body.last == "/"
            if directoryOnly { body.removeLast() }
            if body.isEmpty { continue }
            let basename = !body.contains("/")
            if body.first == "/" { body.removeFirst() }
            // `\z` ends the input exactly, as `$` does in JavaScript without the `m` flag.
            guard let source = wildmatchSource(body),
                  let regex = try? NSRegularExpression(pattern: "^(?:\(source))\\z") else { continue }
            rules.append(Rule(pattern: line, negative: negative, directoryOnly: directoryOnly, basename: basename, regex: regex))
        }
        return rules
    }

    /// Remove trailing spaces that are not escaped with a backslash.
    private static func trimTrailingSpaces(_ line: [Unicode.Scalar]) -> [Unicode.Scalar] {
        var end = 0
        var index = 0
        while index < line.count {
            if line[index] == "\\" {
                index += 1
                end = min(index + 1, line.count)
            } else if line[index] != " " {
                end = index + 1
            }
            index += 1
        }
        return Array(line[..<end])
    }

    private static func string(_ scalars: some Sequence<Unicode.Scalar>) -> String {
        var result = ""
        result.unicodeScalars.append(contentsOf: scalars)
        return result
    }

    /// A regular-expression literal for one scalar. A backslash before ASCII
    /// punctuation is always literal in ICU, inside a set too, where `&&`,
    /// `--` and `{}` would otherwise be set syntax.
    private static func escape(_ scalar: Unicode.Scalar) -> String {
        let punctuation = (0x21...0x7E).contains(scalar.value) && !scalar.properties.isAlphabetic && !("0"..."9").contains(scalar)
        return punctuation ? "\\" + String(scalar) : String(scalar)
    }

    private static let posixClasses: [String: String] = [
        "alnum": "a-zA-Z0-9",
        "alpha": "a-zA-Z",
        "blank": " \\t",
        "digit": "0-9",
        "lower": "a-z",
        "space": " \\t\\n\\r\\f\\x0B",
        "upper": "A-Z",
        "xdigit": "0-9a-fA-F",
    ]

    /// Git's wildmatch as a regular-expression body; nil when the pattern can match nothing.
    private static func wildmatchSource(_ characters: [Unicode.Scalar]) -> String? {
        var source = ""
        var index = 0
        while index < characters.count {
            let character = characters[index]
            if character == "*" {
                var end = index
                while end < characters.count && characters[end] == "*" { end += 1 }
                let doubled = end - index >= 2
                let opensSegment = index == 0 || characters[index - 1] == "/"
                let closesSegment = end == characters.count || characters[end] == "/"
                if doubled && opensSegment && closesSegment {
                    if end == characters.count {
                        source += "[\\s\\S]*"
                        index = end
                    } else {
                        source += "(?:[\\s\\S]*/)?"
                        index = end + 1
                    }
                    continue
                }
                source += "[^/]*"
                index = end
                continue
            }
            if character == "?" {
                source += "[^/]"
                index += 1
                continue
            }
            if character == "[" {
                guard let (fragment, next) = bracket(characters, start: index) else { return nil }
                source += fragment
                index = next
                continue
            }
            if character == "\\" {
                guard index + 1 < characters.count else { return nil }
                source += escape(characters[index + 1])
                index += 2
                continue
            }
            source += escape(character)
            index += 1
        }
        return source
    }

    /// A bracket expression beginning at `start` (the `[`) and the index after
    /// it; nil when it is malformed or has no members, which makes the whole
    /// pattern match nothing, as in Git.
    private static func bracket(_ characters: [Unicode.Scalar], start: Int) -> (String, Int)? {
        func at(_ index: Int) -> Unicode.Scalar? { index < characters.count ? characters[index] : nil }
        var index = start + 1
        let negated = at(index) == "!" || at(index) == "^"
        if negated { index += 1 }
        var members = ""
        var first = true
        while index < characters.count {
            var character = characters[index]
            if character == "]" && !first {
                // A bracket expression never matches `/`.
                if !negated && members.isEmpty { return nil }
                return (negated ? "[^/\(members)]" : "(?:(?!/)[\(members)])", index + 1)
            }
            first = false
            if character == "[" && at(index + 1) == ":" {
                guard let close = characters[(index + 2)...].firstIndex(of: ":"), at(close + 1) == "]",
                      let range = posixClasses[string(characters[(index + 2)..<close])] else { return nil }
                members += range
                index = close + 2
                continue
            }
            if character == "\\" {
                index += 1
                guard index < characters.count else { return nil }
                character = characters[index]
            }
            if at(index + 1) == "-", let rangeEnd = at(index + 2), rangeEnd != "]" {
                var end = rangeEnd
                var after = index + 3
                if end == "\\" {
                    guard let escaped = at(index + 3) else { return nil }
                    end = escaped
                    after = index + 4
                }
                // An inverted range matches nothing.
                if character.value <= end.value { members += escape(character) + "-" + escape(end) }
                index = after
                continue
            }
            members += escape(character)
            index += 1
        }
        return nil
    }
}
