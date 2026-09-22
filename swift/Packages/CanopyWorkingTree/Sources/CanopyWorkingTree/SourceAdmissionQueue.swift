import CanopyAppKit
import OverstoryObjectStore
import Overstory
import Foundation

/// A local publication dependency. Equal roots never identify a predecessor.
public enum SourceAdmissionBasis: Codable, Equatable, Sendable {
    case accepted(WireUpdateBase)
    case authored(change: String)
}

/// Captured page creation. Removal paths are proved to restore the exact
/// pre-creation graph so the creation record reproduces its original basis.
public struct SourcePageCreation: Codable, Equatable, Sendable {
    public var document: WorkspaceReference
    public var removals: [String]
    public init(document: WorkspaceReference, removals: [String]) {
        self.document = document; self.removals = removals
    }
}

/// What a source record remembers about the editor capture it came from:
/// enough to serve the document's hidden candidate and to recognize an exact
/// retry, never the document's bytes.
public struct SourceDocumentCapture: Codable, Equatable, Sendable {
    public var reference: WorkspaceReference
    public var basisRevision: String
    public var intentDigest: String
    public init(reference: WorkspaceReference, basisRevision: String, intentDigest: String) {
        self.reference = reference; self.basisRevision = basisRevision; self.intentDigest = intentDigest
    }
}

/// One immutable source admission. Construction is separate from persistence so
/// a failed/uncertain write is retried with the same change and operation identities.
/// A record keeps hashes, the wire element, and a capture summary; it never
/// retains document sources or editor transactions. Undo is an ordinary edit.
public struct SourceAdmissionRecord: Codable, Equatable, Sendable {
    public let change: String
    public let tree: String
    public let basis: SourceAdmissionBasis
    public let graph: WireSnapshot
    public let sourcePath: String?
    public let document: SourceDocumentCapture?
    public let candidate: WireSnapshot
    public let update: WireCandidateUpdate
    public var entryTransfer: EntryTransfer?
    public var entryActions: EntryActions?
    public var creation: SourcePageCreation?
    public var editorReference: WorkspaceReference? { document?.reference ?? creation?.document }
    var localTrash: WorkingTreeLocalTrash?

    /// Digest of a captured intent, for exact-retry recognition without sources.
    public static func intentDigest(_ intent: WorkspaceDocumentIntent) -> String {
        WireObjectCodec.hash((try? sortedKeysJSON(intent)) ?? Data())
    }

    /// The wire allows this many frames per element and this many operations
    /// across them. A trace that would exceed either after compaction is
    /// dropped to snapshot semantics: exact bytes stay authoritative.
    static let traceFrameLimit = 64
    static let traceOperationLimit = 1024

