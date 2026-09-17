import ArborKit
import ArborObjectStore
import ArborWire
import Foundation

/// A local publication dependency. Equal roots never identify a predecessor.
public enum SourceAdmissionBasis: Codable, Equatable, Sendable {
    case accepted(WireUpdateBase)
    case authored(change: String)
}

/// One immutable source admission. Construction is separate from persistence so
/// a failed/uncertain write is retried with the same change and operation identities.
public struct SourceAdmissionRecord: Codable, Equatable, Sendable {
    public let change: String
    public let tree: String
    public let basis: SourceAdmissionBasis
    public let graph: WireSnapshot
    public let sourcePath: String?
    public let intent: WorkspaceDocumentIntent?
    public let candidate: WireSnapshot
    public let update: WireCandidateUpdate
    public var entryTransfer: EntryTransfer?
    public var entryActions: EntryActions?
    var localTrash: WorkingTreeLocalTrash?

    public init(change: String = UUID().uuidString, tree: String, basis: SourceAdmissionBasis,
                graph: WireSnapshot, sourcePath: String, intent: WorkspaceDocumentIntent) throws {
        try intent.validate()
        guard intent.basis.reference.tree.rawValue == tree else { throw Self.invalid("Wrong tree") }
        let parts = sourcePath.dropFirst().split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        guard sourcePath.hasPrefix("/"), !parts.isEmpty,
              parts.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." && !$0.contains("\\") && !$0.contains("\0") && Data($0.utf8) == Data($0.precomposedStringWithCanonicalMapping.utf8) }),
              !intent.patch.edits.isEmpty else { throw Self.invalid("Invalid source path or empty intent") }
        guard Set(graph.objects.map(\.hash)).count == graph.objects.count else { throw Self.invalid("Duplicate basis object") }
        let decoded = try WireObjectGraph.validate(graph, mode: .sparseFiles)
        var bytes = Dictionary(uniqueKeysWithValues: graph.objects.map { ($0.hash, $0.bytes) })
        var file: String?
        func store(_ object: WireObject) throws -> String {
            let value = try WireObjectCodec.encode(object), hash = WireObjectCodec.hash(value)
            bytes[hash] = value
            return hash
        }
        func replace(_ hash: String, _ depth: Int) throws -> String {
            guard case let .directory(originalEntries, descriptor)? = decoded[hash] else { throw Self.invalid("Source path is not in basis") }
            var entries = originalEntries
            // A directory without a stored body has empty source. Its first save
            // creates material, so publish a snapshot rather than editSource with
            // a fabricated empty-file identity.
            if depth == parts.count - 1, parts[depth] == "_index.md",
               !entries.contains(where: { $0.name == parts[depth] }), intent.basis.source.isEmpty {
                entries.append(WireDirectoryEntry(name: parts[depth], file: try store(.file(Data(intent.source.utf8)))))
                entries.sort { Array($0.name.utf8).lexicographicallyPrecedes(Array($1.name.utf8)) }
                return try store(.directory(entries, childrenSource: descriptor))
            }
            guard let index = entries.firstIndex(where: { $0.name == parts[depth] }) else { throw Self.invalid("Source path is not in basis") }
            if depth == parts.count - 1 {
                guard let source = entries[index].file, case let .file(value)? = decoded[source],
                      value == Data(intent.basis.source.utf8) else { throw Self.invalid("Source bytes do not match basis") }
                file = source
                entries[index].file = try store(.file(Data(intent.source.utf8)))
            } else {
                guard let directory = entries[index].directory else { throw Self.invalid("Source path crosses a file or tree boundary") }
                entries[index].directory = try replace(directory, depth + 1)
            }
            return try store(.directory(entries, childrenSource: descriptor))
        }
        let root = try replace(graph.root, 0)
        var reachable = Set<String>()
        func visit(_ hash: String, _ kind: WireEntryKind) throws {
            guard reachable.insert(hash).inserted, let value = bytes[hash] else { return }
            if case let .directory(entries, _) = try WireObjectCodec.decode(value, kind: kind) {
                for entry in entries { if let child = entry.hash, let kind = entry.kind { try visit(child, kind) } }
            }
        }
        try visit(root, .directory)
        let candidate = WireSnapshot(root: root, objects: reachable.sorted().compactMap { hash in bytes[hash].map { WireObjectEnvelope(hash: hash, bytes: $0) } })
        _ = try WireObjectGraph.validate(candidate, mode: .sparseFiles)
        let operations = try intent.patch.edits.enumerated().compactMap { index, edit -> WireSourceOperation? in
            // Byte-valid output alone does not prove scalar-aligned selection.
            let source = Array(intent.basis.source.utf8)
            for offset in [edit.utf8Range.lowerBound, edit.utf8Range.upperBound] {
                if offset < source.count && source[offset] & 0xc0 == 0x80 { throw Self.invalid("Source range splits a UTF-8 scalar") }
            }
            guard let file else { return nil }
            var fields: [String: WireSemanticValue] = [
                "key": .string("edit-\(index)"), "kind": .string("editSource"),
                "source": .object(["material": .object(["kind": .string("basis"), "path": .string(sourcePath), "object": .string(file)]),
                                   "range": .array([.integer(edit.utf8Range.lowerBound), .integer(edit.utf8Range.upperBound)])]),
                "text": .string(edit.replacement)
            ]
            if let lineage = edit.lineage {
                fields["lineage"] = .array(lineage.map { part in .object([
                    "source": .object(["material": .object(["kind": .string("basis"), "path": .string(sourcePath), "object": .string(file)]),
                                       "range": .array([.integer(part.source.lowerBound), .integer(part.source.upperBound)])]),
                    "range": .array([.integer(part.replacement.lowerBound), .integer(part.replacement.upperBound)])
                ]) })
            }
            return try WireSourceOperation(fields)
        }
        let known = Set(graph.objects.map(\.hash))
        let update = WireCandidateUpdate(candidate: root, change: change, operations: file == nil ? nil : operations,
                                         objects: candidate.objects.filter { !known.contains($0.hash) })
        // Validate the complete Wire grammar, including change and operation identities.
        _ = try JSONEncoder().encode(update)
        self.change = change; self.tree = tree; self.basis = basis
        self.graph = WireSnapshot(root: graph.root, objects: graph.objects.sorted { $0.hash < $1.hash })
        self.sourcePath = sourcePath; self.intent = intent; self.candidate = candidate; self.update = update
    }

