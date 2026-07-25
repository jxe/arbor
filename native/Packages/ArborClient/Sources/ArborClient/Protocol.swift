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

public enum NodeRef: Codable, Sendable, Equatable {
    case path(String)
    case pageID(String, pathHint: String? = nil)

    private enum CodingKeys: String, CodingKey {
        case path, pageID, pathHint
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        if let path = try container.decodeIfPresent(String.self, forKey: .path) {
            self = .path(path)
        } else {
            self = .pageID(
                try container.decode(String.self, forKey: .pageID),
                pathHint: try container.decodeIfPresent(String.self, forKey: .pathHint)
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .path(let path):
            try container.encode(path, forKey: .path)
        case .pageID(let pageID, let pathHint):
            try container.encode(pageID, forKey: .pageID)
            try container.encodeIfPresent(pathHint, forKey: .pathHint)
        }
    }
}

public struct ResolvedNodeRef: Codable, Sendable, Equatable {
    public var path: String
    public var pageID: String?

    public init(path: String, pageID: String? = nil) {
        self.path = path
        self.pageID = pageID
    }
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
    public var path: String
    public var name: String
    public var kind: String
    public var writable: Bool
    public var materialization: String
    public var contentRevision: String?
    public var directoryRevision: String?
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
    public var hash: String
    public var markdown: String
    public var parent: String?
    public var status: String
    public var changedAt: Double
}

public struct RecoveryPage: Codable, Sendable, Equatable {
    public var ref: ResolvedNodeRef
    public var entries: [RecoveryEntry]
    public var observedThrough: String
}

public struct WorkspaceOperation: Codable, Sendable, Equatable {
    public var op: String
    public var ref: NodeRef?
    public var refs: [NodeRef]?
    public var path: String?
    public var name: String?
    public var destination: NodeRef?
    public var beforePath: String?
    public var beforeBlockID: String?
    public var baseContentRevision: String?
    public var baseDirectoryRevision: String?
    public var frontmatterPatch: [String: JSONValue]?
    public var blocks: [ArborBlock]?
    public var hash: String?

    public init(
        op: String,
        ref: NodeRef? = nil,
        refs: [NodeRef]? = nil,
        path: String? = nil,
        name: String? = nil,
        destination: NodeRef? = nil,
        beforePath: String? = nil,
        beforeBlockID: String? = nil,
        baseContentRevision: String? = nil,
        baseDirectoryRevision: String? = nil,
        frontmatterPatch: [String: JSONValue]? = nil,
        blocks: [ArborBlock]? = nil,
        hash: String? = nil
    ) {
        self.op = op
        self.ref = ref
        self.refs = refs
        self.path = path
        self.name = name
        self.destination = destination
        self.beforePath = beforePath
        self.beforeBlockID = beforeBlockID
        self.baseContentRevision = baseContentRevision
        self.baseDirectoryRevision = baseDirectoryRevision
        self.frontmatterPatch = frontmatterPatch
        self.blocks = blocks
        self.hash = hash
    }

    public var isContentOperation: Bool {
        op == "writeMarkdown" || op == "restoreRecovery"
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
