import ArborKit
import Foundation

public struct WorkingTreeProvider: WorkspaceProvider, Sendable {
    public let workingTree: WorkingTree
    /// A read-only provider presents every node as not writable and refuses
    /// structural actions, assets, imports, and document admissions: a visit,
    /// or a placed tree opened while its folder's daemon holds a conflict.
    public let readOnly: Bool
    private let sourceCoordinator: UpdateCoordinator?
    private let onPatchAdmission: (@Sendable (WorkingTreePatchAdmission) async throws -> Void)?

    public init(
        workingTree: WorkingTree,
        readOnly: Bool = false,
        sourceCoordinator: UpdateCoordinator? = nil,
        onPatchAdmission: (@Sendable (WorkingTreePatchAdmission) async throws -> Void)? = nil
    ) {
        self.workingTree = workingTree
        self.sourceCoordinator = sourceCoordinator?.sourceOperationEmission == true ? sourceCoordinator : nil
        self.readOnly = readOnly
        self.onPatchAdmission = onPatchAdmission
    }

    public func capabilities() async -> WorkspaceProviderCapabilities {
        if readOnly { return .readOnly }
        if let sourceCoordinator {
            let available = (try? await sourceCoordinator.sourceStructuralActionsAvailable()) ?? false
            return .init(structuralActions: available, assets: available, localHistory: false)
        }
        return .full
    }

    public func resolve(_ reference: WorkspaceReference) async throws -> WorkspaceNode {
        if let sourceCoordinator { return try await sourceCoordinator.sourceReadProvider(readOnly: readOnly).resolve(reference) }
        if let diagnostic = try await diagnostic(for: reference) { return diagnostic }
        let record = try await workingTree.resolve(reference)
        return try await workspaceNode(record)
    }

    public func children(of reference: WorkspaceReference) async throws -> [WorkspaceNode] {
        if let sourceCoordinator { return try await sourceCoordinator.sourceReadProvider(readOnly: readOnly).children(of: reference) }
        var nodes = try await workingTree.children(of: reference).asyncMap { try await workspaceNode($0) }
        if reference.path == "/" {
            nodes.append(contentsOf: try await workingTree.diagnostics().asyncMap { await diagnosticNode($0) })
        }
        return nodes
    }

    public func search(_ query: String, in tree: TreeID) async throws -> [WorkspaceSearchResult] {
        if let sourceCoordinator { return try await sourceCoordinator.sourceReadProvider(readOnly: readOnly).search(query, in: tree) }
        let replicaTree = await workingTree.treeID()
        guard tree == replicaTree else { return [] }
        guard try await workingTree.heads().generation >= 0 else { return [] }
        let entries = try await workingTree.search(query)
        let backlinkCounts = try await workingTree.backlinkCountsByPath()
        var results: [WorkspaceSearchResult] = []
        for entry in entries {
            let reference = WorkspaceReference(
                tree: tree,
                path: entry.path,
                stableKey: entry.pageID.map(markdownStableKey)
            )
            results.append(WorkspaceSearchResult(
                reference: reference,
                title: entry.title,
                excerpt: entry.source.isEmpty ? nil : entry.source,
                modifiedAt: entry.modifiedAt,
                backlinkCount: backlinkCounts[entry.path, default: 0]
            ))
        }
        return results
    }

    public func backlinks(to reference: WorkspaceReference) async throws -> [WorkspaceSearchResult] {
        if let sourceCoordinator { return try await sourceCoordinator.sourceReadProvider(readOnly: readOnly).backlinks(to: reference) }
        return try await workingTree.backlinks(to: reference).map { entry in
            WorkspaceSearchResult(
                reference: WorkspaceReference(
                    tree: reference.tree,
                    path: entry.path,
                    stableKey: entry.pageID.map(markdownStableKey)
                ),
                title: entry.title,
                excerpt: reference.path
            )
        }
    }

