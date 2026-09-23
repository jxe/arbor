import CanopyAppKit
import Overstory
import Foundation

public struct ArborSyncStatus: Codable, Sendable, Equatable {
    public var service: String
    public var version: String
    public var protocolVersion: String
    public var instanceID: String
    public var runtimeKind: String

    public init(service: String, version: String, protocolVersion: String, instanceID: String, runtimeKind: String) {
        self.service = service
        self.version = version
        self.protocolVersion = protocolVersion
        self.instanceID = instanceID
        self.runtimeKind = runtimeKind
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
    public var conflicted: Bool?
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

    public init(
        code: String,
        message: String,
        retryable: Bool,
        tree: String? = nil,
        path: String? = nil,
        details: JSONValue? = nil
    ) {
        self.code = code
        self.message = message
        self.retryable = retryable
        self.tree = tree
        self.path = path
        self.details = details
    }
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
    public var cursor: String?

    public init(root: String, update: String, cursor: String?) {
        self.root = root
        self.update = update
        self.cursor = cursor
    }
}

/// Placement and routing metadata needed to open a working tree. Daemon
/// synchronization state is deliberately not part of the bootstrap contract.
public struct TreeBootstrapDescriptor: Codable, Sendable, Equatable {
    public var id: String
    public var configurationTree: String?
    public var kind: String
    public var access: String
    public var canonical: CanonicalTreeDescriptor?
    public var name: String
    public var osPath: String?
    public var placement: String
}

/// `GET /v1/bootstrap?tree=`: what a loopback client needs to open a placed tree as its own
/// working tree. Mirrors `TreeBootstrap` in `@arbor/arborsync-client`, with the base64 spine
/// already decoded and validated in sparse mode.
public struct TreeBootstrap: Sendable, Equatable {
    public var tree: TreeBootstrapDescriptor
    public var accepted: TreeBootstrapAccepted
    /// Every directory object plus every Markdown file object; validated with `.sparseFiles`.
    public var spine: WireSnapshot
    public var observedThrough: String

    public init(
        tree: TreeBootstrapDescriptor,
        accepted: TreeBootstrapAccepted,
        spine: WireSnapshot,
        observedThrough: String
    ) {
        self.tree = tree
        self.accepted = accepted
        self.spine = spine
        self.observedThrough = observedThrough
    }
}

/// `GET /v1/credential`: the account credential a same-installation client shares with the daemon.
public struct TreeCredential: Codable, Sendable, Equatable {
    public var token: String

    public init(token: String) { self.token = token }
}

public enum TreeBootstrapError: Error, LocalizedError, Sendable, Equatable {
    case invalidSpine(String)

    public var errorDescription: String? {
        switch self {
        case let .invalidSpine(detail):
            "Bootstrap spine is invalid: \(detail)"
        }
    }
}