    /// Structural actions retain captured operations when available, otherwise
    /// genuine snapshot semantics. Never infer provenance from resulting bytes.
    public init(change: String = UUID().uuidString, tree: String, basis: SourceAdmissionBasis,
                graph: WireSnapshot, candidate: WireSnapshot, entryTransfer: EntryTransfer? = nil, entryActions: EntryActions? = nil) throws {
        _ = try WireObjectGraph.validate(graph, mode: .sparseFiles)
        _ = try WireObjectGraph.validate(candidate, mode: .sparseFiles)
        guard Set(graph.objects.map(\.hash)).count == graph.objects.count,
              Set(candidate.objects.map(\.hash)).count == candidate.objects.count else { throw Self.invalid("Duplicate snapshot object") }
        self.change = change; self.tree = tree; self.basis = basis
        self.graph = WireSnapshot(root: graph.root, objects: graph.objects.sorted { $0.hash < $1.hash })
        self.candidate = WireSnapshot(root: candidate.root, objects: candidate.objects.sorted { $0.hash < $1.hash })
        self.sourcePath = nil; self.intent = nil
        guard entryTransfer == nil || entryActions == nil else { throw Self.invalid("Multiple entry intent representations") }
        self.entryTransfer = entryTransfer; self.entryActions = entryActions
        let prepared = try entryActions?.prepare(graph:graph, candidate:candidate, changeID:change) ?? entryTransfer?.prepare(graph:graph, candidate:candidate, changeID:change)
        if let prepared, prepared.candidate.root != candidate.root { throw Self.invalid("Entry intent does not reproduce candidate") }
        let known = Set(graph.objects.map(\.hash))
        self.update = WireCandidateUpdate(candidate: candidate.root, change: change, operations: prepared?.operations,
                                          objects: self.candidate.objects.filter { !known.contains($0.hash) })
        _ = try JSONEncoder().encode(update)
    }

