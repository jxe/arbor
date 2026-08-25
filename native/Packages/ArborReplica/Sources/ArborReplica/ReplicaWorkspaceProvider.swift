import ArborKit
import Foundation

public struct ReplicaWorkspaceProvider: WorkspaceProvider, Sendable {
    public let replica: ArborReplica
    private let onPatchAdmission: (@Sendable (ReplicaPatchAdmission) async -> Void)?

    public init(
        replica: ArborReplica,
        onPatchAdmission: (@Sendable (ReplicaPatchAdmission) async -> Void)? = nil
    ) {
        self.replica = replica
        self.onPatchAdmission = onPatchAdmission
    }

    public func resolve(_ reference: WorkspaceReference) async throws -> WorkspaceNode {
        if let diagnostic = try await diagnostic(for: reference) { return diagnostic }
        let record = try await replica.resolve(reference)
        return try await workspaceNode(record)
    }

    public func children(of reference: WorkspaceReference) async throws -> [WorkspaceNode] {
        var nodes = try await replica.children(of: reference).asyncMap { try await workspaceNode($0) }
        if reference.pathHint == "/" {
            nodes.append(contentsOf: try await replica.diagnostics().asyncMap { await diagnosticNode($0) })
        }
        return nodes
    }

    public func search(_ query: String, in tree: TreeID) async throws -> [WorkspaceSearchResult] {
        let replicaTree = await replica.treeID()
        guard tree == replicaTree else { return [] }
        guard try await replica.heads().generation >= 0 else { return [] }
        return try await replica.search(query).map { entry in
            WorkspaceSearchResult(
                reference: WorkspaceReference(
                    tree: tree,
                    path: entry.path,
                    pageID: entry.pageID.map(PageID.init(rawValue:))
                ),
                title: entry.title,
                excerpt: entry.source.isEmpty ? nil : entry.source
            )
        }
    }

    public func backlinks(to reference: WorkspaceReference) async throws -> [WorkspaceSearchResult] {
        try await replica.backlinks(to: reference).map { entry in
            WorkspaceSearchResult(
                reference: WorkspaceReference(
                    tree: reference.tree,
                    path: entry.path,
                    pageID: entry.pageID.map(PageID.init(rawValue:))
                ),
                title: entry.title,
                excerpt: reference.pathHint
            )
        }
    }

    public func perform(_ action: WorkspaceStructuralAction) async throws -> WorkspaceNode? {
        let node: ReplicaNodeRecord
        switch action {
        case let .createMarkdown(parent, name, source):
            node = try await replica.createMarkdown(parent: parent, name: name, source: source)
        case let .createDirectory(parent, name):
            node = try await replica.createDirectory(parent: parent, name: name)
        case let .rename(reference, name):
            node = try await replica.rename(reference, name: name)
        case let .move(reference, destination):
            node = try await replica.move(reference, destination: destination)
        case let .copy(reference, destination):
            node = try await replica.copy(reference, destination: destination)
        case let .trash(reference):
            node = try await replica.trash(reference)
        case let .restore(reference):
            node = try await replica.restore(reference)
        }
        return try await workspaceNode(node)
    }

    public func store(asset: WorkspaceAsset, in parent: WorkspaceReference) async throws -> WorkspaceReference {
        let node = try await replica.storeAsset(asset, in: parent)
        return await replica.workspaceReference(node)
    }

    public func openDocument(_ reference: WorkspaceReference) async throws -> any WorkspaceDocumentSession {
        let node = try await resolve(reference)
        guard node.surface.supportsDocumentSession else { throw WorkspaceProviderError.notDocument(node.reference) }
        return ReplicaDocumentSession(
            replica: replica,
            reference: node.reference,
            onPatchAdmission: onPatchAdmission
        )
    }

    @discardableResult
    public func importFile(
        name: String,
        bytes: Data,
        mediaType: String? = nil,
        in parent: WorkspaceReference
    ) async throws -> WorkspaceNode {
        let record = try await replica.importFile(name: name, bytes: bytes, mediaType: mediaType, parent: parent)
        return try await workspaceNode(record)
    }