    /// Builds the record for a source intent. A multi-generation intent
    /// (`intent.generations`) coalesces plain edits before tree construction.
    /// Otherwise it yields one frame per generation, each from the
    /// root the previous generation produced, with operation keys
    /// `edit-<frame>-<index>`; `compact` then merges adjacent frames of plain
    /// edits (`compactTrace`). Only the final candidate's objects travel;
    /// the authority reproduces intermediate roots by executing the frames.
    public init(change: String = UUID().uuidString, tree: String, basis: SourceAdmissionBasis,
                graph: WireSnapshot, sourcePath: String, intent: WorkspaceDocumentIntent, compact: Bool = true) throws {
        try intent.validate()
        guard intent.basis.reference.tree.rawValue == tree else { throw Self.invalid("Wrong tree") }
        let parts = sourcePath.dropFirst().split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        // A generation that changed nothing states nothing; the rest chain exactly.
        var generations = (intent.generations.isEmpty ? [WorkspaceDocumentGeneration(patch: intent.patch, source: intent.source)] : intent.generations)
            .filter { !$0.patch.edits.isEmpty }
        var boundarySource = intent.basis.source
        for generation in generations {
            let bytes = Array(boundarySource.utf8)
            for edit in generation.patch.edits {
                for offset in [edit.utf8Range.lowerBound, edit.utf8Range.upperBound] {
                    if offset < bytes.count && bytes[offset] & 0xc0 == 0x80 {
                        throw Self.invalid("Source range splits a UTF-8 scalar")
                    }
                }
            }
            boundarySource = generation.source
        }
        // Coalesce plain generations before building/hashing an intermediate
        // tree per keystroke. Validate the full chain above, and prove that the
        // composed edit reproduces its final exact bytes. Provenance stays in
        // separate frames; immutable admissions are never rewritten here.
        if compact, generations.count > 1,
           generations.allSatisfy({ $0.patch.edits.allSatisfy {
               ($0.lineage ?? []).isEmpty && ($0.copies ?? []).isEmpty
           } }),
           let edits = try? WorkspaceSourceEdit.compose(generations: generations.map { $0.patch.edits }),
           !edits.isEmpty {
            let patch = WorkspaceDocumentPatch(baseContentRevision: intent.basis.contentRevision, edits: edits)
            if let source = try? patch.applying(to: intent.basis.source), Data(source.utf8) == Data(intent.source.utf8) {
                generations = [.init(patch: patch, source: intent.source)]
            }
        }
        guard sourcePath.hasPrefix("/"), !parts.isEmpty,
              parts.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." && !$0.contains("\\") && !$0.contains("\0") && Data($0.utf8) == Data($0.precomposedStringWithCanonicalMapping.utf8) }),
              !generations.isEmpty else { throw Self.invalid("Invalid source path or empty intent") }
        guard Set(graph.objects.map(\.hash)).count == graph.objects.count else { throw Self.invalid("Duplicate basis object") }
        var decoded = try WireObjectGraph.validate(graph, mode: .sparseFiles)
        var bytes = Dictionary(uniqueKeysWithValues: graph.objects.map { ($0.hash, $0.bytes) })
        func store(_ object: WireObject) throws -> String {
            let value = try WireObjectCodec.encode(object), hash = WireObjectCodec.hash(value)
            bytes[hash] = value
            decoded[hash] = object
            return hash
        }
        // Directories along the path, by depth: their basis hash and the hash the final generation produced.
        var baseDirectories: [Int: String] = [:], resultDirectories: [Int: String] = [:]
        var file: String?, basisFile: String?
        // A directory's first body, added by this generation: where and what.
        var addedBody: (parentPath: String, parent: String, file: String)?
        func replace(_ hash: String, _ depth: Int, from previous: String, to source: String, first: Bool) throws -> String {
            guard case let .directory(originalEntries, descriptor)? = decoded[hash] else { throw Self.invalid("Source path is not in basis") }
            var entries = originalEntries
            // A directory without a stored body has empty source. Its first save
            // creates material: an addEntry of the new body, never editSource
            // with a fabricated empty-file identity.
            if depth == parts.count - 1, parts[depth] == "_index.md",
               !entries.contains(where: { $0.name == parts[depth] }), previous.isEmpty {
                let body = try store(.file(Data(source.utf8)))
                addedBody = (depth == 0 ? "/" : "/" + parts[..<depth].joined(separator: "/"), hash, body)
                entries.append(WireDirectoryEntry(name: parts[depth], file: body))
                entries.sort { Array($0.name.utf8).lexicographicallyPrecedes(Array($1.name.utf8)) }
                return try store(.directory(entries, childrenSource: descriptor))
            }
            guard let index = entries.firstIndex(where: { $0.name == parts[depth] }) else { throw Self.invalid("Source path is not in basis") }
            if depth == parts.count - 1 {
                guard let current = entries[index].file, case let .file(value)? = decoded[current],
                      value == Data(previous.utf8) else { throw Self.invalid("Source bytes do not match basis") }
                file = current
                entries[index].file = try store(.file(Data(source.utf8)))
            } else {
                guard let directory = entries[index].directory else { throw Self.invalid("Source path crosses a file or tree boundary") }
                entries[index].directory = try replace(directory, depth + 1, from: previous, to: source, first: first)
            }
            let result = try store(.directory(entries, childrenSource: descriptor))
            if first { baseDirectories[depth] = hash }
            resultDirectories[depth] = result
            return result
        }
        func copyMaterial(_ copy: WorkspaceSourceLineage, file: String) throws -> WireSemanticValue {
            guard let document = copy.document else {
                return .object(["kind":.string("basis"),"path":.string(sourcePath),"object":.string(file)])
            }
            let parts = document.path.dropFirst().split(separator: "/", omittingEmptySubsequences: false).map(String.init)
            guard document.path.hasPrefix("/"), parts.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }) else { throw Self.invalid("Invalid copy path") }
            // Other documents are untouched by this record, so their basis
            // object is the same in every frame's `before` tree.
            var hash = graph.root
            for (index, part) in parts.enumerated() {
                guard case let .directory(entries, _)? = decoded[hash], let entry = entries.first(where: { $0.name == part }) else { throw Self.invalid("Copy source missing from basis") }
                if index == parts.count - 1 {
                    guard let value = entry.file, case let .file(bytes)? = decoded[value], bytes == Data(document.source.utf8) else { throw Self.invalid("Copy source changed or crosses a tree boundary") }
                    return .object(["kind":.string("basis"),"path":.string(document.path),"object":.string(value)])
                }
                guard let directory = entry.directory else { throw Self.invalid("Copy source crosses a tree boundary") }
                hash = directory
            }
            throw Self.invalid("Invalid copy source")
        }
        var frames: [WireTraceFrame] = []
        var sources: [String: String] = [graph.root: intent.basis.source]
        var previousRoot = graph.root, previousSource = intent.basis.source
        var evidence = true
        for (frame, generation) in generations.enumerated() {
            file = nil; addedBody = nil
            let root = try replace(previousRoot, 0, from: previousSource, to: generation.source, first: frame == 0)
            if frame == 0 { basisFile = file }
            sources[root] = generation.source
            let basisSource = Array(previousSource.utf8)
            var operations = try Self.operationEdits(generation.patch.edits).enumerated().flatMap { index, edit -> [WireSourceOperation] in
                // Byte-valid output alone does not prove scalar-aligned selection.
                for offset in [edit.utf8Range.lowerBound, edit.utf8Range.upperBound] {
                    if offset < basisSource.count && basisSource[offset] & 0xc0 == 0x80 { throw Self.invalid("Source range splits a UTF-8 scalar") }
                }
                guard let file else { return [] }
                let key = "edit-\(frame)-\(index)"
                if edit.utf8Range.isEmpty, let copies = edit.copies, copies.count == 1,
                   copies[0].replacement == 0..<edit.replacement.utf8.count {
                    let material: WireSemanticValue = .object(["kind":.string("basis"),"path":.string(sourcePath),"object":.string(file)])
                    return [try WireSourceOperation(["key":.string("copy-\(frame)-\(index)-0"),"kind":.string("copySource"),
                        "source":.object(["material":try copyMaterial(copies[0], file: file),"range":.array([.integer(copies[0].source.lowerBound),.integer(copies[0].source.upperBound)])]),
                        "at":.object(["material":material,"range":.array([.integer(edit.utf8Range.lowerBound),.integer(edit.utf8Range.lowerBound)])]),"side":.string("before")])]
                }
                var fields: [String: WireSemanticValue] = [
                    "key": .string(key), "kind": .string("editSource"),
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
                var operations = [try WireSourceOperation(fields)]
                for (copyIndex, copy) in (edit.copies ?? []).enumerated() {
                    let target: WireSemanticValue = .object([
                        "material":.object(["kind":.string("operation"),"change":.string(change),"operation":.string(key)]),
                        "range":.array([.integer(copy.replacement.lowerBound),.integer(copy.replacement.upperBound)])])
                    let source: WireSemanticValue = .object([
                        "material":try copyMaterial(copy, file: file),
                        "range":.array([.integer(copy.source.lowerBound),.integer(copy.source.upperBound)])])
                    operations.append(try WireSourceOperation(["key":.string("copy-\(frame)-\(index)-\(copyIndex)"),"kind":.string("copySource"),"source":source,"at":target,"side":.string("before")]))
                    operations.append(try WireSourceOperation(["key":.string("copy-placeholder-\(frame)-\(index)-\(copyIndex)"),"kind":.string("editSource"),"source":target,"text":.string("")]))
                }
                return operations
            }
            if file == nil, let added = addedBody {
                operations = [try WireSourceOperation([
                    "key": .string("add-\(frame)"), "kind": .string("addEntry"),
                    "destination": .object([
                        "parent": .object(["material": .object(["kind": .string("basis"), "path": .string(added.parentPath), "object": .string(added.parent)])]),
                        "name": .string("_index.md"),
                    ]),
                    "value": .object(["file": .string(added.file)]),
                ])]
            }
            // A generation without operations cannot be a frame; the whole
            // record is then a snapshot.
            if operations.isEmpty { evidence = false }
            frames.append(WireTraceFrame(before: previousRoot, after: root, operations: operations))
            previousRoot = root; previousSource = generation.source
        }
        let root = previousRoot
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
        if evidence, compact {
            // A compacted frame is proven against the generation sources it
            // spans before it replaces the chain; otherwise the chain stays.
            let compacted = Self.compactTrace(frames)
            if compacted.allSatisfy({ frame in Self.reproduces(frame, sourcePath: sourcePath, sources: sources) }) { frames = compacted }
        }
        if frames.count > Self.traceFrameLimit || frames.reduce(0, { $0 + $1.operations.count }) > Self.traceOperationLimit { evidence = false }
        let known = Set(graph.objects.map(\.hash))
        var update = WireCandidateUpdate(candidate: root, change: change,
                                         trace: evidence && !frames.isEmpty ? frames : nil,
                                         objects: candidate.objects.filter { !known.contains($0.hash) })
        // Against an accepted basis the server can rebuild the edited file from
        // its retained base, so send the patch as a delta rather than the file.
        // A chained authored basis is not retained server-side when Canopy
        // preflights the request (its delta bases are resolved against the
        // accepted base root before the request's own objects are stored),
        // so its file goes whole.
        if case .accepted = basis {
            var deltas: [WireObjectDelta] = []
            if let file = basisFile,
               let resultHash = (try? WireObjectCodec.encode(.file(Data(intent.source.utf8)))).map(WireObjectCodec.hash),
               let result = update.objects.first(where: { $0.hash == resultHash }),
               let delta = Self.delta(baseHash: file, baseSource: intent.basis.source, edits: intent.patch.edits, result: result) {
                deltas.append(delta)
            }
            // Directories along the path change hash on every edit but differ
            // from their base in one entry; send those as splices too.
            for (depth, base) in baseDirectories.sorted(by: { $0.key < $1.key }) {
                guard let result = resultDirectories[depth], base != result,
                      let baseBytes = bytes[base], let resultObject = update.objects.first(where: { $0.hash == result }),
                      let delta = Self.spliceDelta(baseHash: base, base: baseBytes, result: resultObject) else { continue }
                deltas.append(delta)
            }
            let replaced = Set(deltas.map(\.result))
            update.objects.removeAll { replaced.contains($0.hash) }
            update.deltas = deltas
        }
        // Validate the complete Wire grammar, including change and operation identities.
        _ = try JSONEncoder().encode(update)
        self.change = change; self.tree = tree; self.basis = basis
        self.graph = WireSnapshot(root: graph.root, objects: graph.objects.sorted { $0.hash < $1.hash })
        self.sourcePath = sourcePath; self.candidate = candidate; self.update = update
        self.document = SourceDocumentCapture(reference: intent.basis.reference, basisRevision: intent.basis.contentRevision, intentDigest: Self.intentDigest(intent))
    }

    /// A frame is plain when every operation is a lineage-free `editSource`
    /// over `basis` material of one path with a range: what `compose` handles.
    private static func plainEdits(_ frame: WireTraceFrame) -> (path: String, object: String, edits: [WorkspaceSourceEdit])? {
        var path: String?, object: String?, edits: [WorkspaceSourceEdit] = []
        for operation in frame.operations {
            guard operation.kind == "editSource", operation.fields["lineage"] == nil || operation.fields["lineage"] == .array([]),
                  case let .object(source)? = operation.fields["source"], source["within"] == nil,
                  case let .object(material)? = source["material"], material["kind"] == .string("basis"),
                  case let .string(materialPath)? = material["path"], case let .string(materialObject)? = material["object"],
                  case let .array(range)? = source["range"], range.count == 2,
                  case let .integer(lower) = range[0], case let .integer(upper) = range[1],
                  case let .string(text)? = operation.fields["text"],
                  path == nil || path == materialPath, object == nil || object == materialObject else { return nil }
            path = materialPath; object = materialObject
            edits.append(WorkspaceSourceEdit(utf8Range: lower..<upper, replacement: text))
        }
        guard let path, let object else { return nil }
        return (path, object, edits.sorted { $0.utf8Range.lowerBound < $1.utf8Range.lowerBound })
    }

    /// Merges runs of adjacent plain frames over one path into one frame each,
    /// by `WorkspaceSourceEdit.compose`: the merged frame runs from the first
    /// frame's `before` to the last frame's `after`, names the path's object in
    /// the first frame, and keys its operations `edit-<k>-<i>` where `k` is the
    /// first frame's index in `frames`. A run that ends at the root it started
    /// from changed nothing and yields no frame. Frames with lineage, copies or
    /// operation material are kept as they are, so a claim always stays in the
    /// frame whose basis it was captured against (docs/overstory-spec/09). The same rule runs
    /// in `@arbor/canopy-client` and in Canopy's `composeFrames`.
    public static func compactTrace(_ frames: [WireTraceFrame]) -> [WireTraceFrame] {
        var result: [WireTraceFrame] = []
        var index = 0
        while index < frames.count {
            guard let first = plainEdits(frames[index]) else { result.append(frames[index]); index += 1; continue }
            var end = index + 1, generations = [first.edits]
            while end < frames.count, let next = plainEdits(frames[end]), next.path == first.path { generations.append(next.edits); end += 1 }
            let before = frames[index].before, after = frames[end - 1].after
            if end - index == 1 { result.append(frames[index]) }
            else if before == after { /* a plain run back to its start states nothing */ }
            else if let composed = try? WorkspaceSourceEdit.compose(generations: generations) {
                let operations = composed.enumerated().compactMap { i, edit in
                    try? WireSourceOperation(["key": .string("edit-\(index)-\(i)"), "kind": .string("editSource"),
                        "source": .object(["material": .object(["kind": .string("basis"), "path": .string(first.path), "object": .string(first.object)]),
                                           "range": .array([.integer(edit.utf8Range.lowerBound), .integer(edit.utf8Range.upperBound)])]),
                        "text": .string(edit.replacement)])
                }
                if operations.count == composed.count, !operations.isEmpty { result.append(WireTraceFrame(before: before, after: after, operations: operations)) }
                else { result.append(contentsOf: frames[index..<end]) }
            } else { result.append(contentsOf: frames[index..<end]) }
            index = end
        }
        return result
    }

    /// Whether a plain frame's operations take the source at its `before`
    /// root to the source at its `after` root; frames of other kinds pass.
    private static func reproduces(_ frame: WireTraceFrame, sourcePath: String, sources: [String: String]) -> Bool {
        guard let plain = plainEdits(frame), plain.path == sourcePath else { return true }
        guard let before = sources[frame.before], let after = sources[frame.after],
              let produced = try? WorkspaceDocumentPatch(baseContentRevision: "", edits: plain.edits).applying(to: before) else { return false }
        return Data(produced.utf8) == Data(after.utf8)
    }

    /// A common-prefix/common-suffix splice for a byte object whose base is
    /// retained; used for directory objects where one entry changed.
    static func spliceDelta(baseHash: String, base: Data, result: WireObjectEnvelope) -> WireObjectDelta? {
        let target = result.bytes
        var prefix = 0
        while prefix < base.count, prefix < target.count, base[base.startIndex + prefix] == target[target.startIndex + prefix] { prefix += 1 }
        var suffix = 0
        while suffix < base.count - prefix, suffix < target.count - prefix,
              base[base.endIndex - 1 - suffix] == target[target.endIndex - 1 - suffix] { suffix += 1 }
        var instructions: [WireObjectDeltaInstruction] = []
        if prefix > 0 { instructions.append(.copy(offset: 0, length: prefix)) }
        let middle = target.subdata(in: (target.startIndex + prefix)..<(target.endIndex - suffix))
        if !middle.isEmpty { instructions.append(.insert(middle)) }
        if suffix > 0 { instructions.append(.copy(offset: base.count - suffix, length: suffix)) }
        guard !instructions.isEmpty, let delta = try? WireObjectDelta(base: baseHash, result: result.hash, instructions: instructions).validated(),
              (try? delta.apply(to: base)) == target else { return nil }
        guard let encodedDelta = try? sortedKeysJSON(delta), let encodedResult = try? sortedKeysJSON(result), encodedDelta.count < encodedResult.count else { return nil }
        return delta
    }

    /// Copy/insert instructions from ordered, non-overlapping patch edits, only
    /// when the delta reproduces the exact result bytes and is smaller than them.
    static func delta(baseHash: String, baseSource: String, edits: [WorkspaceSourceEdit], result: WireObjectEnvelope) -> WireObjectDelta? {
        let base = Data(baseSource.utf8)
        var instructions: [WireObjectDeltaInstruction] = []
        var cursor = 0
        for edit in edits.sorted(by: { $0.utf8Range.lowerBound < $1.utf8Range.lowerBound }) {
            let lower = edit.utf8Range.lowerBound
            guard lower >= cursor, edit.utf8Range.upperBound <= base.count else { return nil }
            if lower > cursor { instructions.append(.copy(offset: cursor, length: lower - cursor)) }
            let replacement = Data(edit.replacement.utf8)
            if !replacement.isEmpty { instructions.append(.insert(replacement)) }
            cursor = edit.utf8Range.upperBound
        }
        if cursor < base.count { instructions.append(.copy(offset: cursor, length: base.count - cursor)) }
        guard !instructions.isEmpty, let delta = try? WireObjectDelta(base: baseHash, result: result.hash, instructions: instructions).validated(),
              let baseObject = try? WireObjectCodec.encode(.file(base)),
              (try? delta.apply(to: baseObject)) == result.bytes else { return nil }
        guard let encodedDelta = try? sortedKeysJSON(delta), let encodedResult = try? sortedKeysJSON(result), encodedDelta.count < encodedResult.count else { return nil }
        return delta
    }

    /// Structural actions retain captured operations when available, otherwise
    /// genuine snapshot semantics. Never infer provenance from resulting bytes.
    public init(change: String = UUID().uuidString, tree: String, basis: SourceAdmissionBasis,
                graph: WireSnapshot, candidate: WireSnapshot, entryTransfer: EntryTransfer? = nil, entryActions: EntryActions? = nil, creation: SourcePageCreation? = nil) throws {
        _ = try WireObjectGraph.validate(graph, mode: .sparseFiles)
        _ = try WireObjectGraph.validate(candidate, mode: .sparseFiles)
        guard Set(graph.objects.map(\.hash)).count == graph.objects.count,
              Set(candidate.objects.map(\.hash)).count == candidate.objects.count else { throw Self.invalid("Duplicate snapshot object") }
        self.change = change; self.tree = tree; self.basis = basis
        self.graph = WireSnapshot(root: graph.root, objects: graph.objects.sorted { $0.hash < $1.hash })
        self.candidate = WireSnapshot(root: candidate.root, objects: candidate.objects.sorted { $0.hash < $1.hash })
        self.sourcePath = nil; self.document = nil
        guard entryTransfer == nil || entryActions == nil else { throw Self.invalid("Multiple entry intent representations") }
        self.entryTransfer = entryTransfer; self.entryActions = entryActions
        self.creation = creation
        if let creation {
            guard creation.document.tree.rawValue == tree, entryActions == nil, entryTransfer == nil else { throw Self.invalid("Invalid page creation") }
            let removed = try EntryActions(removals: creation.removals).prepare(graph: candidate, changeID: change)
            guard removed.candidate.root == graph.root else { throw Self.invalid("Creation does not reproduce its original graph") }
        }
        let prepared = try entryActions?.prepare(graph:graph, candidate:candidate, changeID:change) ?? entryTransfer?.prepare(graph:graph, candidate:candidate, changeID:change)
        if let prepared, prepared.candidate.root != candidate.root { throw Self.invalid("Entry intent does not reproduce candidate") }
        let known = Set(graph.objects.map(\.hash))
        let captured = try prepared?.operations ?? creation.map { try Self.creationOperations($0, graph: graph, candidate: candidate) } ?? []
        self.update = WireCandidateUpdate(candidate: candidate.root, change: change,
                                          trace: captured.isEmpty ? nil : [WireTraceFrame(before: graph.root, after: candidate.root, operations: captured)],
                                          objects: self.candidate.objects.filter { !known.contains($0.hash) })
        _ = try JSONEncoder().encode(update)
    }

    /// Rehydrate a stored record. The journal keeps the wire element verbatim,
    /// so nothing is re-derived from document sources on load.
    init(change: String, tree: String, basis: SourceAdmissionBasis, graph: WireSnapshot, candidate: WireSnapshot, update: WireCandidateUpdate,
         sourcePath: String?, document: SourceDocumentCapture?, entryTransfer: EntryTransfer?, entryActions: EntryActions?, creation: SourcePageCreation?, localTrash: WorkingTreeLocalTrash?) throws {
        self.change = change; self.tree = tree; self.basis = basis
        self.graph = WireSnapshot(root: graph.root, objects: graph.objects.sorted { $0.hash < $1.hash })
        self.candidate = WireSnapshot(root: candidate.root, objects: candidate.objects.sorted { $0.hash < $1.hash })
        self.update = update; self.sourcePath = sourcePath; self.document = document
        self.entryTransfer = entryTransfer; self.entryActions = entryActions; self.creation = creation; self.localTrash = localTrash
        try validate()
    }

    /// Structural integrity of one record: hash-checked graphs, a wire element
    /// that names this candidate and change, and objects drawn from the candidate.
    public func validate() throws {
        guard !change.isEmpty, update.change == change, update.candidate == candidate.root else { throw Self.invalid("Wire element does not name its record") }
        guard Set(graph.objects.map(\.hash)).count == graph.objects.count,
              Set(candidate.objects.map(\.hash)).count == candidate.objects.count else { throw Self.invalid("Duplicate snapshot object") }
        _ = try WireObjectGraph.validate(graph, mode: .sparseFiles)
        _ = try WireObjectGraph.validate(candidate, mode: .sparseFiles)
        let known = Set(graph.objects.map(\.hash)), present = Dictionary(uniqueKeysWithValues: candidate.objects.map { ($0.hash, $0.bytes) })
        for object in update.objects {
            guard !known.contains(object.hash), present[object.hash] == object.bytes else { throw Self.invalid("Update object is not a new candidate object") }
        }
        for delta in update.deltas {
            guard present[delta.result] != nil, known.contains(delta.base) || present[delta.base] == nil else { throw Self.invalid("Delta does not target the candidate") }
        }
        guard (document == nil) == (sourcePath == nil) else { throw Self.invalid("Incomplete source intent") }
        if let document { guard document.reference.tree.rawValue == tree else { throw Self.invalid("Wrong tree") } }
        try localTrash?.validate()
        _ = try JSONEncoder().encode(update)
    }

    /// Ordered preservation spans are untouched material, not part of the
    /// authored replacement footprint. Copies live only in the gaps.
    private static func operationEdits(_ edits: [WorkspaceSourceEdit]) -> [WorkspaceSourceEdit] {
        edits.flatMap { edit in
            let lineage = edit.lineage ?? []
            guard !(edit.copies ?? []).isEmpty, !lineage.isEmpty else { return [edit] }
            var prior = edit.utf8Range.lowerBound
            for part in lineage {
                if part.source.lowerBound < prior { return [edit] }
                prior = part.source.upperBound
            }
            let bytes = Data(edit.replacement.utf8)
            var source = edit.utf8Range.lowerBound, output = 0
            var result: [WorkspaceSourceEdit] = []
            let sentinel = WorkspaceSourceLineage(source:edit.utf8Range.upperBound..<edit.utf8Range.upperBound,replacement:bytes.count..<bytes.count)
            for part in lineage + [sentinel] {
                let end = part.replacement.lowerBound
                if source != part.source.lowerBound || output != end {
                    let copies = (edit.copies ?? []).filter { $0.replacement.lowerBound >= output && $0.replacement.upperBound <= end }.map {
                        WorkspaceSourceLineage(source:$0.source,replacement:($0.replacement.lowerBound-output)..<($0.replacement.upperBound-output),document:$0.document)
                    }
                    result.append(.init(utf8Range:source..<part.source.lowerBound,replacement:String(data:bytes.subdata(in:output..<end),encoding:.utf8)!,copies:copies.isEmpty ? nil : copies))
                }
                source = part.source.upperBound; output = part.replacement.upperBound
            }
            return result
        }
    }

    private static func invalid(_ message: String) -> ArborWireValidationError { .invalidValue(message) }

    /// A page creation adds the first new branch of its path under the basis
    /// directory that already held it. The removal proof in `init` shows the
    /// candidate is exactly the basis plus these branches.
    static func creationOperations(_ creation: SourcePageCreation, graph: WireSnapshot, candidate: WireSnapshot) throws -> [WireSourceOperation] {
        let basis = try WireObjectGraph.validate(graph, mode: .sparseFiles)
        let result = try WireObjectGraph.validate(candidate, mode: .sparseFiles)
        func directory(_ objects: [String: WireObject], _ root: String, _ parts: ArraySlice<String>) throws -> [WireDirectoryEntry] {
            var hash = root
            for part in parts {
                guard case let .directory(entries, _)? = objects[hash], let next = entries.first(where: { $0.name == part })?.directory else {
                    throw invalid("Page creation parent is not a basis directory")
                }
                hash = next
            }
            guard case let .directory(entries, _)? = objects[hash] else { throw invalid("Page creation parent is not a directory") }
            return entries
        }
        return try creation.removals.enumerated().map { index, path in
            let parts = path.dropFirst().split(separator: "/", omittingEmptySubsequences: false).map(String.init)
            guard path.hasPrefix("/"), let name = parts.last, !name.isEmpty else { throw invalid("Invalid page creation path") }
            let parentParts = parts.dropLast()
            var parentHash = graph.root
            for part in parentParts {
                guard case let .directory(entries, _)? = basis[parentHash], let next = entries.first(where: { $0.name == part })?.directory else {
                    throw invalid("Page creation parent is not a basis directory")
                }
                parentHash = next
            }
            guard let added = try directory(result, candidate.root, parentParts).first(where: { $0.name == name }) else {
                throw invalid("Page creation entry is not in its candidate")
            }
            let value: WireSemanticValue
            if let file = added.file { value = .object(["file": .string(file)]) }
            else if let directory = added.directory { value = .object(["directory": .string(directory)]) }
            else { throw invalid("Page creation entry is not a file or directory") }
            let parentPath = parentParts.isEmpty ? "/" : "/" + parentParts.joined(separator: "/")
            return try WireSourceOperation([
                "key": .string("add-\(index)"), "kind": .string("addEntry"),
                "destination": .object([
                    "parent": .object(["material": .object(["kind": .string("basis"), "path": .string(parentPath), "object": .string(parentHash)])]),
                    "name": .string(name),
                ]),
                "value": value,
            ])
        }
    }
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
    var document: SourceDocumentCapture?
    var candidate: StoredSourceSnapshot
    var update: WireCandidateUpdate
    var updateObjects: [String]
    var localTrash: StoredSourceTrash?
    var entryTransfer: EntryTransfer?
    var entryActions: EntryActions?
    var creation: SourcePageCreation?
}

