import StoryKit
import OverstoryObjectStore
import OverstoryWorkingTree
import Overstory
import Foundation

/// The directory (People 001): a private tree of the people and trees Story
/// has seen you with, mounted at `/~handle/directory` under your profile.
/// Story keeps it from code. A fact is a row keyed by the fact (a tie, a
/// tree) or a new row with a fresh id (a visit), so two devices writing with
/// nobody at the keyboard never set the same field to different values.
public enum PersonalDirectory {
    /// The name the profile's `mounts.yaml` gives it.
    public static let mountName = "directory"
    public static let people = "/people"
    public static let trees = "/trees"
    /// The seed this Story makes directories from; an older one is replaced.
    public static var seedVersion: Int { PersonalDirectorySeed.version }

    /// The tree's first snapshot: `_index.md` and the empty People and Trees
    /// collections, made by `tools/directory-seed.ts` because Story does not
    /// encode collection tables.
    public static func seed() throws -> ProtocolSnapshot {
        let objects = try PersonalDirectorySeed.objects.map { object in
            guard let bytes = Data(base64Encoded: object.base64) else {
                throw ProtocolValidationError.invalidValue("Directory seed object \(object.hash) is not base64")
            }
            return ProtocolObjectEnvelope(hash: object.hash, bytes: bytes)
        }
        let snapshot = ProtocolSnapshot(root: PersonalDirectorySeed.root, objects: objects)
        _ = try ProtocolObjectGraph.validate(snapshot)
        return snapshot
    }

    /// The directory under the profile at `/~handle`, or nil when there is
    /// none and `create` is false. Creating declares a tree only its profile
    /// administers, mounts it, and activates it with `seed()`; a device that
    /// may not administer the profile fails and leaves it to one that can.
    public static func locate(client: ProtocolClient, handle: String, create: Bool) async throws -> ProtocolTreeDescriptor? {
        let profilePath = "/~\(handle)"
        let profile = try await client.resolve(path: profilePath).ref.tree
        do {
            let resolved = try await client.resolve(path: "\(profilePath)/\(mountName)")
            // A page named `directory` in the profile is not the directory.
            if resolved.ref.path == "/", resolved.ref.tree != profile {
                return try await client.descriptor(tree: resolved.ref.tree).tree
            }
            // Resolving answers for a path that names nothing too, inside the
            // tree that would hold it; only an entry there is in the way.
            var taken = resolved.ref.tree != profile
            if !taken {
                guard case let .directory(entries, _) = try ProtocolObjectCodec.decode(
                    try await client.object(tree: profile, hash: resolved.enclosingTree.root), kind: .directory)
                else { throw ProtocolValidationError.invalidValue("\(profilePath) has no root directory") }
                taken = entries.contains { $0.name == mountName || $0.name == "\(mountName).md" }
            }
            if taken {
                guard create else { return nil }
                throw ProtocolValidationError.invalidValue("\(profilePath)/\(mountName) is already a page in your profile")
            }
            guard create else { return nil }
        } catch let error as ProtocolHTTPError where error.status == 404 {
            guard create else { return nil }
        }
        let tree = try generateOverstoryID(prefix: "tr")
        do {
            try await TreeConfigurationClient(wire: client).declareAndMount(tree: tree, rules: [], parent: profile, name: mountName)
        } catch {
            // Another device made it first.
            if let made = try? await locate(client: client, handle: handle, create: false) { return made }
            throw error
        }
        _ = try await client.activateTree(tree, snapshot: try seed())
        return try await client.descriptor(tree: tree).tree
    }
}

/// How Story knows someone: a `TieKind` in the People collection.
public enum DirectoryTieKind: String, Sendable, CaseIterable {
    /// You are in a host community together; `group` is its profile.
    case community = "Community"
    /// You are in a group together; `group` is the group.
    case group = "Group"
    /// You shared a tree with them.
    case shared = "Shared"
    case sharedWithYou = "SharedWithYou"
    /// You invited them.
    case invited = "Invited"
    case invitedYou = "InvitedYou"
    /// You opened their profile.
    case opened = "Opened"
}