    private func workspaceNode(_ record: ReplicaNodeRecord) async throws -> WorkspaceNode {
        let reference = await replica.workspaceReference(record)
        let revision = await replica.revision(for: record)
        let surface: WorkspaceSurface
        switch record.kind {
        case .markdown:
            surface = .markdown(source: record.source ?? "", contentRevision: revision)
        case .directory:
            if let collection = await replica.collection(for: record) {
                surface = .collection(kind: collection.kind, rowCount: collection.rows)
            } else {
                surface = .directoryDocument(
                    source: await replica.completeSource(for: record) ?? "",
                    contentRevision: revision,
                    stored: record.source != nil
                )
            }
        case .file:
            surface = .file(
                name: ReplicaSemantics.name(of: record.path),
                byteCount: record.bytes?.count ?? 0,
                mediaType: record.mediaType
            )
        case .boundary:
            surface = .placeholder(message: "Nested Arbor tree \(record.boundaryTree ?? "")")
        }
        return WorkspaceNode(
            reference: reference,
            title: ReplicaSemantics.title(for: record),
            surface: surface,
            provenance: WorkspaceProvenance(
                authority: .local,
                sourceDescription: "Offline replica",
                contentRevision: revision
            ),
            materialization: .available,
            isWritable: true
        )
    }

    private func diagnostic(for reference: WorkspaceReference) async throws -> WorkspaceNode? {
        guard reference.pathHint.hasPrefix("/.replica-diagnostic-") else { return nil }
        let replicaTree = await replica.treeID()
        guard reference.tree == replicaTree else { return nil }
        let expected = String(reference.pathHint.dropFirst("/.replica-diagnostic-".count))
        guard let diagnostic = try await replica.diagnostics().first(where: { safeDiagnosticID($0.id) == expected }) else { return nil }
        return await diagnosticNode(diagnostic)
    }

    private func diagnosticNode(_ diagnostic: ReplicaDiagnostic) async -> WorkspaceNode {
        WorkspaceNode(
            reference: WorkspaceReference(
                tree: await replica.treeID(),
                path: "/.replica-diagnostic-\(safeDiagnosticID(diagnostic.id))"
            ),
            title: diagnostic.title,
            surface: .diagnostic(title: diagnostic.title, detail: diagnostic.detail),
            provenance: WorkspaceProvenance(authority: .diagnostic, sourceDescription: "Offline replica integrity"),
            isWritable: false
        )
    }

    private func safeDiagnosticID(_ value: String) -> String {
        value.replacingOccurrences(of: "sha256:", with: "")
    }
}

public actor ReplicaDocumentSession: WorkspaceDocumentSession {
    public nonisolated let identity: WorkspaceIdentity
    private let replica: ArborReplica
    private let initialReference: WorkspaceReference
    private let onPatchAdmission: (@Sendable (ReplicaPatchAdmission) async -> Void)?
    private var terminal = false

    init(
        replica: ArborReplica,
        reference: WorkspaceReference,
        onPatchAdmission: (@Sendable (ReplicaPatchAdmission) async -> Void)?
    ) {
        self.replica = replica
        self.initialReference = reference
        self.onPatchAdmission = onPatchAdmission
        self.identity = reference.identity
    }

    public func snapshot() async throws -> WorkspaceDocumentSnapshot {
        try requireOpen()
        return try await replica.documentSnapshot(initialReference)
    }

    public func admit(source: String, baseContentRevision: String) async throws -> WorkspaceDocumentSnapshot {
        try requireOpen()
        do {
            return try await replica.writeDocument(initialReference, source: source, baseRevision: baseContentRevision)
        } catch ReplicaError.staleRevision {
            let current = try await replica.documentSnapshot(initialReference)
            throw WorkspaceDocumentConflict(current: current, submittedSource: source)
        }
    }

    public func admit(patch: WorkspaceDocumentPatch) async throws -> WorkspaceDocumentSnapshot {
        try requireOpen()
        do {
            let result = try await replica.writeDocument(initialReference, patch: patch)
            if let onPatchAdmission {
                let admission = result.admission
                Task { await onPatchAdmission(admission) }
            }
            return result.snapshot
        } catch ReplicaError.staleRevision {
            let current = try await replica.documentSnapshot(initialReference)
            let submitted = (try? patch.applying(to: current.source)) ?? current.source
            throw WorkspaceDocumentConflict(current: current, submittedSource: submitted)
        }
    }

    public func flush() async throws {
        try requireOpen()
    }

    public func history() async throws -> [WorkspaceHistoryEntry] {
        try requireOpen()
        return try await replica.history(for: initialReference)
    }

    public func recover(revision: String) async throws -> WorkspaceDocumentSnapshot {
        try requireOpen()
        return try await replica.recover(initialReference, revision: revision)
    }

    public func close() async {
        terminal = true
    }

    private func requireOpen() throws {
        if terminal { throw ReplicaError.closed }
    }
}

private extension Array {
    func asyncMap<T>(_ transform: (Element) async throws -> T) async rethrows -> [T] {
        var result: [T] = []
        result.reserveCapacity(count)
        for element in self { result.append(try await transform(element)) }
        return result
    }
}