    public func perform(_ action: WorkspaceStructuralAction) async throws -> WorkspaceNode? {
        if readOnly { throw WorkspaceProviderError.invalidAction("This tree is read-only") }
        if let sourceCoordinator { return try await sourceCoordinator.admitStructure(.action(action)) }
        let node: WorkingTreeNode
        switch action {
        case let .createMarkdown(parent, name, source):
            node = try await workingTree.createMarkdown(parent: parent, name: name, source: source)
        case let .createDirectory(parent, name):
            node = try await workingTree.createDirectory(parent: parent, name: name)
        case let .rename(reference, name):
            node = try await workingTree.rename(reference, name: name)
        case let .move(reference, destination):
            node = try await workingTree.move(reference, destination: destination)
        case let .copy(reference, destination):
            node = try await workingTree.copy(reference, destination: destination)
        case let .trash(reference):
            node = try await workingTree.trash(reference)
        case let .restore(reference):
            node = try await workingTree.restore(reference)
        }
        return try await workspaceNode(node)
    }

    public func store(asset: WorkspaceAsset, in parent: WorkspaceReference) async throws -> WorkspaceStoredAsset {
        if readOnly { throw WorkspaceProviderError.readOnly(parent) }
        if let sourceCoordinator {
            let node = try await sourceCoordinator.admitStructure(.asset(asset, parent: parent))
            return WorkspaceStoredAsset(reference: node.reference, markdownSource: node.reference.path)
        }
        let node = try await workingTree.storeAsset(asset, in: parent)
        let reference = await workingTree.workspaceReference(node)
        return WorkspaceStoredAsset(reference: reference, markdownSource: reference.path)
    }

    public func readFile(_ reference: WorkspaceReference) async throws -> Data {
        if let sourceCoordinator { return try await sourceCoordinator.sourceReadProvider(readOnly: readOnly).readFile(reference) }
        return try await workingTree.fileBytes(reference)
    }

