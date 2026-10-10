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

/// Where a locator points on the protocol: the Canopy origin and the canonical
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
        case "story": components.scheme = url.port == nil ? "https" : "http"
        case "http", "https": components.scheme = scheme
        default: return nil
        }
        guard let origin = components.url else { return nil }
        self.origin = origin
        // Read the parameter from the encoded path: a `%3B` filename is data.
        let suffix = ";overstory-config"
        self.configuration = url.path(percentEncoded: true).hasSuffix(suffix)
        var raw = url.path(percentEncoded: false)
        if configuration { raw.removeLast(suffix.count) }
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

/// A complete Canopy snapshot reduced to the sparse shape a working tree
/// installs: every directory object and every Markdown object stay, every
/// other file becomes a hash the object store serves on demand.
enum StoryVisitSnapshot {
    struct Sparse: Sendable {
        var spine: ProtocolSnapshot
    }

    static func sparsified(_ snapshot: ProtocolSnapshot) throws -> Sparse {
        let objects = try ProtocolObjectGraph.validate(snapshot, mode: .complete)
        var keep = Set<String>()
        var visited = Set<String>()

        func visit(_ hash: String, path: String) {
            guard case let .directory(entries, _)? = objects[hash] else { return }
            keep.insert(hash)
            guard visited.insert(hash).inserted else { return }
            for entry in entries {
                guard let child = entry.hash else { continue }
                let childPath = path == "/" ? "/\(entry.name)" : "\(path)/\(entry.name)"
                switch objects[child] {
                case .directory:
                    visit(child, path: childPath)
                case .file?:
                    if entry.name.hasSuffix(".md") || entry.name.hasSuffix(".mdx") {
                        keep.insert(child)
                    }
                case nil:
                    continue
                }
            }
        }
        visit(snapshot.root, path: "/")
        let spine = ProtocolSnapshot(root: snapshot.root, objects: snapshot.objects.filter { keep.contains($0.hash) })
        return Sparse(spine: spine)
    }

    /// The replacement a visit installs: the sparse spine with omitted file
    /// payloads retained as hash references.
    static func replacement(
        _ snapshot: ProtocolSnapshot,
        tree: TreeID,
        update: String,
        cursor: String?
    ) throws -> WorkingTreeSystemReplacement {
        let sparse = try sparsified(snapshot)
        return try SnapshotBridge.replacement(
            snapshot: sparse.spine,
            tree: tree,
            update: update,
            cursor: cursor,
            mode: .sparseFiles
        )
    }
}

/// Follows a visited tree's protocol watch. An accepted update that chains
/// from what the visit holds is replayed from the event's own transitions; a
/// gap, or a batch that does not chain, re-pulls the current snapshot. There is
/// no coordinator: a visit never submits.
struct StoryVisitFollower: Sendable {
    var client: ProtocolClient
    var tree: String
    var workingTree: WorkingTree
    var maximumReconnectDelay: Duration = .seconds(5)
    var onChange: @Sendable () async -> Void = {}

    func start(after cursor: String?) -> Task<Void, Never> {
        Task { await run(after: cursor) }
    }

    func run(after cursor: String?) async {
        var after = cursor
        await runObservationLoop(maximumDelay: maximumReconnectDelay) { connected in
            do {
                let events = try await client.watch(tree: tree, after: after)
                for try await event in events {
                    connected()
                    try Task.checkCancellation()
                    after = event.id
                    guard event.treeID == tree else { continue }
                    let heads = try await workingTree.heads()
                    if event.update.root == heads.materializedRoot {
                        try await workingTree.recordAccepted(root: event.update.root, update: event.update.id, cursor: event.id)
                        continue
                    }
                    if (try? await workingTree.applyAcceptedTransitions(event)) == nil {
                        try await pull(root: event.update.root, update: event.update.id, cursor: event.id)
                    }
                    await onChange()
                }
            } catch let error as ProtocolHTTPError where error.code == "resync-required" {
                after = try await pullCurrent()
                connected()
                await onChange()
            }
            return .reconnect
        }
    }

    /// Re-pull the descriptor and its snapshot; returns the cursor to watch after.
    @discardableResult
    func pullCurrent() async throws -> String {
        let current = try await client.descriptor(tree: tree)
        let heads = try await workingTree.heads()
        if current.tree.root != heads.materializedRoot {
            try await pull(root: current.tree.root, update: current.tree.update, cursor: current.observedThrough)
        }
        return current.observedThrough
    }

    private func pull(root: String, update: String, cursor: String) async throws {
        let snapshot = try await client.snapshot(tree: tree, root: root)
        let replacement = try StoryVisitSnapshot.replacement(
            snapshot,
            tree: TreeID(rawValue: tree),
            update: update,
            cursor: cursor
        )
        try await workingTree.replaceFromSystem(replacement)
    }
}
