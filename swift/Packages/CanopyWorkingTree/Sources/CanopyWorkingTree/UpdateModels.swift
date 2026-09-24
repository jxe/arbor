import CanopyAppKit
import Overstory
import Foundation

/// JSON with sorted keys and default strategies: the stable spelling of
/// request bodies, digests, tokens, and the sync directory's journals.
func sortedKeysJSON<T: Encodable>(_ value: T) throws -> Data {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    return try encoder.encode(value)
}

public enum UpdateError: Error, Equatable, Sendable {
    case awaitingCanopyReconciliation
    case replicaIsNotPlaced
    case returnedSnapshotMissing
    case returnedSnapshotMismatch
    case returnedRequestDigestMismatch
    case closed
    case requestEmpty
    case unsupportedControlSchema(Int)
    /// Durable state from an earlier client still holds unpublished work in a
    /// form this client no longer runs. Nothing is decoded away or rewritten.
    case earlierPendingWork(String)
}

extension UpdateError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case .awaitingCanopyReconciliation: "Editing can continue. Creating, moving and importing items will resume after Canopy reconciles pending changes."
        case .replicaIsNotPlaced: "This replica has no accepted synchronization base."
        case .returnedSnapshotMissing: "Canopy did not return the snapshot needed to finish synchronization."
        case .returnedSnapshotMismatch: "Canopy returned content that does not match its advertised root."
        case .returnedRequestDigestMismatch: "Canopy answered a different synchronization request."
        case .closed: "This synchronization session is closed."
        case .requestEmpty: "An update request must carry at least one element."
        case let .unsupportedControlSchema(schema): "Update control schema \(schema) is newer than this client."
        case let .earlierPendingWork(file): "\(file) holds unpublished work from an earlier version of Canopy. Open this tree with that version to finish publishing it, then update."
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
    /// One immutable object by hash, for directory walks that avoid a full snapshot.
    func object(tree: String, hash: String) async throws -> Data
}

extension UpdateTransport {
    public func object(tree: String, hash: String) async throws -> Data { throw UpdateError.returnedSnapshotMissing }
    public func conflicts(tree: String, state: String, root: String, after: String?) async throws -> WireDecisionPageContract {
        throw ConflictReviewError.unavailable
    }
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
    public func object(tree: String, hash: String) async throws -> Data { try await client.object(tree: tree, hash: hash) }
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

/// Why a retained request is held, so a restart holds it again.
struct HeldRecord: Codable, Equatable, Sendable {
    var reason: UpdateMachine.HeldReason
    var detail: String?
}

extension UpdateMachine.HeldReason: Codable {}

/// What the update machine's runner retains beside the change log: the exact
/// persisted request and the change it ends at, why it is held, and which
/// changes have settled. The accepted `{ root, update, cursor }` is the
/// working tree's own state. Schema 4 dropped the snapshot head and next base
/// of the earlier snapshot publication path.
struct UpdateControl: Codable, Equatable, Sendable {
    static let currentSchema = 4

    var schema = currentSchema
    var attempt: UpdateAttempt?
    /// The local change the attempt's last element carries.
    var attemptTip: String?
    var held: HeldRecord?
    /// Changes an accepted update incorporates, until the log compacts them.
    var settled: [String] = []
    var acceptedConflicted: Bool?

    init() {}

    private enum CodingKeys: String, CodingKey {
        case schema, attempt, attemptTip, held, settled, acceptedConflicted
        // Schema 3.
        case sourceAttemptChange, sourceAcceptedChanges, head, nextBase
    }

    init(from decoder: any Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        schema = try values.decode(Int.self, forKey: .schema)
        guard schema <= Self.currentSchema else { throw UpdateError.unsupportedControlSchema(schema) }
        attempt = try values.decodeIfPresent(UpdateAttempt.self, forKey: .attempt)
        acceptedConflicted = try values.decodeIfPresent(Bool.self, forKey: .acceptedConflicted)
        if schema < 4 {
            // A snapshot head, a next base, or an attempt outside the change log
            // is unpublished work this client cannot run: refuse, rewrite nothing.
            let tip = try values.decodeIfPresent(String.self, forKey: .sourceAttemptChange)
            if values.contains(.head) && (try? values.decodeNil(forKey: .head)) == false { throw UpdateError.earlierPendingWork("update-control.json") }
            if values.contains(.nextBase) && (try? values.decodeNil(forKey: .nextBase)) == false { throw UpdateError.earlierPendingWork("update-control.json") }
            if attempt != nil, tip == nil { throw UpdateError.earlierPendingWork("update-control.json") }
            attemptTip = tip
            settled = try values.decodeIfPresent([String].self, forKey: .sourceAcceptedChanges) ?? []
        } else {
            attemptTip = try values.decodeIfPresent(String.self, forKey: .attemptTip)
            held = try values.decodeIfPresent(HeldRecord.self, forKey: .held)
            settled = try values.decodeIfPresent([String].self, forKey: .settled) ?? []
        }
        schema = Self.currentSchema
    }

    func encode(to encoder: any Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(schema, forKey: .schema)
        try values.encodeIfPresent(attempt, forKey: .attempt)
        try values.encodeIfPresent(attemptTip, forKey: .attemptTip)
        try values.encodeIfPresent(held, forKey: .held)
        try values.encode(settled, forKey: .settled)
        try values.encodeIfPresent(acceptedConflicted, forKey: .acceptedConflicted)
    }
}
