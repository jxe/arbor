#if os(macOS)
import AppKit
import Overstory
import OverstoryClient
import StoryKit
import SwiftUI
import UniformTypeIdentifiers

struct StoryMacLaunchView: View {
    let workspace: StoryWorkspaceState
    /// The request a window opened from another was made with.
    var windowRequest: UUID?
    @State private var ready: Bool
    @State private var joinAccount: String?
    @State private var joinCode: String?
    @State private var showingJoin = false

    init(workspace: StoryWorkspaceState, windowRequest: UUID? = nil) {
        self.workspace = workspace
        self.windowRequest = windowRequest
        // A window opened beside one already showing a tree skips onboarding.
        _ready = State(initialValue: ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil
            || workspace.launchPhase.showsTree)
    }

    var body: some View {
        Group {
            if ready {
                StoryRootView(workspace: workspace, windowRequest: windowRequest)
            } else {
                StoryMacOnboarding(workspace: workspace, resumeExisting: true, initialCommunity: joinAccount, initialCode: joinCode) { ready = true }
            }
        }
        // Story keeps one window: a link opened while it is up goes to that
        // window instead of making SwiftUI open a second one beside it.
        .handlesExternalEvents(preferring: ["*"], allowing: ["*"])
        .onOpenURL { url in
            switch StoryIncomingLocator(url) {
            case let .join(account, code):
                joinAccount = account
                joinCode = code
                guard ready else { return }
                Task { await acceptInvitation(account: account, code: code) }
            case let .open(locator):
                // Before onboarding completes there is no workspace window to open it in.
                guard ready else { return }
                Task {
                    do { try await workspace.openRemoteLocator(locator) }
                    catch { workspace.errorMessage = error.localizedDescription }
                }
            case nil:
                break
            }
        }
        .sheet(isPresented: $showingJoin) {
            StoryMacOnboarding(workspace: workspace, addingAccount: true, initialCommunity: joinAccount, initialCode: joinCode) { showingJoin = false }
        }
    }

    /// An invite link opened once Story is set up joins that community with
    /// this Mac's profile, as a placement (accounts §1.4); Story keeps one
    /// identity. With no account yet, the link starts setup as before.
    private func acceptInvitation(account: String, code: String) async {
        do {
            guard let home = try await workspace.accountService.accounts().first,
                  workspace.accountService.capabilities.contains(.connectPlacement),
                  let link = buildInviteLocator(account: account, code: code) else {
                showingJoin = true
                return
            }
            try await workspace.ensureStorySync()
            try await workspace.accountService.connectPlacement(configurationTree: home.configurationTree, host: link)
            // Show the new place: the invited address, now this profile's there.
            try await workspace.openRemoteLocator(account)
        } catch {
            workspace.errorMessage = error.localizedDescription
        }
    }
}

/// Setting up Story on a Mac: join a host by invitation link, then a short
/// list of first steps. The data home owns the Mac's identity and claims,
/// through the workspace's `accountService`; the view holds presentation and
/// the Mac's file panels.
struct StoryMacOnboarding: View {
    let workspace: StoryWorkspaceState
    var resumeExisting = false
    var addingAccount = false
    var initialCommunity: String?
    var initialCode: String?
    let complete: () -> Void
    @State private var state: HostAccountState?
    @State private var connected = false
    @State private var busy = false
    @State private var message: String?
    @State private var link = ""
    /// An invitation pasted into the link field; an account URL alone has no code.
    @State private var pasted: (account: String, code: String?)?
    @State private var displayName = ""
    @State private var pairingCode = ""
    @State private var returning = false
    // After the join.
    @State private var joinedAccount: HostAccount?
    @State private var joinedURL: String?
    @State private var photo: NSImage?
    @State private var backedUp = false
    @State private var folder: (name: String, canonical: String)?
    @State private var treeChoices: [ProtocolTreeDescriptor] = []
    @State private var syncedTrees: Set<String> = []

    /// The account and code of the invitation this form was opened with, or was given by paste.
    private var invited: (account: String, code: String?)? {
        if let initialCommunity, let initialCode { return (initialCommunity, initialCode) }
        return pasted
    }

