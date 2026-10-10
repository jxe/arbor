import Foundation

public struct WorkspaceDocumentLease: Sendable {
    public let id: UUID
    public let identity: WorkspaceIdentity
    public let session: any WorkspaceDocumentSession

    fileprivate init(id: UUID, identity: WorkspaceIdentity, session: any WorkspaceDocumentSession) {
        self.id = id
        self.identity = identity
        self.session = session
    }
}

public actor WorkspaceCoordinator {
    private struct Entry {
        var session: any WorkspaceDocumentSession
        var leaseIDs: Set<UUID>
    }

    private let provider: any WorkspaceProvider
    private var sessions: [WorkspaceIdentity: Entry] = [:]

    public init(provider: any WorkspaceProvider) {
        self.provider = provider
    }

    public func leaseDocument(_ reference: WorkspaceReference) async throws -> WorkspaceDocumentLease {
        let node = try await provider.resolve(reference)
        guard node.surface.supportsDocumentSession else {
            throw WorkspaceProviderError.notDocument(node.reference)
        }
        let identity = node.reference.identity
        let leaseID = UUID()
        if var entry = sessions[identity] {
            entry.leaseIDs.insert(leaseID)
            sessions[identity] = entry
            return WorkspaceDocumentLease(id: leaseID, identity: identity, session: entry.session)
        }
        let session = try await provider.openDocument(node.reference)
        let durableIdentity = await session.identity
        if var entry = sessions[durableIdentity] {
            // Opening may promote a path-only document to a durable stable key.
            // Reuse the already-live session if another presentation arrived
            // through the durable identity first.
            await session.close()
            entry.leaseIDs.insert(leaseID)
            sessions[durableIdentity] = entry
            return WorkspaceDocumentLease(id: leaseID, identity: durableIdentity, session: entry.session)
        }
        sessions[durableIdentity] = Entry(session: session, leaseIDs: [leaseID])
        return WorkspaceDocumentLease(id: leaseID, identity: durableIdentity, session: session)
    }

    public func release(_ lease: WorkspaceDocumentLease) async {
        guard var entry = sessions[lease.identity] else { return }
        entry.leaseIDs.remove(lease.id)
        if entry.leaseIDs.isEmpty {
            sessions.removeValue(forKey: lease.identity)
            await entry.session.close()
        } else {
            sessions[lease.identity] = entry
        }
    }

    public func flushAll() async throws {
        for entry in sessions.values { try await entry.session.flush() }
    }

    public func activeSessionCount() -> Int { sessions.count }
}
