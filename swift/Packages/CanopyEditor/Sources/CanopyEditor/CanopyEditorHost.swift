import CanopyAppKit
import Foundation
import Observation
import OSLog
import Quagmire
import QuagmireExtras

public struct CanopyMoveRequest: Identifiable {
    public let id = UUID()
    public let inDocumentCandidates: [InDocMoveTarget]
    let completion: (MoveDestination?) -> Void
}

public struct CanopyStructuralMoveRequest: Identifiable {
    public let id = UUID()
    public let reference: WorkspaceReference
    let completion: (WorkspaceReference?) -> Void
}

public struct CanopyStructuralDestination: Identifiable, Hashable, Sendable {
    public let reference: WorkspaceReference
    public let title: String
    public let isDirectory: Bool
    public let modifiedAt: Date?
    public let backlinkCount: Int
    public var id: WorkspaceIdentity { reference.identity }

    /// Whether a page or folder at `path` can receive `moving`: it is neither
    /// the moving page, one of its descendants, nor its current parent.
    public static func canReceive(_ moving: WorkspaceReference, at path: String) -> Bool {
        let containsTarget = path == moving.path || path.hasPrefix(moving.path + "/")
        let sameParent = moving.parent?.path == path
        return !containsTarget && !sameParent
    }

    public init(
        reference: WorkspaceReference,
        title: String,
        isDirectory: Bool,
        modifiedAt: Date? = nil,
        backlinkCount: Int = 0
    ) {
        self.reference = reference
        self.title = title
        self.isDirectory = isDirectory
        self.modifiedAt = modifiedAt
        self.backlinkCount = backlinkCount
    }
}

private extension WorkspaceSurface {
    var isDirectory: Bool {
        switch self {
        case .directory, .directoryDocument: true
        default: false
        }
    }
}

public struct CanopyMoveDocument: Identifiable, Hashable, Sendable {
    public let reference: DocumentReference
    public let title: String
    public let subtitle: String
    public let isHome: Bool
    public let modifiedAt: Date?
    public let backlinkCount: Int

    public var id: DocumentReference { reference }

    public init(
        reference: DocumentReference,
        title: String,
        subtitle: String,
        isHome: Bool,
        modifiedAt: Date? = nil,
        backlinkCount: Int = 0
    ) {
        self.reference = reference
        self.title = title
        self.subtitle = subtitle
        self.isHome = isHome
        self.modifiedAt = modifiedAt
        self.backlinkCount = backlinkCount
    }

    /// A row for the document at `reference`, linked through its `arbor://`
    /// locator and subtitled with its path.
    public init(
        _ reference: WorkspaceReference,
        title: String,
        modifiedAt: Date? = nil,
        backlinkCount: Int = 0
    ) {
        self.init(
            reference: CanopyDocumentReferenceCodec.encode(reference),
            title: title,
            subtitle: reference.path,
            isHome: reference.path == "/",
            modifiedAt: modifiedAt,
            backlinkCount: backlinkCount
        )
    }
}

/// A reference that names its tree: `arbor://<tree>/<path>;arbor-key=<token>`, which is what
/// `resolveNodeTarget` parses and what the backlink indexes read. Authored Markdown uses it only
/// for a link into another tree; a same-tree link is a relative Markdown link written by
/// `CanopyEditorHost`. The app also uses it for references that never reach Markdown, such as
/// move and drop destinations.
public enum CanopyDocumentReferenceCodec {
    public static func encode(_ reference: WorkspaceReference) -> DocumentReference {
        let locator = buildArborLocator(
            tree: reference.tree.rawValue,
            path: reference.path,
            stableKey: reference.stableKey
        )
        return DocumentReference(locator ?? "arbor://invalid")
    }

    public static func decode(_ value: DocumentReference) -> WorkspaceReference? {
        guard let target = resolveNodeTarget(sourceDirectory: "/", href: value.rawValue), let tree = target.tree else { return nil }
        return WorkspaceReference(tree: TreeID(rawValue: tree), path: target.path, stableKey: target.stableKey)
    }
}

/// Parse the session's current source, let `change` rewrite its blocks, and
/// admit and flush the result against that exact snapshot.
@MainActor
@discardableResult
func admitBlockEdit(
    in session: any WorkspaceDocumentSession,
    foreignCopies: [BlockID: (record: SourceRecord, document: WorkspaceCopyDocument)] = [:],
    _ change: (inout [Block]) -> Void
) async throws -> WorkspaceDocumentSnapshot {
    let snapshot = try await session.snapshot()
    let opened = CanopyMarkdownCodec.open(
        source: snapshot.source,
        revision: snapshot.contentRevision,
        identitySeed: String(describing: snapshot.reference.identity)
    )
    var blocks = opened.blocks
    change(&blocks)
    let (admission, _) = CanopyMarkdownCodec.admission(blocks: blocks, ledger: opened.ledger, foreignCopies: foreignCopies)
    let confirmed = try await session.admit(patch: admission.patch)
    try await session.flush()
    return confirmed
}

@MainActor
@Observable
public final class CanopyEditorHost: EditorHost {
    private static let diagnosticLog = Logger(subsystem: "org.arbor.native", category: "EditorHost")
    /// Distinct nodes a destination walk resolves before it stops.
    private static let treeWalkLimit = 500
    /// Search results a Move To query resolves into writable destinations.
    private static let moveDocumentLimit = 200
    /// Numbered filename suffixes page creation tries before giving up.
    private static let filenameSuffixLimit = 1_000

