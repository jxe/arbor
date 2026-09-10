import ArborKit
import Foundation

public enum WorkingTreeError: Error, Equatable, Sendable {
    case invalidName(String)
    case invalidPath(String)
    case notFound(WorkspaceReference)
    case notDirectory(WorkspaceReference)
    case notDocument(WorkspaceReference)
    case collision(String)
    case readOnly(WorkspaceReference)
    case staleRevision(expected: String, actual: String)
    case pageIDChanged(expected: String, actual: String?)
    case pendingLocalChanges
    case corruptState(String)
    case simulatedCrash(WorkingTreeFailurePoint)
    case closed
}

public enum WorkingTreeFailurePoint: String, Codable, CaseIterable, Sendable {
    case afterJournal
    case afterObjects
    case afterMaterialization
    case afterControl
}

public protocol WorkingTreeFaultInjector: Sendable {
    func reached(_ point: WorkingTreeFailurePoint) throws
}

public struct NoReplicaFaults: WorkingTreeFaultInjector {
    public init() {}
    public func reached(_: WorkingTreeFailurePoint) throws {}
}

public struct WorkingTreeHeads: Codable, Equatable, Sendable {
    public var materializedRoot: String
    public var pendingRoot: String?
    public var acceptedRoot: String?
    public var acceptedUpdate: String?
    public var acceptedCursor: String?
    public var generation: Int
}

/// Where a file node's bytes are: carried in the record until the tree's next
/// transaction stores them in its overlay, or named by hash and served by the
/// object store on demand. Markdown and directory content never use this; their
/// source stays inline on the node.
public enum ContentRef: Codable, Equatable, Sendable {
    case inline(Data)
    case hash(String, size: Int, mediaType: String?)

    private enum CodingKeys: String, CodingKey { case inline, hash, size, mediaType }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        if let inline = try container.decodeIfPresent(Data.self, forKey: .inline) {
            self = .inline(inline)
        } else {
            self = .hash(
                try container.decode(String.self, forKey: .hash),
                size: try container.decode(Int.self, forKey: .size),
                mediaType: try container.decodeIfPresent(String.self, forKey: .mediaType)
            )
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .inline(bytes):
            try container.encode(bytes, forKey: .inline)
        case let .hash(hash, size, mediaType):
            try container.encode(hash, forKey: .hash)
            try container.encode(size, forKey: .size)
            try container.encodeIfPresent(mediaType, forKey: .mediaType)
        }
    }

    /// The wire object hash: computed for inline bytes, carried for a hash ref.
    public var objectHash: String {
        switch self {
        case let .inline(bytes): WorkingTreeWireCodec.hash(WorkingTreeWireCodec.file(bytes))
        case let .hash(hash, _, _): hash
        }
    }

    /// The payload length in bytes.
    public var size: Int {
        switch self {
        case let .inline(bytes): bytes.count
        case let .hash(_, size, _): size
        }
    }

    public var mediaType: String? {
        switch self {
        case .inline: nil
        case let .hash(_, _, mediaType): mediaType
        }
    }

    public var isInline: Bool {
        if case .inline = self { return true }
        return false
    }
}

/// One object of a working-tree snapshot. `bytes` is `nil` for a file the tree
/// only holds by reference; such an object's bytes come from the object store.
public struct WorkingTreeStoredObject: Codable, Equatable, Sendable {
    public var hash: String
    public var bytes: Data?

    public init(hash: String, bytes: Data?) {
        self.hash = hash
        self.bytes = bytes
    }
}

public struct WorkingTreeCollectionFileDescriptor: Codable, Equatable, Sendable {
    public var version: Int
    public var type: String
    public var format: String
    public var source: String
    public var schemaSource: String
    public var schemaFingerprint: String
    public var childSetHash: String

    public init(
        version: Int = 1,
        type: String = "collection-file",
        format: String,
        source: String,
        schemaSource: String,
        schemaFingerprint: String,
        childSetHash: String
    ) {
        self.version = version
        self.type = type
        self.format = format
        self.source = source
        self.schemaSource = schemaSource
        self.schemaFingerprint = schemaFingerprint
        self.childSetHash = childSetHash
    }
}

