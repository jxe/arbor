import StoryKit
import Overstory
import OverstoryClient
import OverstoryWorkingTree
import Foundation

/// A remote tree the app opened by locator without placing it. Visits are
/// app-side: the same working-tree client, read-only, anonymous unless an
/// account at the same origin holds a credential.
struct VisitedTreeRecord: Codable, Equatable, Sendable {
    var version = 1
    var origin: URL
    var tree: ProtocolTreeDescriptor
    /// The locator the visit was opened with, normalized to its root.
    var locator: String
    var visitedAt: Date

    init(origin: URL, tree: ProtocolTreeDescriptor, locator: String, visitedAt: Date = .now) {
        self.origin = origin
        self.tree = tree
        self.locator = locator
        self.visitedAt = visitedAt
    }
}

private struct VisitedTreeCollection: Codable {
    var version = 1
    var visits: [VisitedTreeRecord]
}

/// `Visits.json` beside `Native Placement.json`: the most recent visit first,
/// one entry per tree, bounded.
actor VisitedTreeStore {
    static let limit = 50
    private let url: URL

    init(url: URL = StorySupportDirectories.visitedTrees) {
        self.url = url
    }

    func loadAll() throws -> [VisitedTreeRecord] {
        guard FileManager.default.fileExists(atPath: url.path) else { return [] }
        let collection = try JSONDecoder.visits.decode(VisitedTreeCollection.self, from: Data(contentsOf: url))
        guard collection.version == 1 else {
            throw ProtocolValidationError.invalidValue("Unsupported visit collection")
        }
        return collection.visits
    }

    func record(_ visit: VisitedTreeRecord) throws {
        _ = try visit.tree.validated()
        var visits = try loadAll()
        visits.removeAll { $0.tree.id == visit.tree.id }
        visits.insert(visit, at: 0)
        if visits.count > Self.limit { visits.removeLast(visits.count - Self.limit) }
        try write(VisitedTreeCollection(visits: visits))
    }

    func forget(tree: String) throws {
        var visits = try loadAll()
        visits.removeAll { $0.tree.id == tree }
        try write(VisitedTreeCollection(visits: visits))
    }

    func clear() throws {
        guard FileManager.default.fileExists(atPath: url.path) else { return }
        try FileManager.default.removeItem(at: url)
    }

    private func write(_ collection: VisitedTreeCollection) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder.visits.encode(collection).write(to: url, options: .atomic)
    }
}

private extension JSONEncoder {
    static let visits: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }()
}

private extension JSONDecoder {
    static let visits: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }()
}

/// Where a locator points on the protocol: the host origin and the canonical
/// path beneath it. `overstory://host/path` is the HTTPS origin `host`; an HTTP(S)
/// URL keeps its scheme, host, and port. Query and fragment are dropped.
struct OverstoryRemoteLocator: Equatable, Sendable {
    let origin: URL
    let path: String
    /// `…;overstory-config`: the configuration of the tree whose root `path` names.
    let configuration: Bool

    init?(_ locator: String) {
        guard let url = URL(string: locator.trimmingCharacters(in: .whitespacesAndNewlines)),
              let scheme = url.scheme?.lowercased(),
              let host = url.host(), !host.isEmpty else { return nil }
        var components = URLComponents()
        components.host = host
        components.port = url.port
        switch scheme {
        case "overstory": components.scheme = url.port == nil ? "https" : "http"
        case "http", "https": components.scheme = scheme
        default: return nil
        }
        guard let origin = components.url else { return nil }
        self.origin = origin
        // Read the parameter from the encoded path: a `%3B` filename is data.
        let encoded = splittingTreeConfigurationParameter(url.path(percentEncoded: true))
        self.configuration = encoded.configuration
        let raw = encoded.reference.removingPercentEncoding ?? encoded.reference
        self.path = raw.isEmpty ? "/" : raw
    }

    /// The locator string for `path` at this origin, as the address bar shows it.
    func locator(path: String) -> String {
        var components = URLComponents(url: origin, resolvingAgainstBaseURL: false)!
        components.percentEncodedPath = path
            .split(separator: "/")
            .map { $0.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? String($0) }
            .joined(separator: "/")
            .withLeadingSlash
        return components.url?.absoluteString ?? origin.absoluteString + path
    }

    var rootLocator: String { locator(path: "/") }
}

private extension String {
    var withLeadingSlash: String { hasPrefix("/") ? self : "/" + self }
}

/// What an `overstory://` URL handed to the app by the system asks for
/// (the app registers the `overstory` scheme). A join link is an account
/// locator carrying `#overstory-invite=<code>` (accounts §1.2) and starts the
/// claim; any other locator is opened as Open Location opens it.
enum StoryIncomingLocator: Equatable, Sendable {
    /// `account` is the account's HTTP(S) locator at its host, as the claim takes it.
    case join(account: String, code: String)
    /// `locator` is the `overstory://` locator without query or fragment.
    case open(locator: String)

    init?(_ url: URL) {
        guard url.scheme?.lowercased() == "overstory" else { return nil }
        let text = url.absoluteString
        guard case let .overstory(authority, _, state)? = resolveLogicalURL(sourceDirectory: "/", href: text) else { return nil }
        if state.invite != nil {
            guard let join = Self.pastedJoinLink(text) else { return nil }
            self = join
            return
        }
        // Open Location visits a host; a bare TreeID names no host to ask.
        guard case .dns = authority else { return nil }
        let end = text.firstIndex { $0 == "?" || $0 == "#" } ?? text.endIndex
        self = .open(locator: String(text[..<end]))
    }

    /// An invitation link someone pasted, in either spelling
    /// (`https://<host>/~<handle>#overstory-invite=<code>` or the same under
    /// `overstory://`), as the `.join` it asks for; nil for anything else.
    static func pastedJoinLink(_ text: String) -> StoryIncomingLocator? {
        let link = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard case let .overstory(.dns, _, state)? = resolveLogicalURL(sourceDirectory: "/", href: link),
              let code = state.invite,
              let account = ProfileLocator(link)?.locator
        else { return nil }
        return .join(account: account, code: code)
    }

    /// The join link the Add Person sheet shows for `handle` at `hostOrigin`:
    /// `https://<host>/~<handle>#overstory-invite=<code>`.
    static func joinLink(hostOrigin: String, handle: String, code: String) -> String? {
        let name = handle.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "~"))
        guard !name.isEmpty else { return nil }
        let account = hostOrigin.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/~" + name
        return buildInviteLocator(account: account, code: code)
    }
}
