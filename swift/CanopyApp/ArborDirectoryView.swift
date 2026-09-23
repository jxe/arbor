import SwiftUI
import CanopyAppKit
import Overstory
import OverstoryClient
import ImageIO

enum ArborAvatarImage {
    /// An upright thumbnail of image `data`, at most `maxPixelSize` on its long side.
    static func thumbnail(_ data: Data, maxPixelSize: Int) -> CGImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixelSize,
            kCGImageSourceCreateThumbnailWithTransform: true,
        ]
        return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
    }
}

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
            guard let person, let avatar = person.entry.avatar else { image = nil; return }
            guard let data = try? await AvatarCache().data(for: avatar, fetch: {
                try await workspace.avatarData(for: person)
            }), let thumbnail = ArborAvatarImage.thumbnail(data, maxPixelSize: 256) else { return }
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
    /// Offered when nothing matches: start a new group named after the query.
    var onCreateGroup: ((String) -> Void)?
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
                    if let onCreateGroup {
                        Button("New Group “\(query.trimmingCharacters(in: .whitespacesAndNewlines))”…", systemImage: "person.2.badge.plus") {
                            onCreateGroup(query.trimmingCharacters(in: .whitespacesAndNewlines))
                        }
                        .disabled(disabled)
                    }
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

/// Shared identity presentation for the directory and account management.
struct ArborProfileRow: View {
    let workspace: ArborWorkspaceState
    let person: DirectoryPerson?
    let fallbackTitle: String
    let fallbackSubtitle: String
    /// Replaces the directory subtitle when the row needs a plainer one.
    var subtitle: String?
    var canOpen = true
    var accessory = AnyView(EmptyView())
    let open: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Button(action: open) {
                HStack(spacing: 12) {
                    ArborAvatarView(person: person, workspace: workspace)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(person?.title ?? fallbackTitle)
                        Text(subtitle ?? person?.subtitle ?? fallbackSubtitle)
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 0)
                }
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .disabled(!canOpen)
            accessory
            Button(action: open) {
                Image(systemName: "chevron.right")
                    .foregroundStyle(.secondary)
                    .frame(width: 24, height: 32)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .disabled(!canOpen)
            .accessibilityLabel("Open profile")
            .help(canOpen ? "Open profile" : "Not hosted")
        }
    }
}

struct ArborDirectoryView: View {
    let workspace: ArborWorkspaceState
    let openProfile: (DirectoryPerson) -> Void
    /// Open a group page with its Members sheet, optionally ready to add a person.
    var editMembers: (String, String?) -> Void = { _, _ in }
    /// Open a group this view just created.
    var openGroup: (String) -> Void = { _ in }
    @State private var query = ""
    @State private var newGroup: ArborNewGroupRequest?

    var body: some View {
        let people = DirectoryMatcher.matches(query: query, in: workspace.directory)
        let communities = people.filter(isCommunity)
        let groups = people.filter { $0.entry.kind == "group" && !isCommunity($0) }
        let individuals = people.filter { $0.entry.kind != "group" }
        let members = individuals.filter { $0.entry.sources.contains("community") }
        List {
            if !communities.isEmpty || !members.isEmpty {
                Section("On this Canopy") {
                    ForEach(communities) { row($0) }
                    ForEach(members) { row($0) }
                }
            }
            Section("Groups") {
                ForEach(groups) { row($0) }
                if canCreateGroup {
                    Button("New Group…", systemImage: "person.2.badge.plus") { newGroup = ArborNewGroupRequest() }
                } else if groups.isEmpty, query.isEmpty {
                    Text("No groups yet.").foregroundStyle(.secondary)
                }
            }
            directorySection("Others", values: individuals.filter { !$0.entry.sources.contains("community") })
            if let error = workspace.directoryError { Section { Text(error).foregroundStyle(.red) } }
        }
        .searchable(text: $query, prompt: "Search people and groups")
        .overlay { if people.isEmpty && !query.isEmpty && workspace.directoryError == nil { ContentUnavailableView("No people found", systemImage: "person.2") } }
        .toolbar {
            Button("Refresh", systemImage: "arrow.clockwise") { Task { await workspace.refreshDirectory(force: true) } }
                .disabled(workspace.directoryIsRefreshing)
        }
        .sheet(item: $newGroup) { request in
            ArborNewGroupSheet(workspace: workspace, request: request) { tree in openGroup(tree) }
        }
    }

    private var canCreateGroup: Bool {
#if os(macOS)
        workspace.groupCreationAccount != nil
#else
        false
#endif
    }

    @ViewBuilder private func directorySection(_ title: String, values: [DirectoryPerson]) -> some View {
        if !values.isEmpty {
            Section(title) {
                ForEach(values) { row($0) }
            }
        }
    }

    /// The Canopy's own membership profile: the group hosted at its root.
    private func isCommunity(_ person: DirectoryPerson) -> Bool {
        person.entry.kind == "group" && person.entry.locator.flatMap(URL.init(string:)).map { ["", "/"].contains($0.path) } == true
    }

