#if os(macOS)
import StoryKit
import Overstory
import Foundation

struct StorySyncServiceStatus: Codable, Sendable, Equatable {
    var service: String
    var version: String
    var protocolVersion: String
    var instanceID: String
    var runtimeKind: String
    /// `"token"` from a Story Sync that answered only because the caller sent its data home's token;
    /// absent from older builds, which check no caller and may be another user's.
    var access: String?

    init(service: String, version: String, protocolVersion: String, instanceID: String, runtimeKind: String, access: String? = nil) {
        self.service = service
        self.version = version
        self.protocolVersion = protocolVersion
        self.instanceID = instanceID
        self.runtimeKind = runtimeKind
        self.access = access
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

/// A canonical tree location is the same value on the protocol and through Story Sync.
typealias CanonicalTreeDescriptor = ProtocolCanonicalDescriptor

/// A tree as Story Sync holds it: the protocol descriptor fields plus placement,
/// display name, and synchronization state. `root` and `update` are the
/// accepted host base this placement derives from, absent until one exists.
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

struct StorySyncDiagnostic: Codable, Sendable, Equatable {
    var code: String
    var message: String
    var path: String?
    var severity: String
    var row: Int?
    var field: String?
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
struct StorySyncErrorValue: Codable, Sendable, Equatable {
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

// MARK: - Credential (`GET /v1/credential[?origin=]`)

/// `GET /v1/credential?configurationTree=[&origin=]`: a session of the account's
/// device, which a same-installation client shares with the daemon. With
/// `origin`, it is the session at that host: the account's home host, or a
/// placement host (accounts §1.3) whose trees name it as `canonical.endpoint`.
struct TreeCredential: Codable, Sendable, Equatable {
    var token: String

    init(token: String) { self.token = token }
}

#endif
