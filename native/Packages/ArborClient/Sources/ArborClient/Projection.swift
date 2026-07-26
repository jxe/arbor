import Foundation

/// The client-derived projected directory document, mirroring
/// `@arbor/core` `projection.ts` exactly. Synthetic rows never appear in a
/// REST document and are never serialized back through `writeMarkdown`.
public struct ProjectedDocument: Codable, Sendable, Equatable {
    /// The stored body (or an empty document when the body is implicit).
    public var source: MarkdownDocument
    /// Stored blocks plus one appended synthetic row per unmatched child.
    public var visibleBlocks: [ArborBlock]
    /// One entry per immediate child, in projected document order.
    public var managedChildren: [ManagedChildRow]
    /// "stored" or "implicit".
    public var bodyState: String
}

public struct ManagedChildRow: Codable, Sendable, Equatable {
    public var blockID: String
    public var ref: ResolvedNodeRef
    /// "authored" or "synthetic".
    public var origin: String
    public var kind: String
    public var materialization: String
}

/// Editor-only block ID for a synthetic managed row, derived from child
/// identity. Byte-identical to the TypeScript derivation; the `managed:`
/// prefix must never be sent to the server.
public func syntheticRowBlockID(pageID: String?, path: String) -> String {
    if let pageID { return "managed:id:\(pageID)" }
    return "managed:path:\(canonicalNodePath(path))"
}

public func isSyntheticRowBlockID(_ blockID: String) -> Bool {
    blockID.hasPrefix("managed:")
}

private func protocolKind(_ kind: String) -> String {
    kind == "postgres" ? "database" : kind
}

public func projectDirectoryDocument(
    path inputPath: String,
    document: MarkdownDocument?,
    children: [TreeChild]
) -> ProjectedDocument {
    let directory = canonicalNodePath(inputPath)
    let source = document ?? MarkdownDocument(frontmatter: [:], frontmatterSource: nil, bodySource: "", blocks: [])

    var childByPath: [String: Int] = [:]
    var childByPageID: [String: Int] = [:]
    for (index, child) in children.enumerated() {
        childByPath[canonicalNodePath(child.path)] = index
        if let pageID = child.pageID { childByPageID[pageID] = index }
    }

    var matched: [Int: (blockID: String, order: Int)] = [:]
    var order = 0

    func walk(_ blocks: [ArborBlock]) {
        for block in blocks {
            order += 1
            if block.type == "standaloneLink" {
                var href = ""
                if case .string(let value)? = block.props?["path"] { href = value }
                if case .local(let path, let pageID, _)? = resolveLogicalURL(base: directory, href: href) {
                    // A durable ID wins over a stale path.
                    let index = pageID.flatMap { childByPageID[$0] } ?? childByPath[path]
                    if let index, matched[index] == nil {
                        matched[index] = (block.id, order)
                    }
                }
            }
            walk(block.children)
        }
    }
    walk(source.blocks)

    let authoredRows = matched
        .sorted { $0.value.order < $1.value.order }
        .map { entry -> ManagedChildRow in
            let child = children[entry.key]
            return ManagedChildRow(
                blockID: entry.value.blockID,
                ref: ResolvedNodeRef(path: canonicalNodePath(child.path), pageID: child.pageID),
                origin: "authored",
                kind: protocolKind(child.kind),
                materialization: child.materialization
            )
        }

    let syntheticChildren = children.enumerated().filter { matched[$0.offset] == nil }.map(\.element)
    let syntheticBlocks = syntheticChildren.map { child in
        ArborBlock(
            id: syntheticRowBlockID(pageID: child.pageID, path: child.path),
            type: "standaloneLink",
            content: child.name,
            props: ["path": .string(relativeLogicalReference(from: directory, to: child.path))]
        )
    }
    let syntheticRows = zip(syntheticChildren, syntheticBlocks).map { child, block in
        ManagedChildRow(
            blockID: block.id,
            ref: ResolvedNodeRef(path: canonicalNodePath(child.path), pageID: child.pageID),
            origin: "synthetic",
            kind: protocolKind(child.kind),
            materialization: child.materialization
        )
    }

    return ProjectedDocument(
        source: source,
        visibleBlocks: source.blocks + syntheticBlocks,
        managedChildren: authoredRows + syntheticRows,
        bodyState: document == nil ? "implicit" : "stored"
    )
}

public enum ProjectedNodeUpdate: Sendable {
    case event(WorkspaceEvent)
    case resync(NodeSnapshot, ProjectedDocument?)
}

public struct ProjectedNodeView: Sendable {
    /// The hydrated raw snapshot. `document` never contains synthetic rows.
    public var snapshot: NodeSnapshot
    /// The derived directory projection; nil for non-directory nodes.
    public var projection: ProjectedDocument?
    public var updates: AsyncThrowingStream<ProjectedNodeUpdate, Error>
}

/// Derive the projection from a hydrated snapshot; nil for nodes without a
/// child-bearing surface. Mirrors the TypeScript `projectSnapshot`.
public func projectSnapshot(_ snapshot: NodeSnapshot) -> ProjectedDocument? {
    guard snapshot.kind == "directory" || snapshot.kind == "collection" else { return nil }
    return projectDirectoryDocument(
        path: snapshot.path,
        document: snapshot.bodyState == "implicit" ? nil : snapshot.document,
        children: snapshot.children ?? []
    )
}
