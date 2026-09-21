import SwiftUI
import OverstoryClient
import ImageIO

struct ArborAvatarView: View {
    let person: DirectoryPerson?
    let workspace: ArborWorkspaceState
    var size: CGFloat = 38
    @State private var image: Image?

    var body: some View {
        ZStack {
            Circle().fill(tint.opacity(0.15))
            if let image {
                image.resizable().scaledToFill()
            } else if let person {
                Text(person.initials).font(.system(size: size * 0.34, weight: .semibold))
                    .foregroundStyle(tint)
            } else {
                Image(systemName: "person.2.fill").foregroundStyle(tint)
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .task(id: person?.entry.avatar?.hash) {
            guard let avatar = person?.entry.avatar else { image = nil; return }
            guard let data = try? await AvatarCache().data(for: avatar, fetch: {
                try await workspace.avatarData(for: person!)
            }), let source = CGImageSourceCreateWithData(data as CFData, nil),
                  let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                    kCGImageSourceCreateThumbnailFromImageAlways: true,
                    kCGImageSourceThumbnailMaxPixelSize: 256,
                    kCGImageSourceCreateThumbnailWithTransform: true,
                  ] as CFDictionary) else { return }
            image = Image(decorative: thumbnail, scale: 2)
        }
    }

    private var tint: Color {
        let value = person?.entry.profile.utf8.reduce(0) { ($0 &* 31) &+ Int($1) } ?? 0
        return [.indigo, .blue, .teal, .green, .orange, .pink, .purple][abs(value) % 7]
    }
}

struct ArborPeoplePicker: View {
    @Binding var query: String
    let people: [DirectoryPerson]
    let workspace: ArborWorkspaceState
    let excluding: Set<String>
    let disabled: Bool
    let onPick: (DirectoryPerson) -> Void
    let onRawSubmit: () -> Void
    @State private var selected = 0

    private var matches: [DirectoryPerson] {
        Array(DirectoryMatcher.matches(query: query, in: people).filter { !excluding.contains($0.id) }.prefix(8))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            TextField("Add people or groups", text: $query, prompt: Text("Name, ~handle, or Arbor profile URL"))
                .textFieldStyle(.roundedBorder)
                .disabled(disabled)
                .onSubmit {
                    if matches.indices.contains(selected) { onPick(matches[selected]) }
                    else { onRawSubmit() }
                }
#if os(macOS)
                .onMoveCommand { direction in
                    if direction == .down { selected = min(selected + 1, max(0, matches.count - 1)) }
                    if direction == .up { selected = max(0, selected - 1) }
                }
#else
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
#endif
            if !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                if matches.isEmpty {
                    Button("Add \(query)", action: onRawSubmit).disabled(disabled)
                } else {
                    ForEach(Array(matches.enumerated()), id: \.element.id) { index, person in
                        Button { onPick(person) } label: {
                            HStack(spacing: 10) {
                                ArborAvatarView(person: person, workspace: workspace, size: 32)
                                VStack(alignment: .leading, spacing: 1) {
                                    HStack { Text(person.title); if person.entry.kind == "group" { Text("Group").font(.caption2).foregroundStyle(.secondary) } }
                                    Text(person.subtitle).font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                            }
                            .padding(.vertical, 2)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .background(index == selected ? Color.accentColor.opacity(0.12) : .clear)
                        .disabled(disabled)
                    }
                }
            }
        }
        .onChange(of: query) { _, _ in selected = 0 }
    }
}

struct ArborDirectoryView: View {
    let workspace: ArborWorkspaceState
    let openProfile: (String) -> Void
    @State private var query = ""

    private var people: [DirectoryPerson] { DirectoryMatcher.matches(query: query, in: workspace.directory) }

    var body: some View {
        List {
            directorySection("People", values: people.filter { $0.entry.kind != "group" })
            directorySection("Groups", values: people.filter { $0.entry.kind == "group" })
            if let error = workspace.directoryError { Section { Text(error).foregroundStyle(.red) } }
        }
        .searchable(text: $query, prompt: "Search people and groups")
        .overlay { if people.isEmpty && workspace.directoryError == nil { ContentUnavailableView("No people found", systemImage: "person.2") } }
        .toolbar {
            Button("Refresh", systemImage: "arrow.clockwise") { Task { await workspace.refreshDirectory(force: true) } }
                .disabled(workspace.directoryIsRefreshing)
        }
    }

    @ViewBuilder private func directorySection(_ title: String, values: [DirectoryPerson]) -> some View {
        if !values.isEmpty {
            Section(title) {
                ForEach(values) { person in
                    HStack(spacing: 12) {
                        ArborAvatarView(person: person, workspace: workspace)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(person.title)
                            Text(person.subtitle).font(.caption).foregroundStyle(.secondary)
                            HStack { ForEach(person.entry.sources, id: \.self) { Text(sourceLabel($0)).font(.caption2).padding(.horizontal, 5).background(.quaternary, in: Capsule()) } }
                        }
                        Spacer()
                        Button("Open profile") { openProfile(person.entry.profile) }
                            .disabled(person.entry.locator == nil)
                            .help(person.entry.locator == nil ? "Not hosted" : "Open profile")
                    }
                }
            }
        }
    }

    private func sourceLabel(_ source: String) -> String {
        if source == "community" { return "Community" }
        if source == "access" { return "Shared" }
        return "Group"
    }
}
