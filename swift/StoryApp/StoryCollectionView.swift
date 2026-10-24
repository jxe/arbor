import OverstoryClient
import StoryKit
import SwiftUI

/// A logical collection folder, read-only (Schema language 006): its main
/// model's rows arranged by the schema's views, with tabs, groups that
/// collapse and a search field. Editing comes with Schema language 002.
struct StoryCollectionView: View {
    let node: WorkspaceNode
    let workspace: StoryWorkspaceState
    /// Shown when the folder holds no logical collection (a `_store.*` from before 005).
    let kind: String
    let rowCount: Int?

    private enum Load {
        case loading
        case loaded(WorkspaceCollectionRows)
        case notCollection
        case failed(String)
    }

    @State private var load = Load.loading
    @State private var tab = 0
    @State private var query = ""
    /// Collapsed groups by tab and group id; the client's own, never stored in the tree.
    @State private var collapsed: Set<String> = []

    private struct LoadKey: Hashable {
        var node: WorkspaceNode
        var generation: Int
        var providerRevision: Int
    }

    var body: some View {
        content
            .task(id: LoadKey(node: node, generation: workspace.generation, providerRevision: workspace.providerRevision)) {
                await reload()
            }
    }

    @ViewBuilder
    private var content: some View {
        switch load {
        case .loading:
            ProgressView().frame(maxWidth: .infinity)
        case .notCollection:
            LabeledContent("Collection", value: kind)
            if let rowCount { LabeledContent("Rows", value: rowCount.formatted()) }
        case let .failed(message):
            ContentUnavailableView("Can't show this collection", systemImage: "tablecells.badge.ellipsis", description: Text(message))
        case let .loaded(collection):
            presented(collection)
        }
    }

    private func reload() async {
        do {
            load = .loaded(try await workspace.provider.collectionRows(node.reference))
        } catch WorkspaceCollectionError.notCollection {
            load = .notCollection
        } catch {
            load = .failed(error.localizedDescription)
        }
    }

    @ViewBuilder
    private func presented(_ collection: WorkspaceCollectionRows) -> some View {
        let people = workspace.directory.map { PresentedPerson(id: $0.id, name: $0.title) }
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        switch Result(catching: {
            try presentView(collection.schema, rows: collection.rows, options: PresentOptions(
                view: tab, people: people, query: trimmed.isEmpty ? nil : trimmed
            ))
        }) {
        case let .failure(error):
            ContentUnavailableView("Can't show this collection", systemImage: "tablecells.badge.ellipsis",
                                   description: Text((error as? ViewError)?.message ?? error.localizedDescription))
        case let .success(view):
            let directory = Dictionary(workspace.directory.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
            StoryPresentedCollection(view: view, tab: $tab, query: $query, collapsed: $collapsed) { chip, size in
                if case let .string(id) = chip.member, let person = directory[id] {
                    StoryAvatarView(person: person, workspace: workspace, size: size)
                } else {
                    StoryCollectionInitials(chip: chip, size: size)
                }
            }
        }
    }
}
