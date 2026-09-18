import ArborKit
import ArborWire
import Foundation

public enum UpdateError: Error, Equatable, Sendable {
    case awaitingCanopyReconciliation
    case replicaIsNotPlaced
    case returnedSnapshotMissing
    case returnedSnapshotMismatch
    case returnedRequestDigestMismatch
    case retainedLegacyConflict
    case closed
    case requestEmpty
    case unsupportedControlSchema(Int)
}

extension UpdateError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case .awaitingCanopyReconciliation: "Editing can continue. Creating, moving and importing items will resume after Canopy reconciles pending changes."
        case .replicaIsNotPlaced: "This replica has no accepted synchronization base."
        case .returnedSnapshotMissing: "Canopy did not return the snapshot needed to finish synchronization."
        case .returnedSnapshotMismatch: "Canopy returned content that does not match its advertised root."
        case .returnedRequestDigestMismatch: "Canopy answered a different synchronization request."
        case .retainedLegacyConflict: "This device contains an older synchronization conflict or hold. Saved work is unchanged and needs recovery with the prior client."
        case .closed: "This synchronization session is closed."
        case .requestEmpty: "An update request must carry at least one element."
        case let .unsupportedControlSchema(schema): "Update control schema \(schema) is newer than this client."
        }
    }
}

public enum UpdateFailurePoint: String, CaseIterable, Sendable {
    case beforeRequestPersistence
    case afterRequestPersistence
    case duringUpload
    case afterServerAcceptance
    case duringGraphDownload
    case duringMaterialization
    case afterMaterialization
    case beforeBaseAdvancement
}

public protocol UpdateFaultInjector: Sendable {
    func reached(_ point: UpdateFailurePoint) throws
}

public struct NoUpdateFaults: UpdateFaultInjector {
    public init() {}
    public func reached(_: UpdateFailurePoint) throws {}
}

public protocol UpdateTransport: Sendable {
    func submit(_ prepared: PreparedWireUpdate) async throws -> WireUpdateResponse
    func descriptor(tree: String) async throws -> WireCurrentTree
    func snapshot(tree: String, root: String) async throws -> WireSnapshot
    func conflicts(tree: String, state: String, root: String, after: String?) async throws -> WireDecisionPageContract
    func conflictObject(tree: String, state: String, conflict: String, alternative: String, hash: String) async throws -> Data
}

extension UpdateTransport {
    public func conflicts(tree: String, state: String, root: String, after: String?) async throws -> WireDecisionPageContract {
        throw ConflictReviewError.unavailable
    }
    public func conflictObject(tree: String, state: String, conflict: String, alternative: String, hash: String) async throws -> Data { throw ConflictReviewError.unavailable }
}

public struct ArborWireReplicaTransport: UpdateTransport, Sendable {
    public let client: ArborWireClient

    public init(client: ArborWireClient) { self.client = client }
    public func submit(_ prepared: PreparedWireUpdate) async throws -> WireUpdateResponse {
        try await client.submitUpdateResponse(prepared)
    }
    public func descriptor(tree: String) async throws -> WireCurrentTree {
        try await client.descriptor(tree: tree)
    }
    public func snapshot(tree: String, root: String) async throws -> WireSnapshot {
        try await client.snapshot(tree: tree, root: root)
    }
    public func conflicts(tree: String, state: String, root: String, after: String?) async throws -> WireDecisionPageContract {
        try await client.conflicts(tree: tree, state: state, root: root, after: after)
    }
    public func conflictObject(tree: String, state: String, conflict: String, alternative: String, hash: String) async throws -> Data { try await client.conflictObject(tree: tree, state: state, conflict: conflict, alternative: alternative, hash: hash) }
}

/// One exact persisted request: its body (with every object envelope it
/// carries) is the immutable record resubmission reads. It never consults a
/// live object store, so overlay collection cannot change what is resent.
struct UpdateAttempt: Codable, Equatable, Sendable {
    var tree: String
    var base: WireUpdateBase
    var candidate: String
    var generation: Int
    var body: Data
    /// All per-element digests in prefix order. Nil decodes a pre-plural durable one-element attempt.
    var requestDigests: [String]?
    var digest: String

    var allRequestDigests: [String] { requestDigests ?? [digest] }
}

/// The latest durable local head together with the objects it introduces over
/// its base, written before the machine learns of the head. A process that
/// stops before the publication delay recovers this as a one-element attempt.
struct UpdateHead: Codable, Equatable, Sendable {
    /// Inline object bytes above this total spill to `objects/<hash>` beside the control file.
    static let inlineByteCap = 32 * 1024 * 1024

    var base: WireUpdateBase
    var root: String
    var generation: Int
    /// Objects carried inline.
    var objects: [WireObjectEnvelope]
    /// Objects spilled beside the control file and referenced by hash.
    var spilledObjects: [String]?
}

/// Schema 2 retains snapshot heads. Old conflict/hold records are rejected by
/// the loader before decoding can silently discard their recovery material.
/// Schema 3 protects opt-in source queues from older clients. Legacy mode stays at 2.
struct UpdateControl: Codable, Equatable, Sendable {
    static let currentSchema = 3

    /// Source-session activation is an explicit server-first release choice.
    var sourceMode: Bool?
    var sourceAttemptChange: String?
    var sourceAcceptedChanges: [String]?
    var acceptedConflicted: Bool?
    var schema = 2
    var attempt: UpdateAttempt?
    var nextBase: WireUpdateBase?
    var head: UpdateHead?
    var presentation = WorkspaceSyncPresentation(state: .offline)

    var hasLegacyWork: Bool {
        head != nil || nextBase != nil ||
            (attempt != nil && sourceAttemptChange == nil)
    }
}
