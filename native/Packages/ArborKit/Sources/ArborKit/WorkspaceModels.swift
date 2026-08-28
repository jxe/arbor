import Foundation

public struct TreeID: RawRepresentable, Hashable, Codable, Sendable, ExpressibleByStringLiteral {
    public var rawValue: String

    public init(rawValue: String) { self.rawValue = rawValue }
    public init(stringLiteral value: String) { self.rawValue = value }
}

@available(*, deprecated, message: "Use WorkspaceReference.stableKey")
public struct PageID: RawRepresentable, Hashable, Codable, Sendable, ExpressibleByStringLiteral {
    public var rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public init(stringLiteral value: String) { self.rawValue = value }
}

public struct WorkspaceReference: Hashable, Codable, Sendable {
    public var tree: TreeID
    public var path: String
    public var stableKey: String?

    public init(tree: TreeID, path: String, stableKey: String? = nil) {
        self.tree = tree
        self.path = Self.normalized(path)
        self.stableKey = stableKey
    }

    @available(*, deprecated, message: "Pass the canonical stable key")
    public init(tree: TreeID, path: String, pageID: PageID?) {
        self.init(tree: tree, path: path, stableKey: pageID.map { markdownStableKey($0.rawValue) })
    }

    @available(*, deprecated, message: "Use path")
    public var pathHint: String {
        get { path }
        set { path = Self.normalized(newValue) }
    }

    @available(*, deprecated, message: "Use stableKey")
    public var pageID: PageID? {
        get { markdownID(fromStableKey: stableKey).map(PageID.init(rawValue:)) }
        set { stableKey = newValue.map { markdownStableKey($0.rawValue) } }
    }

    public var parent: WorkspaceReference? {
        guard path != "/" else { return nil }
        let components = path.split(separator: "/")
        let path = components.dropLast().isEmpty ? "/" : "/" + components.dropLast().joined(separator: "/")
        return WorkspaceReference(tree: tree, path: path)
    }

    public var identity: WorkspaceIdentity {
        if let stableKey { return .key(tree: tree, stableKey: stableKey) }
        return .path(tree: tree, path: path)
    }

    private static func normalized(_ path: String) -> String {
        let parts = path.split(separator: "/").filter { $0 != "." }
        var result: [Substring] = []
        for part in parts {
            if part == ".." { _ = result.popLast() }
            else { result.append(part) }
        }
        return result.isEmpty ? "/" : "/" + result.joined(separator: "/")
    }
}

/// The address a browser tab follows. A location deliberately remains
/// separate from the resolved `WorkspaceReference`: local filesystem
/// navigation must retain its absolute path when arborsync resolves a node into
/// an enclosing Arbor tree, while document and mutation APIs use that stable
/// resolved identity.
public enum WorkspaceLocation: Hashable, Codable, Sendable {
    case localPath(String)
    case reference(WorkspaceReference)
    case remote(locator: String, rootLocator: String)

    public static func local(_ path: String) -> WorkspaceLocation {
        .localPath(Self.normalizedLocalPath(path))
    }

    public var parent: WorkspaceLocation? {
        switch self {
        case let .localPath(path):
            guard path != "/" else { return nil }
            return .local(URL(fileURLWithPath: path).deletingLastPathComponent().path)
        case let .reference(reference):
            return reference.parent.map(WorkspaceLocation.reference)
        case let .remote(locator, rootLocator):
            guard let current = URL(string: locator), let root = URL(string: rootLocator) else { return nil }
            let currentPath = current.path.removingPercentEncoding ?? current.path
            let rootPath = root.path.removingPercentEncoding ?? root.path
            guard currentPath != rootPath, currentPath.hasPrefix(rootPath == "/" ? "/" : "\(rootPath)/") else {
                return nil
            }
            let parentPath = URL(fileURLWithPath: currentPath).deletingLastPathComponent().path
            var components = URLComponents(url: current, resolvingAgainstBaseURL: false)
            components?.percentEncodedPath = parentPath
                .split(separator: "/")
                .map { $0.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? String($0) }
                .joined(separator: "/")
                .withLeadingSlash
            guard let parent = components?.url?.absoluteString else { return nil }
            return .remote(locator: parent, rootLocator: rootLocator)
        }
    }

    public var pathHint: String {
        switch self {
        case let .localPath(path): path
        case let .reference(reference): reference.path
        case let .remote(locator, _):
            URL(string: locator)?.path.removingPercentEncoding ?? locator
        }
    }

    public var reference: WorkspaceReference? {
        guard case let .reference(reference) = self else { return nil }
        return reference
    }

    private static func normalizedLocalPath(_ path: String) -> String {
        URL(fileURLWithPath: path).standardizedFileURL.path
    }
}

private extension String {
    var withLeadingSlash: String { hasPrefix("/") ? self : "/\(self)" }
}

public enum WorkspaceIdentity: Hashable, Codable, Sendable {
    case key(tree: TreeID, stableKey: String)
    case path(tree: TreeID, path: String)
}

/// The current Markdown `id` representation projected into the generic node-key slot.
public func markdownStableKey(_ id: String) -> String {
    let data = try! JSONSerialization.data(withJSONObject: [["id", id]], options: [.sortedKeys])
    return String(decoding: data, as: UTF8.self)
}

