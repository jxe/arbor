import Foundation
import Overstory
import StoryKit

/// Reads and edits tree configurations through the host, as one of the
/// tree's administrators: the sharing panel's rules, app consents, and
/// declaring and mounting new trees. The person's own profile configuration is
/// also their account checkout, which a Mac may edit on disk instead.
public struct TreeConfigurationClient: Sendable {
    /// The host that holds the tree and its configuration.
    public let wire: ProtocolClient
    /// The profile's home host when `wire` is one of its placement hosts
    /// (accounts §1.3): the account, `devices.yaml` and `apps.yaml` are read
    /// there, since a placement host holds none of them.
    public let home: ProtocolClient?
    public init(wire: ProtocolClient, home: ProtocolClient? = nil) {
        self.wire = wire
        self.home = home
    }

    private var homeWire: ProtocolClient { home ?? wire }

    /// A tree's configuration, which only its administrators may read, and
    /// whether this device is an administrator device of the person's profile,
    /// with the person's `apps.yaml`.
    func treeConfiguration(_ tree: String) async throws
        -> (account: ProtocolAccountDescriptor, configuration: ProtocolTreeDescriptor, snapshot: ProtocolSnapshot, devicesSource: String, appsSource: String) {
        let account = try await homeWire.account().account
        let profile = try account.configuration.validated()
        let profileSnapshot = try await homeWire.snapshot(tree: profile.id, root: profile.root)
        let devicesSource = try utf8(profileSnapshot.rootFile(named: "devices.yaml"), name: "devices.yaml")
        let appsSource = (try? utf8(profileSnapshot.rootFile(named: "apps.yaml"), name: "apps.yaml")) ?? "{}\n"
        if home == nil, profile.id == treeConfigurationID(tree) { return (account, profile, profileSnapshot, devicesSource, appsSource) }
        let configuration: ProtocolTreeDescriptor
        do { configuration = try await wire.descriptor(tree: treeConfigurationID(tree)).tree.validated() }
        catch { throw ProtocolValidationError.invalidValue("Only this tree's administrators can see and change who has access") }
        let snapshot = try await wire.snapshot(tree: configuration.id, root: configuration.root)
        return (account, configuration, snapshot, devicesSource, appsSource)
    }

    func submitConfiguration(_ configuration: ProtocolTreeDescriptor, snapshot: ProtocolSnapshot, file: String, source: String) async throws {
        let candidate = try snapshot.settingRootFile(named: file, to: Data(source.utf8))
        let prepared = try await wire.prepareUpdate(
            tree: configuration.id,
            base: ProtocolUpdateBase(root: configuration.root, update: configuration.update),
            snapshot: candidate,
            ifCurrent: configuration.update
        )
        _ = try await wire.submitUpdate(prepared)
    }

    public func access(tree: String) async throws -> NativeTreeAccessPresentation {
        let (account, _, snapshot, devicesSource, appsSource) = try await treeConfiguration(tree)
        let accessSource = try utf8(snapshot.rootFile(named: "access.yaml"), name: "access.yaml")
        let canonical = (try? await wire.descriptor(tree: tree).tree.httpURL) ?? nil
        let declaration = try TreeConfigurationYAML.declaration(canonical: canonical ?? "", source: accessSource)
        var profileLocators = (try? await wire.access(tree: tree).locators) ?? [:]
        if let profileTree = account.profileTree, let profileURL = account.profileURL {
            profileLocators[profileTree] = profileURL
        }
        // Groups this person administers: the writable profiles, other than
        // their own, whose configuration the host lets them read.
        var approvals = (try? TreeConfigurationYAML.appApprovals(for: tree, source: appsSource)) ?? []
        var groups: [NativeApprovalGroup] = []
        for profile in account.writableProfiles where profile.id != account.profileTree {
            guard let group = try? await TreeConfigurationClient(wire: homeWire).treeConfiguration(profile.id) else { continue }
            groups.append(NativeApprovalGroup(tree: profile.id, label: profile.canonical?.path ?? profile.id))
            let source = (try? utf8(group.snapshot.rootFile(named: "apps.yaml"), name: "apps.yaml")) ?? "{}\n"
            approvals += (try? TreeConfigurationYAML.appApprovals(for: tree, source: source, group: profile.id)) ?? []
        }
        return NativeTreeAccessPresentation(
            tree: tree,
            canonical: declaration.canonical,
            entries: ProfileConfigurationYAML.presentedAccessEntries(
                rules: declaration.access,
                profileLocators: profileLocators,
                currentProfileTree: account.profileTree,
                currentHandle: account.handle
            ),
            canEdit: try ProfileConfigurationYAML.isAdministrator(
                deviceID: account.device?.id,
                devicesSource: devicesSource
            ),
            resourceRules: declaration.resourceAccess.filter { HostedTreeDeclaration.ordinaryRule($0) == nil },
            appApprovals: approvals,
            approvalGroups: groups
        )
    }

