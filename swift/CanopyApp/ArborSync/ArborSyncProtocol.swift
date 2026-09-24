#if os(macOS)
import CanopyAppKit
import Overstory
import Foundation

struct ArborSyncServiceStatus: Codable, Sendable, Equatable {
    var service: String
    var version: String
    var protocolVersion: String
    var instanceID: String
    var runtimeKind: String

    init(service: String, version: String, protocolVersion: String, instanceID: String, runtimeKind: String) {
        self.service = service
        self.version = version
        self.protocolVersion = protocolVersion
        self.instanceID = instanceID
        self.runtimeKind = runtimeKind
    }
}

/// One node location with optional schema-derived stable identity.
struct NodeRef: Codable, Sendable, Equatable {
    var tree: String
    var path: String
    var stableKey: String?

    init(tree: String, path: String, stableKey: String? = nil) {
        self.tree = tree
        self.path = path
        self.stableKey = stableKey
    }

    static func path(_ path: String, tree: String) -> NodeRef {
        NodeRef(tree: tree, path: path)
    }

    private enum CodingKeys: String, CodingKey { case tree, path, stableKey, pageID, pathHint }

    init(from decoder: Decoder) throws {
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

    func encode(to encoder: Encoder) throws {
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

/// A canonical tree location is the same value on the protocol and through Arbor Sync.
typealias CanonicalTreeDescriptor = ProtocolCanonicalDescriptor

struct SnapshotEnvelope<Value: Codable & Sendable & Equatable>: Codable, Sendable, Equatable {
    var snapshot: Value
    var observedThrough: String
}

struct LocatorResolution: Codable, Sendable, Equatable {
    var ref: NodeRef
    var enclosingTree: TreeDescriptor?
    var historical: Bool
    var observedThrough: String
}

struct TreeDescriptor: Codable, Sendable, Equatable {
    var id: String
    var kind: String
    var access: String
    var canonical: CanonicalTreeDescriptor?
}

/// A tree as Arbor Sync holds it: the protocol descriptor fields plus placement,
/// display name, and synchronization state. `root` and `update` are the
/// accepted Canopy base this placement derives from, absent until one exists.
struct LocalTreeDescriptor: Codable, Sendable, Equatable {
    var conflicted: Bool?
    var id: String
    var configurationTree: String?
    var kind: String
    var access: String
    var canonical: CanonicalTreeDescriptor?
    var root: String?
    var update: String?
    var name: String
    var osPath: String?
    var placement: String
    var sync: String?
    var missing: Bool?
}

struct ArborSyncDiagnostic: Codable, Sendable, Equatable {
    var code: String
    var message: String
    var path: String?
    var severity: String
    var row: Int?
    var field: String?
}

struct MutationEffect: Codable, Sendable, Equatable {
    var kind: String
    var ref: NodeRef
    var previousPath: String?
    var contentRevision: String?
    var propertiesRevision: String?
    /// Exact top-level property names when the provider can prove them.
    var changedProperties: [String]?
    var directoryRevision: String?
}

struct WorkspaceChange: Codable, Sendable, Equatable {
    var ref: NodeRef
    var previousPath: String?
    var contentRevision: String?
    var propertiesRevision: String?
    /// Exact top-level property names when the provider can prove them.
    var changedProperties: [String]?
    var directoryRevision: String?
    var origin: String
    var mutationID: String?
    /// Authenticated protocol requests incorporated by this materialized sync transition.
    var acceptedRequestDigests: [String]?
}

struct WorkspaceEvent: Codable, Sendable, Equatable {
    var cursor: String
    /// Scope the event belongs to; one process-wide stream orders all scopes.
    var tree: String
    var kind: String
    var change: WorkspaceChange
}

/// A daemon error body. The wire names the code `error`.
struct ArborSyncErrorValue: Codable, Sendable, Equatable {
    var code: String
    var message: String
    var retryable: Bool
    var tree: String?
    var path: String?
    var details: JSONValue?

    private enum CodingKeys: String, CodingKey {
        case code = "error", message, retryable, tree, path, details
    }

    init(
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

// MARK: - Bootstrap and credential (`GET /v1/bootstrap`, `GET /v1/credential`)

/// The daemon's recorded accepted base for a placement; `cursor` equals `update` and seeds a protocol watch.
struct TreeBootstrapAccepted: Codable, Sendable, Equatable {
    var root: String
    var update: String
    var cursor: String?

    init(root: String, update: String, cursor: String?) {
        self.root = root
        self.update = update
        self.cursor = cursor
    }
}

/// Placement and routing metadata needed to open a working tree. Daemon
/// synchronization state is deliberately not part of the bootstrap contract.
struct TreeBootstrapDescriptor: Codable, Sendable, Equatable {
    var id: String
    var configurationTree: String?
    var kind: String
    var access: String
    var canonical: CanonicalTreeDescriptor?
    var name: String
    var osPath: String?
    var placement: String
}

/// `GET /v1/bootstrap?tree=`: what a loopback client needs to open a placed tree as its own
/// working tree. Mirrors `TreeBootstrap` in `@arbor/arborsync-client`, with the base64 spine
/// already decoded and validated in sparse mode.
struct TreeBootstrap: Sendable, Equatable {
    var tree: TreeBootstrapDescriptor
    var accepted: TreeBootstrapAccepted
    /// Every directory object plus every Markdown file object; validated with `.sparseFiles`.
    var spine: ProtocolSnapshot
    var observedThrough: String

    init(
        tree: TreeBootstrapDescriptor,
        accepted: TreeBootstrapAccepted,
        spine: ProtocolSnapshot,
        observedThrough: String
    ) {
        self.tree = tree
        self.accepted = accepted
        self.spine = spine
        self.observedThrough = observedThrough
    }
}

/// `GET /v1/credential`: the account credential a same-installation client shares with the daemon.
struct TreeCredential: Codable, Sendable, Equatable {
    var token: String

    init(token: String) { self.token = token }
}

enum TreeBootstrapError: Error, LocalizedError, Sendable, Equatable {
    case invalidSpine(String)

    var errorDescription: String? {
        switch self {
        case let .invalidSpine(detail):
            "Bootstrap spine is invalid: \(detail)"
        }
    }
}
#endif