/// Bounded bridge used only where the physical Markdown representation stores `id`.
public func markdownID(fromStableKey stableKey: String?) -> String? {
    guard let stableKey,
          let data = stableKey.data(using: .utf8),
          let value = try? JSONSerialization.jsonObject(with: data) as? [[Any]],
          value.count == 1,
          value[0].count == 2,
          value[0][0] as? String == "id"
    else { return nil }
    return value[0][1] as? String
}

public enum WorkspaceAuthority: String, Hashable, Codable, Sendable {
    case local
    case synchronized
    case historical
    case diagnostic
}

public enum WorkspaceMaterialization: String, Hashable, Codable, Sendable {
    case available
    case downloading
    case placeholder
    case unavailable
}

public enum WorkspaceSynchronization: String, Hashable, Codable, Sendable {
    case offline
    case locallyPending
    case requestPending
    case uploading
    case downloading
    case current
    case autoMerged
    case approximatePlacement
    case conflict
    case authenticationFailure
    case revoked
}

public struct WorkspaceSyncPresentation: Hashable, Codable, Sendable {
    public var state: WorkspaceSynchronization
    public var detail: String?
    public var acceptedRoot: String?
    public var localRoot: String?
    public var localAdditions: Bool
    public var remoteAdditions: Bool
    public var approximatePlacements: Int

    public init(
        state: WorkspaceSynchronization,
        detail: String? = nil,
        acceptedRoot: String? = nil,
        localRoot: String? = nil,
        localAdditions: Bool = false,
        remoteAdditions: Bool = false,
        approximatePlacements: Int = 0
    ) {
        self.state = state
        self.detail = detail
        self.acceptedRoot = acceptedRoot
        self.localRoot = localRoot
        self.localAdditions = localAdditions
        self.remoteAdditions = remoteAdditions
        self.approximatePlacements = approximatePlacements
    }
}

public struct WorkspaceProvenance: Hashable, Codable, Sendable {
    public var authority: WorkspaceAuthority
    public var sourceDescription: String
    public var physicalURL: URL?
    public var treeRootURL: URL?
    public var contentRevision: String?

    public init(
        authority: WorkspaceAuthority,
        sourceDescription: String,
        physicalURL: URL? = nil,
        treeRootURL: URL? = nil,
        contentRevision: String? = nil
    ) {
        self.authority = authority
        self.sourceDescription = sourceDescription
        self.physicalURL = physicalURL
        self.treeRootURL = treeRootURL
        self.contentRevision = contentRevision
    }
}

public enum WorkspaceSurface: Hashable, Codable, Sendable {
    case markdown(source: String, contentRevision: String)
    case directory(summary: String?)
    case directoryDocument(source: String, contentRevision: String, stored: Bool)
    case file(name: String, byteCount: Int?, mediaType: String?)
    case collection(kind: String, rowCount: Int?)
    case placeholder(message: String)
    case diagnostic(title: String, detail: String)
    case historical(source: String, revision: String)

    public var supportsDocumentSession: Bool {
        switch self {
        case .markdown, .directoryDocument: true
        default: false
        }
    }

    public var isReadOnly: Bool {
        switch self {
        case .historical, .diagnostic, .placeholder: true
        default: false
        }
    }
}

public struct WorkspaceNode: Hashable, Codable, Sendable, Identifiable {
    public var reference: WorkspaceReference
    public var location: WorkspaceLocation
    public var title: String
    public var surface: WorkspaceSurface
    public var provenance: WorkspaceProvenance
    public var materialization: WorkspaceMaterialization
    public var isWritable: Bool

    public init(
        reference: WorkspaceReference,
        location: WorkspaceLocation? = nil,
        title: String,
        surface: WorkspaceSurface,
        provenance: WorkspaceProvenance,
        materialization: WorkspaceMaterialization = .available,
        isWritable: Bool = true
    ) {
        self.reference = reference
        self.location = location ?? .reference(reference)
        self.title = title
        self.surface = surface
        self.provenance = provenance
        self.materialization = materialization
        self.isWritable = isWritable && !surface.isReadOnly
    }

    public var id: WorkspaceIdentity { reference.identity }
}

public struct WorkspaceSearchResult: Hashable, Codable, Sendable, Identifiable {
    public var reference: WorkspaceReference
    public var title: String
    public var excerpt: String?

    public init(reference: WorkspaceReference, title: String, excerpt: String? = nil) {
        self.reference = reference
        self.title = title
        self.excerpt = excerpt
    }

    public var id: WorkspaceIdentity { reference.identity }
}

public struct WorkspaceHistoryEntry: Hashable, Codable, Sendable, Identifiable {
    public var id: String
    public var revision: String
    public var title: String
    public var timestamp: Date

    public init(id: String, revision: String, title: String, timestamp: Date) {
        self.id = id
        self.revision = revision
        self.title = title
        self.timestamp = timestamp
    }
}

public struct WorkspaceAsset: Hashable, Codable, Sendable {
    public var name: String
    public var mediaType: String?
    public var bytes: Data

    public init(name: String, mediaType: String? = nil, bytes: Data) {
        self.name = name
        self.mediaType = mediaType
        self.bytes = bytes
    }
}

public struct WorkspaceStoredAsset: Hashable, Codable, Sendable {
    public var reference: WorkspaceReference
    public var markdownSource: String

    public init(reference: WorkspaceReference, markdownSource: String) {
        self.reference = reference
        self.markdownSource = markdownSource
    }
}
