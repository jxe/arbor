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

public struct ArborSyncStatus: Codable, Sendable, Equatable {
    public var service: String
    public var version: String
    public var protocolVersion: String
    public var deviceID: String?

    public init(service: String, version: String, protocolVersion: String, deviceID: String? = nil) {
        self.service = service
        self.version = version
        self.protocolVersion = protocolVersion
        self.deviceID = deviceID
    }
}

/// One node location with optional schema-derived stable identity.
public struct NodeRef: Codable, Sendable, Equatable {
    public var tree: String
    public var path: String
    public var stableKey: String?

    public init(tree: String, path: String, stableKey: String? = nil) {
        self.tree = tree
        self.path = path
        self.stableKey = stableKey
    }

    public static func path(_ path: String, tree: String) -> NodeRef {
        NodeRef(tree: tree, path: path)
    }

    private enum CodingKeys: String, CodingKey { case tree, path, stableKey, pageID, pathHint }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        guard container.contains(.stableKey), !container.contains(.pageID), !container.contains(.pathHint) else {
            throw DecodingError.dataCorruptedError(forKey: .stableKey, in: container, debugDescription: "node refs require explicit stableKey and reject PageID references")
        }
        tree = try container.decode(String.self, forKey: .tree)
        path = try container.decode(String.self, forKey: .path)
        stableKey = try container.decodeIfPresent(String.self, forKey: .stableKey)
        guard !tree.isEmpty, !path.isEmpty, stableKey.map({ encodeStableKey($0) != nil }) ?? true else {
            throw DecodingError.dataCorruptedError(forKey: .stableKey, in: container, debugDescription: "node refs require nonempty location fields and a canonical stable key")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(tree, forKey: .tree)
        try container.encode(path, forKey: .path)
        if let stableKey {
            guard encodeStableKey(stableKey) != nil else {
                throw EncodingError.invalidValue(stableKey, .init(codingPath: encoder.codingPath, debugDescription: "stableKey is not canonical identity JSON"))
            }
            try container.encode(stableKey, forKey: .stableKey)
        }
        else { try container.encodeNil(forKey: .stableKey) }
    }
}

public typealias ResolvedNodeRef = NodeRef

public struct CanonicalTreeDescriptor: Codable, Sendable, Equatable {
    public var locator: String
    public var path: String
    public var endpoint: String
    public var httpURL: String
    public var parentTree: String?
}

public struct SnapshotEnvelope<Value: Codable & Sendable & Equatable>: Codable, Sendable, Equatable {
    public var snapshot: Value
    public var observedThrough: String
}

public struct LocatorResolution: Codable, Sendable, Equatable {
    public var ref: ResolvedNodeRef
    public var enclosingTree: TreeDescriptor?
    public var historical: Bool
    public var observedThrough: String
}

public struct TreeDescriptor: Codable, Sendable, Equatable {
    public var id: String
    public var kind: String
    public var access: String
    public var canonical: CanonicalTreeDescriptor?
}

public struct LocalTreeDescriptor: Codable, Sendable, Equatable {
    public var id: String
    public var kind: String
    public var access: String
    public var canonical: CanonicalTreeDescriptor?
    public var name: String
    public var osPath: String?
    public var placement: String
    public var sync: String?
    public var missing: Bool?
}

public struct Diagnostic: Codable, Sendable, Equatable {
    public var code: String
    public var message: String
    public var path: String?
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
    /// Exact authoritative Markdown source, including frontmatter.
    public var source: String
    public var frontmatter: [String: JSONValue]
    public var frontmatterSource: String?
    public var bodySource: String
    public var blocks: [ArborBlock]
}

public struct PropertiesCapability: Codable, Sendable, Equatable {
    public var revision: String
    public var schema: String?
    public var writable: Bool
}

public struct ContentCapability: Codable, Sendable, Equatable {
    public var revision: String
    public var mediaType: String
    public var format: String?
    public var writable: Bool
}

public struct ChildRepresentationSummary: Codable, Sendable, Equatable {
    public var type: String
    public var codec: String?
    public var scope: String?
    public var modelDigest: String?
    public var driver: String?
}

public struct ChildrenCapability: Codable, Sendable, Equatable {
    public var revision: String
    public var schema: String?
    public var representation: ChildRepresentationSummary?
    public var total: Int?
    public var writable: Bool
}

public struct ExecutableCapability: Codable, Sendable, Equatable {
    public var version: String
    public var state: String
}

public struct NodeCapabilities: Codable, Sendable, Equatable {
    public var properties: PropertiesCapability?
    public var content: ContentCapability?
    public var children: ChildrenCapability?
    public var executable: ExecutableCapability?
}

public struct NodeContentRepresentation: Codable, Sendable, Equatable {
    public var state: String
    public var origin: String?
}

public struct NodeContent: Codable, Sendable, Equatable {
    public var source: String
    public var representation: NodeContentRepresentation?
}

private enum LegacyNodeCodingKeys: String, CodingKey, CaseIterable {
    case tree, path, kind, pageID, collection, document, children
}

private func rejectLegacyNodeFields(_ decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: LegacyNodeCodingKeys.self)
    if let key = LegacyNodeCodingKeys.allCases.first(where: { container.contains($0) }) {
        throw DecodingError.dataCorruptedError(
            forKey: key,
            in: container,
            debugDescription: "\(key.stringValue) duplicates or violates the canonical node model"
        )
    }
}

public struct NodeSummary: Codable, Sendable, Equatable {
    public var ref: ResolvedNodeRef
    public var name: String
    public var revision: String
    public var properties: [String: JSONValue]
    public var capabilities: NodeCapabilities
    public var materialization: String
    public var diagnostics: [Diagnostic]

