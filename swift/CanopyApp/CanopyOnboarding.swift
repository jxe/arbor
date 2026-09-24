#if os(macOS)
import AppKit
import Overstory
import OverstoryClient
import SwiftUI

struct CanopyMacLaunchView: View {
    let workspace: ArborWorkspaceState
    @State private var ready = ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil

    var body: some View {
        if ready {
            ArborRootView(workspace: workspace)
        } else {
            CanopyMacOnboarding(workspace: workspace, resumeExisting: true) { ready = true }
        }
    }
}

/// The daemon owns the Mac's identity and claims; the view holds presentation only.
struct CanopyMacOnboarding: View {
    let workspace: ArborWorkspaceState
    var resumeExisting = false
    var addingAccount = false
    let complete: () -> Void
    @State private var state: LocalCanopyAccountsEnvelope?
    @State private var client: ArborSyncRESTClient?
    @State private var legacy: NativeProfileIdentity?
    @State private var legacyConflict = false
    @State private var busy = false
    @State private var message: String?
    @State private var community = ""
    @State private var pairingCode = ""
    @State private var treeChoices: [WireTreeDescriptor] = []
    @State private var treeOrigin: URL?

    private var profilePath: String {
        state?.identity?.profilePath ?? ArborSupportDirectories.root.appending(path: "Profile").path
    }

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
                        Button("Copy Public Identity") { arborCopyToPasteboard("arbor://\(identity.profileTree)/") }
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
                        if let pending = state.pendingPairing {
                            Text("Pending pairing with \(pending.origin)")
                            Button("Resume Pairing") {
                                run { client in
                                    try await client.claimPairing()
                                    try await reload()
                                    if let account = self.state?.accounts.first(where: { $0.canopy == pending.origin && $0.credentialAvailable }) {
                                        try await chooseTrees(account)
                                    }
                                }
                            }
                        } else {
                            TextField("Pairing code", text: $pairingCode)
                            Button("Pair This Mac") {
                                run { client in
                                    let known = Set(state.accounts.filter(\.credentialAvailable).map(\.configurationTree))
                                    try await client.claimPairing(payload: Data(pairingCode.utf8))
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
                                if pending.canCancel == true {
                                    Button("Cancel Connection") {
                                        run { client in try await client.cancelPendingClaim(); community = ""; try await reload() }
                                    }
                                } else {
                                    Text("This connection may already have reached the community. Resume it to finish safely.")
                                        .foregroundStyle(.secondary)
                                }
                            } else {
                                TextField("https://community.example", text: $community)
                            }
                            Button(state.pendingClaim == nil ? "Connect" : "Resume Connection") {
                                run { client in
                                    let target = state.pendingClaim?.account ?? community.trimmingCharacters(in: .whitespacesAndNewlines)
                                    let known = Set(state.accounts.filter(\.credentialAvailable).map(\.configurationTree))
                                    try await client.claimAccount(account: target, path: state.pendingClaim?.path ?? profilePath)
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
                                Button(account.handle.map { "~\($0) · \(account.canopy ?? "")" } ?? account.configurationTree) {
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
                        Button("Create Identity") {
                            run { client in try await client.createIdentity(path: profilePath); try await reload() }
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
                    if state == nil, client != nil { Button("Recover Identity…") { recover() } }
                }
            }
        }
        .formStyle(.grouped)
        .frame(minWidth: 520, minHeight: 480)
        .disabled(busy)
        .task { await load() }
    }

    private func load() async {
        busy = true
        defer { busy = false }
        do {
            client = try await workspace.ensureArborSync().client
            legacy = try await KeychainProfileIdentityStore().identity()
            try await reload()
            let reconciliation = ProfileIdentityReconciliation.decide(
                arbor: state?.identity?.profileTree,
                keyAvailable: state?.identity?.keyAvailable == true,
                native: legacy?.profileTree
            )
            if !addingAccount, reconciliation == .adoptNative, let client {
                try await client.restoreIdentity(backup: KeychainProfileIdentityStore().backupData(), path: profilePath)
                try await reload()
            }
            if reconciliation == .chooseExisting, let identity = state?.identity, let legacy {
                legacyConflict = UserDefaults.standard.string(forKey: "onboarding.legacy.\(identity.profileTree)") != legacy.profileTree
            }
            if resumeExisting, !legacyConflict, state?.pendingClaim == nil, state?.pendingPairing == nil,
               state?.identity != nil,
               (state?.accounts.contains(where: { $0.credentialAvailable }) == true || FileManager.default.fileExists(atPath: ArborSupportDirectories.nativePlacement.path)) {
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
        guard let client else { return }
        state = try await client.onboardingState()
        if let pending = state?.pendingClaim { community = pending.account }
        message = nil
    }

    private func run(_ action: @escaping (ArborSyncRESTClient) async throws -> Void) {
        guard let client else { return }
        Task {
            busy = true
            message = nil
            defer { busy = false }
            do { try await action(client) }
            catch {
                let failure = error.localizedDescription
                try? await reload()
                message = failure
            }
        }
    }

    private func recover() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.message = "Choose your Arbor identity backup."
        guard panel.runModal() == .OK, let url = panel.url else { return }
        run { client in
            try await client.restoreIdentity(backup: Data(contentsOf: url), path: profilePath)
            try await reload()
        }
    }

    private func backup() {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = "Arbor Identity.json"
        panel.message = "This backup contains your private identity key. Keep it somewhere secure. Choose a new file."
        guard panel.runModal() == .OK, let url = panel.url else { return }
        run { client in try await client.backupIdentity(destination: url.path) }
    }

    private func chooseTrees(_ account: LocalCanopyAccountDescriptor) async throws {
        guard let client, let canopy = account.canopy, let origin = URL(string: canopy) else { return }
        let credential = try await client.credential(configurationTree: account.configurationTree)
        let wire = ArborWireClient(origin: origin, credential: credential)
        treeChoices = try await wire.trees().snapshot.filter { $0.id != account.configurationTree }
        treeOrigin = origin
    }
}
#endif