/// The wire graph of a working-tree state. Directory and Markdown objects are
/// always carried with bytes; file objects held by reference appear as hashes.
public struct WorkingTreeSnapshot: Codable, Equatable, Sendable {
    public var root: String
    public var objects: [WorkingTreeStoredObject]

    public init(root: String, objects: [WorkingTreeStoredObject]) {
        self.root = root
        self.objects = objects
    }

    /// Objects carried with bytes.
    public var inlineObjects: [WorkingTreeStoredObject] { objects.filter { $0.bytes != nil } }

    /// Every hash in the graph, with or without bytes.
    public var hashes: Set<String> { Set(objects.map(\.hash)) }

    /// Hashes the snapshot carries without bytes.
    public var sparseHashes: Set<String> { Set(objects.filter { $0.bytes == nil }.map(\.hash)) }

    var inlineObjectsByHash: [String: Data] {
        Dictionary(uniqueKeysWithValues: objects.compactMap { object in object.bytes.map { (object.hash, $0) } })
    }
}

/** One locally durable editor admission that may seed a single immediate sync attempt. */
public struct WorkingTreePatchAdmission: Sendable, Equatable {
    public var reference: WorkspaceReference
    public var baseRoot: String
    public var candidateRoot: String
    public var generation: Int
    public var baseFile: String
    public var resultFile: String
    public var patch: WorkspaceDocumentPatch
    public var baseWasAccepted: Bool

    public init(
        reference: WorkspaceReference,
        baseRoot: String,
        candidateRoot: String,
        generation: Int,
        baseFile: String,
        resultFile: String,
        patch: WorkspaceDocumentPatch,
        baseWasAccepted: Bool
    ) {
        self.reference = reference
        self.baseRoot = baseRoot
        self.candidateRoot = candidateRoot
        self.generation = generation
        self.baseFile = baseFile
        self.resultFile = resultFile
        self.patch = patch
        self.baseWasAccepted = baseWasAccepted
    }
}

public struct WorkingTreeDiagnostic: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var title: String
    public var detail: String

    public init(id: String, title: String, detail: String) {
        self.id = id
        self.title = title
        self.detail = detail
    }
}

public enum WorkingTreeSystemNodeContent: Sendable, Equatable {
    case directory(source: String? = nil)
    case markdown(source: String)
    case file(ref: ContentRef, mediaType: String? = nil)
    case boundary(tree: TreeID)
}

public enum WorkingTreeDirectoryBodyPlacement: String, Codable, Sendable {
    case siblingMarkdown
}

public struct WorkingTreeSystemNode: Sendable, Equatable {
    public var path: String
    public var pageID: String?
    public var content: WorkingTreeSystemNodeContent
    public var childrenSource: WorkingTreeCollectionFileDescriptor?
    public var directoryBodyPlacement: WorkingTreeDirectoryBodyPlacement?
    public var shadowedSiblingMarkdownSource: String?

    public init(
        path: String,
        pageID: String? = nil,
        content: WorkingTreeSystemNodeContent,
        childrenSource: WorkingTreeCollectionFileDescriptor? = nil,
        directoryBodyPlacement: WorkingTreeDirectoryBodyPlacement? = nil,
        shadowedSiblingMarkdownSource: String? = nil
    ) {
        self.path = path
        self.pageID = pageID
        self.content = content
        self.childrenSource = childrenSource
        self.directoryBodyPlacement = directoryBodyPlacement
        self.shadowedSiblingMarkdownSource = shadowedSiblingMarkdownSource
    }
}

public struct WorkingTreeSystemReplacement: Sendable, Equatable {
    public var root: String
    public var update: String
    public var cursor: String?
    public var nodes: [WorkingTreeSystemNode]

    public init(root: String, update: String, cursor: String? = nil, nodes: [WorkingTreeSystemNode]) {
        self.root = root
        self.update = update
        self.cursor = cursor
        self.nodes = nodes
    }
}

enum WorkingTreeNodeKind: String, Codable, Sendable {
    case directory
    case markdown
    case file
    case boundary
}

