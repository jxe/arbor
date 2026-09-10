import ArborKit
import ArborWire
import ArborWorkingTree
import Foundation

/// A remote tree the app opened by locator without placing it. Visits are
/// app-side: the same working-tree client, read-only, anonymous unless an
/// account at the same origin holds a credential.
struct VisitedTreeRecord: Codable, Equatable, Sendable {
    var version = 1
    var origin: URL
    var tree: WireTreeDescriptor
    /// The locator the visit was opened with, normalized to its root.
    var locator: String
    var visitedAt: Date

    init(origin: URL, tree: WireTreeDescriptor, locator: String, visitedAt: Date = .now) {
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

    init(url: URL = ArborSupportDirectories.visitedTrees) {
        self.url = url
    }

    func loadAll() throws -> [VisitedTreeRecord] {
        guard FileManager.default.fileExists(atPath: url.path) else { return [] }
        let collection = try JSONDecoder.visits.decode(VisitedTreeCollection.self, from: Data(contentsOf: url))
        guard collection.version == 1 else {
            throw ArborWireValidationError.invalidValue("Unsupported visit collection")
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

/// Where a locator points on the Wire: the Canopy origin and the canonical
/// path beneath it. `arbor://host/path` is the HTTPS origin `host`; an HTTP(S)
/// URL keeps its scheme, host, and port. Query and fragment are dropped.
struct ArborRemoteLocator: Equatable, Sendable {
    let origin: URL
    let path: String

    init?(_ locator: String) {
        guard let url = URL(string: locator.trimmingCharacters(in: .whitespacesAndNewlines)),
              let scheme = url.scheme?.lowercased(),
              let host = url.host(), !host.isEmpty else { return nil }
        var components = URLComponents()
        components.host = host
        components.port = url.port
        switch scheme {
        case "arbor": components.scheme = url.port == nil ? "https" : "http"
        case "http", "https": components.scheme = scheme
        default: return nil
        }
        guard let origin = components.url else { return nil }
        self.origin = origin
        let raw = url.path(percentEncoded: false)
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
enum ArborVisitSnapshot {
    struct Sparse: Sendable {
        var spine: WireSnapshot
        var files: [String: SparseFileMetadata]
    }

    static func sparsified(_ snapshot: WireSnapshot) throws -> Sparse {
        let objects = try WireObjectGraph.validate(snapshot, mode: .complete)
        var keep = Set<String>()
        var files: [String: SparseFileMetadata] = [:]
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
                case let .file(bytes)?:
                    if entry.name.hasSuffix(".md") || entry.name.hasSuffix(".mdx") {
                        keep.insert(child)
                    } else {
                        files[childPath] = SparseFileMetadata(
                            size: bytes.count,
                            mediaType: SnapshotBridge.inferredMediaType(for: entry.name)
                        )
                    }
                case nil:
                    continue
                }
            }
        }
        visit(snapshot.root, path: "/")
        let spine = WireSnapshot(root: snapshot.root, objects: snapshot.objects.filter { keep.contains($0.hash) })
        return Sparse(spine: spine, files: files)
    }

    /// The replacement a visit installs: the sparse spine bridged with the file
    /// sizes it dropped.
    static func replacement(
        _ snapshot: WireSnapshot,
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
            files: sparse.files
        )
    }
}

/// Follows a visited tree's Wire watch and re-pulls the current snapshot on
/// every accepted update and on a watch gap. There is no coordinator: a visit
/// never submits, so the tree is simply replaced from the server each time.
struct ArborVisitFollower: Sendable {
    var client: ArborWireClient
    var tree: String
    var workingTree: WorkingTree
    var maximumReconnectDelay: Duration = .seconds(5)
    var onChange: @Sendable () async -> Void = {}

    func start(after cursor: String?) -> Task<Void, Never> {
        Task { await run(after: cursor) }
    }

    func run(after cursor: String?) async {
        var lastEventID = cursor
        var reconnectAttempt = 0
        while !Task.isCancelled {
            do {
                let events = try await client.watch(tree: tree, lastEventID: lastEventID)
                reconnectAttempt = 0
                for try await event in events {
                    try Task.checkCancellation()
                    lastEventID = event.id
                    guard event.tree.id == tree else { continue }
                    let heads = try await workingTree.heads()
                    if event.tree.root == heads.materializedRoot {
                        try await workingTree.recordAccepted(root: event.tree.root, update: event.tree.update, cursor: event.id)
                        continue
                    }
                    try await pull(root: event.tree.root, update: event.tree.update, cursor: event.id)
                    await onChange()
                }
            } catch is CancellationError {
                return
            } catch let error as WireHTTPError where error.code == "resync-required" {
                do {
                    lastEventID = try await pullCurrent()
                    reconnectAttempt = 0
                    await onChange()
                } catch {
                    reconnectAttempt += 1
                }
            } catch {
                reconnectAttempt += 1
            }
            let backoff = Duration.milliseconds(250 * (1 << min(reconnectAttempt, 5)))
            do { try await Task.sleep(for: min(backoff, maximumReconnectDelay)) } catch { return }
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
        let replacement = try ArborVisitSnapshot.replacement(
            snapshot,
            tree: TreeID(rawValue: tree),
            update: update,
            cursor: cursor
        )
        try await workingTree.replaceFromSystem(replacement)
    }
}
