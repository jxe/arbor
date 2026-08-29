import ArborKit
import Foundation
import Observation
import Quagmire
import QuagmireExtras

public struct ArborMoveRequest: Identifiable {
    public let id = UUID()
    public let inDocumentCandidates: [InDocMoveTarget]
    let completion: (MoveDestination?) -> Void
}

public struct ArborStructuralMoveRequest: Identifiable {
    public let id = UUID()
    public let reference: WorkspaceReference
    let completion: (WorkspaceReference?) -> Void
}

public struct ArborMoveDirectory: Identifiable, Hashable, Sendable {
    public let reference: WorkspaceReference
    public let title: String
    public var id: WorkspaceIdentity { reference.identity }
}

private extension WorkspaceSurface {
    var isDirectory: Bool {
        switch self {
        case .directory, .directoryDocument: true
        default: false
        }
    }
}

public struct ArborMoveDocument: Identifiable, Hashable, Sendable {
    public let reference: DocumentReference
    public let title: String
    public let subtitle: String
    public let isHome: Bool

    public var id: DocumentReference { reference }

    public init(reference: DocumentReference, title: String, subtitle: String, isHome: Bool) {
        self.reference = reference
        self.title = title
        self.subtitle = subtitle
        self.isHome = isHome
    }
}

public enum ArborDocumentReferenceCodec {
    public static func encode(_ reference: WorkspaceReference) -> DocumentReference {
        var components = URLComponents()
        components.scheme = "arbor"
        components.host = reference.tree.rawValue
        components.path = "/node\(reference.path)"
        components.queryItems = reference.stableKey.map { [URLQueryItem(name: "stableKey", value: $0)] }
        return DocumentReference(components.string ?? "arbor://invalid")
    }

    public static func decode(_ value: DocumentReference) -> WorkspaceReference? {
        guard let components = URLComponents(string: value.rawValue), components.scheme == "arbor",
              let tree = components.host else { return nil }
        guard components.path.hasPrefix("/node/") || components.path == "/node" else { return nil }
        let path = String(components.path.dropFirst("/node".count))
        let stableKey = components.queryItems?.first(where: { $0.name == "stableKey" })?.value
        return WorkspaceReference(tree: TreeID(rawValue: tree), path: path.isEmpty ? "/" : path, stableKey: stableKey)
    }
}

@MainActor
@Observable
public final class ArborEditorHost: EditorHost {
    public let binding: ArborDocumentBinding
    public private(set) var moveRequest: ArborMoveRequest?
    public private(set) var structuralMoveRequest: ArborStructuralMoveRequest?
    private let provider: any WorkspaceProvider
    private let linkPreviewService: LinkPreviewService
    private let relativeReferenceBase: WorkspaceReference
    private let openAction: @MainActor (WorkspaceReference) -> Void
    private let backAction: @MainActor () -> Void
    private let errorAction: @MainActor (String) -> Void
    private let performStructuralAction: @MainActor (WorkspaceStructuralAction) async throws -> WorkspaceNode?
    private let offerTrashAfterDeletingLink: @MainActor (WorkspaceNode, WorkspaceReference) -> Void
    private var lookups: [DocumentReference: DocumentLookup] = [:]
    private var lookupTasks: [DocumentReference: Task<Void, Never>] = [:]

