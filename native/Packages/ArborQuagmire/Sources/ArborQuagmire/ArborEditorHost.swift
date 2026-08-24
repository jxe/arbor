import ArborKit
import Foundation
import Observation
import Quagmire

public struct ArborMoveRequest: Identifiable {
    public let id = UUID()
    public let inDocumentCandidates: [InDocMoveTarget]
    let completion: (MoveDestination?) -> Void
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
        components.path = reference.pageID.map { "/page/\($0.rawValue)" } ?? "/path\(reference.pathHint)"
        components.queryItems = [URLQueryItem(name: "path", value: reference.pathHint)]
        return DocumentReference(components.string ?? "arbor://invalid")
    }

    public static func decode(_ value: DocumentReference) -> WorkspaceReference? {
        guard let components = URLComponents(string: value.rawValue), components.scheme == "arbor",
              let tree = components.host else { return nil }
        let hint = components.queryItems?.first(where: { $0.name == "path" })?.value ?? "/"
        if components.path.hasPrefix("/page/") {
            return WorkspaceReference(
                tree: TreeID(rawValue: tree),
                path: hint,
                pageID: PageID(rawValue: String(components.path.dropFirst("/page/".count)))
            )
        }
        return WorkspaceReference(tree: TreeID(rawValue: tree), path: hint)
    }
}

@MainActor
@Observable
public final class ArborEditorHost: EditorHost, ImagesUnsupported, LinkPreviewsUnsupported, BlockActionsUnsupported {
    public let binding: ArborDocumentBinding
    public private(set) var moveRequest: ArborMoveRequest?
    private let provider: any WorkspaceProvider
    private let openAction: @MainActor (WorkspaceReference) -> Void
    private let backAction: @MainActor () -> Void
    private var lookups: [DocumentReference: DocumentLookup] = [:]
    private var lookupTasks: [DocumentReference: Task<Void, Never>] = [:]

    public init(
        binding: ArborDocumentBinding,
        provider: any WorkspaceProvider,
        open: @escaping @MainActor (WorkspaceReference) -> Void = { _ in },
        navigateBack: @escaping @MainActor () -> Void = {}
    ) {
        self.binding = binding
        self.provider = provider
        self.openAction = open
        self.backAction = navigateBack
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
                    subtitle: node.reference.pathHint,
                    isHome: node.reference.pathHint == "/"
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
                subtitle: $0.reference.pathHint,
                isHome: $0.reference.pathHint == "/"
            )
        }
    }

    public func openDocument(_ reference: DocumentReference) {
        guard let decoded = ArborDocumentReferenceCodec.decode(reference) else { return }
        openAction(decoded)
    }

    public func setDocumentIcon(_: String, for _: DocumentReference) async -> Bool { false }

    public func lookupDocument(_ reference: DocumentReference) -> DocumentLookup {
        if let value = lookups[reference] { return value }
        guard let decoded = ArborDocumentReferenceCodec.decode(reference) else { return .missing }
        lookups[reference] = .pending
        if lookupTasks[reference] == nil {
            lookupTasks[reference] = Task { @MainActor [weak self] in
                guard let self else { return }
                do {
                    let node = try await provider.resolve(decoded)
                    let capabilities: DocumentCapabilities = node.isWritable && node.surface.supportsDocumentSession
                        ? [.navigate, .receiveBlocks, .inline] : [.navigate]
                    lookups[reference] = .present(.init(title: node.title, capabilities: capabilities))
                } catch {
                    lookups[reference] = .missing
                }
                lookupTasks[reference] = nil
            }
        }
        return .pending
    }

    public func didDeleteDocumentLink(reference _: DocumentReference, label _: String, from _: Document) {}

    public func resolveReference(from url: URL, in _: Document) -> DocumentReference? {
        if url.scheme == "arbor" { return DocumentReference(url.absoluteString) }
        guard url.scheme == nil, let parent = binding.reference.parent else { return nil }
        let raw = url.relativeString.removingPercentEncoding ?? url.relativeString
        let path = raw.hasPrefix("/") ? raw : (parent.pathHint == "/" ? "/\(raw)" : "\(parent.pathHint)/\(raw)")
        let logical = path.hasSuffix(".md") ? String(path.dropLast(3)) : path
        return ArborDocumentReferenceCodec.encode(WorkspaceReference(tree: binding.reference.tree, path: logical))
    }

    public func linkURL(for reference: DocumentReference, in _: Document) -> URL? {
        URL(string: reference.rawValue)
    }

    public func createDocument(
        title: String,
        requestedReference: DocumentReference?,
        initialContent: [Block]?
    ) async -> DocumentReference? {
        let requested = requestedReference.flatMap(ArborDocumentReferenceCodec.decode)
        let parent = requested?.parent ?? binding.reference.parent ?? WorkspaceReference(tree: binding.reference.tree, path: "/")
        let requestedName = requested?.pathHint.split(separator: "/").last.map(String.init)
        let name = requestedName ?? slug(title)
        let body = initialContent.map { ArborMarkdownCodec.serializeBlocks($0) } ?? ""
        let source = "# \(title)\n\n\(body)"
        guard let created = try? await provider.perform(.createMarkdown(parent: parent, name: name, source: source)) else { return nil }
        return ArborDocumentReferenceCodec.encode(created.reference)
    }

    public func loadDocumentBlocks(_ reference: DocumentReference) async -> [Block]? {
        guard let decoded = ArborDocumentReferenceCodec.decode(reference),
              let session = try? await provider.openDocument(decoded),
              let snapshot = try? await session.snapshot() else { return nil }
        await session.close()
        return ArborMarkdownCodec.parseBlocks(snapshot.source, identitySeed: String(describing: snapshot.reference.identity))
    }

    public func inlineAndRetireDocument(_ reference: DocumentReference, parent _: Document) async -> Bool {
        guard let decoded = ArborDocumentReferenceCodec.decode(reference) else { return false }
        await binding.flush()
        return (try? await provider.perform(.trash(reference: decoded))) != nil
    }

    public func appendToDocument(_ reference: DocumentReference, _ blocks: [Block]) async -> Bool {
        guard let decoded = ArborDocumentReferenceCodec.decode(reference),
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

    public func navigateBack() { backAction() }

    public func persistCommit(changes _: [DocumentChange], in document: Document) {
        guard document === binding.document else { return }
        binding.admitCurrentGeneration()
    }

    public func flush(_ document: Document) async {
        guard document === binding.document else { return }
        await binding.flush()
    }

    public func serializeBlocksForPasteboard(_ blocks: [Block]) -> String {
        ArborMarkdownCodec.serializeBlocks(blocks)
    }

    public func parseBlocksFromPasteboard(_ string: String) -> [Block]? {
        let blocks = ArborMarkdownCodec.parseBlocks(string)
        return blocks.isEmpty ? nil : blocks
    }

    private func slug(_ value: String) -> String {
        let result = value.lowercased().map { $0.isLetter || $0.isNumber ? $0 : "-" }
        return String(result).split(separator: "-").filter { !$0.isEmpty }.joined(separator: "-")
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
