import Foundation

public enum JSONValue: Codable, Sendable, Equatable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null }
        else if let value = try? container.decode(Bool.self) { self = .bool(value) }
        else if let value = try? container.decode(Double.self) { self = .number(value) }
        else if let value = try? container.decode(String.self) { self = .string(value) }
        else if let value = try? container.decode([JSONValue].self) { self = .array(value) }
        else { self = .object(try container.decode([String: JSONValue].self)) }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }
}

/// A local reference: a logical path or a durable page ID plus hint,
/// optionally qualified by the `tree` scope it resolves in: "local",
/// "system", or a stable shared TreeID.
public struct NodeRef: Codable, Sendable, Equatable {
    public var tree: String?
    public var path: String?
    public var pageID: String?
    public var pathHint: String?

    public init(tree: String? = nil, path: String? = nil, pageID: String? = nil, pathHint: String? = nil) {
        self.tree = tree
        self.path = path
        self.pageID = pageID
        self.pathHint = pathHint
    }

    public static func path(_ path: String, tree: String? = nil) -> NodeRef {
        NodeRef(tree: tree, path: path)
    }

    public static func pageID(_ pageID: String, pathHint: String? = nil, tree: String? = nil) -> NodeRef {
        NodeRef(tree: tree, pageID: pageID, pathHint: pathHint)
    }
}

public struct ResolvedNodeRef: Codable, Sendable, Equatable {
    /// Scope the reference resolved in; absent only in legacy payloads (the session root).
    public var tree: String?
    public var path: String
    public var pageID: String?

    public init(path: String, pageID: String? = nil, tree: String? = nil) {
        self.tree = tree
        self.path = path
        self.pageID = pageID
    }
}

public struct TreeDescriptor: Codable, Sendable, Equatable {
    public var id: String
    public var name: String
    public var osPath: String?
    public var canonical: String?
    public var canonicalPath: String?
    public var httpURL: String?
    public var endpoint: String?
    public var publicAccess: String?
    public var access: String?
    public var accessEntries: [TreeAccessEntry]?
    public var placement: String
    public var sync: String?
    public var legacy: Bool?
    public var missing: Bool?
}

public struct TreeAccessEntry: Codable, Sendable, Equatable {
    public var id: String
    public var kind: String
    public var access: String
    public var locator: String?
}

public struct Diagnostic: Codable, Sendable, Equatable {
    public var code: String
    public var message: String
    public var path: String
    public var severity: String
    public var row: Int?
    public var field: String?
}

public struct ArborBlock: Codable, Sendable, Equatable {
    public var id: String
    public var type: String
    public var content: String?
    public var props: [String: JSONValue]?
    public var children: [ArborBlock]
    public var source: String?
    public var sourceHash: String?

    public init(
        id: String,
        type: String,
        content: String? = nil,
        props: [String: JSONValue]? = nil,
        children: [ArborBlock] = [],
        source: String? = nil,
        sourceHash: String? = nil
    ) {
        self.id = id
        self.type = type
        self.content = content
        self.props = props
        self.children = children
        self.source = source
        self.sourceHash = sourceHash
    }
}

public struct MarkdownDocument: Codable, Sendable, Equatable {
    public var frontmatter: [String: JSONValue]
    public var frontmatterSource: String?
    public var bodySource: String
    public var blocks: [ArborBlock]
}

public struct TreeChild: Codable, Sendable, Equatable {
    public var name: String
    public var path: String
    public var kind: String
    public var materialization: String
    /// Durable document identity, when known unambiguously.
    public var pageID: String?
}

public struct CollectionSummary: Codable, Sendable, Equatable {
    public var backing: String
    public var columns: [String]
    public var editable: Bool
    public var total: Int?
    public var tables: [String]?
}

public struct NodeSnapshot: Codable, Sendable, Equatable {
    public var ref: ResolvedNodeRef
    /// Scope the snapshot resolved in, after canonicalization.
    public var tree: String?
    /// The enclosing shared tree or legacy placement, when applicable.
    public var enclosingTree: TreeDescriptor?
    public var path: String
    public var name: String
    public var kind: String
    public var writable: Bool
    public var materialization: String
    public var contentRevision: String?
    public var directoryRevision: String?
    /// "stored" or "implicit" — whether `document` reflects stored bytes.
    public var bodyState: String?
    /// "sibling" or "index" — which representation supplies a stored body.
    public var bodyOrigin: String?
    public var document: MarkdownDocument?
    public var collection: CollectionSummary?
    public var diagnostics: [Diagnostic]
    public var observedThrough: String
    public var children: [TreeChild]?
}

public struct ChildrenPage: Codable, Sendable, Equatable {
    public var parent: ResolvedNodeRef
    public var items: [TreeChild]
    public var nextCursor: String?
    public var observedThrough: String
}

public struct SearchResult: Codable, Sendable, Equatable {
    /// Scope the result belongs to.
    public var tree: String?
    public var path: String
    public var pageID: String?
    public var title: String
    public var excerpt: String
    public var score: Double
}

public struct SearchPage: Codable, Sendable, Equatable {
    public var results: [SearchResult]
    public var nextCursor: String?
    public var observedThrough: String
}

public struct BacklinkEntry: Codable, Sendable, Equatable {
    public var ref: ResolvedNodeRef
    public var title: String
    public var context: String
}

public struct BacklinksPage: Codable, Sendable, Equatable {
    public var target: ResolvedNodeRef
    public var entries: [BacklinkEntry]
    public var nextCursor: String?
    public var observedThrough: String
}

public struct CollectionRow: Codable, Sendable, Equatable {
    public var key: String
    public var path: String?
    public var values: [String: JSONValue]
    public var diagnostics: [Diagnostic]
}