    public func validate() throws {
        var rebuilt: Self
        if let intent, let sourcePath {
            rebuilt = try Self(change: change, tree: tree, basis: basis, graph: graph, sourcePath: sourcePath, intent: intent)
        } else {
            guard intent == nil, sourcePath == nil else { throw Self.invalid("Incomplete source intent") }
            rebuilt = try Self(change: change, tree: tree, basis: basis, graph: graph, candidate: candidate, entryTransfer: entryTransfer, entryActions: entryActions)
        }
        try localTrash?.validate()
        rebuilt.localTrash = localTrash
        guard rebuilt == self else { throw Self.invalid("Retained source candidate or operations changed") }
    }

    private static func invalid(_ message: String) -> ArborWireValidationError { .invalidValue(message) }
}

/// Client-owned durable intent, independent of the legacy head/rejection file.
/// This queue prepares requests but never enables operation emission itself.
private struct StoredSourceSnapshot: Codable {
    var root: String
    var objects: [String]
}

private struct StoredSourceTrash: Codable {
    var nodes: [WorkingTreeNode]
    var objects: [String]
}

private struct StoredSourceAdmission: Codable {
    var change: String
    var tree: String
    var basis: SourceAdmissionBasis
    var graph: StoredSourceSnapshot
    var sourcePath: String?
    var intent: WorkspaceDocumentIntent?
    var candidate: StoredSourceSnapshot
    var update: WireCandidateUpdate
    var updateObjects: [String]
    var localTrash: StoredSourceTrash?
    var entryTransfer: EntryTransfer?
    var entryActions: EntryActions?
}

private struct SourceAdmissionJournal: Codable {
    static let currentSchema = 2
    var schema = currentSchema
    var tree: String
    var records: [StoredSourceAdmission]
}

private struct SourceAdmissionFingerprint: Equatable {
    var size: UInt64
    var modified: TimeInterval
    var inode: UInt64
}

