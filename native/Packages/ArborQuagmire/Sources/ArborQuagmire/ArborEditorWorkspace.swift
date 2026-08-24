import ArborKit
import Foundation

@MainActor
public struct ArborEditorLease {
    public let id: UUID
    public let identity: WorkspaceIdentity
    public let binding: ArborDocumentBinding
}

@MainActor
public final class ArborEditorWorkspace {
    private struct Entry {
        var binding: ArborDocumentBinding
        var workspaceLeases: [UUID: WorkspaceDocumentLease]
    }

    public let provider: any WorkspaceProvider
    private let coordinator: WorkspaceCoordinator
    private var entries: [WorkspaceIdentity: Entry] = [:]

    public init(provider: any WorkspaceProvider) {
        self.provider = provider
        self.coordinator = WorkspaceCoordinator(provider: provider)
    }

    public func lease(_ reference: WorkspaceReference) async throws -> ArborEditorLease {
        let workspaceLease = try await coordinator.leaseDocument(reference)
        let id = UUID()
        if var entry = entries[workspaceLease.identity] {
            entry.workspaceLeases[id] = workspaceLease
            entries[workspaceLease.identity] = entry
            return ArborEditorLease(id: id, identity: workspaceLease.identity, binding: entry.binding)
        }
        let binding = try await ArborDocumentBinding.open(reference: reference, session: workspaceLease.session)
        entries[workspaceLease.identity] = Entry(binding: binding, workspaceLeases: [id: workspaceLease])
        return ArborEditorLease(id: id, identity: workspaceLease.identity, binding: binding)
    }

    public func release(_ lease: ArborEditorLease) async {
        guard var entry = entries[lease.identity], let workspaceLease = entry.workspaceLeases.removeValue(forKey: lease.id) else { return }
        if entry.workspaceLeases.isEmpty {
            await entry.binding.flush()
            entries.removeValue(forKey: lease.identity)
        } else {
            entries[lease.identity] = entry
        }
        await coordinator.release(workspaceLease)
    }

    public func flushAll() async throws {
        for entry in entries.values { await entry.binding.flush() }
        try await coordinator.flushAll()
    }
}
