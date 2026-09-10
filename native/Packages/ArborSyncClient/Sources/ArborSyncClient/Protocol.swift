import ArborKit
import ArborWire
import Foundation

public struct ArborSyncStatus: Codable, Sendable, Equatable {
    public var service: String
    public var version: String
    public var protocolVersion: String
    public var instanceID: String
    public var runtimeKind: String
    public var deviceID: String?

    public init(service: String, version: String, protocolVersion: String, instanceID: String, runtimeKind: String, deviceID: String? = nil) {
        self.service = service
        self.version = version
        self.protocolVersion = protocolVersion
        self.instanceID = instanceID
        self.runtimeKind = runtimeKind
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

/// A canonical tree location is the same value on the Wire and through Arbor Sync.
public typealias CanonicalTreeDescriptor = WireCanonicalDescriptor

public struct SnapshotEnvelope<Value: Codable & Sendable & Equatable>: Codable, Sendable, Equatable {
    public var snapshot: Value
    public var observedThrough: String
}

public struct LocatorResolution: Codable, Sendable, Equatable {
    public var ref: NodeRef
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

/// A tree as Arbor Sync holds it: the Wire descriptor fields plus placement,
/// display name, and synchronization state. `root` and `update` are the
/// accepted Canopy base this placement derives from, absent until one exists.
public struct LocalTreeDescriptor: Codable, Sendable, Equatable {
    public var id: String
    public var configurationTree: String?
    public var kind: String
    public var access: String
    public var canonical: CanonicalTreeDescriptor?
    public var root: String?
    public var update: String?
    public var name: String
    public var osPath: String?
    public var placement: String
    public var sync: String?
    public var reviewableConflict: Bool?
    public var missing: Bool?
}

public struct ArborSyncConflictContent: Codable, Sendable, Equatable {
    public var kind: String
    public var text: String?
    public var bytes: String?
    public var entries: [String]?
    public var tree: String?
}

public struct ArborSyncConflictItem: Codable, Sendable, Equatable, Identifiable {
    public var id: String { path }
    public var path: String
    public var reasons: [String]
    public var base: ArborSyncConflictContent
    public var current: ArborSyncConflictContent
    public var mine: ArborSyncConflictContent
    public var draft: ArborSyncConflictContent
    public var offersBoth: Bool
}

public struct ArborSyncConflictWorkspace: Codable, Sendable, Equatable {
    public var identity: String
    public var tree: String
    public var items: [ArborSyncConflictItem]
    public var unattemptedCount: Int
}

public enum ArborSyncConflictResolution: Sendable, Equatable {
    case current
    case mine
    case both
    case edit(String)
}

public struct Diagnostic: Codable, Sendable, Equatable {
    public var code: String
    public var message: String
    public var path: String?
    public var severity: String
    public var row: Int?
    public var field: String?
}

public struct MutationEffect: Codable, Sendable, Equatable {
    public var kind: String
    public var ref: NodeRef
    public var previousPath: String?
    public var contentRevision: String?
    public var propertiesRevision: String?
    /// Exact top-level property names when the provider can prove them.
    public var changedProperties: [String]?
    public var directoryRevision: String?
}

public struct WorkspaceChange: Codable, Sendable, Equatable {
    public var ref: NodeRef
    public var previousPath: String?
    public var contentRevision: String?
    public var propertiesRevision: String?
    /// Exact top-level property names when the provider can prove them.
    public var changedProperties: [String]?
    public var directoryRevision: String?
    public var origin: String
    public var mutationID: String?
    /// Authenticated Wire requests incorporated by this materialized sync transition.
    public var acceptedRequestDigests: [String]?
}

public struct WorkspaceEvent: Codable, Sendable, Equatable {
    public var cursor: String
    /// Scope the event belongs to; one process-wide stream orders all scopes.
    public var tree: String
    public var kind: String
    public var change: WorkspaceChange
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

// MARK: - Bootstrap and credential (`GET /v1/bootstrap`, `GET /v1/credential`)

/// The daemon's recorded accepted base for a placement; `cursor` equals `update` and seeds a Wire watch.
public struct TreeBootstrapAccepted: Codable, Sendable, Equatable {
    public var root: String
    public var update: String
    public var cursor: String

    public init(root: String, update: String, cursor: String) {
        self.root = root
        self.update = update
        self.cursor = cursor
    }
}

/// One non-Markdown file the sparse spine references by hash only; its bytes come through `/v1/objects`.
public struct TreeBootstrapFile: Codable, Sendable, Equatable {
    public var size: Int
    /// Milliseconds since the epoch.
    public var mtime: Int64

    public init(size: Int, mtime: Int64) {
        self.size = size
        self.mtime = mtime
    }
}

/// The daemon's stored update string, verbatim, when it still ends at the folder exactly.
public struct TreeBootstrapPending: Codable, Sendable, Equatable {
    public var base: String?
    public var updates: [WireCandidateUpdate]
    /// Per-element request digests (`updateRequestDigests`); they exclude object envelopes.
    public var requestDigests: [String]

    public init(base: String?, updates: [WireCandidateUpdate], requestDigests: [String]) {
        self.base = base
        self.updates = updates
        self.requestDigests = requestDigests
    }

    private enum CodingKeys: String, CodingKey { case base, updates, requestDigests }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        base = try values.decodeIfPresent(String.self, forKey: .base)
        updates = try values.decode([WireCandidateUpdate].self, forKey: .updates)
        requestDigests = try values.decode([String].self, forKey: .requestDigests)
        guard updates.count == requestDigests.count else {
            throw DecodingError.dataCorruptedError(
                forKey: .requestDigests,
                in: values,
                debugDescription: "pending.requestDigests must have one digest per update element"
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(base, forKey: .base)
        try container.encode(updates, forKey: .updates)
        try container.encode(requestDigests, forKey: .requestDigests)
    }
}

/// Why a bootstrap must not be treated as a clean base.
public enum TreeBootstrapBlock: String, Codable, Sendable, Equatable {
    case conflict
    case unsettled
    case editorPending = "editor-pending"
}

/// `GET /v1/bootstrap?tree=`: what a loopback client needs to open a placed tree as its own
/// working tree. Mirrors `TreeBootstrap` in `@arbor/arborsync-client`, with the base64 spine
/// already decoded and validated in sparse mode.
public struct TreeBootstrap: Sendable, Equatable {
    public var tree: LocalTreeDescriptor
    public var accepted: TreeBootstrapAccepted
    /// Every directory object plus every Markdown file object; validated with `.sparseFiles`.
    public var spine: WireSnapshot
    /// Every payload-less file entry by wire path.
    public var files: [String: TreeBootstrapFile]
    public var pending: TreeBootstrapPending?
    public var blocked: TreeBootstrapBlock?
    public var observedThrough: String

    public init(
        tree: LocalTreeDescriptor,
        accepted: TreeBootstrapAccepted,
        spine: WireSnapshot,
        files: [String: TreeBootstrapFile],
        pending: TreeBootstrapPending? = nil,
        blocked: TreeBootstrapBlock? = nil,
        observedThrough: String
    ) {
        self.tree = tree
        self.accepted = accepted
        self.spine = spine
        self.files = files
        self.pending = pending
        self.blocked = blocked
        self.observedThrough = observedThrough
    }
}

/// `GET /v1/credential`: the account credential a same-installation client shares with the daemon.
public struct TreeCredential: Codable, Sendable, Equatable {
    public var token: String

    public init(token: String) { self.token = token }
}

public enum TreeBootstrapError: Error, LocalizedError, Sendable, Equatable {
    /// The spine referenced a payload-less entry that `files` does not list, so the client
    /// cannot tell a lazily omitted file from a missing directory.
    case unlistedFile(path: String, hash: String)
    case invalidSpine(String)

    public var errorDescription: String? {
        switch self {
        case let .unlistedFile(path, hash):
            "Bootstrap spine references \(path) (\(hash)) without listing it in files"
        case let .invalidSpine(detail):
            "Bootstrap spine is invalid: \(detail)"
        }
    }
}