public actor SourceAdmissionQueue {
    private let tree: String
    private let files: UpdateControlFiles
    private let objects: DirectoryObjectStore
    /// The platform's durable accepted-object store. When present, the queue
    /// owns only objects introduced by its admissions and resolves the rest by
    /// hash through this shared API.
    private let platform: (any ObjectStore)?
    private var records: [SourceAdmissionRecord]
    private var fingerprint: SourceAdmissionFingerprint?
    private var objectCache: [String: Data] = [:]

    public init(
        tree: String,
        stateRoot: URL,
        platform: (any ObjectStore)? = nil,
        settled: Set<String> = []
    ) async throws {
        self.tree = tree
        files = try UpdateControlFiles(root: stateRoot)
        objects = try DirectoryObjectStore(directory: files.directory.appending(path: "source-admission-objects", directoryHint: .isDirectory))
        self.platform = platform
        records = []
        let loaded = try await load(settled: settled)
        records = loaded.records
        objectCache = loaded.objects
        fingerprint = try currentFingerprint()
    }

    public func retained() async throws -> [SourceAdmissionRecord] {
        try await reloadIfChanged()
        return records
    }

    /// Acknowledges only after the complete record and its basis are fsynced.
    public func retain(_ record: SourceAdmissionRecord) async throws {
        while true {
            // Resolve platform objects before locking. Actor reentrancy must
            // never leave another call synchronously waiting on our own flock.
            try await reloadIfChanged()
            let expected = fingerprint
            let descriptor = try files.lockSourceAdmissions()
            do {
                guard try currentFingerprint() == expected else {
                    files.unlockSourceAdmissions(descriptor)
                    continue
                }
                if let prior = records.first(where: { $0.change == record.change }) {
                    guard prior == record else { throw ArborWireValidationError.invalidValue("Authored identity was reused") }
                    // A prior rename may have succeeded before its directory sync failed.
                    try persist(records)
                    files.unlockSourceAdmissions(descriptor)
                    return
                }
                let next = records + [record]
                try Self.validate(next, tree: tree)
                try persist(next)
                files.unlockSourceAdmissions(descriptor)
                return
            } catch {
                files.unlockSourceAdmissions(descriptor)
                throw error
            }
        }
    }

    /// Drop settled records that no pending authored descendant still needs.
    /// Object collection follows the journal rename, so a crash can leak cache
    /// bytes but can never strand retained intent without its basis.
    @discardableResult
    public func compact(settled: Set<String>, preservingSettledTail: Bool = true) async throws -> Bool {
        while true {
            try await reloadIfChanged()
            let expected = fingerprint
            let descriptor = try files.lockSourceAdmissions()
            do {
                guard try currentFingerprint() == expected else {
                    files.unlockSourceAdmissions(descriptor)
                    continue
                }
                var required = Set(records.filter { !settled.contains($0.change) }.map(\.change))
                // An open editor may still name the latest local revision after
                // its projection settled (including a hidden candidate). Keep
                // that replay chain until process restart proves no live view.
                if preservingSettledTail, required.isEmpty, let latest = records.last {
                    required.insert(latest.change)
                }
                var changed = true
                while changed {
                    changed = false
                    for record in records where required.contains(record.change) {
                        if case let .authored(parent) = record.basis, required.insert(parent).inserted { changed = true }
                    }
                }
                let next = records.filter { required.contains($0.change) }
                if next.count != records.count { try persist(next) }
                let empty = records.isEmpty
                files.unlockSourceAdmissions(descriptor)
                return empty
            } catch {
                files.unlockSourceAdmissions(descriptor)
                throw error
            }
        }
    }

    /// Replays the original candidate chain, including an already accepted prefix.
    /// A selected peer projection never becomes a substitute for a local predecessor.
    public func request(through change: String) async throws -> (base: WireUpdateBase, request: WireUpdateRequest) {
        try await reloadIfChanged()
        var current = change, updates: [WireCandidateUpdate] = []
        while let record = records.first(where: { $0.change == current }) {
            updates.insert(record.update, at: 0)
            switch record.basis {
            case let .accepted(base): return (base, WireUpdateRequest(base: base.update, updates: updates))
            case let .authored(parent): current = parent
            }
        }
        throw ArborWireValidationError.invalidValue("Missing authored dependency")
    }

    private func load(settled: Set<String> = []) async throws -> (records: [SourceAdmissionRecord], objects: [String: Data]) {
        guard let data = try files.readSourceAdmissionsData() else { return ([], [:]) }
        // The installed iOS journal predates hash-only storage and can be
        // hundreds of megabytes. If durable control says every top-level
        // change settled, scan only its identities and retire it without
        // constructing the embedded snapshots in memory.
        if Self.isFullySettledLegacyJournal(data, settled: settled) {
            try writeJournal([])
            try objects.retain(reachableFrom: [], files: [])
            return ([], [:])
        }
        if let journal = try? JSONDecoder().decode(SourceAdmissionJournal.self, from: data) {
            guard journal.schema == SourceAdmissionJournal.currentSchema, journal.tree == tree else {
                throw ArborWireValidationError.invalidValue("Invalid source journal schema or tree")
            }
            if !journal.records.isEmpty, journal.records.allSatisfy({ settled.contains($0.change) }) {
                try writeJournal([])
                try objects.retain(reachableFrom: [], files: [])
                return ([], [:])
            }
            let hashes = Set(journal.records.flatMap { $0.graph.objects + $0.candidate.objects + $0.updateObjects + ($0.localTrash?.objects ?? []) })
            var loaded: [String: Data] = [:]
            loaded.reserveCapacity(hashes.count)
            for hash in hashes { loaded[hash] = try await bytes(hash) }
            let values = try journal.records.map { try materialize($0, from: loaded) }
            try Self.validate(values, tree: tree)
            return (values, loaded)
        }

        // Schema 1 embedded complete object bytes in every record. A fully
        // settled legacy journal can be retired from durable control identities
        // without rehashing hundreds of megabytes first.
        let legacy = try JSONDecoder().decode([SourceAdmissionRecord].self, from: data)
        if !legacy.isEmpty, legacy.allSatisfy({ settled.contains($0.change) }) {
            try writeJournal([])
            try objects.retain(reachableFrom: [], files: [])
            return ([], [:])
        }
        try Self.validate(legacy, tree: tree)
        // A pre-upgrade replica may already have collected an old accepted
        // basis. Preserve every embedded byte while migrating pending work.
        try persist(legacy, selfContained: true)
        return (records, objectCache)
    }

    private func reloadIfChanged() async throws {
        let current = try currentFingerprint()
        guard current != fingerprint else { return }
        let loaded = try await load()
        records = loaded.records
        objectCache.merge(loaded.objects) { _, new in new }
        fingerprint = try currentFingerprint()
    }

    private func persist(_ next: [SourceAdmissionRecord], selfContained: Bool = false) throws {
        var bytes = objectCache
        var presented: [String: Data] = [:]
        for record in next {
            for object in record.graph.objects + record.candidate.objects {
                bytes[object.hash] = object.bytes
            }
            for object in record.localTrash?.objects ?? [] {
                bytes[object.hash] = object.bytes; presented[object.hash] = object.bytes
            }
            // Candidate updates are precisely the objects introduced relative
            // to their graph. Accepted graph objects stay in the platform CAS;
            // authored descendants resolve their parent additions here.
            for object in record.update.objects { presented[object.hash] = object.bytes }
        }
        // Standalone queues have no shared platform and remain self-contained.
        if platform == nil || selfContained {
            for (hash, value) in bytes { presented[hash] = value }
        }
        try objects.store(presented)
        let stored = next.map(stored)
        try files.writeSourceAdmissions(SourceAdmissionJournal(tree: tree, records: stored))
        let retained = Set(stored.flatMap { $0.graph.objects + $0.candidate.objects + $0.updateObjects + ($0.localTrash?.objects ?? []) })
        try objects.retain(reachableFrom: [], files: retained)
        records = next
        objectCache = bytes.filter { retained.contains($0.key) }
        fingerprint = try currentFingerprint()
    }

    private func bytes(_ hash: String) async throws -> Data {
        if let cached = objectCache[hash] { return cached }
        if let local = try objects.storedBytes(hash) { return local }
        guard let platform else { throw ObjectStoreError.missing(hash) }
        return try verifyObject(try await platform.bytes(hash), hash: hash)
    }

    private func writeJournal(_ records: [StoredSourceAdmission]) throws {
        try files.writeSourceAdmissions(SourceAdmissionJournal(tree: tree, records: records))
    }

    private func stored(_ record: SourceAdmissionRecord) -> StoredSourceAdmission {
        var update = record.update
        let updateObjects = update.objects.map(\.hash).sorted()
        update.objects = []
        return StoredSourceAdmission(
            change: record.change,
            tree: record.tree,
            basis: record.basis,
            graph: .init(root: record.graph.root, objects: record.graph.objects.map(\.hash).sorted()),
            sourcePath: record.sourcePath,
            intent: record.intent,
            candidate: .init(root: record.candidate.root, objects: record.candidate.objects.map(\.hash).sorted()),
            update: update,
            updateObjects: updateObjects,
            localTrash: record.localTrash.map { .init(nodes: $0.nodes, objects: $0.objects.map(\.hash).sorted()) },
            entryTransfer: record.entryTransfer, entryActions: record.entryActions
        )
    }

    private func materialize(_ record: StoredSourceAdmission, from bytes: [String: Data]) throws -> SourceAdmissionRecord {
        func snapshot(_ stored: StoredSourceSnapshot) throws -> WireSnapshot {
            WireSnapshot(root: stored.root, objects: try stored.objects.map { hash in
                guard let value = bytes[hash] else { throw ObjectStoreError.missing(hash) }
                return WireObjectEnvelope(hash: hash, bytes: value)
            })
        }
        var update = record.update
        update.objects = try record.updateObjects.map { hash in
            guard let value = bytes[hash] else { throw ObjectStoreError.missing(hash) }
            return WireObjectEnvelope(hash: hash, bytes: value)
        }
        var value: SourceAdmissionRecord
        if let intent = record.intent, let sourcePath = record.sourcePath {
            value = try SourceAdmissionRecord(change: record.change, tree: record.tree, basis: record.basis,
                graph: snapshot(record.graph), sourcePath: sourcePath, intent: intent)
        } else {
            guard record.intent == nil, record.sourcePath == nil else {
                throw ArborWireValidationError.invalidValue("Incomplete stored source admission")
            }
            value = try SourceAdmissionRecord(change: record.change, tree: record.tree, basis: record.basis,
                graph: snapshot(record.graph), candidate: snapshot(record.candidate), entryTransfer: record.entryTransfer, entryActions: record.entryActions)
        }
        if let trash = record.localTrash {
            value.localTrash = WorkingTreeLocalTrash(nodes: trash.nodes, objects: try trash.objects.map { hash in
                guard let bytes = bytes[hash] else { throw ObjectStoreError.missing(hash) }
                return WireObjectEnvelope(hash: hash, bytes: bytes)
            })
        }
        guard value.update == update, value.candidate.root == record.candidate.root,
              value.candidate.objects.map(\.hash).sorted() == record.candidate.objects else {
            throw ArborWireValidationError.invalidValue("Retained source candidate or operations changed")
        }
        return value
    }

    private func currentFingerprint() throws -> SourceAdmissionFingerprint? {
        guard FileManager.default.fileExists(atPath: files.sourceAdmissionsURL.path) else { return nil }
        let attributes = try FileManager.default.attributesOfItem(atPath: files.sourceAdmissionsURL.path)
        return SourceAdmissionFingerprint(
            size: (attributes[.size] as? NSNumber)?.uint64Value ?? 0,
            modified: (attributes[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0,
            inode: (attributes[.systemFileNumber] as? NSNumber)?.uint64Value ?? 0
        )
    }

    /// Recognizes the old top-level record array while retaining only each
    /// record's `change` string. It deliberately does not decode object bytes.
    private static func isFullySettledLegacyJournal(_ data: Data, settled: Set<String>) -> Bool {
        guard !settled.isEmpty else { return false }
        return data.withUnsafeBytes { raw in
            let bytes = raw.bindMemory(to: UInt8.self)
            func whitespace(_ byte: UInt8) -> Bool { byte == 0x20 || byte == 0x09 || byte == 0x0a || byte == 0x0d }
            func nextNonWhitespace(_ start: Int) -> Int {
                var index = start
                while index < bytes.count, whitespace(bytes[index]) { index += 1 }
                return index
            }
            func isChangeKey(_ start: Int, _ end: Int, escaped: Bool) -> Bool {
                guard !escaped, end - start == 6 else { return false }
                return bytes[start] == 0x63 && bytes[start + 1] == 0x68 && bytes[start + 2] == 0x61
                    && bytes[start + 3] == 0x6e && bytes[start + 4] == 0x67 && bytes[start + 5] == 0x65
            }

            var index = nextNonWhitespace(0)
            guard index < bytes.count, bytes[index] == 0x5b else { return false } // [
            var arrayDepth = 1, objectDepth = 0, records = 0
            var changes = Set<String>()
            var inString = false, escaped = false, stringEscaped = false, stringStart = 0
            var currentChange: String?, closed = false
            index += 1
            while index < bytes.count {
                let byte = bytes[index]
                if inString {
                    if escaped { escaped = false; stringEscaped = true }
                    else if byte == 0x5c { escaped = true }
                    else if byte == 0x22 {
                        inString = false
                        if objectDepth == 1, arrayDepth == 1,
                           isChangeKey(stringStart, index, escaped: stringEscaped) {
                            var value = nextNonWhitespace(index + 1)
                            guard value < bytes.count, bytes[value] == 0x3a else { return false } // :
                            value = nextNonWhitespace(value + 1)
                            guard value < bytes.count, bytes[value] == 0x22 else { return false }
                            let start = value + 1
                            value = start
                            while value < bytes.count, bytes[value] != 0x22 {
                                guard bytes[value] != 0x5c, bytes[value] >= 0x20 else { return false }
                                value += 1
                            }
                            guard value < bytes.count, currentChange == nil,
                                  let change = String(bytes: bytes[start..<value], encoding: .utf8),
                                  !change.isEmpty else { return false }
                            currentChange = change
                        }
                    }
                    index += 1
                    continue
                }
                if closed {
                    guard whitespace(byte) else { return false }
                    index += 1
                    continue
                }
                switch byte {
                case 0x22: // "
                    inString = true; escaped = false; stringEscaped = false; stringStart = index + 1
                case 0x5b: // [
                    guard objectDepth > 0 else { return false }
                    arrayDepth += 1
                case 0x5d: // ]
                    guard objectDepth == 0, arrayDepth == 1 else { arrayDepth -= 1; if arrayDepth < 1 { return false }; index += 1; continue }
                    arrayDepth = 0; closed = true
                case 0x7b: // {
                    if objectDepth == 0 {
                        guard arrayDepth == 1 else { return false }
                        records += 1; currentChange = nil
                    }
                    objectDepth += 1
                case 0x7d: // }
                    guard objectDepth > 0 else { return false }
                    objectDepth -= 1
                    if objectDepth == 0 {
                        guard let change = currentChange, settled.contains(change), changes.insert(change).inserted else { return false }
                    }
                default:
                    if objectDepth == 0, arrayDepth == 1, !whitespace(byte), byte != 0x2c { return false }
                }
                index += 1
            }
            return closed && !inString && objectDepth == 0 && arrayDepth == 0 && records > 0 && changes.count == records
        }
    }

    private static func validate(_ records: [SourceAdmissionRecord], tree: String) throws {
        var prior: [String: SourceAdmissionRecord] = [:]
        for record in records {
            try record.validate()
            guard record.tree == tree, prior[record.change] == nil else { throw ArborWireValidationError.invalidValue("Invalid queue scope or duplicate identity") }
            switch record.basis {
            case let .accepted(base):
                guard !base.update.isEmpty, base.root == record.graph.root else { throw ArborWireValidationError.invalidValue("Accepted basis does not match graph") }
            case let .authored(change):
                guard let parent = prior[change], parent.candidate == record.graph else { throw ArborWireValidationError.invalidValue("Missing or altered authored basis") }
            }
            prior[record.change] = record
        }
    }
}

/// Captured by the working-tree actor in one turn, before any later watch can
/// change the graph. It is not reconstructed from a document's byte revision.
public struct CapturedSourceAdmissionBasis: Sendable {
    public let document: WorkspaceDocumentSnapshot
    public let graph: WireSnapshot
    public let accepted: WireUpdateBase?
    public let sourcePath: String

    public func prepare(intent: WorkspaceDocumentIntent, predecessor: String? = nil,
                        change: String = UUID().uuidString) throws -> SourceAdmissionRecord {
        guard intent.basis.reference == document.reference,
              intent.basis.contentRevision == document.contentRevision,
              Data(intent.basis.source.utf8) == Data(document.source.utf8) else {
            throw ArborWireValidationError.invalidValue("Intent does not name the captured document basis")
        }
        let basis: SourceAdmissionBasis
        if let accepted {
            guard predecessor == nil else { throw ArborWireValidationError.invalidValue("Cannot relabel a captured accepted basis as a local predecessor") }
            basis = .accepted(accepted)
        }
        else if let predecessor { basis = .authored(change: predecessor) }
        else { throw ArborWireValidationError.invalidValue("Unaccepted basis requires an explicit authored predecessor") }
        return try SourceAdmissionRecord(change: change, tree: document.reference.tree.rawValue,
                                         basis: basis, graph: graph, sourcePath: sourcePath, intent: intent)
    }
}

/// Private recovery material, excluded from candidate snapshots and Wire requests.
struct WorkingTreeLocalTrash: Codable, Equatable, Sendable {
    var nodes: [WorkingTreeNode]
    var objects: [WireObjectEnvelope]

    func validate() throws {
        guard nodes.allSatisfy({ $0.path == "/Trash" || $0.path.hasPrefix("/Trash/") }),
              Set(nodes.map(\.path)).count == nodes.count,
              Set(objects.map(\.hash)).count == objects.count,
              objects.allSatisfy({ WireObjectCodec.hash($0.bytes) == $0.hash }) else {
            throw ArborWireValidationError.invalidValue("Invalid retained local trash")
        }
    }
}