    /// Review an app's access to `tree`: with `group`, an entry in that group's
    /// `apps.yaml` (the person must administer the group); otherwise the tree's
    /// own rule through the app when this person administers the tree and the
    /// rule is not their own approval, or else an entry in their `apps.yaml`.
    public func prepareResourceConsent(tree: String, app: String, rule: ProtocolAppAccessRule, removing: Bool = false, group: String? = nil) async throws -> NativeResourceConsent {
        if let group {
            let config = try await TreeConfigurationClient(wire: homeWire).treeConfiguration(group)
            let source = (try? utf8(config.snapshot.rootFile(named: "apps.yaml"), name: "apps.yaml")) ?? "{}\n"
            return try ProfileConfigurationYAML.prepareAppConsent(profile: group, group: true, app: app, rule: rule, removing: removing, source: source)
        }
        let account = try await homeWire.account().account
        if rule.who != .me, let treeConfig = try? await treeConfiguration(tree) {
            return try ProfileConfigurationYAML.prepareTreeAppConsent(tree: tree, app: app, rule: rule, removing: removing,
                source: utf8(treeConfig.snapshot.rootFile(named: "access.yaml"), name: "access.yaml"))
        }
        guard let profile = account.profileTree else { throw ProtocolValidationError.invalidValue("This account has no profile") }
        let configuration = try account.configuration.validated()
        let snapshot = try await homeWire.snapshot(tree: configuration.id, root: configuration.root)
        let source = (try? utf8(snapshot.rootFile(named: "apps.yaml"), name: "apps.yaml")) ?? "{}\n"
        return try ProfileConfigurationYAML.prepareAppConsent(profile: profile, group: false, app: app, rule: rule, removing: removing, source: source)
    }

    public func applyResourceConsent(_ review: NativeResourceConsent) async throws -> NativeTreeAccessPresentation? {
        let governed: String = switch review.target {
        case .profileApps(let profile, _): profile
        case .treeAccess(let tree): tree
        }
        let (account, configuration, snapshot, devicesSource, _) = try await treeConfiguration(governed)
        guard configuration.id == review.configurationTree else { throw ResourcePolicyError.invalid }
        let current = (try? utf8(snapshot.rootFile(named: review.target.file), name: review.target.file)) ?? "{}\n"
        let after = try ProfileConfigurationYAML.applyingResourceConsent(review, to: current,
            deviceID: account.device?.id, devicesSource: devicesSource)
        try await submitConfiguration(configuration, snapshot: snapshot, file: review.target.file, source: after)
        return try? await access(tree: review.tree)
    }

