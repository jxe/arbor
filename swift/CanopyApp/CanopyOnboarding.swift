#if os(macOS)
import AppKit
import Overstory
import OverstoryClient
import SwiftUI

struct CanopyMacLaunchView: View {
    let workspace: CanopyWorkspaceState
    @State private var ready = ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil
    @State private var joinAccount: String?
    @State private var joinCode: String?
    @State private var showingJoin = false

    var body: some View {
        Group {
            if ready {
                CanopyRootView(workspace: workspace)
            } else {
                CanopyMacOnboarding(workspace: workspace, resumeExisting: true, initialCommunity: joinAccount, initialCode: joinCode) { ready = true }
            }
        }
        .onOpenURL { url in
            guard url.scheme == "canopy", url.host == "join",
                  let account = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "account" })?.value,
                  let target = URL(string: account), target.scheme == "https" || target.host == "127.0.0.1" else { return }
            joinAccount = account
            joinCode = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "code" })?.value
            showingJoin = ready
        }
        .sheet(isPresented: $showingJoin) {
            CanopyMacOnboarding(workspace: workspace, addingAccount: true, initialCommunity: joinAccount, initialCode: joinCode) { showingJoin = false }
        }
    }
}

/// The data home owns the Mac's identity and claims, through the workspace's
/// `accountService`; the view holds presentation and the Mac's file panels.
struct CanopyMacOnboarding: View {
    let workspace: CanopyWorkspaceState
    var resumeExisting = false
    var addingAccount = false
    var initialCommunity: String?
    var initialCode: String?
    let complete: () -> Void
    @State private var state: CanopyAccountState?
    @State private var connected = false
    @State private var legacy: NativeProfileIdentity?
    @State private var legacyConflict = false
    @State private var busy = false
    @State private var message: String?
    @State private var community = ""
    @State private var inviteCode = ""
    @State private var pairingCode = ""
    @State private var treeChoices: [ProtocolTreeDescriptor] = []
    @State private var treeOrigin: URL?

