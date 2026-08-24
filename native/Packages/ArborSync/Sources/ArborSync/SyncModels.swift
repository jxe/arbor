import ArborKit
import ArborWire
import Foundation

public enum ReplicaSyncError: Error, Equatable, Sendable {
    case replicaIsNotPlaced
    case returnedSnapshotMissing
    case returnedSnapshotMismatch
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

public protocol ReplicaAuthorityTransport: Sendable {
    func submit(_ prepared: PreparedAuthorityUpdate) async throws -> AuthorityUpdateResponse
    func snapshot(root: String) async throws -> AuthoritySnapshot
}

public struct ArborWireReplicaTransport: ReplicaAuthorityTransport, Sendable {
    public let client: ArborAuthorityClient

    public init(client: ArborAuthorityClient) { self.client = client }
    public func submit(_ prepared: PreparedAuthorityUpdate) async throws -> AuthorityUpdateResponse {
        try await client.submitUpdateResponse(prepared)
    }
    public func snapshot(root: String) async throws -> AuthoritySnapshot {
        try await client.snapshot(root: root)
    }
}

struct DurableSyncAttempt: Codable, Equatable, Sendable {
    var tree: String
    var base: AuthorityUpdateBase
    var candidate: String
    var generation: Int
    var body: Data
    var digest: String
}

struct DurableSyncConflict: Codable, Equatable, Sendable {
    var response: AuthorityUpdateConflict
    var localRootAtConflict: String
}

struct DurableSyncControl: Codable, Equatable, Sendable {
    var schema = 1
    var attempt: DurableSyncAttempt?
    var conflict: DurableSyncConflict?
    var nextBase: AuthorityUpdateBase?
    var presentation = WorkspaceSyncPresentation(state: .offline)
}

public struct ReplicaConflictPresentation: Sendable, Equatable {
    public var base: String
    public var local: String
    public var remote: String
    public var draft: String
    public var reasons: [AuthorityConflictReason]

    public init(base: String, local: String, remote: String, draft: String, reasons: [AuthorityConflictReason]) {
        self.base = base
        self.local = local
        self.remote = remote
        self.draft = draft
        self.reasons = reasons
    }
}
