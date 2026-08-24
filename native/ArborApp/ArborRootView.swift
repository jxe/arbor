import ArborKit
import SwiftUI

struct ArborRootView: View {
    @State private var model = ArborAppModel()

    var body: some View {
        NavigationSplitView {
            List(model.children) { node in
                Button {
                    Task { await model.navigate(to: node.reference) }
                } label: {
                    Label(node.title, systemImage: symbol(for: node.surface))
                }
                .buttonStyle(.plain)
            }
            .navigationTitle("Arbor")
            .overlay {
                if model.children.isEmpty {
                    ContentUnavailableView("No children", systemImage: "tree")
                }
            }
        } detail: {
            Group {
                if let node = model.node {
                    WorkspaceSurfaceView(node: node)
                } else if let message = model.errorMessage {
                    ContentUnavailableView("Unable to open", systemImage: "exclamationmark.triangle", description: Text(message))
                } else {
                    ProgressView()
                }
            }
            .navigationTitle(model.node?.title ?? "Arbor")
            .toolbar {
                ToolbarItemGroup(placement: .navigation) {
                    Button("Back", systemImage: "chevron.left") { Task { await model.goBack() } }
                        .disabled(!model.canGoBack)
                    Button("Forward", systemImage: "chevron.right") { Task { await model.goForward() } }
                        .disabled(!model.canGoForward)
                    Button("Parent", systemImage: "arrow.up") { Task { await model.goParent() } }
                        .disabled(!model.canGoParent)
                    Button("Home", systemImage: "house") { Task { await model.goHome() } }
                }
            }
        }
        .task { await model.load() }
    }

    private func symbol(for surface: WorkspaceSurface) -> String {
        switch surface {
        case .markdown: "doc.text"
        case .directory: "folder"
        case .directoryDocument: "folder.badge.gearshape"
        case .file: "doc"
        case .collection: "tablecells"
        case .placeholder: "icloud.slash"
        case .diagnostic: "exclamationmark.triangle"
        case .historical: "clock.arrow.circlepath"
        }
    }
}

private struct WorkspaceSurfaceView: View {
    let node: WorkspaceNode

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                provenance
                switch node.surface {
                case let .markdown(source, _):
                    Text(source).textSelection(.enabled)
                case let .directory(summary):
                    ContentUnavailableView(summary ?? "Directory", systemImage: "folder")
                case let .directoryDocument(source, _, stored):
                    if !stored {
                        Text("Implicit directory document").font(.caption).foregroundStyle(.secondary)
                    }
                    Text(source).textSelection(.enabled)
                case let .file(name, byteCount, mediaType):
                    LabeledContent("File", value: name)
                    LabeledContent("Size", value: ByteCountFormatter.string(fromByteCount: Int64(byteCount), countStyle: .file))
                    if let mediaType { LabeledContent("Type", value: mediaType) }
                case let .collection(kind, rowCount):
                    LabeledContent("Collection", value: kind)
                    if let rowCount { LabeledContent("Rows", value: rowCount.formatted()) }
                case let .placeholder(message):
                    ContentUnavailableView("Not available offline", systemImage: "icloud.slash", description: Text(message))
                case let .diagnostic(title, detail):
                    ContentUnavailableView(title, systemImage: "exclamationmark.triangle", description: Text(detail))
                case let .historical(source, revision):
                    Text("Historical revision \(revision)").font(.headline)
                    Text(source).textSelection(.enabled)
                }
            }
            .frame(maxWidth: 720, alignment: .leading)
            .padding()
        }
    }

    private var provenance: some View {
        HStack {
            Text(node.provenance.sourceDescription)
            Spacer()
            if !node.isWritable { Label("Read only", systemImage: "lock") }
        }
        .font(.caption)
        .foregroundStyle(.secondary)
    }
}