struct WorkingTreeNode: Codable, Equatable, Sendable {
    var path: String
    var pageID: String?
    var kind: WorkingTreeNodeKind
    var source: String?
    /// Present exactly for `.file` nodes.
    var ref: ContentRef?
    var mediaType: String?
    var trashedFrom: String?
    var boundaryTree: String?
    var childrenSource: WorkingTreeCollectionFileDescriptor?
    // `nil` preserves the original encoding: a directory source is `_index.md`.
    // Contentless legacy directory records also decode unchanged.
    var directoryBodyPlacement: WorkingTreeDirectoryBodyPlacement?
    // Not logical content; retained only so a shadowed sibling round-trips exactly.
    var shadowedSiblingMarkdownSource: String?
    /// Local observation time for recency sorting. This is replica metadata,
    /// deliberately omitted from ArborWire object encoding.
    var modifiedAt: Date?

    init(
        path: String,
        pageID: String? = nil,
        kind: WorkingTreeNodeKind,
        source: String? = nil,
        ref: ContentRef? = nil,
        mediaType: String? = nil,
        trashedFrom: String? = nil,
        boundaryTree: String? = nil,
        childrenSource: WorkingTreeCollectionFileDescriptor? = nil,
        directoryBodyPlacement: WorkingTreeDirectoryBodyPlacement? = nil,
        shadowedSiblingMarkdownSource: String? = nil,
        modifiedAt: Date? = nil
    ) {
        self.path = path
        self.pageID = pageID
        self.kind = kind
        self.source = source
        self.ref = ref
        self.mediaType = mediaType
        self.trashedFrom = trashedFrom
        self.boundaryTree = boundaryTree
        self.childrenSource = childrenSource
        self.directoryBodyPlacement = directoryBodyPlacement
        self.shadowedSiblingMarkdownSource = shadowedSiblingMarkdownSource
        self.modifiedAt = modifiedAt
    }
}

struct WorkingTreeState: Codable, Equatable, Sendable {
    static let currentSchema = 2
    var schema = WorkingTreeState.currentSchema
    var tree: String
    var nodes: [WorkingTreeNode]
}

struct WorkingTreeControl: Codable, Equatable, Sendable {
    var schema = 1
    var tree: String
    var materializedRoot: String
    var pendingRoot: String?
    var acceptedRoot: String?
    var acceptedUpdate: String?
    var acceptedCursor: String?
    var generation: Int

    init(
        tree: String,
        materializedRoot: String,
        pendingRoot: String? = nil,
        acceptedRoot: String? = nil,
        acceptedUpdate: String? = nil,
        acceptedCursor: String? = nil,
        generation: Int
    ) {
        self.tree = tree
        self.materializedRoot = materializedRoot
        self.pendingRoot = pendingRoot
        self.acceptedRoot = acceptedRoot
        self.acceptedUpdate = acceptedUpdate
        self.acceptedCursor = acceptedCursor
        self.generation = generation
    }

    var heads: WorkingTreeHeads {
        WorkingTreeHeads(
            materializedRoot: materializedRoot,
            pendingRoot: pendingRoot,
            acceptedRoot: acceptedRoot,
            acceptedUpdate: acceptedUpdate,
            acceptedCursor: acceptedCursor,
            generation: generation
        )
    }
}

struct WorkingTreeMutationIntent: Codable, Equatable, Sendable {
    var id: String
    var pageKey: String
    var generation: Int
    var mutation: String
    var changedAt: Date
    var state: WorkingTreeState
    var acceptedRoot: String?
    var acceptedUpdate: String?
    var acceptedCursor: String?
    /// A conflict resolution may install a reviewed materialized root while
    /// advancing its accepted base to a different authoritative root.
    var retainsPendingAgainstAcceptedBase: Bool? = nil
}

struct WorkingTreeSearchIndex: Codable, Equatable, Sendable {
    struct Entry: Codable, Equatable, Sendable {
        var path: String
        var pageID: String?
        var title: String
        var source: String
        var links: [ResolvedNodeTarget]
        var modifiedAt: Date?
    }

    var generation: Int
    var entries: [Entry]
}
