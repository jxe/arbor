import ArborKit
import ArborWire
import Foundation

public enum ReplicaSyncError: Error, Equatable, Sendable {
    case replicaIsNotPlaced
    case returnedSnapshotMissing
    case returnedSnapshotMismatch
    case returnedRequestDigestMismatch
    case conflictSnapshotMissing
    case conflictSequenceRequiresReview
    case conflictResolutionIncomplete
    case conflictPathOverlap
    case conflictContentIsNotEditable
    case noConflict
    case localWorkAdvanced
    case closed
}

extension ReplicaSyncError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case .replicaIsNotPlaced: "This replica has no accepted synchronization base."
        case .returnedSnapshotMissing: "Canopy did not return the snapshot needed to finish synchronization."
        case .returnedSnapshotMismatch: "Canopy returned content that does not match its advertised root."
        case .returnedRequestDigestMismatch: "Canopy answered a different synchronization request."
        case .conflictSnapshotMissing: "The content needed to review this conflict is unavailable or invalid."
        case .conflictSequenceRequiresReview: "Later queued changes still need ordered replay after this conflict."
        case .conflictResolutionIncomplete: "Choose a resolution for every conflicting path."
        case .conflictPathOverlap: "The reported conflict paths overlap and cannot be resolved independently."
        case .conflictContentIsNotEditable: "This conflict contains non-text content and cannot be edited as text."
        case .noConflict: "There is no current synchronization conflict."
        case .localWorkAdvanced: "The tree changed while this conflict was open. Reopen the review before submitting."
        case .closed: "This synchronization session is closed."
        }
    }
}

public enum ReplicaSyncFailurePoint: String, CaseIterable, Sendable {
    case beforeRequestPersistence
    case afterRequestPersistence
    case duringUpload
    case afterServerAcceptance
    case duringGraphDownload
    case duringMaterialization
    case afterMaterialization
    case beforeBaseAdvancement
}

public protocol ReplicaSyncFaultInjector: Sendable {
    func reached(_ point: ReplicaSyncFailurePoint) throws
}

public struct NoReplicaSyncFaults: ReplicaSyncFaultInjector {
    public init() {}
    public func reached(_: ReplicaSyncFailurePoint) throws {}
}

public protocol ReplicaWireTransport: Sendable {
    func submit(_ prepared: PreparedWireUpdate) async throws -> WireUpdateResponse
    func descriptor(tree: String) async throws -> WireCurrentTree
    func snapshot(tree: String, root: String) async throws -> WireSnapshot
}

public struct ArborWireReplicaTransport: ReplicaWireTransport, Sendable {
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
}

struct DurableSyncAttempt: Codable, Equatable, Sendable {
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

struct DurableSyncConflict: Codable, Equatable, Sendable {
    var response: WireUpdateConflict
    var localRootAtConflict: String
    /// The exact update string that stopped at `response.details.failedIndex`.
    /// Retaining it preserves the failed element and untouched suffix across
    /// restart; the final local root alone cannot recover those boundaries.
    var attempt: DurableSyncAttempt? = nil
    /// Complete, hash-validated graphs used by the review sheet. Once fetched,
    /// these remain available across restart even if the network disappears.
    var material: DurableConflictMaterial? = nil
}

struct DurableConflictMaterial: Codable, Equatable, Sendable {
    var base: WireSnapshot
    var current: WireSnapshot
    var mine: WireSnapshot
    var draft: WireSnapshot
}

struct DurableSyncControl: Codable, Equatable, Sendable {
    var schema = 1
    var attempt: DurableSyncAttempt?
    var conflict: DurableSyncConflict?
    var nextBase: WireUpdateBase?
    var presentation = WorkspaceSyncPresentation(state: .offline)
}

public struct ReplicaConflictPresentation: Sendable, Equatable {
    public var base: String
    public var local: String
    public var remote: String
    public var draft: String
    public var reasons: [WireConflictReason]

    public init(base: String, local: String, remote: String, draft: String, reasons: [WireConflictReason]) {
        self.base = base
        self.local = local
        self.remote = remote
        self.draft = draft
        self.reasons = reasons
    }
}

public enum ReplicaConflictContent: Sendable, Equatable {
    case missing
    case text(String)
    case binary(Data)
    case directory([String])
    case boundary(tree: String)

    public var editableText: String? {
        if case let .text(value) = self { value } else { nil }
    }

    public var summary: String {
        switch self {
        case .missing: "Not present"
        case let .text(value): value
        case let .binary(bytes): "Binary content, \(bytes.count) bytes"
        case let .directory(entries): entries.isEmpty ? "Empty directory" : "Directory containing: \(entries.joined(separator: ", "))"
        case let .boundary(tree): "Shared tree boundary: \(tree)"
        }
    }
}

public struct ReplicaConflictItem: Identifiable, Sendable, Equatable {
    public var id: String { path }
    public var path: String
    public var reasons: [String]
    public var base: ReplicaConflictContent
    public var current: ReplicaConflictContent
    public var mine: ReplicaConflictContent
    public var draft: ReplicaConflictContent
    public var offersBoth: Bool

    public init(
        path: String,
        reasons: [String],
        base: ReplicaConflictContent,
        current: ReplicaConflictContent,
        mine: ReplicaConflictContent,
        draft: ReplicaConflictContent,
        offersBoth: Bool
    ) {
        self.path = path
        self.reasons = reasons
        self.base = base
        self.current = current
        self.mine = mine
        self.draft = draft
        self.offersBoth = offersBoth
    }
}

public struct ReplicaConflictWorkspace: Sendable, Equatable {
    public var identity: String
    public var items: [ReplicaConflictItem]
    public var unattemptedCount: Int

    public init(identity: String, items: [ReplicaConflictItem], unattemptedCount: Int) {
        self.identity = identity
        self.items = items
        self.unattemptedCount = unattemptedCount
    }
}

public enum ReplicaConflictResolution: Sendable, Equatable {
    case current
    case mine
    /// Use the server-produced draft value at this path.
    case both
    case edit(String)
}