    var body: some View {
        Form {
            Section {
                HStack {
                    Text(addingAccount ? "Add account" : "Welcome to Canopy").font(.largeTitle)
                    Spacer()
                    if addingAccount { Button("Done", action: complete) }
                }
                Text(addingAccount ? "Connect to a community or pair this Mac with an existing account." : "Your identity connects you to your communities.")
                    .foregroundStyle(.secondary)
            }
            if let state {
                if legacyConflict, let identity = state.identity, let legacy {
                    Section("Two existing identities") {
                        Text("Arbor uses \(identity.profileTree). This app also retains \(legacy.profileTree). Neither will be replaced.")
                            .textSelection(.enabled)
                        Button("Use Arbor’s identity") {
                            UserDefaults.standard.set(legacy.profileTree, forKey: "onboarding.legacy.\(identity.profileTree)")
                            legacyConflict = false
                        }
                        Text("To use the other identity, first back up and reconcile your existing Arbor accounts. You can close this window and leave both identities intact.")
                            .foregroundStyle(.secondary)
                    }
                } else if let identity = state.identity {
                    if !addingAccount {
                    Section("Your public identity") {
                        Text(identity.profileTree).font(.caption.monospaced()).textSelection(.enabled)
                        ShareLink("Share Public Identity", item: "arbor://\(identity.profileTree)/")
                        Button("Copy Public Identity") { canopyCopyToPasteboard("arbor://\(identity.profileTree)/") }
                        Text("Send this public ID to a community administrator. Once they add you, enter the community address below.")
                        if !identity.keyAvailable {
                            Text("The private key is unavailable. Recover this identity from its backup to claim new accounts.").foregroundStyle(.red)
                            Button("Recover Identity…") { recover() }
                        } else {
                            Button("Back Up Identity…") { backup() }
                        }
                    }
                    }
                    Section("Already joined on another device?") {
                        Text("Recovering your identity does not authorize this Mac on an existing account. Create a pairing code on an authorized device, then paste it here.")
                        if let pendingOrigin = state.pendingPairingOrigin {
                            Text("Pending pairing with \(pendingOrigin)")
                            Button("Resume Pairing") {
                                run { service in
                                    try await service.resumePairing()
                                    try await reload()
                                    if let account = self.state?.accounts.first(where: { $0.origin?.absoluteString == pendingOrigin && $0.credentialAvailable }) {
                                        try await chooseTrees(account)
                                    }
                                }
                            }
                        } else {
                            TextField("Pairing code", text: $pairingCode)
                            Button("Pair This Mac") {
                                run { service in
                                    let known = Set(state.accounts.filter(\.credentialAvailable).map(\.configurationTree))
                                    _ = try await service.claimPairing(Data(pairingCode.utf8), deviceLabel: Self.deviceLabel)
                                    pairingCode = ""
                                    try await reload()
                                    if let account = self.state?.accounts.first(where: { !known.contains($0.configurationTree) && $0.credentialAvailable }) {
                                        try await chooseTrees(account)
                                    }
                                }
                            }.disabled(pairingCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        }
                    }
                    if addingAccount, !identity.keyAvailable {
                        Section {
                            Text("Recover your identity key to connect to a new community.")
                            Button("Recover Identity…") { recover() }
                        }
                    }
                    if identity.keyAvailable {
                        Section("Connect to a community") {
                            if let pending = state.pendingClaim {
                                Text(pending.account).textSelection(.enabled)
                                if pending.canCancel {
                                    Button("Cancel Connection") {
                                        run { service in try await service.cancelPendingClaim(); community = ""; try await reload() }
                                    }
                                } else {
                                    Text("This connection may already have reached the community. Resume it to finish safely.")
                                        .foregroundStyle(.secondary)
                                }
                            } else {
                                TextField("https://community.example", text: $community)
                            }
                            SecureField("Invitation code (if you have one)", text: $inviteCode)
                            Button(state.pendingClaim == nil ? "Connect" : "Resume Connection") {
                                run { service in
                                    let target = state.pendingClaim?.account ?? community.trimmingCharacters(in: .whitespacesAndNewlines)
                                    let known = Set(state.accounts.filter(\.credentialAvailable).map(\.configurationTree))
                                    try await service.claimAccount(target, deviceLabel: Self.deviceLabel,
                                        inviteCode: inviteCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                                            ? nil : inviteCode.trimmingCharacters(in: .whitespacesAndNewlines))
                                    try await reload()
                                    if let account = self.state?.accounts.first(where: { !known.contains($0.configurationTree) && $0.credentialAvailable }) {
                                        try await chooseTrees(account)
                                    }
                                }
                            }
                            .disabled(state.pendingClaim == nil && community.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        }
                    }
                    if !addingAccount, !state.accounts.isEmpty {
                        Section("Communities") {
                            ForEach(state.accounts) { account in
                                Button(account.handle.map { "~\($0) · \(account.origin?.absoluteString ?? "")" } ?? account.configurationTree) {
                                    run { _ in try await chooseTrees(account) }
                                }
                                .disabled(!account.credentialAvailable)
                            }
                        }
                    }
                    if !treeChoices.isEmpty {
                        Section("Choose a tree") {
                            ForEach(treeChoices, id: \.id) { tree in
                                Button(tree.canonicalPath ?? tree.id) {
                                    guard let origin = treeOrigin, let path = tree.canonicalPath else { return }
                                    run { _ in
                                        await workspace.restoreLocalWorkspaceIfAvailable()
                                        try await workspace.openRemoteLocator(origin.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + path)
                                        complete()
                                    }
                                }
                                .disabled(tree.canonicalPath == nil)
                            }
                        }
                    }
                    Button(addingAccount ? "Done" : "Continue with Local Files", action: complete)
                } else {
                    Section("Set up your identity") {
                        if initialCommunity != nil {
                            Text("Create your identity to join this Canopy. Your invitation link will stay ready here.")
                                .foregroundStyle(.secondary)
                            Text(initialCommunity ?? "").font(.caption.monospaced()).textSelection(.enabled)
                        }
                        Button("Create Identity") {
                            run { service in try await service.createIdentity(); try await reload() }
                        }
                        Button("Recover Identity…") { recover() }
                    }
                }
            }
            if busy { ProgressView("Opening Canopy…") }
            if let message {
                Section {
                    Text(message).foregroundStyle(.red).textSelection(.enabled)
                    Button("Try Again") { Task { await load() } }
                    if state == nil, connected { Button("Recover Identity…") { recover() } }
                }
            }
        }
        .formStyle(.grouped)
        .frame(minWidth: 520, minHeight: 480)
        .disabled(busy)
        .task {
            if let initialCommunity { community = initialCommunity }
            if let initialCode { inviteCode = initialCode }
            await load()
        }
        .onChange(of: initialCommunity) { _, value in if let value { community = value } }
        .onChange(of: initialCode) { _, value in if let value { inviteCode = value } }
    }

    private func load() async {
        busy = true
        defer { busy = false }
        do {
            try await workspace.ensureArborSync()
            connected = true
            legacy = try await KeychainProfileIdentityStore().identity()
            try await reload()
            let reconciliation = ProfileIdentityReconciliation.decide(
                arbor: state?.identity?.profileTree,
                keyAvailable: state?.identity?.keyAvailable == true,
                native: legacy?.profileTree
            )
            if !addingAccount, reconciliation == .adoptNative {
                // Adopt the identity this app kept in its own keychain before
                // the data home held one.
                try await workspace.accountService.restoreIdentity(backup: KeychainProfileIdentityStore().backupData(), passphrase: nil)
                try await reload()
            }
            if reconciliation == .chooseExisting, let identity = state?.identity, let legacy {
                legacyConflict = UserDefaults.standard.string(forKey: "onboarding.legacy.\(identity.profileTree)") != legacy.profileTree
            }
            if resumeExisting, !legacyConflict, state?.pendingClaim == nil, state?.pendingPairingOrigin == nil,
               state?.identity != nil,
               (state?.accounts.contains(where: { $0.credentialAvailable }) == true || FileManager.default.fileExists(atPath: CanopySupportDirectories.nativePlacement.path)) {
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
        if let pending = state?.pendingClaim { community = pending.account }
        message = nil
    }

    private func run(_ action: @escaping (any CanopyAccountService) async throws -> Void) {
        guard connected else { return }
        let service = workspace.accountService
        Task {
            busy = true
            message = nil
            defer { busy = false }
            do { try await action(service) }
            catch {
                let failure = error.localizedDescription
                try? await reload()
                message = failure
            }
        }
    }

    private func recover() {
        guard let (backup, passphrase) = CanopyIdentityBackupPrompt.chooseBackup() else { return }
        run { service in
            try await service.restoreIdentity(backup: backup, passphrase: passphrase)
            try await reload()
        }
    }

    private func backup() {
        guard let (url, passphrase) = CanopyIdentityBackupPrompt.chooseDestination() else { return }
        run { service in try await service.backupIdentity(to: url, passphrase: passphrase) }
    }

    private func chooseTrees(_ account: CanopyAccount) async throws {
        guard connected, let origin = account.origin else { return }
        let wire = try await workspace.accountService.client(for: account)
        treeChoices = try await wire.trees().snapshot.filter { $0.id != account.configurationTree }
        treeOrigin = origin
    }

    /// The data home names this Mac's device itself and ignores the label.
    private static let deviceLabel = "Mac"
}
/// The panels around an identity backup. A backup is encrypted under a
/// passphrase, because the profile key it holds can reset every device of the
/// profile; an older backup without one still restores.
enum CanopyIdentityBackupPrompt {
    static let minimumPassphraseLength = 8

    /// A new backup file and its passphrase, entered twice; nil when cancelled.
    @MainActor static func chooseDestination() -> (URL, String)? {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = "Arbor Identity.json"
        panel.message = "This backup contains your private identity key, encrypted under a passphrase you choose. Choose a new file."
        guard panel.runModal() == .OK, let url = panel.url else { return nil }
        var message = "Choose a passphrase of at least \(minimumPassphraseLength) characters. Without it the backup cannot be restored."
        while true {
            guard let entered = passphrase(title: "Encrypt the backup", message: message, confirm: true) else { return nil }
            if entered.0.count < minimumPassphraseLength { message = "The passphrase needs at least \(minimumPassphraseLength) characters." }
            else if entered.0 != entered.1 { message = "The two passphrases differ. Enter them again." }
            else { return (url, entered.0) }
        }
    }

    /// A backup file's contents, and its passphrase when it is encrypted; nil when cancelled.
    @MainActor static func chooseBackup() -> (Data, String?)? {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.message = "Choose your Arbor identity backup."
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
        first.placeholderString = "Passphrase"
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