    public let binding: CanopyDocumentBinding
    public private(set) var moveRequest: CanopyMoveRequest?
    public private(set) var structuralMoveRequest: CanopyStructuralMoveRequest?
    private let provider: any WorkspaceProvider
    private let linkPreviewService: LinkPreviewService
    /// The tree directory holding this document's body file: relative links in it resolve from
    /// here, and same-tree links this host writes are relative to it.
    private let sourceDirectory: String
    /// Where known same-tree nodes keep their bodies, so a synchronous link conversion can name
    /// a node's file. Filled from suggestions, lookups and created pages.
    @ObservationIgnored private var knownBodies: [String: MarkdownBodyOrigin?] = [:]
    private let openAction: @MainActor (WorkspaceReference) -> Void
    private let backAction: @MainActor () -> Void
    private let errorAction: @MainActor (String) -> Void
    private let performStructuralAction: @MainActor (WorkspaceStructuralAction) async throws -> WorkspaceNode?
    private let offerTrashAfterDeletingLink: @MainActor (WorkspaceNode, WorkspaceReference) -> Void
    private var lookups: [DocumentReference: DocumentLookup] = [:]
    private var lookupTasks: [DocumentReference: Task<Void, Never>] = [:]
    private var deferredPersistTask: Task<Void, Never>?
    private var cachedMoveDocuments: [CanopyMoveDocument] = []
    private var cachedStructuralDestinations: [WorkspaceIdentity: [CanopyStructuralDestination]] = [:]

    public init(
        binding: CanopyDocumentBinding,
        provider: any WorkspaceProvider,
        linkPreviewService: LinkPreviewService,
        sourceDirectory: String? = nil,
        open: @escaping @MainActor (WorkspaceReference) -> Void = { _ in },
        navigateBack: @escaping @MainActor () -> Void = {},
        reportError: @escaping @MainActor (String) -> Void = { _ in },
        performStructuralAction: (@MainActor (WorkspaceStructuralAction) async throws -> WorkspaceNode?)? = nil,
        offerTrashAfterDeletingLink: @escaping @MainActor (WorkspaceNode, WorkspaceReference) -> Void = { _, _ in }
    ) {
        self.binding = binding
        self.provider = provider
        self.linkPreviewService = linkPreviewService
        self.sourceDirectory = sourceDirectory
            ?? markdownSourceDirectory(nodePath: binding.reference.path, body: .sibling)
        self.openAction = open
        self.backAction = navigateBack
        self.errorAction = reportError
        self.performStructuralAction = performStructuralAction ?? { action in
            try await provider.perform(action)
        }
        self.offerTrashAfterDeletingLink = offerTrashAfterDeletingLink
    }

    public var supportsDocumentCreation: Bool { true }
    public var supportsDocumentInlining: Bool { true }
    public var supportsMoveDestinationPicker: Bool { true }

    public func moveDestination(for _: [BlockID], candidates: [InDocMoveTarget]) async -> MoveDestination? {
        if let pending = moveRequest {
            moveRequest = nil
            pending.completion(nil)
        }
        return await withCheckedContinuation { continuation in
            moveRequest = CanopyMoveRequest(
                inDocumentCandidates: candidates,
                completion: { destination in continuation.resume(returning: destination) }
            )
        }
    }

    public func resolveMoveRequest(with destination: MoveDestination?) {
        guard let request = moveRequest else { return }
        moveRequest = nil
        request.completion(destination)
    }

    public func moveDocuments(matching rawQuery: String) async -> [CanopyMoveDocument] {
        let query = rawQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            let results = try await provider.search("", in: binding.reference.tree).filter {
                Self.matches(query, title: $0.title, path: $0.reference.path)
            }
            var documents: [CanopyMoveDocument] = []
            for result in results.prefix(Self.moveDocumentLimit) {
                guard let node = try? await provider.resolve(result.reference),
                      node.isWritable,
                      node.surface.supportsDocumentSession,
                      node.reference.identity != binding.reference.identity else { continue }
                documents.append(CanopyMoveDocument(
                    node.reference,
                    title: result.title,
                    modifiedAt: result.modifiedAt,
                    backlinkCount: result.backlinkCount
                ))
            }
            if query.isEmpty { cachedMoveDocuments = documents }
            return documents
        } catch {
            Self.diagnosticLog.notice("move destination search failed; walking the tree: \(String(describing: error), privacy: .public)")
        }