    public init(
        binding: ArborDocumentBinding,
        provider: any WorkspaceProvider,
        linkPreviewService: LinkPreviewService,
        relativeReferenceBase: WorkspaceReference? = nil,
        open: @escaping @MainActor (WorkspaceReference) -> Void = { _ in },
        navigateBack: @escaping @MainActor () -> Void = {},
        reportError: @escaping @MainActor (String) -> Void = { _ in },
        performStructuralAction: (@MainActor (WorkspaceStructuralAction) async throws -> WorkspaceNode?)? = nil,
        offerTrashAfterDeletingLink: @escaping @MainActor (WorkspaceNode, WorkspaceReference) -> Void = { _, _ in }
    ) {
        self.binding = binding
        self.provider = provider
        self.linkPreviewService = linkPreviewService
        self.relativeReferenceBase = relativeReferenceBase
            ?? binding.reference.parent
            ?? binding.reference
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
            moveRequest = ArborMoveRequest(
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

    public func moveDocuments(matching rawQuery: String) async -> [ArborMoveDocument] {
        let query = rawQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        let nodes: [WorkspaceNode]
        if query.isEmpty {
            nodes = await enumerateDocumentNodes()
        } else {
            let results = (try? await provider.search(query, in: binding.reference.tree)) ?? []
            nodes = await resolveDocumentNodes(results.map(\.reference))
        }
        return nodes
            .filter { $0.reference.identity != binding.reference.identity }
            .map { node in
                ArborMoveDocument(
                    reference: ArborDocumentReferenceCodec.encode(node.reference),
                    title: node.title,
                    subtitle: node.reference.path,
                    isHome: node.reference.path == "/"
                )
            }
            .sorted {
                if $0.isHome != $1.isHome { return $0.isHome }
                return $0.subtitle.localizedStandardCompare($1.subtitle) == .orderedAscending
            }
    }

    public func suggestDocuments(_ query: String, in _: Document) async -> [MentionItem] {
        let results = (try? await provider.search(query, in: binding.reference.tree)) ?? []
        return results.prefix(8).map {
            MentionItem(
                id: ArborDocumentReferenceCodec.encode($0.reference),
                title: $0.title,
                subtitle: $0.reference.path,
                isHome: $0.reference.path == "/"
            )
        }
    }

    public func openDocument(_ reference: DocumentReference) {
        guard let decoded = workspaceReference(for: reference) else { return }
        openAction(decoded)
    }

    public func setDocumentIcon(_: String, for _: DocumentReference) async -> Bool { false }

    public func lookupDocument(_ reference: DocumentReference) -> DocumentLookup {
        if let value = lookups[reference] { return value }
        guard let decoded = workspaceReference(for: reference) else { return .missing }
        lookups[reference] = .pending
        if lookupTasks[reference] == nil {
            lookupTasks[reference] = Task { @MainActor [weak self] in
                guard let self else { return }
                do {
                    let node = try await provider.resolve(decoded)
                    var capabilities: DocumentCapabilities = node.isWritable && node.surface.supportsDocumentSession
                        ? [.navigate, .receiveBlocks, .inline] : [.navigate]
                    if node.isWritable, isEligibleLinkedChild(node.reference) {
                        capabilities.insert(.relocate)
                    }
                    lookups[reference] = .present(.init(title: node.title, capabilities: capabilities))
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
        guard binding.lastError == nil, binding.conflict == nil,
              let node = try? await provider.resolve(target),
              node.isWritable, node.surface.supportsDocumentSession,
              let backlinks = try? await provider.backlinks(to: node.reference),
              backlinks.isEmpty else { return nil }
        return node
    }

    public func resolveReference(from url: URL, in _: Document) -> DocumentReference? {
        if url.scheme == "arbor" { return DocumentReference(url.absoluteString) }
        guard let reference = workspaceReference(for: url) else { return nil }
        return ArborDocumentReferenceCodec.encode(reference)
    }

    private func workspaceReference(for reference: DocumentReference) -> WorkspaceReference? {
        if let decoded = ArborDocumentReferenceCodec.decode(reference) { return decoded }
        guard let url = URL(string: reference.rawValue) else { return nil }
        return workspaceReference(for: url)
    }

    private func workspaceReference(for url: URL) -> WorkspaceReference? {
        guard url.scheme == nil else { return nil }
        let raw = url.path.removingPercentEncoding ?? url.path
        guard !raw.isEmpty else { return nil }
        let path = raw.hasPrefix("/")
            ? raw
            : (relativeReferenceBase.path == "/"
                ? "/\(raw)"
                : "\(relativeReferenceBase.path)/\(raw)")
        let logical = path.lowercased().hasSuffix(".md") ? String(path.dropLast(3)) : path
        return WorkspaceReference(tree: binding.reference.tree, path: logical)
    }

    public func linkURL(for reference: DocumentReference, in _: Document) -> URL? {
        URL(string: reference.rawValue)
    }

    public func createDocument(
        title: String,
        requestedReference: DocumentReference?,
        initialContent: [Block]?
    ) async -> DocumentReference? {
        let requested = requestedReference.flatMap(workspaceReference(for:))
        let parent = requested?.parent ?? binding.reference.parent ?? WorkspaceReference(tree: binding.reference.tree, path: "/")
        let body = initialContent.map { ArborMarkdownCodec.serializeBlocks($0) } ?? ""
        let source = "# \(title)\n\n\(body)"

        if let requested {
            if let existing = try? await provider.resolve(requested), existing.surface.supportsDocumentSession {
                return ArborDocumentReferenceCodec.encode(existing.reference)
            }
            let name = requested.path.split(separator: "/").last.map(String.init) ?? WorkspaceTitleSlug.name(for: title)
            return await createDocument(
                parent: parent,
                name: name,
                title: title,
                source: source,
                acceptAnyExisting: true
            )
        }

        let baseName = WorkspaceTitleSlug.name(for: title)
        let siblings = (try? await provider.children(of: parent)) ?? []
        if let existing = siblings.first(where: { page($0, hasExactTitle: title) }) {
            return ArborDocumentReferenceCodec.encode(existing.reference)
        }
        if let existing = await documentElsewhere(in: parent.tree, titled: title) {
            return ArborDocumentReferenceCodec.encode(existing.reference)
        }
        var siblingsByName: [String: WorkspaceNode] = [:]
        for node in siblings {
            guard let name = node.reference.path.split(separator: "/").last.map(String.init) else { continue }
            siblingsByName[name.lowercased()] = node
        }
        for suffix in 1...1_000 {
            let name = suffix == 1 ? baseName : "\(baseName)-\(suffix)"
            if let existing = siblingsByName[name.lowercased()] {
                if page(existing, hasExactTitle: title) {
                    return ArborDocumentReferenceCodec.encode(existing.reference)
                }
                continue
            }
            if let created = await createDocument(
                parent: parent,
                name: name,
                title: title,
                source: source,
                acceptAnyExisting: false
            ) {
                return created
            }
            if let materialized = try? await provider.resolve(childReference(parent: parent, name: name)) {
                siblingsByName[name.lowercased()] = materialized
                if page(materialized, hasExactTitle: title) {
                    return ArborDocumentReferenceCodec.encode(materialized.reference)
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
        acceptAnyExisting: Bool
    ) async -> DocumentReference? {
        do {
            if let created = try await performStructuralAction(.createMarkdown(parent: parent, name: name, source: source)) {
                return ArborDocumentReferenceCodec.encode(created.reference)
            }
        } catch {
            // A structural write may be durable before the provider can resolve
            // its receipt. Recover that exact postcondition instead of leaving
            // the source block unchanged and making every retry collide.
            if let materialized = try? await provider.resolve(childReference(parent: parent, name: name)),
               materialized.surface.supportsDocumentSession,
               (acceptAnyExisting || page(materialized, hasExactTitle: title)) {
                return ArborDocumentReferenceCodec.encode(materialized.reference)
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
            return ArborDocumentReferenceCodec.encode(materialized.reference)
        }
        errorAction("Failed to create page: the workspace returned no created page")
        return nil
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
        if let first = ArborMarkdownCodec.parseBlocks(source).first,
           case let .heading(level, text) = first.kind,
           level == .h1 {
            return String(text.characters) == title
        }
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
              let session = try? await provider.openDocument(decoded),
              let snapshot = try? await session.snapshot() else { return nil }
        await session.close()
        return ArborMarkdownCodec.parseBlocks(snapshot.source, identitySeed: String(describing: snapshot.reference.identity))
    }

    public func inlineAndRetireDocument(_ reference: DocumentReference, parent _: Document) async -> Bool {
        guard let decoded = workspaceReference(for: reference) else { return false }
        await binding.flush()
        return (try? await performStructuralAction(.trash(reference: decoded))) != nil
    }

    public func appendToDocument(_ reference: DocumentReference, _ blocks: [Block]) async -> Bool {
        guard let decoded = workspaceReference(for: reference),
              let session = try? await provider.openDocument(decoded),
              let snapshot = try? await session.snapshot() else { return false }
        let opened = ArborMarkdownCodec.open(
            source: snapshot.source,
            revision: snapshot.contentRevision,
            identitySeed: String(describing: snapshot.reference.identity)
        )
        let (admission, _) = ArborMarkdownCodec.admission(blocks: opened.blocks + blocks, ledger: opened.ledger)
        do {
            _ = try await session.admit(patch: admission.patch)
            try await session.flush()
            await session.close()
            return true
        } catch {
            await session.close()
            return false
        }
    }

    public func relocateDocument(_ reference: DocumentReference, from document: Document) async -> Bool {
        guard document === binding.document,
              let decoded = workspaceReference(for: reference),
              let node = try? await provider.resolve(decoded),
              isEligibleLinkedChild(node.reference) else { return false }
        let currentReference = node.reference
        if let pending = structuralMoveRequest {
            structuralMoveRequest = nil
            pending.completion(nil)
        }
        let destination = await withCheckedContinuation { continuation in
            structuralMoveRequest = ArborStructuralMoveRequest(
                reference: currentReference,
                completion: { continuation.resume(returning: $0) }
            )
        }
        guard let destination else { return false }
        await binding.flush()
        guard binding.lastError == nil, binding.conflict == nil else { return false }
        do {
            guard let moved = try await performStructuralAction(.move(reference: currentReference, destination: destination)) else {
                return false
            }
            lookups[reference] = .present(.init(
                title: moved.title,
                capabilities: moved.isWritable ? [.navigate, .receiveBlocks, .inline] : [.navigate]
            ))
            return true
        } catch {
            errorAction("Failed to move linked page: \(error.localizedDescription)")
            return false
        }
    }

    public func resolveStructuralMoveRequest(with destination: WorkspaceReference?) {
        guard let request = structuralMoveRequest else { return }
        structuralMoveRequest = nil
        request.completion(destination)
    }

    public func moveDirectories(for reference: WorkspaceReference, matching rawQuery: String) async -> [ArborMoveDirectory] {
        let query = rawQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        let root = WorkspaceReference(tree: reference.tree, path: "/")
        var queue = [root]
        var visited = Set<WorkspaceIdentity>()
        var result: [ArborMoveDirectory] = []
        while !queue.isEmpty, visited.count < 500 {
            let candidate = queue.removeFirst()
            guard let node = try? await provider.resolve(candidate), visited.insert(node.id).inserted else { continue }
            guard node.reference.tree == reference.tree else { continue }
            guard node.surface.isDirectory else { continue }
            if let children = try? await provider.children(of: node.reference) {
                queue.append(contentsOf: children.map(\.reference))
            }
            let path = node.reference.path
            let containsTarget = path == reference.path || path.hasPrefix(reference.path + "/")
            let sameParent = reference.parent?.path == path
            let matches = query.isEmpty
                || node.title.localizedCaseInsensitiveContains(query)
                || path.localizedCaseInsensitiveContains(query)
            if node.isWritable, !containsTarget, !sameParent, matches {
                result.append(ArborMoveDirectory(reference: node.reference, title: node.title))
            }
        }
        return result.sorted {
            if $0.reference.path == "/" { return true }
            if $1.reference.path == "/" { return false }
            return $0.reference.path.localizedStandardCompare($1.reference.path) == .orderedAscending
        }
    }

    public func navigateBack() { backAction() }

    public func persistCommit(changes _: [DocumentChange], in document: Document) {
        guard document === binding.document else { return }
        binding.admitCurrentGeneration()
    }

    public func flush(_ document: Document) async {
        guard document === binding.document else { return }
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
        ArborMarkdownCodec.serializeBlocks(blocks)
    }

    public func parseBlocksFromPasteboard(_ string: String) -> [Block]? {
        let blocks = ArborMarkdownCodec.parseBlocks(string)
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
            let base = relativeReferenceBase.path
            path = base == "/" ? "/\(withoutFragment)" : "\(base)/\(withoutFragment)"
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

    private func resolveDocumentNodes(_ references: [WorkspaceReference]) async -> [WorkspaceNode] {
        var nodes: [WorkspaceNode] = []
        for reference in references.prefix(200) {
            guard let node = try? await provider.resolve(reference),
                  node.isWritable,
                  node.surface.supportsDocumentSession else { continue }
            nodes.append(node)
        }
        return nodes
    }

    private func enumerateDocumentNodes() async -> [WorkspaceNode] {
        let root = WorkspaceReference(tree: binding.reference.tree, path: "/")
        var queue = [root]
        var visited = Set<WorkspaceIdentity>()
        var nodes: [WorkspaceNode] = []

        while !queue.isEmpty, visited.count < 500 {
            let reference = queue.removeFirst()
            guard let node = try? await provider.resolve(reference), visited.insert(node.id).inserted else { continue }
            if node.isWritable, node.surface.supportsDocumentSession { nodes.append(node) }
            switch node.surface {
            case .directory, .directoryDocument, .collection:
                if let children = try? await provider.children(of: node.reference) {
                    queue.append(contentsOf: children.map(\.reference))
                }
            default:
                break
            }
        }
        return nodes
    }
}
