import ArborKit
import Foundation
import Quagmire

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
public final class ArborEditorHost: EditorHost, MoveDestinationUnsupported, ImagesUnsupported, LinkPreviewsUnsupported, BlockActionsUnsupported {
    public let binding: ArborDocumentBinding
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
}
