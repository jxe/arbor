import ArborKit
import ArborWire
import Foundation

public enum ReplicaSyncError: Error, Equatable, Sendable {
    case replicaIsNotPlaced
    case returnedSnapshotMissing
    case returnedSnapshotMismatch
    case returnedRequestDigestMismatch
    case conflictSnapshotMissing
    case noConflict
    case localWorkAdvanced
    case closed
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
    func currentSnapshot(tree: String) async throws -> WireCurrentSnapshot
}

public struct ArborWireReplicaTransport: ReplicaWireTransport, Sendable {
    public let client: ArborWireClient

    public init(client: ArborWireClient) { self.client = client }
    public func submit(_ prepared: PreparedWireUpdate) async throws -> WireUpdateResponse {
        try await client.submitUpdateResponse(prepared)
    }
    public func currentSnapshot(tree: String) async throws -> WireCurrentSnapshot {
        try await client.currentSnapshot(tree: tree)
    }
}

struct DurableSyncAttempt: Codable, Equatable, Sendable {
    var tree: String
    var base: WireUpdateBase
    var candidate: String
    var generation: Int
    var body: Data
    var digest: String
}

struct DurableSyncConflict: Codable, Equatable, Sendable {
    var response: WireUpdateConflict
    var localRootAtConflict: String
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
