import Foundation

/// One recovered journal record: an opaque token the store uses to remove it,
/// and the encoded intent.
public struct WorkingTreeJournalRecord: Sendable, Equatable {
    public var token: String
    public var data: Data

    public init(token: String, data: Data) {
        self.token = token
        self.data = data
    }
}

/// Where a working tree keeps its own records: the node index (state), the
/// heads (control), the mutation journal, and the rebuildable search index.
/// Object bytes are not the store's business; they live in an `ObjectOverlay`.
///
/// Every value is an opaque encoded blob so the seam is the same on disk (iOS)
/// and in memory (Mac, tests). The `WorkingTree` actor serializes all access.
public protocol WorkingTreeStateStore: Sendable {
    var hasState: Bool { get }
    func readState() throws -> Data
    func writeState(_ data: Data) throws

    var hasControl: Bool { get }
    func readControl() throws -> Data
    func writeControl(_ data: Data) throws

    /// `nil` when no index has been written or it cannot be read.
    func readIndex() -> Data?
    func writeIndex(_ data: Data) throws
    func removeIndexes() throws

    /// Durably record an intent before it is applied. Returns the record's token.
    func writeJournal(pageKey: String, id: String, _ data: Data) throws -> String
    /// Every journal record, in a stable order.
    func journalRecords() throws -> [WorkingTreeJournalRecord]
    func removeJournal(token: String) throws

    /// False for a store that keeps nothing, so the tree skips encoding
    /// what it would write.
    var keepsWrites: Bool { get }
}

extension WorkingTreeStateStore {
    public var keepsWrites: Bool { true }
}

/// The store of a disposable fork: a view that lives only in memory and is
/// never reloaded, so nothing it would write is kept, and the fork does no
/// whole-tree encoding on each change (its search index is built on first
/// use instead).
final class DisposableWorkingTreeStore: WorkingTreeStateStore, @unchecked Sendable {
    var keepsWrites: Bool { false }
    var hasState: Bool { false }
    func readState() throws -> Data { throw WorkingTreeError.corruptState("A disposable fork keeps no state") }
    func writeState(_ data: Data) throws {}
    var hasControl: Bool { false }
    func readControl() throws -> Data { throw WorkingTreeError.corruptState("A disposable fork keeps no control") }
    func writeControl(_ data: Data) throws {}
    func readIndex() -> Data? { nil }
    func writeIndex(_ data: Data) throws {}
    func removeIndexes() throws {}
    func writeJournal(pageKey: String, id: String, _ data: Data) throws -> String { "" }
    func journalRecords() throws -> [WorkingTreeJournalRecord] { [] }
    func removeJournal(token: String) throws {}
}

/// Dictionary-backed store for working trees that keep nothing on disk. A
/// process that exits loses the tree; durability for such trees is the
/// coordinator's update control and the platform object store.
public final class InMemoryWorkingTreeStore: WorkingTreeStateStore, @unchecked Sendable {
    private let lock = NSLock()
    private var state: Data?
    private var control: Data?
    private var index: Data?
    private var journal: [String: Data] = [:]

    public init() {}

    public var hasState: Bool { lock.withLock { state != nil } }

    public func readState() throws -> Data {
        try lock.withLock {
            guard let state else { throw WorkingTreeError.corruptState("No working tree state") }
            return state
        }
    }

    public func writeState(_ data: Data) throws { lock.withLock { state = data } }

    public var hasControl: Bool { lock.withLock { control != nil } }

    public func readControl() throws -> Data {
        try lock.withLock {
            guard let control else { throw WorkingTreeError.corruptState("No working tree control") }
            return control
        }
    }

    public func writeControl(_ data: Data) throws { lock.withLock { control = data } }

    public func readIndex() -> Data? { lock.withLock { index } }
    public func writeIndex(_ data: Data) throws { lock.withLock { index = data } }
    public func removeIndexes() throws { lock.withLock { index = nil } }

    public func writeJournal(pageKey: String, id: String, _ data: Data) throws -> String {
        let token = "\(pageKey)/\(id)"
        lock.withLock { journal[token] = data }
        return token
    }

    public func journalRecords() throws -> [WorkingTreeJournalRecord] {
        lock.withLock {
            journal.keys.sorted().map { WorkingTreeJournalRecord(token: $0, data: journal[$0]!) }
        }
    }

    public func removeJournal(token: String) throws {
        lock.withLock { _ = journal.removeValue(forKey: token) }
    }
}