    private enum CodingKeys: String, CodingKey {
        case ref, name, revision, properties, capabilities, materialization, diagnostics
    }

    public init(from decoder: Decoder) throws {
        try rejectLegacyNodeFields(decoder)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        ref = try container.decode(ResolvedNodeRef.self, forKey: .ref)
        name = try container.decode(String.self, forKey: .name)
        revision = try container.decode(String.self, forKey: .revision)
        properties = try container.decode([String: JSONValue].self, forKey: .properties)
        capabilities = try container.decode(NodeCapabilities.self, forKey: .capabilities)
        materialization = try container.decode(String.self, forKey: .materialization)
        diagnostics = try container.decode([Diagnostic].self, forKey: .diagnostics)
    }
}

public struct NodeSnapshot: Codable, Sendable, Equatable {
    public var ref: ResolvedNodeRef
    /// Placement context supplied by local/Canopy response adapters.
    public var enclosingTree: LocalTreeDescriptor?
    public var name: String
    public var revision: String
    public var properties: [String: JSONValue]
    public var capabilities: NodeCapabilities
    public var content: NodeContent?
    public var materialization: String
    public var diagnostics: [Diagnostic]
    public var observedThrough: String

    private enum CodingKeys: String, CodingKey {
        case ref, enclosingTree, name, revision, properties, capabilities, content, materialization, diagnostics, observedThrough
    }

    public init(from decoder: Decoder) throws {
        try rejectLegacyNodeFields(decoder)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        ref = try container.decode(ResolvedNodeRef.self, forKey: .ref)
        enclosingTree = try container.decodeIfPresent(LocalTreeDescriptor.self, forKey: .enclosingTree)
        name = try container.decode(String.self, forKey: .name)
        revision = try container.decode(String.self, forKey: .revision)
        properties = try container.decode([String: JSONValue].self, forKey: .properties)
        capabilities = try container.decode(NodeCapabilities.self, forKey: .capabilities)
        content = try container.decodeIfPresent(NodeContent.self, forKey: .content)
        materialization = try container.decode(String.self, forKey: .materialization)
        diagnostics = try container.decode([Diagnostic].self, forKey: .diagnostics)
        observedThrough = try container.decode(String.self, forKey: .observedThrough)
    }
}

public struct ChildrenPage: Codable, Sendable, Equatable {
    public var parent: ResolvedNodeRef
    public var items: [NodeSummary]
    public var nextCursor: String?
    public var observedThrough: String
}

public struct SearchResult: Codable, Sendable, Equatable {
    public var ref: ResolvedNodeRef
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
    public var basePropertiesRevision: String?
    public var properties: [String: JSONValue]?
    public var baseContentRevision: String?
    public var source: String?
    public var sourceEdits: [ProtocolSourceEdit]?
    public var hash: String?

    public init(
        op: String,
        ref: NodeRef? = nil,
        refs: [NodeRef]? = nil,
        tree: String? = nil,
        path: String? = nil,
        name: String? = nil,
        destination: NodeRef? = nil,
        basePropertiesRevision: String? = nil,
        properties: [String: JSONValue]? = nil,
        baseContentRevision: String? = nil,
        source: String? = nil,
        sourceEdits: [ProtocolSourceEdit]? = nil,
        hash: String? = nil
    ) {
        self.op = op
        self.ref = ref
        self.refs = refs
        self.tree = tree
        self.path = path
        self.name = name
        self.destination = destination
        self.basePropertiesRevision = basePropertiesRevision
        self.properties = properties
        self.baseContentRevision = baseContentRevision
        self.source = source
        self.sourceEdits = sourceEdits
        self.hash = hash
    }

    public var isContentOperation: Bool {
        op == "writeProperties" || op == "writeText" || op == "writeMarkdown" || op == "restoreRecovery" || op == "ensureDocumentIdentity"
    }
}

public struct ProtocolSourceEdit: Codable, Sendable, Equatable {
    public var offset: Int
    public var length: Int
    public var replacement: String
    public var expected: String?

    public init(offset: Int, length: Int, replacement: String, expected: String? = nil) {
        self.offset = offset
        self.length = length
        self.replacement = replacement
        self.expected = expected
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
    public var ref: NodeRef
    public var previousPath: String?
    public var contentRevision: String?
    public var propertiesRevision: String?
    public var directoryRevision: String?
}

public struct MutationReceipt: Codable, Sendable, Equatable {
    public var mutationID: String
    public var observedThrough: String
    public var effects: [MutationEffect]
}

public struct WorkspaceChange: Codable, Sendable, Equatable {
    public var ref: NodeRef
    public var previousPath: String?
    public var contentRevision: String?
    public var propertiesRevision: String?
    public var directoryRevision: String?
    public var origin: String
    public var mutationID: String?
}

public struct WorkspaceEvent: Codable, Sendable, Equatable {
    public var cursor: String
    /// Scope the event belongs to; one process-wide stream orders all scopes.
    public var tree: String
    public var kind: String
    public var change: WorkspaceChange
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

public struct ArborSyncErrorValue: Codable, Sendable, Equatable {
    public var code: String
    public var message: String
    public var retryable: Bool
    public var tree: String?
    public var path: String?
    public var details: JSONValue?
}

public struct ArborSyncErrorEnvelope: Codable, Sendable, Equatable {
    public var error: String
    public var message: String
    public var retryable: Bool
    public var tree: String? = nil
    public var path: String? = nil
    public var details: JSONValue? = nil

    public var value: ArborSyncErrorValue {
        ArborSyncErrorValue(
            code: error,
            message: message,
            retryable: retryable,
            tree: tree,
            path: path,
            details: details
        )
    }
}
