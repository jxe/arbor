import ArborKit
import ArborWire
import Foundation

public enum UpdateError: Error, Equatable, Sendable {
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
    case adoptionBlocked
    case adoptedRequestDigestMismatch
    case adoptedRequestEmpty
    case unsupportedControlSchema(Int)
}

extension UpdateError: LocalizedError {
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
        case .adoptionBlocked: "Another request or conflict is already retained; nothing can be adopted."
        case .adoptedRequestDigestMismatch: "The adopted request's recomputed digests do not match the ones it was persisted with."
        case .adoptedRequestEmpty: "An adopted request must carry at least one element."
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
    /// How many leading elements were adopted verbatim from another working
    /// tree's persisted request (the daemon's). Those elements are owned by
    /// their author: a conflict inside the prefix is held, never reviewed here.
    var adoptedCount: Int?

    var allRequestDigests: [String] { requestDigests ?? [digest] }
    var adoptedElementCount: Int { adoptedCount ?? 0 }
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

/// Why submission is paused. A hold keeps every durable record (head, attempt)
/// intact and reports `conflict`; it never discards work.
public struct UpdateHold: Codable, Equatable, Sendable {
    public var reason: String
    /// The hold was raised because an element inside an adopted prefix
    /// conflicted. That element belongs to the working tree that authored it
    /// (the daemon's placed folder); its review happens in that tree's flow,
    /// never in this client's conflict sheet.
    public var foreignConflict: Bool

    public init(reason: String, foreignConflict: Bool = false) {
        self.reason = reason
        self.foreignConflict = foreignConflict
    }
}

struct UpdateConflictRecord: Codable, Equatable, Sendable {
    var response: WireUpdateConflict
    var localRootAtConflict: String
    /// The exact update string that stopped at `response.details.failedIndex`.
    /// Retaining it preserves the failed element and untouched suffix across
    /// restart; the final local root alone cannot recover those boundaries.
    var attempt: UpdateAttempt? = nil
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

/// Schema 2 adds `head` and `hold`; schema 1 files (placed iOS devices) decode
/// with both absent and are rewritten as schema 2 on the next write.
struct UpdateControl: Codable, Equatable, Sendable {
    static let currentSchema = 2

    var schema = UpdateControl.currentSchema
    var attempt: UpdateAttempt?
    var conflict: UpdateConflictRecord?
    var nextBase: WireUpdateBase?
    var head: UpdateHead?
    var hold: UpdateHold?
    var presentation = WorkspaceSyncPresentation(state: .offline)
}

public struct UpdateConflictPresentation: Sendable, Equatable {
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

public enum UpdateConflictContent: Sendable, Equatable {
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

public struct UpdateConflictItem: Identifiable, Sendable, Equatable {
    public var id: String { path }
    public var path: String
    public var reasons: [String]
    public var base: UpdateConflictContent
    public var current: UpdateConflictContent
    public var mine: UpdateConflictContent
    public var draft: UpdateConflictContent
    public var offersBoth: Bool

    public init(
        path: String,
        reasons: [String],
        base: UpdateConflictContent,
        current: UpdateConflictContent,
        mine: UpdateConflictContent,
        draft: UpdateConflictContent,
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

public struct UpdateConflictWorkspace: Sendable, Equatable {
    public var identity: String
    public var items: [UpdateConflictItem]
    public var unattemptedCount: Int

    public init(identity: String, items: [UpdateConflictItem], unattemptedCount: Int) {
        self.identity = identity
        self.items = items
        self.unattemptedCount = unattemptedCount
    }
}

public enum UpdateConflictResolution: Sendable, Equatable {
    case current
    case mine
    /// Use the server-produced draft value at this path.
    case both
    case edit(String)
}
