import ArborKit
import Foundation

public enum ReplicaError: Error, Equatable, Sendable {
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
    case simulatedCrash(ReplicaFailurePoint)
    case closed
}

public enum ReplicaFailurePoint: String, Codable, CaseIterable, Sendable {
    case afterJournal
    case afterObjects
    case afterMaterialization
    case afterHistory
    case afterControl
}

public protocol ReplicaFaultInjector: Sendable {
    func reached(_ point: ReplicaFailurePoint) throws
}

public struct NoReplicaFaults: ReplicaFaultInjector {
    public init() {}
    public func reached(_: ReplicaFailurePoint) throws {}
}

public struct ReplicaHeads: Codable, Equatable, Sendable {
    public var materializedRoot: String
    public var pendingRoot: String?
    public var acceptedRoot: String?
    public var acceptedUpdate: String?
    public var acceptedCursor: String?
    public var generation: Int
}

public struct ReplicaStoredObject: Codable, Equatable, Sendable {
    public var hash: String
    public var bytes: Data

    public init(hash: String, bytes: Data) {
        self.hash = hash
        self.bytes = bytes
    }
}

public struct ReplicaSnapshot: Codable, Equatable, Sendable {
    public var root: String
    public var objects: [ReplicaStoredObject]

    public init(root: String, objects: [ReplicaStoredObject]) {
        self.root = root
        self.objects = objects
    }
}

public struct ReplicaDiagnostic: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var title: String
    public var detail: String

    public init(id: String, title: String, detail: String) {
        self.id = id
        self.title = title
        self.detail = detail
    }
}

public enum ReplicaSystemNodeContent: Sendable, Equatable {
    case directory(source: String? = nil)
    case markdown(source: String)
    case file(bytes: Data, mediaType: String? = nil)
    case boundary(tree: TreeID)
}

public struct ReplicaSystemNode: Sendable, Equatable {
    public var path: String
    public var pageID: String?
    public var content: ReplicaSystemNodeContent

    public init(path: String, pageID: String? = nil, content: ReplicaSystemNodeContent) {
        self.path = path
        self.pageID = pageID
        self.content = content
    }
}

public struct ReplicaSystemReplacement: Sendable, Equatable {
    public var root: String
    public var update: String
    public var cursor: String?
    public var nodes: [ReplicaSystemNode]

    public init(root: String, update: String, cursor: String? = nil, nodes: [ReplicaSystemNode]) {
        self.root = root
        self.update = update
        self.cursor = cursor
        self.nodes = nodes
    }
}

enum ReplicaNodeKind: String, Codable, Sendable {
    case directory
    case markdown
    case file
    case boundary
}

struct ReplicaNodeRecord: Codable, Equatable, Sendable {
    var path: String
    var pageID: String?
    var kind: ReplicaNodeKind
    var source: String?
    var bytes: Data?
    var mediaType: String?
    var trashedFrom: String?
    var boundaryTree: String?

    init(
        path: String,
        pageID: String? = nil,
        kind: ReplicaNodeKind,
        source: String? = nil,
        bytes: Data? = nil,
        mediaType: String? = nil,
        trashedFrom: String? = nil,
        boundaryTree: String? = nil
    ) {
        self.path = path
        self.pageID = pageID
        self.kind = kind
        self.source = source
        self.bytes = bytes
        self.mediaType = mediaType
        self.trashedFrom = trashedFrom
        self.boundaryTree = boundaryTree
    }
}

struct ReplicaState: Codable, Equatable, Sendable {
    var schema = 1
    var tree: String
    var nodes: [ReplicaNodeRecord]
}

struct ReplicaControl: Codable, Equatable, Sendable {
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

    var heads: ReplicaHeads {
        ReplicaHeads(
            materializedRoot: materializedRoot,
            pendingRoot: pendingRoot,
            acceptedRoot: acceptedRoot,
            acceptedUpdate: acceptedUpdate,
            acceptedCursor: acceptedCursor,
            generation: generation
        )
    }
}

struct ReplicaHistoryRecord: Codable, Equatable, Sendable {
    var id: String
    var generation: Int
    var mutation: String
    var changedAt: Date
    var root: String
    var state: ReplicaState
}

struct ReplicaMutationIntent: Codable, Equatable, Sendable {
    var id: String
    var pageKey: String
    var generation: Int
    var mutation: String
    var changedAt: Date
    var state: ReplicaState
    var acceptedRoot: String?
    var acceptedUpdate: String?
    var acceptedCursor: String?
}

struct ReplicaSearchIndex: Codable, Equatable, Sendable {
    struct Entry: Codable, Equatable, Sendable {
        var path: String
        var pageID: String?
        var title: String
        var source: String
        var links: [String]
    }

    var generation: Int
    var entries: [Entry]
}