    public func openDocument(_ reference: WorkspaceReference) async throws -> any WorkspaceDocumentSession {
        let node = try await resolve(reference)
        guard node.surface.supportsDocumentSession else { throw WorkspaceProviderError.notDocument(node.reference) }
        return WorkingTreeDocumentSession(
            workingTree: workingTree,
            reference: node.reference,
            readOnly: readOnly,
            sourceCoordinator: sourceCoordinator,
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
        if readOnly { throw WorkspaceProviderError.readOnly(parent) }
        if let sourceCoordinator {
            return try await sourceCoordinator.admitStructure(.imported(name: name, bytes: bytes, mediaType: mediaType, parent: parent))
        }
        let record = try await workingTree.importFile(name: name, bytes: bytes, mediaType: mediaType, parent: parent)
        return try await workspaceNode(record)
    }

    private func workspaceNode(_ record: WorkingTreeNode) async throws -> WorkspaceNode {
        let reference = await workingTree.workspaceReference(record)
        let revision = await workingTree.revision(for: record)
        let surface: WorkspaceSurface
        switch record.kind {
        case .markdown:
            surface = .markdown(source: record.source ?? "", contentRevision: revision)
        case .directory:
            if let collection = await workingTree.collection(for: record) {
                surface = .collection(kind: collection.kind, rowCount: collection.rows)
            } else {
                surface = .directoryDocument(
                    source: await workingTree.completeSource(for: record) ?? "",
                    contentRevision: revision,
                    stored: record.source != nil
                )
            }
        case .file:
            surface = .file(
                name: WorkingTreeSemantics.name(of: record.path),
                byteCount: record.ref?.size,
                mediaType: record.mediaType ?? record.ref?.mediaType
            )
        case .boundary:
            surface = .placeholder(message: "Nested Arbor tree \(record.boundaryTree ?? "")")
        }
        // A file held by hash is available until a read finds no store that can
        // serve it; only that miss presents the node as a placeholder.
        let knownMissing = await workingTree.isKnownMissing(record)
        return WorkspaceNode(
            reference: reference,
            title: WorkingTreeSemantics.title(for: record),
            surface: surface,
            provenance: WorkspaceProvenance(
                authority: .local,
                sourceDescription: "Working tree",
                contentRevision: revision
            ),
            materialization: knownMissing ? .placeholder : .available,
            isWritable: !readOnly
        )
    }

    private func diagnostic(for reference: WorkspaceReference) async throws -> WorkspaceNode? {
        guard reference.path.hasPrefix("/.working-tree-diagnostic-") else { return nil }
        let replicaTree = await workingTree.treeID()
        guard reference.tree == replicaTree else { return nil }
        let expected = String(reference.path.dropFirst("/.working-tree-diagnostic-".count))
        guard let diagnostic = try await workingTree.diagnostics().first(where: { safeDiagnosticID($0.id) == expected }) else { return nil }
        return await diagnosticNode(diagnostic)
    }

    private func diagnosticNode(_ diagnostic: WorkingTreeDiagnostic) async -> WorkspaceNode {
        WorkspaceNode(
            reference: WorkspaceReference(
                tree: await workingTree.treeID(),
                path: "/.working-tree-diagnostic-\(safeDiagnosticID(diagnostic.id))"
            ),
            title: diagnostic.title,
            surface: .diagnostic(title: diagnostic.title, detail: diagnostic.detail),
            provenance: WorkspaceProvenance(authority: .diagnostic, sourceDescription: "Working tree integrity"),
            isWritable: false
        )
    }

    private func safeDiagnosticID(_ value: String) -> String {
        value.replacingOccurrences(of: "sha256:", with: "")
    }
}

public actor WorkingTreeDocumentSession: WorkspaceDocumentSession {
    public nonisolated let identity: WorkspaceIdentity
    private let workingTree: WorkingTree
    private let initialReference: WorkspaceReference
    private let readOnly: Bool
    private let sourceCoordinator: UpdateCoordinator?
    private var sourceSnapshots: [String: WorkspaceDocumentSnapshot] = [:]
    public var admissionPolicy: WorkspaceAdmissionPolicy { sourceCoordinator == nil ? .compareAndSwap : .retainedBasis }
    private let onPatchAdmission: (@Sendable (WorkingTreePatchAdmission) async throws -> Void)?
    private var pendingAdmission: WorkingTreePatchAdmission?
    private var terminal = false

    init(
        workingTree: WorkingTree,
        reference: WorkspaceReference,
        readOnly: Bool = false,
        sourceCoordinator: UpdateCoordinator? = nil,
        onPatchAdmission: (@Sendable (WorkingTreePatchAdmission) async throws -> Void)?
    ) {
        self.workingTree = workingTree
        self.initialReference = reference
        self.sourceCoordinator = sourceCoordinator?.sourceOperationEmission == true ? sourceCoordinator : nil
        self.readOnly = readOnly
        self.onPatchAdmission = onPatchAdmission
        self.identity = reference.identity
    }

    public func snapshot() async throws -> WorkspaceDocumentSnapshot {
        try requireOpen()
        let snapshot: WorkspaceDocumentSnapshot
        if let sourceCoordinator { snapshot = try await sourceCoordinator.sourceSnapshot(initialReference) }
        else { snapshot = try await workingTree.documentSnapshot(initialReference) }
        if sourceCoordinator != nil { sourceSnapshots[snapshot.contentRevision] = snapshot }
        return snapshot
    }

    public func updates() async throws -> AsyncThrowingStream<WorkspaceDocumentSnapshot, Error> {
        try requireOpen()
        let changes = try await workingTree.changes()
        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    for await _ in changes {
                        try Task.checkCancellation()
                        continuation.yield(try await self.snapshot())
                    }
                    continuation.finish()
                } catch is CancellationError {
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    public func admit(intent: WorkspaceDocumentIntent) async throws -> WorkspaceDocumentSnapshot {
        try requireOpen()
        guard !readOnly else { throw WorkspaceProviderError.readOnly(initialReference) }
        try intent.validate()
        guard intent.basis.reference.identity == identity else { throw WorkspaceProviderError.invalidAction("Intent belongs to another document") }
        if let sourceCoordinator {
            let snapshot = try await sourceCoordinator.admitSourceIntent(intent)
            sourceSnapshots[snapshot.contentRevision] = snapshot
            return snapshot
        }
        do { return try await admit(patch: intent.patch) }
        catch let conflict as WorkspaceDocumentConflict {
            throw WorkspaceDocumentConflict(base: intent.basis, current: conflict.current, submittedSource: intent.source)
        }
    }

    public func admit(source: String, baseContentRevision: String) async throws -> WorkspaceDocumentSnapshot {
        try requireOpen()
        if readOnly { throw WorkspaceProviderError.readOnly(initialReference) }
        if sourceCoordinator != nil {
            guard let basis = sourceSnapshots[baseContentRevision] else { throw WorkspaceProviderError.invalidAction("Original source basis was not retained by this session") }
            return try await admit(intent: .init(basis: basis, patch: .init(baseContentRevision: baseContentRevision,
                edits: [.init(utf8Range: 0..<basis.source.utf8.count, replacement: source, expected: basis.source)]), source: source))
        }
        do {
            let current = try await workingTree.documentSnapshot(initialReference)
            guard current.contentRevision == baseContentRevision else {
                throw WorkspaceDocumentConflict(current: current, submittedSource: source)
            }
            return try await admit(patch: WorkspaceDocumentPatch(
                baseContentRevision: baseContentRevision,
                edits: [WorkspaceSourceEdit(utf8Range: 0..<current.source.utf8.count, replacement: source, expected: current.source)]
            ))
        } catch WorkingTreeError.staleRevision {
            let current = try await workingTree.documentSnapshot(initialReference)
            throw WorkspaceDocumentConflict(current: current, submittedSource: source)
        }
    }

    public func admit(patch: WorkspaceDocumentPatch) async throws -> WorkspaceDocumentSnapshot {
        try requireOpen()
        if readOnly { throw WorkspaceProviderError.readOnly(initialReference) }
        if sourceCoordinator != nil {
            guard let basis = sourceSnapshots[patch.baseContentRevision] else { throw WorkspaceProviderError.invalidAction("Original source basis was not retained by this session") }
            return try await admit(intent: .init(basis: basis, patch: patch, source: patch.applying(to: basis.source)))
        }
        do {
            let result = try await workingTree.writeDocument(initialReference, patch: patch)
            // On the Mac the working tree is in memory. The coordinator's
            // head must reach disk before this session acknowledges a save.
            pendingAdmission = result.admission
            try await flush()

            return result.snapshot
        } catch WorkingTreeError.staleRevision {
            let current = try await workingTree.documentSnapshot(initialReference)
            let submitted = (try? patch.applying(to: current.source)) ?? current.source
            throw WorkspaceDocumentConflict(current: current, submittedSource: submitted)
        }
    }

    public func flush() async throws {
        try requireOpen()
        guard let admission = pendingAdmission else { return }
        try await onPatchAdmission?(admission)
        if pendingAdmission?.generation == admission.generation { pendingAdmission = nil }
    }

    public func createForEditor(parent: WorkspaceReference, name: String, source: String, transaction: String) async throws -> WorkspaceNode? {
        try requireOpen()
        guard !readOnly, parent.tree == initialReference.tree else { throw WorkspaceProviderError.invalidAction("Creation crosses a tree boundary") }
        return try await sourceCoordinator?.admitStructure(.pageCreation(parent: parent, name: name, source: source, transaction: transaction, document: initialReference))
    }

    public func copyDocument() async throws -> WorkspaceCopyDocument? {
        guard let sourceCoordinator else { return nil }
        return try await sourceCoordinator.copyDocument(snapshot())
    }


    public func history() async throws -> [WorkspaceHistoryEntry] {
        try requireOpen()
        throw WorkspaceProviderError.invalidAction("Canopy history is not available yet")
    }

    public func recover(revision: String) async throws -> WorkspaceDocumentSnapshot {
        try requireOpen()
        throw WorkspaceProviderError.invalidAction("Canopy history is not available yet")
    }

    public func close() async {
        terminal = true
    }

    private func requireOpen() throws {
        if terminal { throw WorkingTreeError.closed }
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