/// One fact about knowing someone: a `Tie` row, keyed by the fact itself so
/// that two devices seeing it make one row.
public struct DirectoryTie: Sendable, Equatable {
    /// A profile id, or `contact:<key>` for a placeholder.
    public var person: String
    public var kind: DirectoryTieKind
    /// The group or community, for those kinds.
    public var group: String?
    /// The card as seen then.
    public var name: String?
    public var handle: String?
    public var host: String?

    public init(person: String, kind: DirectoryTieKind, group: String? = nil, name: String? = nil, handle: String? = nil, host: String? = nil) {
        self.person = person; self.kind = kind; self.group = group; self.name = name; self.handle = handle; self.host = host
    }

    /// The row's id: the fact.
    public var id: String { [kind.rawValue, person, group].compactMap { $0 }.joined(separator: "-") }
}

/// How you came to a tree: an `Arrival` in the Trees collection.
public enum DirectoryArrival: String, Sendable, CaseIterable {
    case opened = "Opened"
    case placed = "Placed"
    case sharedWithYou = "SharedWithYou"
    case followed = "Followed"
}

/// One arrival at a page: a `Visit` row, and the tree's `Tree` row the
/// first time Story sees the tree.
public struct DirectoryVisit: Sendable, Equatable {
    public var tree: String
    public var path: String
    public var title: String?
    /// The tree's own title, for its `Tree` row.
    public var treeTitle: String?
    public var host: String?
    /// The host community's profile.
    public var canopy: String?
    public var arrival: DirectoryArrival
    public var at: Date

    public init(tree: String, path: String, title: String? = nil, treeTitle: String? = nil, host: String? = nil, canopy: String? = nil,
                arrival: DirectoryArrival = .opened, at: Date = .now) {
        self.tree = tree; self.path = path; self.title = title; self.treeTitle = treeTitle; self.host = host; self.canopy = canopy
        self.arrival = arrival; self.at = at
    }
}

extension RowEdit {
    /// A new row of `model` keyed by `id`, with the non-nil `values`.
    static func directoryRow(_ model: String, id: String, _ values: [String: String?], at: Date) -> RowEdit {
        var row: USLRow = ["id": .string(id)]
        for case let (name, value?) in values { row[name] = .string(value) }
        return .create(table: model, row: rowKey(id), values: row, at: ProtocolSourceOperation.rowTime(at))
    }

    /// A row's canonical stable key when it is keyed by `id`.
    static func rowKey(_ id: String) -> String {
        let data = try! JSONSerialization.data(withJSONObject: [["id", id]])
        return String(decoding: data, as: UTF8.self)
    }

    public static func directory(_ tie: DirectoryTie, at: Date = .now) -> RowEdit {
        directoryRow("Tie", id: tie.id, ["person": tie.person, "group": tie.group, "kind": tie.kind.rawValue,
            "name": tie.name, "handle": tie.handle, "host": tie.host], at: at)
    }

    /// A visit, a new row with a fresh id.
    public static func directory(_ visit: DirectoryVisit, device: String?) -> RowEdit {
        let time = ProtocolSourceOperation.rowTime(visit.at)
        return directoryRow("Visit", id: UUID().uuidString.lowercased(), ["tree": visit.tree, "path": visit.path, "title": visit.title,
            "how": visit.arrival.rawValue, "device": device, "at": time], at: visit.at)
    }

    /// The tree's row, keyed by its TreeID.
    public static func directoryTree(_ visit: DirectoryVisit) -> RowEdit {
        directoryRow("Tree", id: visit.tree, ["canopy": visit.canopy, "title": visit.treeTitle, "host": visit.host], at: visit.at)
    }
}