public struct CollectionPage: Codable, Sendable, Equatable {
    public var path: String
    public var backing: String
    public var columns: [String]
    public var rows: [CollectionRow]
    public var nextCursor: String?
    public var diagnostics: [Diagnostic]
    public var editable: Bool
    public var observedThrough: String
}

public struct RecoveryEntry: Codable, Sendable, Equatable {
    /// "block" or "trash".
    public var kind: String
    public var ref: ResolvedNodeRef
    public var hash: String?
    public var markdown: String?
    public var parent: String?
    public var status: String?
    public var originalPath: String?
    public var nodeKind: String?
    public var changedAt: Double
}

public struct RecoveryPage: Codable, Sendable, Equatable {
    public var ref: ResolvedNodeRef
    public var entries: [RecoveryEntry]
    public var nextCursor: String?
    public var observedThrough: String
}

public struct WorkspaceOperation: Codable, Sendable, Equatable {
    public var op: String
    public var ref: NodeRef?
    public var refs: [NodeRef]?
    /// Scope for path-literal operations (createMarkdown/createDirectory).
    public var tree: String?
    public var path: String?
    public var name: String?
    public var destination: NodeRef?
    /// "natural" (default) or "authored" — whether a move places a stored destination row.
    public var placement: String?
    public var beforePath: String?
    public var beforeBlockID: String?
    public var baseContentRevision: String?
    public var baseDirectoryRevision: String?
    public var frontmatterPatch: [String: JSONValue]?
    public var blocks: [ArborBlock]?
    public var hash: String?
    public var origin: String?
    public var accountToken: String?
    public var handle: String?
    public var displayName: String?
    public var canonicalPath: String?
    public var audience: JSONValue?
    public var subject: JSONValue?
    public var access: String?
    public var endpoint: String?
    public var canonical: String?

    public init(
        op: String,
        ref: NodeRef? = nil,
        refs: [NodeRef]? = nil,
        tree: String? = nil,
        path: String? = nil,
        name: String? = nil,
        destination: NodeRef? = nil,
        placement: String? = nil,
        beforePath: String? = nil,
        beforeBlockID: String? = nil,
        baseContentRevision: String? = nil,
        baseDirectoryRevision: String? = nil,
        frontmatterPatch: [String: JSONValue]? = nil,
        blocks: [ArborBlock]? = nil,
        hash: String? = nil,
        origin: String? = nil,
        accountToken: String? = nil,
        handle: String? = nil,
        displayName: String? = nil,
        canonicalPath: String? = nil,
        audience: JSONValue? = nil,
        subject: JSONValue? = nil,
        access: String? = nil,
        endpoint: String? = nil,
        canonical: String? = nil
    ) {
        self.op = op
        self.ref = ref
        self.refs = refs
        self.tree = tree
        self.path = path
        self.name = name
        self.destination = destination
        self.placement = placement
        self.beforePath = beforePath
        self.beforeBlockID = beforeBlockID
        self.baseContentRevision = baseContentRevision
        self.baseDirectoryRevision = baseDirectoryRevision
        self.frontmatterPatch = frontmatterPatch
        self.blocks = blocks
        self.hash = hash
        self.origin = origin
        self.accountToken = accountToken
        self.handle = handle
        self.displayName = displayName
        self.canonicalPath = canonicalPath
        self.audience = audience
        self.subject = subject
        self.access = access
        self.endpoint = endpoint
        self.canonical = canonical
    }

    public var isContentOperation: Bool {
        op == "writeMarkdown" || op == "restoreRecovery" || op == "ensureDocumentIdentity"
    }
}

public struct MutationRequest: Codable, Sendable, Equatable {
    public var mutationID: String
    public var operations: [WorkspaceOperation]

    public init(mutationID: String, operations: [WorkspaceOperation]) {
        self.mutationID = mutationID
        self.operations = operations
    }
}

public struct MutationEffect: Codable, Sendable, Equatable {
    public var kind: String
    /// Scope the effect landed in.
    public var tree: String?
    public var path: String
    public var previousPath: String?
    public var pageID: String?
    public var contentRevision: String?
    public var directoryRevision: String?
}

public struct MutationReceipt: Codable, Sendable, Equatable {
    public var mutationID: String
    public var eventCursor: String
    public var effects: [MutationEffect]
}

public struct WorkspaceEvent: Codable, Sendable, Equatable {
    public var cursor: String
    /// Scope the event belongs to; one process-wide stream orders all scopes.
    public var tree: String?
    public var kind: String
    public var path: String
    public var previousPath: String?
    public var pageID: String?
    public var contentRevision: String?
    public var directoryRevision: String?
    public var origin: String
    public var mutationID: String?
}

public enum ObservedNodeUpdate: Sendable, Equatable {
    case event(WorkspaceEvent)
    case resync(NodeSnapshot)
}

public struct ObservedNodeView: Sendable {
    public var snapshot: NodeSnapshot
    public var updates: AsyncThrowingStream<ObservedNodeUpdate, Error>

    public init(
        snapshot: NodeSnapshot,
        updates: AsyncThrowingStream<ObservedNodeUpdate, Error>
    ) {
        self.snapshot = snapshot
        self.updates = updates
    }
}

public struct ArbordErrorAnchor: Codable, Sendable, Equatable {
    public var beforePath: String?
    public var beforeBlockID: String?
}

public struct ArbordErrorValue: Codable, Sendable, Equatable {
    public var code: String
    public var message: String
    public var retryable: Bool
    public var path: String?
    public var current: NodeSnapshot?
    public var owners: [String]?
    public var anchor: ArbordErrorAnchor?
    public var mutationID: String?
}

public struct ArbordErrorEnvelope: Codable, Sendable, Equatable {
    public var error: ArbordErrorValue
}