/// Schema 4 stores hashes and the wire element with its frame chain.
private struct SourceAdmissionJournal: Codable {
    static let currentSchema = 4
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
        try await retain([record])
    }

    /// One durable boundary for a batch of records.
    public func retain(_ batch: [SourceAdmissionRecord]) async throws {
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
                var next = records
                for record in batch {
                    if let prior = next.first(where: { $0.change == record.change }) {
                        guard prior == record else { throw ArborWireValidationError.invalidValue("Authored identity was reused") }
                    } else { next.append(record) }
                }
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
                if preservingSettledTail {
                    if let latest = records.last { required.insert(latest.change) }
                    var documents = Set<WorkspaceIdentity>()
                    for record in records.reversed() {
                        if let identity = record.document?.reference.identity, documents.insert(identity).inserted {
                            required.insert(record.change)
                        }
                    }
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

    /// Batch the oldest pending branch through its newest contiguous descendant.
    /// Stop at a sibling/independent basis: equal roots never establish lineage.
    /// Existing persisted attempts are selected by the coordinator before this
    /// method, so their exact bodies and identities cannot change.
    public func nextPublication(accepted: Set<String>) async throws -> SourceAdmissionRecord? {
        try await reloadIfChanged()
        let tip = UpdateMachine.publicationTip(records.map { record in
            let parent: String? = if case let .authored(change) = record.basis { change } else { nil }
            return (record.change, parent)
        }, accepted: accepted)
        return records.first { $0.change == tip }
    }

    /// Replays the original candidate chain, including an already accepted prefix.
    /// A selected peer projection never becomes a substitute for a local predecessor.
    public func request(through change: String, accepted: Set<String> = []) async throws -> (base: WireUpdateBase, request: WireUpdateRequest) {
        try await reloadIfChanged()
        let byChange = Dictionary(uniqueKeysWithValues: records.map { ($0.change, $0) })
        var current = change, updates: [WireCandidateUpdate] = []
        while let record = byChange[current] {
            var update = record.update
            // Durable receipts prove these objects already reached Canopy.
            // Keep the authored chain and its digests; only omit transport aids.
            if accepted.contains(record.change) {
                update.objects = []
                update.deltas = []
            }
            updates.insert(update, at: 0)
            switch record.basis {
            case let .accepted(base): return (base, WireUpdateRequest(base: base.update, updates: updates))
            case let .authored(parent): current = parent
            }
        }
        throw ArborWireValidationError.invalidValue("Missing authored dependency")
    }

    private func load(settled: Set<String> = []) async throws -> (records: [SourceAdmissionRecord], objects: [String: Data]) {
        guard let data = try files.readSourceAdmissionsData() else { return ([], [:]) }
        let journal = try JSONDecoder().decode(SourceAdmissionJournal.self, from: data)
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
        var values: [SourceAdmissionRecord] = []
        for stored in journal.records { values.append(try materialize(stored, from: loaded)) }
        try Self.validate(values, tree: tree)
        return (values, loaded)
    }

    private func reloadIfChanged() async throws {
        let current = try currentFingerprint()
        guard current != fingerprint else { return }
        let loaded = try await load()
        records = loaded.records
        objectCache.merge(loaded.objects) { _, new in new }
        fingerprint = try currentFingerprint()
    }

    private func persist(_ next: [SourceAdmissionRecord]) throws {
        var bytes = objectCache
        var presented: [String: Data] = [:]
        for record in next {
            for object in record.graph.objects + record.candidate.objects {
                bytes[object.hash] = object.bytes
            }
            for object in record.localTrash?.objects ?? [] {
                bytes[object.hash] = object.bytes; presented[object.hash] = object.bytes
            }
            // Objects a candidate introduces relative to its graph are queue-owned
            // until the admission settles, whether the wire element carries them
            // whole or as deltas. Accepted graph objects stay in the platform CAS.
            let basis = Set(record.graph.objects.map(\.hash))
            for object in record.candidate.objects where !basis.contains(object.hash) { presented[object.hash] = object.bytes }
        }
        // Standalone queues have no shared platform and remain self-contained.
        if platform == nil {
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
            document: record.document,
            candidate: .init(root: record.candidate.root, objects: record.candidate.objects.map(\.hash).sorted()),
            update: update,
            updateObjects: updateObjects,
            localTrash: record.localTrash.map { .init(nodes: $0.nodes, objects: $0.objects.map(\.hash).sorted()) },
            entryTransfer: record.entryTransfer, entryActions: record.entryActions, creation: record.creation
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
        let trash = try record.localTrash.map { trash in
            WorkingTreeLocalTrash(nodes: trash.nodes, objects: try trash.objects.map { hash in
                guard let value = bytes[hash] else { throw ObjectStoreError.missing(hash) }
                return WireObjectEnvelope(hash: hash, bytes: value)
            })
        }
        return try SourceAdmissionRecord(change: record.change, tree: record.tree, basis: record.basis, graph: try snapshot(record.graph),
            candidate: try snapshot(record.candidate), update: update, sourcePath: record.sourcePath, document: record.document,
            entryTransfer: record.entryTransfer, entryActions: record.entryActions, creation: record.creation, localTrash: trash)
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

    /// `compact` merges adjacent plain frames of a multi-generation intent
    /// (`SourceAdmissionRecord.compactTrace`); tests pass `false` to compare.
    public func prepare(intent: WorkspaceDocumentIntent, predecessor: String? = nil,
                        change: String = UUID().uuidString, compact: Bool = true) throws -> SourceAdmissionRecord {
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
                                         basis: basis, graph: graph, sourcePath: sourcePath, intent: intent, compact: compact)
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
