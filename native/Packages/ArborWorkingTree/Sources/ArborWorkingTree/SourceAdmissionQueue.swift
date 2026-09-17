import ArborKit
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
            return try WireSourceOperation([
                "key": .string("edit-\(index)"), "kind": .string("editSource"),
                "source": .object(["material": .object(["kind": .string("basis"), "path": .string(sourcePath), "object": .string(file)]),
                                   "range": .array([.integer(edit.utf8Range.lowerBound), .integer(edit.utf8Range.upperBound)])]),
                "text": .string(edit.replacement)
            ])
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

    /// Structural actions retain an ordinary snapshot in the same dependency queue.
    /// No move/copy provenance is invented from its resulting bytes.
    public init(change: String = UUID().uuidString, tree: String, basis: SourceAdmissionBasis,
                graph: WireSnapshot, candidate: WireSnapshot) throws {
        _ = try WireObjectGraph.validate(graph, mode: .sparseFiles)
        _ = try WireObjectGraph.validate(candidate, mode: .sparseFiles)
        guard Set(graph.objects.map(\.hash)).count == graph.objects.count,
              Set(candidate.objects.map(\.hash)).count == candidate.objects.count else { throw Self.invalid("Duplicate snapshot object") }
        self.change = change; self.tree = tree; self.basis = basis
        self.graph = WireSnapshot(root: graph.root, objects: graph.objects.sorted { $0.hash < $1.hash })
        self.candidate = WireSnapshot(root: candidate.root, objects: candidate.objects.sorted { $0.hash < $1.hash })
        self.sourcePath = nil; self.intent = nil
        let known = Set(graph.objects.map(\.hash))
        self.update = WireCandidateUpdate(candidate: candidate.root, change: change, operations: nil,
                                          objects: self.candidate.objects.filter { !known.contains($0.hash) })
        _ = try JSONEncoder().encode(update)
    }

    public func validate() throws {
        var rebuilt: Self
        if let intent, let sourcePath {
            rebuilt = try Self(change: change, tree: tree, basis: basis, graph: graph, sourcePath: sourcePath, intent: intent)
        } else {
            guard intent == nil, sourcePath == nil else { throw Self.invalid("Incomplete source intent") }
            rebuilt = try Self(change: change, tree: tree, basis: basis, graph: graph, candidate: candidate)
        }
        try localTrash?.validate()
        rebuilt.localTrash = localTrash
        guard rebuilt == self else { throw Self.invalid("Retained source candidate or operations changed") }
    }

    private static func invalid(_ message: String) -> ArborWireValidationError { .invalidValue(message) }
}

/// Client-owned durable intent, independent of the legacy head/rejection file.
/// This queue prepares requests but never enables operation emission itself.
public actor SourceAdmissionQueue {
    private let tree: String
    private let files: UpdateControlFiles
    private var records: [SourceAdmissionRecord]

    public init(tree: String, stateRoot: URL) throws {
        self.tree = tree
        files = try UpdateControlFiles(root: stateRoot)
        records = try files.readSourceAdmissions()
        try Self.validate(records, tree: tree)
    }

    public func retained() throws -> [SourceAdmissionRecord] {
        let stored = try files.readSourceAdmissions()
        try Self.validate(stored, tree: tree)
        records = stored
        return stored
    }

    /// Acknowledges only after the complete record and its basis are fsynced.
    public func retain(_ record: SourceAdmissionRecord) throws {
        try files.withSourceAdmissionsLock {
            // Re-read after an uncertain write: the same identity is idempotent.
            let stored = try files.readSourceAdmissions()
            try Self.validate(stored, tree: tree)
            if let prior = stored.first(where: { $0.change == record.change }) {
                guard prior == record else { throw ArborWireValidationError.invalidValue("Authored identity was reused") }
                // A prior rename may have succeeded before its directory sync failed.
                try files.writeSourceAdmissions(stored)
                records = stored
                return
            }
            let next = stored + [record]
            try Self.validate(next, tree: tree)
            try files.writeSourceAdmissions(next)
            records = next
        }
    }

    /// Replays the original candidate chain, including an already accepted prefix.
    /// A selected peer projection never becomes a substitute for a local predecessor.
    public func request(through change: String) throws -> (base: WireUpdateBase, request: WireUpdateRequest) {
        records = try retained()
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