/// Keeps the directory open in the background and adds rows to it, while
/// the person works in other trees. It holds its own replica of the tree, so
/// opening the directory in a window never shares a working tree with it.
/// Rows recorded before it opens wait in memory and go once it has.
public actor PersonalDirectoryKeeper {
    private let client: ProtocolClient
    private let handle: String
    private let stateRoot: URL
    private let device: String?
    private let mayCreate: Bool
    private var opened: (tree: ProtocolTreeDescriptor, coordinator: UpdateCoordinator, provider: WorkingTreeProvider)?
    private var waiting: [(collection: String, edit: RowEdit)] = []
    /// When this device last recorded each page, so a page read all morning is one visit an hour.
    private var lastVisit: [String: Date] = [:]
    public static let visitSpacing: TimeInterval = 3600

    /// `stateRoot` holds the replica and its sync state. `device` is this
    /// device's label for the rows it writes.
    public init(client: ProtocolClient, handle: String, stateRoot: URL, device: String?, mayCreate: Bool) {
        self.client = client; self.handle = handle; self.stateRoot = stateRoot; self.device = device; self.mayCreate = mayCreate
    }

    public var tree: ProtocolTreeDescriptor? { opened?.tree }

    /// Find or make the directory, open its replica, and send what waited.
    /// Returns nil when there is none and this device may not make it.
    @discardableResult
    public func open() async throws -> ProtocolTreeDescriptor? {
        if let opened { return opened.tree }
        guard var tree = try await PersonalDirectory.locate(client: client, handle: handle, create: mayCreate) else { return nil }
        if try await seedVersion(of: tree) < PersonalDirectorySeed.version, mayCreate {
            tree = try await replaceWithSeed(tree)
        }
        let replica = stateRoot.appending(path: "WorkingTree", directoryHint: .isDirectory)
        let transport = ProtocolReplicaTransport(client: client)
        let marker = stateRoot.appending(path: "tree")
        let placed = "\(tree.id) \(PersonalDirectorySeed.version)"
        let workingTree: WorkingTree
        if (try? String(contentsOf: marker, encoding: .utf8)) == placed,
           FileManager.default.fileExists(atPath: replica.appending(path: "materialized/tree.json").path) {
            workingTree = try await WorkingTree.open(at: replica, tree: TreeID(rawValue: tree.id), platform: HostObjectStore(client: client, tree: tree.id))
        } else {
            // A new directory, another one than before, or one replaced from
            // a newer seed: start afresh, dropping rows queued for the old one.
            try? FileManager.default.removeItem(at: stateRoot)
            try FileManager.default.createDirectory(at: stateRoot, withIntermediateDirectories: true)
            workingTree = try await WorkingTreePlacementService.place(tree: tree, at: replica, transport: transport,
                platform: HostObjectStore(client: client, tree: tree.id))
            try placed.write(to: marker, atomically: true, encoding: .utf8)
        }
        let coordinator = try UpdateCoordinator(workingTree: workingTree, transport: transport,
            stateRoot: stateRoot.appending(path: "Sync", directoryHint: .isDirectory), pollInterval: .seconds(60))
        let provider = WorkingTreeProvider(workingTree: workingTree, coordinator: coordinator)
        opened = (tree, coordinator, provider)
        _ = try? await coordinator.syncOnce()
        await flush()
        return tree
    }

    /// The `_version` of the seed the directory was made from; 1 before seeds had one.
    private func seedVersion(of tree: ProtocolTreeDescriptor) async throws -> Int {
        guard case let .directory(entries, _) = try ProtocolObjectCodec.decode(try await client.object(tree: tree.id, hash: tree.root), kind: .directory),
              let file = entries.first(where: { $0.name == "_version" })?.file else { return 1 }
        let text = String(decoding: try await client.object(tree: tree.id, hash: file), as: UTF8.self)
        return Int(text.trimmingCharacters(in: .whitespacesAndNewlines)) ?? 1
    }

    /// Until the directory has migrations, one made from an older seed is
    /// replaced by the current seed. Story rewrites what it recorded: ties
    /// on the next refresh, visits as pages are opened.
    private func replaceWithSeed(_ tree: ProtocolTreeDescriptor) async throws -> ProtocolTreeDescriptor {
        let prepared = try await client.prepareUpdate(tree: tree.id, base: ProtocolUpdateBase(root: tree.root, update: tree.update),
            snapshot: try PersonalDirectory.seed(), ifCurrent: tree.update)
        _ = try await client.submitUpdate(prepared)
        return try await client.descriptor(tree: tree.id).tree
    }

    /// Record ties with people. One already in the directory is skipped.
    public func record(_ ties: [DirectoryTie]) async {
        var seen = Set(await rows(PersonalDirectory.people, model: "Tie").compactMap { $0["id"]?.stringValue })
        seen.formUnion(waitingIDs("Tie"))
        for tie in ties where seen.insert(tie.id).inserted {
            waiting.append((PersonalDirectory.people, .directory(tie)))
        }
        await flush()
    }

    /// Record arriving at pages; each page opened at most once an hour on this device.
    /// A tree's row gets the canopy and title it lacked when a visit knows them.
    public func record(_ visits: [DirectoryVisit]) async {
        await note(visits, visiting: true)
    }

    /// Record trees you have without arriving anywhere, such as your profile
    /// and the groups you run: their `Tree` rows only.
    public func record(trees: [DirectoryVisit]) async {
        await note(trees, visiting: false)
    }

    private func note(_ visits: [DirectoryVisit], visiting: Bool) async {
        var known = Dictionary(await rows(PersonalDirectory.trees, model: "Tree").compactMap { row in
            row["id"]?.stringValue.map { ($0, row) }
        }, uniquingKeysWith: { first, _ in first })
        for id in waitingIDs("Tree") where known[id] == nil { known[id] = [:] }
        for visit in visits {
            if let row = known[visit.tree] {
                var filled = row
                for (field, value) in [("canopy", visit.canopy), ("title", visit.treeTitle)] {
                    let before = row[field] ?? .null
                    guard let value, !value.isEmpty, before == .null || before == .string(""), !row.isEmpty else { continue }
                    waiting.append((PersonalDirectory.trees, .set(table: "Tree", row: RowEdit.rowKey(visit.tree), field: field,
                        before: before, value: .string(value), at: ProtocolSourceOperation.rowTime(visit.at))))
                    filled[field] = .string(value)
                }
                known[visit.tree] = filled
            } else {
                waiting.append((PersonalDirectory.trees, .directoryTree(visit)))
                // Queued, not yet in the rows: nothing to fill in for it.
                known[visit.tree] = [:]
            }
            guard visiting else { continue }
            let key = visit.tree + "\0" + visit.path
            if visit.arrival == .opened, let last = lastVisit[key], abs(visit.at.timeIntervalSince(last)) < Self.visitSpacing { continue }
            lastVisit[key] = visit.at
            waiting.append((PersonalDirectory.trees, .directory(visit, device: device)))
        }
        await flush()
    }

    /// Rows already written: from the replica and the queue.
    public func rows(_ collection: String, model: String) async -> [USLRow] {
        guard let opened else { return [] }
        let reference = WorkspaceReference(tree: TreeID(rawValue: opened.tree.id), path: collection)
        return (try? await opened.provider.collectionRows(reference).rows[model]) ?? []
    }

    /// Why the host refused the last rows, if it did.
    public func refused() async -> String? {
        await opened?.coordinator.refusedRowEdits()
    }

    public func close() async {
        await opened?.coordinator.close()
        opened = nil
    }

    private func waitingIDs(_ model: String) -> [String] {
        waiting.compactMap { pending in
            guard case let .create(table, _, values, _) = pending.edit, table == model else { return nil }
            return values["id"]?.stringValue
        }
    }

    private func flush() async {
        guard let opened, !waiting.isEmpty else { return }
        let batch = waiting
        waiting = []
        let reference = { (path: String) in WorkspaceReference(tree: TreeID(rawValue: opened.tree.id), path: path) }
        for collection in [PersonalDirectory.people, PersonalDirectory.trees] {
            let edits = batch.filter { $0.collection == collection }.map(\.edit)
            guard !edits.isEmpty else { continue }
            do { try await opened.provider.appendRowEdits(edits, to: reference(collection)) }
            catch { waiting += batch.filter { $0.collection == collection } }
        }
    }
}