    /// The host and handle of an account URL such as `https://host/~handle`.
    private static func place(_ account: String?) -> (host: String, handle: String)? {
        guard let account, let url = URL(string: account), let host = url.host(), url.path.hasPrefix("/~") else { return nil }
        return (url.port.map { "\(host):\($0)" } ?? host, String(url.path.dropFirst(2)))
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 22) {
                header
                if let state {
                    if let joinedURL, let joined = Self.place(joinedURL) {
                        firstSteps(host: joined.host, handle: joined.handle)
                    } else if let pending = state.pendingClaim {
                        pendingCard(pending)
                    } else if let invited, let invitation = Self.place(invited.account) {
                        joinCard(state, host: invitation.host, handle: invitation.handle)
                    } else {
                        linkCard
                    }
                    if joinedURL == nil {
                        if let pendingOrigin = state.pendingPairingOrigin {
                            card {
                                Text("Adding this Mac to your account on \(pendingOrigin) did not finish.")
                                Button("Finish") {
                                    run { service in
                                        try await service.resumePairing()
                                        try await reload()
                                        complete()
                                    }
                                }
                            }
                        } else {
                            Button("I’ve used Story before…") { returning = true }
                                .buttonStyle(.link)
                        }
                    }
                }
                if busy { ProgressView() }
                if let message {
                    Text(message).foregroundStyle(.red).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if state == nil { Button("Try Again") { Task { await load() } } }
                }
            }
            .frame(maxWidth: 460)
            .padding(.horizontal, 32)
            .padding(.vertical, 36)
            .frame(maxWidth: .infinity)
        }
        .frame(minWidth: 540, minHeight: 540)
        .disabled(busy)
        .task { await load() }
        .onChange(of: link) { _, value in
            let text = value.trimmingCharacters(in: .whitespacesAndNewlines)
            // A code is 22 characters; a shorter one is a link still being typed.
            if case let .join(account, code)? = StoryIncomingLocator.pastedJoinLink(text), code.count == 22 {
                pasted = (account, code)
            } else if state?.identity != nil, Self.place(text) != nil, text.hasPrefix("http"), !text.contains("#") {
                // An account reserved for the identity already on this Mac needs no code.
                pasted = (text, nil)
            }
        }
        .sheet(isPresented: $returning) { returningSheet }
    }

    private var header: some View {
        VStack(spacing: 10) {
            if addingAccount {
                HStack {
                    Spacer()
                    Button("Done", action: complete)
                }
            } else {
                Image(nsImage: NSApp.applicationIconImage).resizable().frame(width: 84, height: 84)
            }
            Text(addingAccount ? "Add an Account" : joinedURL == nil ? "Welcome to Story" : "You’re in")
                .font(.largeTitle.weight(.semibold))
        }
    }

    /// A rounded panel: the one kind of block on these screens.
    private func card(@ViewBuilder _ content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 12, content: content)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(18)
            .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 14))
    }

    // MARK: Joining

    private var linkCard: some View {
        VStack(spacing: 14) {
            Text("Story is joined by invitation. Paste the link you were sent.")
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            TextField("Invitation link", text: $link, prompt: Text(verbatim: "https://host.example/~you#overstory-invite=…"))
                .labelsHidden()
                .textFieldStyle(.roundedBorder)
                .controlSize(.large)
            Text("Or open the link in your browser and choose Open in Story.")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private func joinCard(_ state: HostAccountState, host: String, handle: String) -> some View {
        Text("You’ve been invited to **\(host)** as **~\(handle)**.")
            .multilineTextAlignment(.center)
        card {
            if let identity = state.identity {
                if identity.keyAvailable {
                    Text("You’ll join with the identity already on this Mac.").foregroundStyle(.secondary)
                    joinButton(host, enabled: true)
                } else {
                    Text("The identity on this Mac has lost its key. Recover it from its backup to join.")
                    Button("Recover Identity…") { recover() }
                }
            } else {
                Text("What should people call you?").foregroundStyle(.secondary)
                TextField("Your name", text: $displayName, prompt: Text("Your name"))
                    .labelsHidden()
                    .textFieldStyle(.roundedBorder)
                    .controlSize(.large)
                    .onSubmit { if !displayName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { join() } }
                joinButton(host, enabled: !displayName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        if pasted != nil {
            Button("Use a different link") { pasted = nil; link = "" }.buttonStyle(.link)
        }
    }

    private func joinButton(_ host: String, enabled: Bool) -> some View {
        Button { join() } label: { Text("Join \(host)").frame(maxWidth: .infinity) }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(!enabled)
    }

    private func pendingCard(_ pending: PendingHostAccountClaim) -> some View {
        card {
            Text("Joining \(Self.place(pending.account)?.host ?? pending.account)").font(.headline)
            Text(pending.canCancel
                ? "This did not finish. Try it again, or cancel it to use another link."
                : "This may already have reached the host. Finish it to continue safely.")
                .foregroundStyle(.secondary)
            HStack {
                Button("Finish Joining") { join(resuming: pending.account) }.buttonStyle(.borderedProminent)
                if pending.canCancel {
                    Button("Cancel") { run { service in try await service.cancelPendingClaim(); try await reload() } }
                }
            }
        }
    }

    /// For someone who has used Story before: add this Mac to an account, or bring an identity back.
    private var returningSheet: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Used Story before?").font(.title2.weight(.semibold))
            card {
                Text("Add this Mac to your account").font(.headline)
                Text("On a device that already uses the account, choose Sync & Accounts, then Pair another device, and paste its code here. With no such device, ask the host’s administrator for a recovery code.")
                    .font(.callout).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                TextField("Pairing code", text: $pairingCode, prompt: Text("Pairing or recovery code"))
                    .labelsHidden()
                    .textFieldStyle(.roundedBorder)
                Button("Add This Mac") {
                    returning = false
                    run { service in
                        _ = try await service.claimPairing(Data(pairingCode.utf8), deviceLabel: Self.deviceLabel)
                        pairingCode = ""
                        try await reload()
                        complete()
                    }
                }
                .disabled(pairingCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            if state?.identity == nil {
                card {
                    Text("Join somewhere new as the same person").font(.headline)
                    Text("Recover your identity from its backup file, then join with an invitation as usual.")
                        .font(.callout).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    Button("Recover Identity…") { returning = false; recover() }
                }
            }
            HStack {
                Spacer()
                Button("Cancel") { returning = false }.keyboardShortcut(.cancelAction)
            }
        }
        .padding(24)
        .frame(width: 460)
    }

    /// Create the identity if this Mac has none, then claim the invited account.
    private func join(resuming pendingAccount: String? = nil) {
        guard let account = pendingAccount ?? invited?.account else { return }
        let code = pendingAccount == nil ? invited?.code : nil
        let name = displayName.trimmingCharacters(in: .whitespacesAndNewlines)
        let hadIdentity = state?.identity != nil
        let known = Set(state?.accounts.filter(\.credentialAvailable).map(\.configurationTree) ?? [])
        run { service in
            if !hadIdentity { try await service.createIdentity() }
            try await service.claimAccount(account, deviceLabel: Self.deviceLabel, inviteCode: code, displayName: name.isEmpty ? nil : name)
            try await reload()
            joinedURL = account
            if let joined = self.state?.accounts.first(where: { !known.contains($0.configurationTree) && $0.credentialAvailable }) {
                joinedAccount = joined
                try await chooseTrees(joined)
            }
        }
    }

    // MARK: First steps

    @ViewBuilder
    private func firstSteps(host: String, handle: String) -> some View {
        Text("You joined **\(host)** as **~\(handle)**. Three quick things before you start.")
            .multilineTextAlignment(.center)
        card {
            step(photo != nil, "Add a photo", "So people on \(host) recognize you.") {
                if let photo {
                    Image(nsImage: photo).resizable().scaledToFill().frame(width: 28, height: 28).clipShape(Circle())
                }
                Button(photo == nil ? "Choose Photo…" : "Change…") { choosePhoto() }
            }
            Divider()
            step(backedUp, "Back up your identity", "Your identity is a key kept on this Mac. The backup file is the only way to get it back.") {
                Button(backedUp ? "Back Up Again…" : "Back Up…") { backup() }
            }
            Divider()
            step(folder != nil, folder.map { "Syncing \($0.name)" } ?? "Choose a folder to sync",
                 "Its pages are kept on \(host) and on this Mac, private until you share them. A new, empty folder for your notes is fine.") {
                if folder == nil { Button("Choose Folder…") { chooseFolder() } }
            }
        }
        let shared = treeChoices.filter(isShared)
        if !shared.isEmpty {
            Text("Also on \(host), if you’d like a copy on this Mac")
                .font(.callout).foregroundStyle(.secondary)
            card {
                ForEach(shared, id: \.id) { tree in
                    step(syncedTrees.contains(tree.id), Self.treeName(tree), tree.canonicalPath ?? "") {
                        if !syncedTrees.contains(tree.id) { Button("Sync to Documents") { syncExisting(tree) } }
                    }
                }
            }
        }
        Button { finish() } label: { Text(addingAccount ? "Done" : "Start Using Story").frame(maxWidth: .infinity) }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(photo == nil || !backedUp || folder == nil)
    }

    private func step(_ done: Bool, _ title: String, _ detail: String, @ViewBuilder action: () -> some View) -> some View {
        HStack(spacing: 12) {
            Image(systemName: done ? "checkmark.circle.fill" : "circle")
                .font(.title2)
                .foregroundStyle(done ? Color.green : Color.secondary)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).fontWeight(.medium)
                if !detail.isEmpty {
                    Text(detail).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 12)
            action()
        }
    }

    /// A tree worth offering to sync: not the host's home, nobody's profile, and not the folder just added.
    private func isShared(_ tree: ProtocolTreeDescriptor) -> Bool {
        guard let path = tree.canonicalPath, path != "/" else { return false }
        let segments = path.split(separator: "/")
        if segments.count == 1, segments[0].hasPrefix("~") { return false }
        if let folder, folder.canonical.hasSuffix(path) { return false }
        return true
    }

    /// What a person calls a tree: the last name in its address.
    static func treeName(_ tree: ProtocolTreeDescriptor) -> String {
        tree.canonicalPath?.split(separator: "/").last.map(String.init) ?? tree.id
    }

    /// Put a photo in the profile folder and name it in the profile page; Story Sync publishes both.
    private func choosePhoto() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.image]
        panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let url = panel.url else { return }
        run { service in
            guard let profileFolder = try await service.profileFolder() else {
                throw ProtocolValidationError.invalidValue("This Mac keeps no profile folder to put a photo in")
            }
            let asset = try StoryProfilePhotoImport.load(from: url)
            let index = profileFolder.appending(path: "_index.md")
            let source = try String(contentsOf: index, encoding: .utf8)
            let profile = StoryProfileDocument.parse(source)
            let updated = try StoryProfileDocument.updatingPerson(
                source, displayName: profile?.displayName ?? "", description: profile?.description ?? "", avatarPath: asset.name
            )
            try asset.bytes.write(to: profileFolder.appending(path: asset.name), options: .atomic)
            try updated.write(to: index, atomically: true, encoding: .utf8)
            photo = NSImage(data: asset.bytes)
        }
    }

    /// Make a folder from this Mac a private tree under the joined account, named after the folder.
    private func chooseFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.allowsMultipleSelection = false
        panel.message = "Choose a folder to keep in sync, or make a new one. Everything in it is sent to the host."
        guard panel.runModal() == .OK, let url = panel.url, let joinedAccount, let origin = joinedAccount.origin else { return }
        let home = FileManager.default.homeDirectoryForCurrentUser.standardizedFileURL.path
        let path = url.standardizedFileURL.path
        guard path != home, !["Documents", "Desktop", "Downloads", "Library"].map({ home + "/" + $0 }).contains(path) else {
            message = "Choose a folder inside \(url.lastPathComponent), not the whole of it."
            return
        }
        let slug = StoryGroupSlug.make(from: url.lastPathComponent)
        guard StoryGroupSlug.isValid(slug) else {
            message = "Give the folder a name with letters or numbers, so it can have an address."
            return
        }
        let account = StoryShareAccount(
            configurationTree: joinedAccount.configurationTree,
            origin: origin.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")),
            handle: joinedAccount.handle
        )
        let canonical = account.accountURL + "/" + slug
        run { _ in
            try await workspace.promoteLocalFolder(path: path, account: account, canonical: canonical, publicAccess: .noAccess)
            folder = (url.lastPathComponent, canonical)
        }
    }

    /// Copy a tree the account can already open into Documents and keep it in sync.
    private func syncExisting(_ tree: ProtocolTreeDescriptor) {
        guard let joinedAccount else { return }
        let destination = FileManager.default.homeDirectoryForCurrentUser
            .appending(path: "Documents/\(Self.treeName(tree))", directoryHint: .isDirectory)
        guard !FileManager.default.fileExists(atPath: destination.path) else {
            message = "Documents already has a folder named \(destination.lastPathComponent). Move it away, then try again."
            return
        }
        run { _ in
            try await workspace.placeExistingTree(tree.id, configurationTree: joinedAccount.configurationTree, folder: destination.path)
            syncedTrees.insert(tree.id)
        }
    }

    private func finish() {
        guard let folder else { return }
        run { _ in
            await workspace.restoreLocalWorkspaceIfAvailable()
            try await workspace.openRemoteLocator(folder.canonical)
            complete()
        }
    }

    // MARK: State

    private func load() async {
        busy = true
        defer { busy = false }
        do {
            try await workspace.ensureStorySync()
            connected = true
            try await reload()
            if resumeExisting, state?.pendingClaim == nil, state?.pendingPairingOrigin == nil,
               state?.identity != nil,
               (state?.accounts.contains(where: { $0.credentialAvailable }) == true || FileManager.default.fileExists(atPath: StorySupportDirectories.nativePlacement.path)) {
                complete()
            }
        } catch {
            message = error.localizedDescription
            // Opening an existing replica does not require the profile signing key
            // or a reachable daemon. The workspace restores its offline preview.
            if resumeExisting, (try? NativePlacementStore.selected()) != nil { complete() }
        }
    }

    private func reload() async throws {
        guard connected else { return }
        state = try await workspace.accountService.state()
        message = nil
    }

    private func run(_ action: @escaping (any HostAccountService) async throws -> Void) {
        guard connected else { return }
        let service = workspace.accountService
        Task {
            busy = true
            message = nil
            defer { busy = false }
            do { try await action(service) }
            catch {
                var failure = error.localizedDescription
                try? await reload()
                // An account can be claimed once; a second device joins it by pairing.
                if failure.localizedCaseInsensitiveContains("already claimed") {
                    failure += "\n\nIf this is your account, choose I’ve used Story before to add this Mac to it."
                }
                message = failure
            }
        }
    }

    private func recover() {
        guard let (backup, passphrase) = StoryIdentityBackupPrompt.chooseBackup() else { return }
        run { service in
            try await service.restoreIdentity(backup: backup, passphrase: passphrase)
            try await reload()
        }
    }

    private func backup() {
        guard let (url, passphrase) = StoryIdentityBackupPrompt.chooseDestination() else { return }
        run { service in
            try await service.backupIdentity(to: url, passphrase: passphrase)
            backedUp = true
        }
    }

    private func chooseTrees(_ account: HostAccount) async throws {
        guard connected else { return }
        let wire = try await workspace.accountService.client(for: account)
        treeChoices = try await wire.trees().snapshot.filter { $0.id != account.configurationTree }
    }

    /// The data home names this Mac's device itself and ignores the label.
    private static let deviceLabel = "Mac"
}
/// The panels around an identity backup. A backup is encrypted under a
/// passphrase, because the profile key it holds can reset every device of the
/// profile; an older backup without one still restores.
enum StoryIdentityBackupPrompt {
    static let minimumPassphraseLength = 4