    private func row(_ person: DirectoryPerson) -> some View {
        let isGroup = person.entry.kind == "group"
        let memberCount = workspace.directory.filter { $0.entry.sources.contains("group:\(person.id)") && $0.id != person.id }.count
        return ArborProfileRow(
            workspace: workspace, person: person,
            fallbackTitle: person.title, fallbackSubtitle: person.subtitle,
            subtitle: isCommunity(person) ? "Everyone on \(person.origin.host() ?? person.origin.absoluteString)" : nil,
            canOpen: person.entry.locator != nil,
            accessory: isGroup
                ? AnyView(Text(memberCount == 1 ? "1 member" : "\(memberCount) members").font(.caption).foregroundStyle(.secondary))
                : AnyView(EmptyView()),
            open: { openProfile(person) }
        )
        .contextMenu {
            if isGroup {
                if workspace.writableProfileTrees.contains(person.id) {
                    Button("Edit Members…", systemImage: "person.2") { editMembers(person.id, nil) }
                }
                Button(isCommunity(person) ? "Open Member List" : "Open Group", systemImage: "arrow.right.circle") { openProfile(person) }
                    .disabled(person.entry.locator == nil)
            } else {
                let candidates = writableGroups.filter { !person.entry.sources.contains("group:\($0.id)") }
                if !candidates.isEmpty {
                    Menu("Add to Group", systemImage: "person.2.badge.plus") {
                        ForEach(candidates) { group in
                            Button(group.title) { editMembers(group.id, person.id) }
                        }
                    }
                }
                if canCreateGroup {
                    Button("New Group with \(person.title)…", systemImage: "plus") {
                        newGroup = ArborNewGroupRequest(members: [person.id])
                    }
                }
                Button("Open Profile", systemImage: "arrow.right.circle") { openProfile(person) }
                    .disabled(person.entry.locator == nil)
            }
        }
    }

    /// Directory groups this account can edit. The Canopy's member list is
    /// edited from its own row, where adding a person also reserves a handle.
    private var writableGroups: [DirectoryPerson] {
        let writable = workspace.writableProfileTrees
        return workspace.directory.filter { $0.entry.kind == "group" && !isCommunity($0) && writable.contains($0.id) }
    }
}

/// What a New Group sheet starts with.
struct ArborNewGroupRequest: Identifiable {
    let id = UUID()
    var name = ""
    var members: [String] = []
}

/// Create a group profile: a name, its address under the account, and its
/// first members. Everyone on the Canopy can see it.
struct ArborNewGroupSheet: View {
    @Environment(\.dismiss) private var dismiss
    let workspace: ArborWorkspaceState
    let request: ArborNewGroupRequest
    let created: (String) -> Void
    @State private var name = ""
    @State private var slug = ""
    @State private var slugEdited = false
    @State private var groupDescription = ""
    @State private var members: [String] = []
    @State private var query = ""
    @State private var busy = false
    @State private var message: String?

    private var handle: String? {
#if os(macOS)
        workspace.groupCreationAccount?.handle
#else
        nil
#endif
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Name", text: $name, prompt: Text("Garden Club"))
                    LabeledContent("Address") {
                        HStack(spacing: 0) {
                            Text("/~\(handle ?? "you")/").foregroundStyle(.secondary)
                            TextField("Address", text: Binding(get: { slug }, set: { slug = $0; slugEdited = true }), prompt: Text("garden-club"))
                                .labelsHidden()
#if os(iOS)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
#endif
                        }
                    }
                    TextField("Description", text: $groupDescription, prompt: Text("Optional"), axis: .vertical)
                        .lineLimit(1...4)
                } footer: {
                    Text("Everyone on this Canopy can see the group and who is in it. Sharing a tree with the group shares it with every member.")
                }
                Section("Members") {
                    ForEach(members, id: \.self) { tree in
                        let person = workspace.directory.first { $0.id == tree }
                        HStack(spacing: 10) {
                            ArborAvatarView(person: person, workspace: workspace, size: 28)
                            Text(person?.title ?? tree).lineLimit(1).truncationMode(.middle)
                            Spacer()
                            Button("Remove", systemImage: "minus.circle") { members.removeAll { $0 == tree } }
                                .labelStyle(.iconOnly)
                                .buttonStyle(.borderless)
                        }
                    }
                    ArborPeoplePicker(
                        query: $query,
                        people: workspace.directory.filter { $0.entry.kind != "group" },
                        workspace: workspace,
                        excluding: Set(members),
                        disabled: busy,
                        onPick: { person in
                            members.append(person.id)
                            query = ""
                        },
                        onRawSubmit: addRaw
                    )
                }
                if let message { Section { Text(message).foregroundStyle(.red) } }
            }
            .formStyle(.grouped)
            .navigationTitle("New Group")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") { Task { await create() } }
                        .disabled(busy || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !ArborGroupSlug.isValid(slug))
                }
            }
        }
        .frame(minWidth: 460, minHeight: 440)
        .onAppear {
            name = request.name
            slug = ArborGroupSlug.make(from: request.name)
            members = request.members
        }
        .onChange(of: name) { _, value in
            if !slugEdited { slug = ArborGroupSlug.make(from: value) }
        }
    }

    private func addRaw() {
        let value = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard TreeID.isWellFormed(value) else {
            message = "Pick someone from People, or enter their Profile TreeID (tr_…)"
            return
        }
        if !members.contains(value) { members.append(value) }
        query = ""
        message = nil
    }

    private func create() async {
#if os(macOS)
        busy = true
        defer { busy = false }
        do {
            let tree = try await workspace.createGroup(
                name: name,
                slug: slug,
                description: groupDescription,
                memberTrees: members
            )
            dismiss()
            created(tree)
        } catch {
            message = error.localizedDescription
        }
#endif
    }
}