        func hasChildren(_ node: WorkspaceNode) -> Bool {
            switch node.surface {
            case .directory, .directoryDocument, .collection: return true
            default: return false
            }
        }
        let current = binding.reference.identity
        let documents = await walkTree(binding.reference.tree, descendsInto: hasChildren)
            .filter { $0.isWritable && $0.surface.supportsDocumentSession && $0.reference.identity != current }
            .map { CanopyMoveDocument($0.reference, title: $0.title) }
        if query.isEmpty { cachedMoveDocuments = documents }
        return documents
    }

    public func staleMoveDocuments(matching rawQuery: String) -> [CanopyMoveDocument] {
        let query = rawQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return cachedMoveDocuments }
        return cachedMoveDocuments.filter { Self.matches(query, title: $0.title, path: $0.subtitle) }
    }

    private static func matches(_ query: String, title: String, path: String) -> Bool {
        query.isEmpty
            || title.localizedCaseInsensitiveContains(query)
            || path.localizedCaseInsensitiveContains(query)
    }

    public func suggestDocuments(_ rawQuery: String, in _: Document) async -> [MentionItem] {
        let query = rawQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        let allResults = (try? await provider.search("", in: binding.reference.tree)) ?? []
        let results: [WorkspaceSearchResult]
        if query.isEmpty {
            results = allResults
        } else {
            results = allResults.filter {
                $0.title.localizedCaseInsensitiveContains(query)
                    || $0.reference.path.localizedCaseInsensitiveContains(query)
            }.sorted { lhs, rhs in
                let lhsRank = mentionSuggestionRank(lhs, query: query)
                let rhsRank = mentionSuggestionRank(rhs, query: query)
                if lhsRank != rhsRank { return lhsRank < rhsRank }
                let titleOrder = lhs.title.localizedStandardCompare(rhs.title)
                if titleOrder != .orderedSame { return titleOrder == .orderedAscending }
                return lhs.reference.path.localizedStandardCompare(rhs.reference.path) == .orderedAscending
            }
        }
        var items: [MentionItem] = []
        for result in results.prefix(8) {
            var body = result.markdownBody
            if body == nil, let node = try? await provider.resolve(result.reference) { body = node.markdownBody }
            items.append(MentionItem(
                id: documentReference(for: result.reference, body: body),
                title: result.title,
                subtitle: result.reference.path,
                isHome: result.reference.path == "/"
            ))
        }
        return items
    }

    /// The reference a document link in this page stores for `reference`: a relative Markdown
    /// link to its body file, with its key, in this tree, and an `arbor://` locator into another.
    func documentReference(for reference: WorkspaceReference, body: MarkdownBodyOrigin?) -> DocumentReference {
        guard reference.tree == binding.reference.tree else { return CanopyDocumentReferenceCodec.encode(reference) }
        knownBodies[reference.path] = body
        let target = MarkdownLinkTarget(path: reference.path, body: body, stableKey: reference.stableKey)
        return buildMarkdownLink(from: sourceDirectory, to: target).map { DocumentReference($0) }
            ?? CanopyDocumentReferenceCodec.encode(reference)
    }

    private func documentReference(for node: WorkspaceNode) -> DocumentReference {
        documentReference(for: node.reference, body: node.markdownBody)
    }

    private func mentionSuggestionRank(_ result: WorkspaceSearchResult, query: String) -> Int {
        if result.title.compare(query, options: [.caseInsensitive, .diacriticInsensitive]) == .orderedSame {
            return 0
        }
        if result.title.localizedCaseInsensitiveContains(query) { return 1 }
        return 2
    }

    public func openDocument(_ reference: DocumentReference) {
        guard let decoded = workspaceReference(for: reference) else { return }
        openAction(decoded)
    }

    public func setDocumentIcon(_ emoji: String, for reference: DocumentReference) async -> Bool {
        guard let decoded = workspaceReference(for: reference) else { return false }
        do {
            let node = try await provider.resolve(decoded)
            guard node.isWritable, node.surface.supportsDocumentSession else { return false }
            var title = ""
            _ = try await withDocumentSession(node.reference) { session in
                try await admitBlockEdit(in: session) { blocks in
                    if let titleIndex = blocks.firstIndex(where: { block in
                        if case .heading(.h1, _) = block.kind { return true }
                        return false
                    }), case .heading(.h1, let titleText) = blocks[titleIndex].kind {
                        title = pageTitle(String(titleText.characters), settingEmoji: emoji)
                        blocks[titleIndex].kind = .heading(level: .h1, text: AttributedString(title))
                    } else {
                        title = pageTitle(node.title, settingEmoji: emoji)
                        blocks = [.heading(level: .h1, text: AttributedString(title), children: blocks)]
                    }
                }
            }
            lookups[reference] = .present(.init(title: title, capabilities: documentCapabilities(for: node)))
            return true
        } catch {
            errorAction("Couldn't set the page icon: \(error.localizedDescription)")
            return false
        }
    }

    public func lookupDocument(_ reference: DocumentReference) -> DocumentLookup {
        if let value = lookups[reference] { return value }
        guard let decoded = workspaceReference(for: reference) else { return .missing }
        // This provider owns the currently open tree. A reference into another
        // tree is resolved by Arbor's nested-tree opener, which can find an
        // already placed tree (or fetch one) before installing its provider.
        // Asking the current provider would incorrectly turn every cross-tree
        // reference into a missing, non-navigable row.
        if decoded.tree != binding.reference.tree {
            let lookup = DocumentLookup.present(.init(title: nil, capabilities: [.navigate]))
            lookups[reference] = lookup
            return lookup
        }
        lookups[reference] = .pending
        if lookupTasks[reference] == nil {
            lookupTasks[reference] = Task { @MainActor [weak self] in
                guard let self else { return }
                do {
                    let node = try await provider.resolve(decoded)
                    if node.reference.tree == binding.reference.tree { knownBodies[node.reference.path] = node.markdownBody }
                    lookups[reference] = .present(.init(
                        title: node.title,
                        capabilities: documentCapabilities(for: node)
                    ))
                } catch {
                    lookups[reference] = .missing
                }
                lookupTasks[reference] = nil
            }
        }
        return .pending
    }

    public func didDeleteDocumentLink(reference: DocumentReference, label _: String, from _: Document) {
        guard let target = workspaceReference(for: reference) else { return }
        let source = binding.reference
        Task { @MainActor [weak self] in
            guard let self,
                  let node = await orphanedDocumentAfterDeletingLink(target, from: source) else { return }
            offerTrashAfterDeletingLink(node, source)
        }
    }

    func orphanedDocumentAfterDeletingLink(
        _ target: WorkspaceReference,
        from source: WorkspaceReference
    ) async -> WorkspaceNode? {
        guard target.identity != source.identity else { return nil }
        await binding.flush()
        guard binding.lastError == nil,
              let node = try? await provider.resolve(target),
              node.isWritable, node.surface.supportsDocumentSession,
              let backlinks = try? await provider.backlinks(to: node.reference),
              backlinks.isEmpty else { return nil }
        return node
    }

    /// A relative link already names its target from this page, so it is kept as written; a
    /// same-tree `arbor://` locator becomes the relative link this page would write for it, naming
    /// the body file known from earlier lookups (or a sibling `x.md` until one is known), and a
    /// locator into another tree stays one.
    public func resolveReference(from url: URL, in _: Document) -> DocumentReference? {
        let href = url.absoluteString
        guard let target = resolveNodeTarget(sourceDirectory: sourceDirectory, href: href) else { return nil }
        guard let tree = target.tree else { return DocumentReference(href) }
        let reference = WorkspaceReference(tree: TreeID(rawValue: tree), path: target.path, stableKey: target.stableKey)
        guard reference.tree == binding.reference.tree else { return CanopyDocumentReferenceCodec.encode(reference) }
        return documentReference(for: reference, body: knownBodies[reference.path] ?? .sibling)
    }

    /// The node a reference this page stores names, from this page's source directory.
    func workspaceReference(for reference: DocumentReference) -> WorkspaceReference? {
        guard let target = resolveNodeTarget(sourceDirectory: sourceDirectory, href: reference.rawValue) else { return nil }
        let tree = target.tree.map(TreeID.init(rawValue:)) ?? binding.reference.tree
        return WorkspaceReference(tree: tree, path: target.path, stableKey: target.stableKey)
    }

    /// References this host hands the editor are already the hrefs the page stores.
    public func linkURL(for reference: DocumentReference, in _: Document) -> URL? {
        URL(string: reference.rawValue)
    }

    public func createDocument(title: String, requestedReference: DocumentReference?, initialContent: [Block]?, transaction: UUID) async -> DocumentReference? {
        await createDocument(title: title, requestedReference: requestedReference, initialContent: initialContent, editorTransaction: transaction.uuidString)
    }

    public func createDocument(title: String, requestedReference: DocumentReference?, initialContent: [Block]?) async -> DocumentReference? {
        await createDocument(title: title, requestedReference: requestedReference, initialContent: initialContent, editorTransaction: nil)
    }

    private func createDocument(
        title: String,
        requestedReference: DocumentReference?,
        initialContent: [Block]?,
        editorTransaction: String?
    ) async -> DocumentReference? {
        let requested = requestedReference.flatMap(workspaceReference(for:))
        let parent = requested?.parent ?? binding.reference
        let body = initialContent.map { CanopyMarkdownCodec.serializeBlocks($0) } ?? ""
        let source = "# \(title)\n\n\(body)"

        if let requested {
            if let existing = try? await provider.resolve(requested), existing.surface.supportsDocumentSession {
                return await durableDocumentReference(for: existing)
            }
            let name = requested.path.split(separator: "/").last.map(String.init) ?? WorkspaceTitleSlug.name(for: title)
            return await createDocument(
                parent: parent,
                name: name,
                title: title,
                source: source,
                acceptAnyExisting: true, editorTransaction: editorTransaction
            )
        }

        let baseName = WorkspaceTitleSlug.name(for: title)
        let siblings = (try? await provider.children(of: parent)) ?? []
        if let existing = siblings.first(where: { page($0, hasExactTitle: title) }) {
            return await durableDocumentReference(for: existing)
        }
        if let existing = await documentElsewhere(in: parent.tree, titled: title) {
            return await durableDocumentReference(for: existing)
        }
        var siblingsByName: [String: WorkspaceNode] = [:]
        for node in siblings {
            guard let name = node.reference.path.split(separator: "/").last.map(String.init) else { continue }
            siblingsByName[name.lowercased()] = node
        }
        for suffix in 1...Self.filenameSuffixLimit {
            let name = suffix == 1 ? baseName : "\(baseName)-\(suffix)"
            if let existing = siblingsByName[name.lowercased()] {
                if page(existing, hasExactTitle: title) {
                    return await durableDocumentReference(for: existing)
                }
                continue
            }
            if let created = await createDocument(
                parent: parent,
                name: name,
                title: title,
                source: source,
                acceptAnyExisting: false, editorTransaction: editorTransaction
            ) {
                return created
            }
            if let materialized = try? await provider.resolve(childReference(parent: parent, name: name)) {
                siblingsByName[name.lowercased()] = materialized
                if page(materialized, hasExactTitle: title) {
                    return documentReference(for: materialized)
                }
                continue
            }
            return nil
        }
        errorAction("Failed to create page: no available filename for \(title)")
        return nil
    }

    private func createDocument(
        parent: WorkspaceReference,
        name: String,
        title: String,
        source: String,
        acceptAnyExisting: Bool, editorTransaction: String?
    ) async -> DocumentReference? {
        do {
            if let editorTransaction {
                await binding.flush()
                guard binding.lastError == nil else { return nil }
                // A working-tree session records the creation with the editor's
                // transaction; other sessions return nil and use the structural action.
                if let created = try await binding.session.createForEditor(parent: parent, name: name, source: source, transaction: editorTransaction) {
                    return await durableDocumentReference(for: created)
                }
            }
            if let created = try await performStructuralAction(.createMarkdown(parent: parent, name: name, source: source)) {
                return await durableDocumentReference(for: created)
            }
        } catch {
            // A structural write may be durable before the provider can resolve
            // its receipt. Recover that exact postcondition instead of leaving
            // the source block unchanged and making every retry collide.
            if let materialized = try? await provider.resolve(childReference(parent: parent, name: name)),
               materialized.surface.supportsDocumentSession,
               (acceptAnyExisting || page(materialized, hasExactTitle: title)) {
                return await durableDocumentReference(for: materialized)
            }
            if !acceptAnyExisting,
               (try? await provider.resolve(childReference(parent: parent, name: name))) != nil {
                return nil
            }
            errorAction("Failed to create page: \(error.localizedDescription)")
            return nil
        }

        if let materialized = try? await provider.resolve(childReference(parent: parent, name: name)),
           materialized.surface.supportsDocumentSession,
           (acceptAnyExisting || page(materialized, hasExactTitle: title)) {
            return await durableDocumentReference(for: materialized)
        }
        errorAction("Failed to create page: the workspace returned no created page")
        return nil
    }

    private func durableDocumentReference(for node: WorkspaceNode) async -> DocumentReference? {
        if node.reference.stableKey != nil || node.reference.tree == "local" {
            return documentReference(for: node)
        }
        do {
            let snapshot = try await withDocumentSession(node.reference) { try await $0.snapshot() }
            guard snapshot.reference.stableKey != nil else {
                errorAction("Failed to create a durable page link: the workspace returned no identity")
                return nil
            }
            return documentReference(for: snapshot.reference, body: node.markdownBody)
        } catch {
            errorAction("Failed to create a durable page link: \(error.localizedDescription)")
            return nil
        }
    }

    private func childReference(parent: WorkspaceReference, name: String) -> WorkspaceReference {
        let path = parent.path == "/" ? "/\(name)" : "\(parent.path)/\(name)"
        return WorkspaceReference(tree: parent.tree, path: path)
    }

    private func page(_ node: WorkspaceNode, hasExactTitle title: String) -> Bool {
        guard node.surface.supportsDocumentSession else { return false }
        let source: String
        switch node.surface {
        case let .markdown(value, _), let .directoryDocument(value, _, _):
            source = value
        default:
            return node.title == title
        }
        if let heading = CanopyMarkdownCodec.leadingH1Text(source) { return heading == title }
        return node.title == title
    }

    private func documentElsewhere(in tree: TreeID, titled title: String) async -> WorkspaceNode? {
        guard let matches = try? await provider.search(title, in: tree) else { return nil }
        for match in matches {
            guard let node = try? await provider.resolve(match.reference),
                  page(node, hasExactTitle: title) else { continue }
            return node
        }
        return nil
    }

    public func loadDocumentBlocks(_ reference: DocumentReference) async -> [Block]? {
        guard let decoded = workspaceReference(for: reference),
              let snapshot = try? await withDocumentSession(decoded, { try await $0.snapshot() }) else { return nil }
        return CanopyMarkdownCodec.parseBlocks(snapshot.source, identitySeed: String(describing: snapshot.reference.identity))
    }

    public func inlineAndRetireDocument(_ reference: DocumentReference, parent _: Document) async -> Bool {
        guard let decoded = workspaceReference(for: reference) else { return false }
        await binding.flush()
        return (try? await performStructuralAction(.trash(reference: decoded))) != nil
    }

    public func copyToDocument(_ reference: DocumentReference, blocks: [Block], from document: Document) async -> Bool {
        guard document === binding.document else {
            Self.diagnosticLog.error("copy requested from a document this host does not bind")
            return false
        }
        guard let destination = workspaceReference(for: reference) else {
            errorAction("Couldn't copy blocks: the destination page is not in this workspace")
            return false
        }
        // Freeze identity and source before suspension. Never infer a copy from
        // matching text in another page after the user changes the selection.
        await binding.flush()
        if let error = binding.lastError {
            errorAction("Couldn't copy blocks: this page has changes that are not saved yet (\(error.localizedDescription))")
            return false
        }
        let ledger = binding.ledger
        guard destination.tree == binding.reference.tree else {
            return await appendToDocument(reference, blocks.map { $0.withFreshIDs() })
        }
        do {
            guard let origin = try await binding.session.copyDocument() else {
                return await appendToDocument(reference, blocks.map { $0.withFreshIDs() })
            }
            // The copy names this page's source as the session holds it. When
            // that is not the source the selected blocks were read from, their
            // bytes cannot be proven; copying them as new text would silently
            // drop the copy the user asked for.
            guard origin.source == ledger.source else {
                Self.diagnosticLog.notice("copy refused: session source \(EditorSourceID.of(origin.source), privacy: .public) differs from editor source \(EditorSourceID.of(ledger.source), privacy: .public)")
                errorAction("Couldn't copy blocks: this page changed while copying. Try again.")
                return false
            }
            let copies = blocks.map { $0.withFreshIDs() }
            var mapping: [BlockID: BlockID] = [:]
            func map(_ source: Block, _ copy: Block) {
                mapping[copy.id] = source.id
                for (a, b) in zip(source.children, copy.children) { map(a, b) }
            }
            for (a, b) in zip(blocks, copies) { map(a, b) }
            var foreign: [BlockID: (record: SourceRecord, document: WorkspaceCopyDocument)] = [:]
            for (id, sourceID) in mapping {
                if let record = ledger.records[sourceID] { foreign[id] = (record, origin) }
            }
            _ = try await withDocumentSession(destination) { session in
                try await admitBlockEdit(in: session, foreignCopies: foreign) { $0 += copies }
            }
            return true
        } catch {
            errorAction("Couldn't copy blocks: \(error.localizedDescription)")
            return false
        }
    }

    public func appendToDocument(_ reference: DocumentReference, _ blocks: [Block]) async -> Bool {
        guard let decoded = workspaceReference(for: reference) else {
            errorAction("Couldn't add blocks: the destination page is not in this workspace")
            return false
        }
        if let moved = await moveToDocument(decoded, reference: reference, blocks) { return moved }
        do {
            _ = try await withDocumentSession(decoded) { session in
                try await admitBlockEdit(in: session) { $0 += blocks }
            }
            return true
        } catch {
            Self.diagnosticLog.notice("append to \(decoded.path, privacy: .private) failed: \(String(describing: error), privacy: .public)")
            errorAction("Couldn't add blocks to \(decoded.path): \(error.localizedDescription)")
            return false
        }
    }

    /// Move to Document within one tree as one change: Quagmire hands a move
    /// this document's own blocks (a copy gets fresh identities), so blocks
    /// recorded in this editor's source are moved rather than retyped. When
    /// the two pages' local work sits on different chains, publish it and try
    /// once more on the accepted view; failing that, or when the move is not
    /// one exact change, copy the blocks exactly and let Quagmire remove them
    /// here. Nil leaves an ordinary append.
    private func moveToDocument(_ destination: WorkspaceReference, reference: DocumentReference, _ blocks: [Block]) async -> Bool? {
        guard destination.tree == binding.reference.tree, destination.identity != binding.reference.identity,
              !blocks.isEmpty, blocks.allSatisfy({ binding.ledger.records[$0.id] != nil }) else { return nil }
        func attempt() async throws -> Bool {
            try await withDocumentSession(destination) { session in
                try await self.binding.transferBlocks(blocks, into: session) != nil
            }
        }
        do {
            if try await attempt() { return true }
            Self.diagnosticLog.notice("move to \(destination.path, privacy: .private) is not one exact change; copying instead")
        } catch WorkspaceTransferError.basesDiverged {
            await binding.session.publishPending()
            await binding.adoptCurrentSnapshot()
            do { if try await attempt() { return true } }
            catch WorkspaceTransferError.basesDiverged {}
            catch {
                errorAction("Couldn't move blocks: \(error.localizedDescription)")
                return false
            }
            Self.diagnosticLog.notice("move to \(destination.path, privacy: .private) spans diverged local work after publication; copying instead")
        } catch {
            errorAction("Couldn't move blocks: \(error.localizedDescription)")
            return false
        }
        return await copyToDocument(reference, blocks: blocks, from: binding.document)
    }

    /// Open a provider session for one operation and always close it.
    private func withDocumentSession<T>(
        _ reference: WorkspaceReference,
        _ body: (any WorkspaceDocumentSession) async throws -> T
    ) async throws -> T {
        let session = try await provider.openDocument(reference)
        do {
            let value = try await body(session)
            await session.close()
            return value
        } catch {
            await session.close()
            throw error
        }
    }

    public func prepareBlocksForTransfer(_ blocks: [Block], in document: Document) -> [Block] {
        guard document === binding.document else { return blocks }
        return CanopyMarkdownCodec.materializingProjectedChildren(blocks)
    }

    public func relocateDocument(_ reference: DocumentReference, from document: Document) async -> Bool {
        guard document === binding.document,
              let decoded = workspaceReference(for: reference),
              let node = try? await provider.resolve(decoded),
              isEligibleLinkedChild(node.reference) else { return false }
        return await relocate(node.reference, failureLabel: "linked page", navigateAfterMove: false, lookupReference: reference)
    }

    public func moveCurrentDocument() async -> Bool {
        await moveDocument(binding.reference)
    }

    public func moveDocument(_ reference: WorkspaceReference) async -> Bool {
        guard reference.path != "/",
              !reference.path.hasPrefix("/Trash/"),
              let node = try? await provider.resolve(reference),
              node.isWritable,
              node.surface.supportsDocumentSession else { return false }
        return await relocate(
            node.reference,
            failureLabel: "page",
            navigateAfterMove: node.reference.identity == binding.reference.identity
        )
    }

    private func relocate(
        _ currentReference: WorkspaceReference,
        failureLabel: String,
        navigateAfterMove: Bool,
        lookupReference: DocumentReference? = nil
    ) async -> Bool {
        if let pending = structuralMoveRequest {
            structuralMoveRequest = nil
            pending.completion(nil)
        }
        let destination = await withCheckedContinuation { continuation in
            structuralMoveRequest = CanopyStructuralMoveRequest(
                reference: currentReference,
                completion: { continuation.resume(returning: $0) }
            )
        }
        guard let destination else { return false }
        await binding.flush()
        guard binding.lastError == nil else { return false }
        do {
            guard let moved = try await performStructuralAction(.move(reference: currentReference, destination: destination)) else {
                return false
            }
            if let lookupReference {
                lookups[lookupReference] = .present(.init(
                    title: moved.title,
                    capabilities: documentCapabilities(for: moved)
                ))
            }
            if navigateAfterMove { openAction(moved.reference) }
            return true
        } catch {
            errorAction("Failed to move \(failureLabel): \(error.localizedDescription)")
            return false
        }
    }

    public func resolveStructuralMoveRequest(with destination: WorkspaceReference?) {
        guard let request = structuralMoveRequest else { return }
        structuralMoveRequest = nil
        request.completion(destination)
    }

    private func documentCapabilities(for node: WorkspaceNode) -> DocumentCapabilities {
        guard node.isWritable, node.surface.supportsDocumentSession else { return [.navigate] }
        var capabilities: DocumentCapabilities = [.navigate, .receiveBlocks, .inline, .setIcon]
        if isEligibleLinkedChild(node.reference) {
            capabilities.insert(.relocate)
        }
        return capabilities
    }

    public func structuralDestinations(for reference: WorkspaceReference, matching rawQuery: String) async -> [CanopyStructuralDestination] {
        let query = rawQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        let searchResults: [WorkspaceSearchResult]
        do {
            searchResults = try await provider.search(query, in: reference.tree)
        } catch {
            // Destinations still come from the tree walk; only their dates
            // and backlink counts are unavailable.
            Self.diagnosticLog.notice("structural destination search failed: \(String(describing: error), privacy: .public)")
            searchResults = []
        }
        let searchResultByIdentity = Dictionary(
            searchResults.map { ($0.reference.identity, $0) },
            uniquingKeysWith: { first, _ in first }
        )
        func isContainer(_ node: WorkspaceNode) -> Bool {
            node.reference.tree == reference.tree
                && (node.surface.isDirectory || node.surface.supportsDocumentSession)
        }
        let result = await walkTree(reference.tree, descendsInto: isContainer)
            .filter {
                isContainer($0) && $0.isWritable
                    && CanopyStructuralDestination.canReceive(reference, at: $0.reference.path)
                    && Self.matches(query, title: $0.title, path: $0.reference.path)
            }
            .map { node in
                let searchResult = searchResultByIdentity[node.reference.identity]
                return CanopyStructuralDestination(
                    reference: node.reference,
                    title: node.title,
                    isDirectory: node.surface.isDirectory,
                    modifiedAt: searchResult?.modifiedAt,
                    backlinkCount: searchResult?.backlinkCount ?? 0
                )
            }
        let ordered = result.sorted {
            if $0.reference.path == "/" { return true }
            if $1.reference.path == "/" { return false }
            return $0.reference.path.localizedStandardCompare($1.reference.path) == .orderedAscending
        }
        if query.isEmpty { cachedStructuralDestinations[reference.identity] = ordered }
        return ordered
    }

    public func staleStructuralDestinations(
        for reference: WorkspaceReference,
        matching rawQuery: String
    ) -> [CanopyStructuralDestination] {
        let candidates = cachedStructuralDestinations[reference.identity] ?? cachedMoveDocuments.compactMap { document in
            guard let decoded = CanopyDocumentReferenceCodec.decode(document.reference) else { return nil }
            return CanopyStructuralDestination(
                reference: decoded,
                title: document.title,
                isDirectory: false,
                modifiedAt: document.modifiedAt,
                backlinkCount: document.backlinkCount
            )
        }
        let query = rawQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        return candidates.filter { destination in
            CanopyStructuralDestination.canReceive(reference, at: destination.reference.path)
                && Self.matches(query, title: destination.title, path: destination.reference.path)
        }
    }

    public func navigateBack() { backAction() }

    public func persistCommit(changes _: [DocumentChange], in document: Document) {
        guard document === binding.document else { return }
        deferredPersistTask?.cancel()
        deferredPersistTask = nil
        binding.appendCurrentGeneration()
    }

    public func persistCommit(changes _: [DocumentChange], in document: Document, after delay: Duration) {
        guard document === binding.document else { return }
        binding.captureTransactionEvidence()
        deferredPersistTask?.cancel()
        deferredPersistTask = Task { @MainActor [weak self, weak document] in
            do { try await Task.sleep(for: delay) } catch { return }
            guard let self, let document, document === self.binding.document,
                  !Task.isCancelled else { return }
            self.deferredPersistTask = nil
            self.binding.appendCurrentGeneration()
        }
    }

    public func noteEditingActivity(in document: Document) {
        guard document === binding.document, deferredPersistTask != nil else { return }
        deferredPersistTask?.cancel()
        deferredPersistTask = nil
    }

    public func flush(_ document: Document) async {
        guard document === binding.document else { return }
        deferredPersistTask?.cancel()
        deferredPersistTask = nil
        await binding.flush()
    }

    public func saveImages(_ items: [PastedImage], in document: Document) async -> [String] {
        guard document === binding.document, !items.isEmpty else { return [] }
        let assets: WorkspaceReference
        do {
            assets = try await assetsDirectory()
        } catch {
            errorAction("Failed to prepare Assets: \(error.localizedDescription)")
            return []
        }

        var sources: [String] = []
        sources.reserveCapacity(items.count)
        for item in items {
            let ext = imageExtension(item.ext)
            do {
                let stored = try await provider.store(
                    asset: WorkspaceAsset(
                        name: "pasted-\(UUID().uuidString.lowercased()).\(ext)",
                        mediaType: imageMediaType(ext),
                        bytes: item.data
                    ),
                    in: assets
                )
                sources.append(stored.markdownSource)
            } catch {
                // Quagmire maps returned sources positionally to the pasted
                // items, so partial success must always be a durable prefix.
                errorAction("Failed to save pasted image: \(error.localizedDescription)")
                break
            }
        }
        return sources
    }

    public func imageResource(for source: String, in document: Document) async -> EditorImageResource? {
        guard document === binding.document,
              let reference = imageReference(for: source) else { return nil }
        do {
            return .data(try await provider.readFile(reference))
        } catch {
            return nil
        }
    }

    public func serializeBlocksForPasteboard(_ blocks: [Block]) -> String {
        CanopyMarkdownCodec.serializeBlocks(blocks)
    }

    public func parseBlocksFromPasteboard(_ string: String) -> [Block]? {
        let blocks = CanopyMarkdownCodec.parseBlocks(string)
        return blocks.isEmpty ? nil : blocks
    }

    public func linkPreview(for url: URL) async -> LinkPreview? {
        await linkPreviewService.preview(for: url)
    }

    public func blockActions(in _: Document) -> [EditorBlockAction] {
        TranscriptPolishingActions.actions()
    }

    private func assetsDirectory() async throws -> WorkspaceReference {
        let reference = WorkspaceReference(tree: binding.reference.tree, path: "/Assets")
        if let node = try? await provider.resolve(reference), node.surface.isDirectory {
            return node.reference
        }
        if let created = try await performStructuralAction(.createDirectory(
            parent: WorkspaceReference(tree: binding.reference.tree, path: "/"),
            name: "Assets"
        )) {
            return created.reference
        }
        let resolved = try await provider.resolve(reference)
        guard resolved.surface.isDirectory else {
            throw WorkspaceProviderError.invalidAction("/Assets is not a directory")
        }
        return resolved.reference
    }

    private func imageReference(for source: String) -> WorkspaceReference? {
        let trimmed = source.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !trimmed.contains("://"), !trimmed.hasPrefix("data:") else { return nil }
        let decoded = trimmed.removingPercentEncoding ?? trimmed
        let withoutFragment = decoded.split(separator: "#", maxSplits: 1).first.map(String.init) ?? decoded
        guard !withoutFragment.isEmpty else { return nil }
        let path: String
        if withoutFragment.hasPrefix("/") {
            path = withoutFragment
        } else {
            path = sourceDirectory == "/" ? "/\(withoutFragment)" : "\(sourceDirectory)/\(withoutFragment)"
        }
        return WorkspaceReference(tree: binding.reference.tree, path: path)
    }

    private func imageExtension(_ value: String) -> String {
        let normalized = value.lowercased().filter { $0.isLetter || $0.isNumber }
        return normalized.isEmpty ? "bin" : String(normalized.prefix(12))
    }

    private func imageMediaType(_ ext: String) -> String {
        switch ext {
        case "png": "image/png"
        case "jpg", "jpeg": "image/jpeg"
        case "gif": "image/gif"
        case "webp": "image/webp"
        case "heic", "heif": "image/heic"
        default: "application/octet-stream"
        }
    }

    private func isEligibleLinkedChild(_ reference: WorkspaceReference) -> Bool {
        reference.tree == binding.reference.tree
            && reference.parent?.path == binding.reference.path
            && reference.identity != binding.reference.identity
    }

    /// Breadth-first nodes of `tree` from its root, resolving at most
    /// `treeWalkLimit` distinct nodes. Unresolvable references and unreadable
    /// children are skipped; `descendsInto` chooses whose children to read.
    private func walkTree(
        _ tree: TreeID,
        descendsInto: (WorkspaceNode) -> Bool
    ) async -> [WorkspaceNode] {
        var queue = [WorkspaceReference(tree: tree, path: "/")]
        var cursor = 0
        var visited = Set<WorkspaceIdentity>()
        var nodes: [WorkspaceNode] = []
        while cursor < queue.count, visited.count < Self.treeWalkLimit {
            let reference = queue[cursor]
            cursor += 1
            guard let node = try? await provider.resolve(reference), visited.insert(node.id).inserted else { continue }
            nodes.append(node)
            if descendsInto(node), let children = try? await provider.children(of: node.reference) {
                queue.append(contentsOf: children.map(\.reference))
            }
        }
        return nodes
    }
}