    /// A new backup file and its passphrase, entered twice; nil when cancelled.
    @MainActor static func chooseDestination() -> (URL, String)? {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = "Story Identity.json"
        panel.message = "This backup contains your private identity key. Keep it somewhere safe, away from this Mac."
        guard panel.runModal() == .OK, let url = panel.url else { return nil }
        var message = "A passphrase is optional. With one, the backup is encrypted and cannot be restored without it. Without one, anyone who gets the file can act as you."
        while true {
            guard let entered = passphrase(title: "Protect the backup?", message: message, confirm: true) else { return nil }
            if entered.0.isEmpty, entered.1.isEmpty { return (url, "") }
            if entered.0.count < minimumPassphraseLength { message = "A passphrase needs at least \(minimumPassphraseLength) characters. Leave both fields empty for none." }
            else if entered.0 != entered.1 { message = "The two passphrases differ. Enter them again." }
            else { return (url, entered.0) }
        }
    }

    /// A backup file's contents, and its passphrase when it is encrypted; nil when cancelled.
    @MainActor static func chooseBackup() -> (Data, String?)? {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.message = "Choose your Story identity backup."
        guard panel.runModal() == .OK, let url = panel.url, let data = try? Data(contentsOf: url) else { return nil }
        let version = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["version"] as? Int
        guard version == 2 else { return (data, nil) }
        guard let entered = passphrase(title: "Open the backup", message: "Enter the passphrase this backup was encrypted with.", confirm: false) else { return nil }
        return (data, entered.0)
    }

    @MainActor private static func passphrase(title: String, message: String, confirm: Bool) -> (String, String)? {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        let first = NSSecureTextField(frame: NSRect(x: 0, y: confirm ? 30 : 0, width: 260, height: 24))
        first.placeholderString = "Passphrase (optional)"
        let second = NSSecureTextField(frame: NSRect(x: 0, y: 0, width: 260, height: 24))
        second.placeholderString = "Repeat the passphrase"
        let stack = NSView(frame: NSRect(x: 0, y: 0, width: 260, height: confirm ? 54 : 24))
        stack.addSubview(first)
        if confirm { stack.addSubview(second) }
        alert.accessoryView = stack
        alert.window.initialFirstResponder = first
        guard alert.runModal() == .alertFirstButtonReturn else { return nil }
        return (first.stringValue, confirm ? second.stringValue : first.stringValue)
    }
}
#endif
