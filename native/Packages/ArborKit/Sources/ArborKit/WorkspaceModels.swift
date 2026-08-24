import Foundation

public struct TreeID: RawRepresentable, Hashable, Codable, Sendable, ExpressibleByStringLiteral {
    public var rawValue: String

    public init(rawValue: String) { self.rawValue = rawValue }
    public init(stringLiteral value: String) { self.rawValue = value }
}

public struct PageID: RawRepresentable, Hashable, Codable, Sendable, ExpressibleByStringLiteral {
    public var rawValue: String

    public init(rawValue: String) { self.rawValue = rawValue }
    public init(stringLiteral value: String) { self.rawValue = value }
}

public struct WorkspaceReference: Hashable, Codable, Sendable {
    public var tree: TreeID
    public var pageID: PageID?
    public var pathHint: String

    public init(tree: TreeID, path: String, pageID: PageID? = nil) {
        self.tree = tree
        self.pageID = pageID
        self.pathHint = Self.normalized(path)
    }

    public var parent: WorkspaceReference? {
        guard pathHint != "/" else { return nil }
        let components = pathHint.split(separator: "/")
        let path = components.dropLast().isEmpty ? "/" : "/" + components.dropLast().joined(separator: "/")
        return WorkspaceReference(tree: tree, path: path)
    }

    public var identity: WorkspaceIdentity {
        if let pageID { return .page(tree: tree, pageID: pageID) }
        return .path(tree: tree, path: pathHint)
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

public enum WorkspaceIdentity: Hashable, Codable, Sendable {
    case page(tree: TreeID, pageID: PageID)
    case path(tree: TreeID, path: String)
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

public struct WorkspaceProvenance: Hashable, Codable, Sendable {
    public var authority: WorkspaceAuthority
    public var sourceDescription: String
    public var physicalURL: URL?
    public var contentRevision: String?

    public init(
        authority: WorkspaceAuthority,
        sourceDescription: String,
        physicalURL: URL? = nil,
        contentRevision: String? = nil
    ) {
        self.authority = authority
        self.sourceDescription = sourceDescription
        self.physicalURL = physicalURL
        self.contentRevision = contentRevision
    }
}

public enum WorkspaceSurface: Hashable, Codable, Sendable {
    case markdown(source: String, contentRevision: String)
    case directory(summary: String?)
    case directoryDocument(source: String, contentRevision: String, stored: Bool)
    case file(name: String, byteCount: Int, mediaType: String?)
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
    public var title: String
    public var surface: WorkspaceSurface
    public var provenance: WorkspaceProvenance
    public var materialization: WorkspaceMaterialization
    public var isWritable: Bool

    public init(
        reference: WorkspaceReference,
        title: String,
        surface: WorkspaceSurface,
        provenance: WorkspaceProvenance,
        materialization: WorkspaceMaterialization = .available,
        isWritable: Bool = true
    ) {
        self.reference = reference
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
