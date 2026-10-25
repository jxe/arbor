import StoryKit
import OverstoryObjectStore
import OverstoryWorkingTree
import Overstory
import Foundation

/// The directory (People 001): a private tree of the people and trees Story
/// has seen you with, mounted at `/~handle/directory` under your profile.
/// Story keeps it from code. Every fact is a new row with a fresh id, so two
/// devices writing with nobody at the keyboard never edit the same row.
public enum PersonalDirectory {
    /// The name the profile's `mounts.yaml` gives it.
    public static let mountName = "directory"
    public static let people = "/people"
    public static let trees = "/trees"

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
            guard create else { return nil }
            throw ProtocolValidationError.invalidValue("\(profilePath)/\(mountName) is already a page in your profile")
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

/// How Story saw a tie with someone: a `Tie` in the People collection.
public enum DirectoryTie: String, Sendable, CaseIterable {
    /// You invited them.
    case invited = "Invited"
    case invitedYou = "InvitedYou"
    /// You shared a tree with them.
    case shared = "Shared"
    case sharedWithYou = "SharedWithYou"
    /// You are in a group together; `tree` is the group.
    case group = "Group"
    /// You opened their profile.
    case opened = "Opened"
}

/// How you came to a tree: an `Arrival` in the Trees collection.
public enum DirectoryArrival: String, Sendable, CaseIterable {
    case opened = "Opened"
    case placed = "Placed"
    case sharedWithYou = "SharedWithYou"
    case followed = "Followed"
}

/// One tie with a person: a `Sighting` row.
public struct DirectorySighting: Sendable, Equatable {
    /// A profile id, or `contact:<key>` for a placeholder.
    public var person: String
    public var tie: DirectoryTie
    /// The card as seen then.
    public var name: String?
    public var handle: String?
    public var host: String?
    /// The tree the tie is about: the group, or the tree shared.
    public var tree: String?

    public init(person: String, tie: DirectoryTie, name: String? = nil, handle: String? = nil, host: String? = nil, tree: String? = nil) {
        self.person = person; self.tie = tie; self.name = name; self.handle = handle; self.host = host; self.tree = tree
    }
}

/// One arrival at a page: a `Visit` row.
public struct DirectoryVisit: Sendable, Equatable {
    public var tree: String
    public var path: String
    public var title: String?
    public var host: String?
    public var arrival: DirectoryArrival
    public var at: Date

    public init(tree: String, path: String, title: String? = nil, host: String? = nil, arrival: DirectoryArrival = .opened, at: Date = .now) {
        self.tree = tree; self.path = path; self.title = title; self.host = host; self.arrival = arrival; self.at = at
    }
}

extension RowEdit {
    /// A new row of `model`, keyed by a fresh id, with the non-nil `values`.
    static func directoryRow(_ model: String, _ values: [String: String?], at: Date) -> RowEdit {
        let id = UUID().uuidString.lowercased()
        var row: USLRow = ["id": .string(id)]
        for case let (name, value?) in values { row[name] = .string(value) }
        let time = ProtocolSourceOperation.rowTime(at)
        row["at"] = .string(time)
        return .create(table: model, row: rowKey(id), values: row, at: time)
    }

    /// A row's canonical stable key when it is keyed by `id`.
    static func rowKey(_ id: String) -> String {
        let data = try! JSONSerialization.data(withJSONObject: [["id", id]])
        return String(decoding: data, as: UTF8.self)
    }

    public static func directory(_ sighting: DirectorySighting, device: String?, at: Date = .now) -> RowEdit {
        directoryRow("Sighting", ["person": sighting.person, "kind": sighting.tie.rawValue, "name": sighting.name,
            "handle": sighting.handle, "host": sighting.host, "tree": sighting.tree, "device": device], at: at)
    }

    public static func directory(_ visit: DirectoryVisit, device: String?) -> RowEdit {
        directoryRow("Visit", ["tree": visit.tree, "path": visit.path, "title": visit.title, "host": visit.host,
            "how": visit.arrival.rawValue, "device": device], at: visit.at)
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
        guard let tree = try await PersonalDirectory.locate(client: client, handle: handle, create: mayCreate) else { return nil }
        let replica = stateRoot.appending(path: "WorkingTree", directoryHint: .isDirectory)
        let transport = ProtocolReplicaTransport(client: client)
        let marker = stateRoot.appending(path: "tree")
        let workingTree: WorkingTree
        if (try? String(contentsOf: marker, encoding: .utf8)) == tree.id,
           FileManager.default.fileExists(atPath: replica.appending(path: "materialized/tree.json").path) {
            workingTree = try await WorkingTree.open(at: replica, tree: TreeID(rawValue: tree.id), platform: HostObjectStore(client: client, tree: tree.id))
        } else {
            // A new directory, or another one than before: start afresh.
            try? FileManager.default.removeItem(at: stateRoot)
            try FileManager.default.createDirectory(at: stateRoot, withIntermediateDirectories: true)
            workingTree = try await WorkingTreePlacementService.place(tree: tree, at: replica, transport: transport,
                platform: HostObjectStore(client: client, tree: tree.id))
            try tree.id.write(to: marker, atomically: true, encoding: .utf8)
        }
        let coordinator = try UpdateCoordinator(workingTree: workingTree, transport: transport,
            stateRoot: stateRoot.appending(path: "Sync", directoryHint: .isDirectory), pollInterval: .seconds(60))
        let provider = WorkingTreeProvider(workingTree: workingTree, coordinator: coordinator)
        opened = (tree, coordinator, provider)
        _ = try? await coordinator.syncOnce()
        await flush()
        return tree
    }

    /// Record ties with people. A tie already in the directory (the same
    /// person, kind and tree) is not recorded again.
    public func record(_ sightings: [DirectorySighting]) async {
        var seen = Set(await knownSightings())
        for sighting in sightings {
            let key = Self.key(sighting.person, sighting.tie.rawValue, sighting.tree)
            guard seen.insert(key).inserted else { continue }
            waiting.append((PersonalDirectory.people, .directory(sighting, device: device)))
        }
        await flush()
    }

    /// Record arriving at pages; each page opened at most once an hour on this device.
    public func record(_ visits: [DirectoryVisit]) async {
        for visit in visits {
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

    private func knownSightings() async -> [String] {
        (await rows(PersonalDirectory.people, model: "Sighting")).compactMap { row in
            guard let person = row["person"]?.stringValue, let kind = row["kind"]?.stringValue else { return nil }
            return Self.key(person, kind, row["tree"]?.stringValue)
        } + waiting.compactMap { pending in
            guard case let .create(table, _, values, _) = pending.edit, table == "Sighting",
                  let person = values["person"]?.stringValue, let kind = values["kind"]?.stringValue else { return nil }
            return Self.key(person, kind, values["tree"]?.stringValue)
        }
    }

    private static func key(_ person: String, _ kind: String, _ tree: String?) -> String {
        [person, kind, tree ?? ""].joined(separator: "\0")
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