    public func setAccess(
        tree: String,
        target: NativeTreeAccessTarget,
        access: String
    ) async throws -> NativeTreeAccessPresentation {
        let (account, configuration, snapshot, _, _) = try await treeConfiguration(tree)
        let source = try utf8(snapshot.rootFile(named: "access.yaml"), name: "access.yaml")
        let subject: AccountAccessSubject = switch target {
        case .everyone: .everyone
        case .profile(let locator): .profile(tree: try await resolveProfile(locator))
        case .existing(let subject): subject
        }
        try ProfileConfigurationYAML.validateAccessChange(
            subject: subject,
            access: access,
            currentProfileTree: account.profileTree
        )
        let nextSource = try TreeConfigurationYAML.replacingAccess(in: source) { declaration in
            declaration.access.removeAll { $0.subject.sameSubject(as: subject) }
            if access != "none" {
                declaration.access.append(AccountAccessRule(subject: subject, access: access))
            }
        }
        try await submitConfiguration(configuration, snapshot: snapshot, file: "access.yaml", source: nextSource)
        return try await self.access(tree: tree)
    }

    /// Declare a new tree administered by this person's profile with `rules`,
    /// then mount it in `parent`'s configuration at `name`. The tree activates
    /// with its first snapshot, which the placing client submits.
    public func declareAndMount(tree: String, rules: [ProtocolResourceAccessRule], parent: String, name: String) async throws {
        let account = try await homeWire.account().account
        guard let profile = account.profileTree else { throw ProtocolValidationError.invalidValue("This account has no profile") }
        let access = try TreeConfigurationYAML.encodeAccess([ProtocolResourceAccessRule(who: .profile(profile), allow: [.admin])] + rules)
        let configuration = try Self.snapshot(files: ["access.yaml": access, "mounts.yaml": "{}\n"])
        _ = try await wire.declareTree(tree, configuration: configuration)
        try await mount(tree: tree, in: parent, at: name)
    }

    /// Mount `tree` at `name` in `parent`'s configuration.
    public func mount(tree: String, in parent: String, at name: String) async throws {
        let (_, configuration, snapshot, _, _) = try await treeConfiguration(parent)
        let source = try utf8(snapshot.rootFile(named: "mounts.yaml"), name: "mounts.yaml")
        let next = try TreeConfigurationYAML.replacingMounts(in: source) { mounts in
            guard mounts[name] == nil else { throw ProtocolValidationError.invalidValue("\(name) is already mounted") }
            mounts[name] = tree
        }
        try await submitConfiguration(configuration, snapshot: snapshot, file: "mounts.yaml", source: next)
    }

    static func snapshot(files: [String: String]) throws -> ProtocolSnapshot {
        let objects = try files.mapValues { try ProtocolObjectCodec.object(.file(Data($0.utf8))) }
        let entries = objects.keys.sorted { $0.utf8.lexicographicallyPrecedes($1.utf8) }.map { ProtocolDirectoryEntry(name: $0, file: objects[$0]!.hash) }
        let root = try ProtocolObjectCodec.object(.directory(entries))
        let snapshot = ProtocolSnapshot(root: root.hash, objects: (Array(objects.values) + [root]).sorted { $0.hash < $1.hash })
        _ = try ProtocolObjectGraph.validate(snapshot)
        return snapshot
    }

    private func utf8(_ data: Data, name: String) throws -> String {
        guard let source = String(data: data, encoding: .utf8) else {
            throw ProtocolValidationError.invalidValue("\(name) is not UTF-8")
        }
        return source
    }

    private func resolveProfile(_ input: String) async throws -> String {
        let value = input.trimmingCharacters(in: .whitespacesAndNewlines)
        if TreeID.isWellFormed(value) { return value }
        // A profile URL at another host is the subject itself, its locator,
        // which the tree's host pins when it accepts the rule (locators §1).
        if let locator = ProfileLocator(value), locator.origin != wire.canonicalOrigin { return locator.locator }
        let path: String
        if value.hasPrefix("~") {
            path = "/\(value)"
        } else if let url = URL(string: value), url.scheme != nil {
            path = url.path
        } else {
            throw ProtocolValidationError.invalidValue("Enter a person or group Story URL, handle, or TreeID")
        }
        return try await wire.resolve(path: path).ref.tree
    }
}
