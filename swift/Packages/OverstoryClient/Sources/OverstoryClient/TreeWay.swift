import Foundation

/// The three ways an app holds a tree (Clients 003), chosen from facts about
/// the tree and this device rather than by which screen opened it.
public enum TreeWay: String, Sendable, CaseIterable, Codable {
    /// Opened pages from the host, nothing kept, read-only.
    case browse
    /// The whole tree kept on disk and synced with the host.
    case replica
    /// Story Sync keeps the tree in a folder here; the app reads its folder
    /// and loopback and keeps only a change log.
    case alongsideStorySync = "alongside"

    /// What the choice is made from.
    public struct Facts: Sendable, Equatable {
        /// Story Sync is running and has placed this tree in a folder here.
        public var placedWithStorySync: Bool
        /// The person may change the tree.
        public var canWrite: Bool
        /// Free space on the volume a replica would use; nil when unknown.
        public var freeDiskBytes: Int64?
        /// About how much a replica of the tree takes; nil when unknown
        /// (before it has ever been fetched here).
        public var treeBytes: Int64?
        /// The person's choice for this tree, honored when it can work.
        public var override: TreeWay?

        public init(placedWithStorySync: Bool, canWrite: Bool, freeDiskBytes: Int64? = nil, treeBytes: Int64? = nil, override: TreeWay? = nil) {
            self.placedWithStorySync = placedWithStorySync
            self.canWrite = canWrite
            self.freeDiskBytes = freeDiskBytes
            self.treeBytes = treeBytes
            self.override = override
        }
    }

    /// Space a replica must leave free on its volume.
    public static let diskReserve: Int64 = 1 << 30

    /// The way to hold a tree with `facts`:
    /// - an override, when it can work (Alongside needs the tree placed with
    ///   Story Sync running; a replica needs room);
    /// - Alongside Story Sync when the tree is placed here and Story Sync runs;
    /// - otherwise a replica for a tree the person can change and that fits;
    /// - otherwise Browse.
    public static func choose(_ facts: Facts) -> TreeWay {
        if let chosen = facts.override, works(chosen, facts) { return chosen }
        if facts.placedWithStorySync { return .alongsideStorySync }
        if facts.canWrite, works(.replica, facts) { return .replica }
        return .browse
    }

    /// Whether `way` can hold a tree with `facts`.
    public static func works(_ way: TreeWay, _ facts: Facts) -> Bool {
        switch way {
        case .browse: true
        case .alongsideStorySync: facts.placedWithStorySync
        case .replica: fits(facts)
        }
    }

    /// Whether a replica fits: twice the tree (objects and the index beside
    /// them) plus the reserve. An unknown size or free space is assumed to fit.
    static func fits(_ facts: Facts) -> Bool {
        guard let free = facts.freeDiskBytes else { return true }
        return free >= (facts.treeBytes ?? 0) * 2 + diskReserve
    }
}
