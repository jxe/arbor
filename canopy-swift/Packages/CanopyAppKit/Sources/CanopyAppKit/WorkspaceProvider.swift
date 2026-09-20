import Foundation

public struct WorkspaceProviderCapabilities: Hashable, Codable, Sendable {
    public var structuralActions: Bool
    public var assets: Bool
    public var search: Bool
    public var backlinks: Bool
    public var localHistory: Bool

    public init(
        structuralActions: Bool = true,
        assets: Bool = true,
        search: Bool = true,
        backlinks: Bool = true,
        localHistory: Bool = true
    ) {
        self.structuralActions = structuralActions
        self.assets = assets
        self.search = search
        self.backlinks = backlinks
        self.localHistory = localHistory
    }

    public static let full = WorkspaceProviderCapabilities()
    public static let readOnly = WorkspaceProviderCapabilities(
        structuralActions: false,
        assets: false,
        search: true,
        backlinks: true,
        localHistory: false
    )
}

public enum WorkspaceStructuralAction: Hashable, Codable, Sendable {
    case createMarkdown(parent: WorkspaceReference, name: String, source: String)
    case createDirectory(parent: WorkspaceReference, name: String)
    case rename(reference: WorkspaceReference, name: String)
    case move(reference: WorkspaceReference, destination: WorkspaceReference)
    case copy(reference: WorkspaceReference, destination: WorkspaceReference)
    case trash(reference: WorkspaceReference)
    case restore(reference: WorkspaceReference)
}

public struct WorkspaceDocumentSnapshot: Hashable, Codable, Sendable {
    public var reference: WorkspaceReference
    public var source: String
    public var contentRevision: String

    public init(reference: WorkspaceReference, source: String, contentRevision: String) {
        self.reference = reference
        self.source = source
        self.contentRevision = contentRevision
    }
}

public struct WorkspaceDocumentConflict: Hashable, Codable, Sendable, Error {
    public struct Context: Hashable, Codable, Sendable {
        public struct ConflictReason: Hashable, Codable, Sendable {
            public var path: String
            public var reason: String

            public init(path: String, reason: String) {
                self.path = path
                self.reason = reason
            }
        }

        public var code: String
        public var message: String
        public var kind: String?
        public var reason: String?
        public var conflicts: [ConflictReason]
        public var resolutions: [String]

        public var paths: [String] { conflicts.map(\.path) }

        public init(
            code: String,
            message: String,
            kind: String? = nil,
            reason: String? = nil,
            conflicts: [ConflictReason] = [],
            resolutions: [String] = []
        ) {
            self.code = code
            self.message = message
            self.kind = kind
            self.reason = reason
            self.conflicts = conflicts
            self.resolutions = resolutions
        }
    }

    /// The exact source/revision the editor changed. Providers which cannot
    /// retain the base may leave this nil.
    public var base: WorkspaceDocumentSnapshot?
    public var current: WorkspaceDocumentSnapshot
    public var submittedSource: String
    /// Structured provider conflict evidence, when the provider returned it.
    public var context: Context?

    public init(
        base: WorkspaceDocumentSnapshot? = nil,
        current: WorkspaceDocumentSnapshot,
        submittedSource: String,
        context: Context? = nil
    ) {
        self.base = base
        self.current = current
        self.submittedSource = submittedSource
        self.context = context
    }
}

/// Exact same-tree source material captured for a cross-document copy.
public struct WorkspaceCopyDocument: Hashable, Codable, Sendable {
    public var path: String
    public var source: String
    public init(path: String, source: String) { self.path = path; self.source = source }
}

public struct WorkspaceSourceLineage: Hashable, Codable, Sendable {
    public var source: Range<Int>
    public var replacement: Range<Int>
    public var document: WorkspaceCopyDocument?
    public init(source: Range<Int>, replacement: Range<Int>, document: WorkspaceCopyDocument? = nil) {
        self.source = source; self.replacement = replacement; self.document = document
    }
}

public struct WorkspaceSourceEdit: Hashable, Codable, Sendable {
    public var utf8Range: Range<Int>
    public var replacement: String
    public var expected: String?
    public var lineage: [WorkspaceSourceLineage]?
    /// Explicit duplication: unlike lineage, the source occurrence is not consumed.
    public var copies: [WorkspaceSourceLineage]?

    public init(utf8Range: Range<Int>, replacement: String, expected: String? = nil, lineage: [WorkspaceSourceLineage]? = nil, copies: [WorkspaceSourceLineage]? = nil) {
        self.utf8Range = utf8Range
        self.replacement = replacement
        self.expected = expected
        self.lineage = lineage
        self.copies = copies
    }
}

extension WorkspaceSourceEdit {
    /// Composes generations of plain edits (no lineage, no copies, no guards)
    /// into one generation over the original source. Generation `n` is stated
    /// over the source generation `n - 1` produced; the result is stated over
    /// the original and produces exactly what the last generation produced.
    /// It needs no intermediate bytes: the original is modelled as pieces that
    /// are copied ranges of it or inserted text, and each generation only
    /// splits, removes or interleaves pieces. Copied pieces stay in original
    /// order, so the composed edits are ascending, never adjacent and never
    /// share an anchor. The same rule runs as `composeSourceEdits` in
    /// `@arbor/core` and in Canopy's `composeFrames`;
    /// `spec/conformance/source-admission-queue.json` holds the shared vectors.
    public static func compose(generations: [[WorkspaceSourceEdit]]) throws -> [WorkspaceSourceEdit] {
        enum Piece { case copy(Range<Int>); case text(Data)
            var size: Int { switch self { case let .copy(range): range.count; case let .text(data): data.count } }
        }
        // The original's tail is open-ended: no generation may reach past the real end.
        let open = Int.max / 2
        var pieces: [Piece] = [.copy(0..<open)]
        for edits in generations {
            var cursor = 0
            for edit in edits {
                guard edit.utf8Range.lowerBound >= cursor, (edit.lineage ?? []).isEmpty, (edit.copies ?? []).isEmpty else {
                    throw WorkspacePatchError.invalidRange(edit.utf8Range)
                }
                cursor = edit.utf8Range.upperBound
            }
            // Split the pieces at every edit boundary so no piece straddles one.
            let boundaries = Set(edits.flatMap { [$0.utf8Range.lowerBound, $0.utf8Range.upperBound] }).sorted()
            var split: [Piece] = []
            var position = 0, next = 0
            for piece in pieces {
                var start = position, remaining = piece
                while next < boundaries.count, boundaries[next] <= start { next += 1 }
                while next < boundaries.count, boundaries[next] < start + remaining.size {
                    let at = boundaries[next] - start
                    switch remaining {
                    case let .copy(range):
                        split.append(.copy(range.lowerBound..<(range.lowerBound + at)))
                        remaining = .copy((range.lowerBound + at)..<range.upperBound)
                    case let .text(data):
                        split.append(.text(data.prefix(at)))
                        remaining = .text(data.dropFirst(at))
                    }
                    start += at; next += 1
                }
                split.append(remaining)
                position += piece.size
            }
            // Walk the split pieces, dropping what each edit replaces and inserting its text.
            var applied: [Piece] = []
            var index = 0, skipUntil = 0
            position = 0
            func flush() {
                while index < edits.count, edits[index].utf8Range.lowerBound == position {
                    let edit = edits[index]; index += 1
                    if !edit.replacement.isEmpty { applied.append(.text(Data(edit.replacement.utf8))) }
                    skipUntil = max(skipUntil, edit.utf8Range.upperBound)
                }
            }
            for piece in split {
                flush()
                if position >= skipUntil, piece.size > 0 { applied.append(piece) }
                position += piece.size
            }
            flush()
            guard index == edits.count else { throw WorkspacePatchError.invalidRange(edits[index].utf8Range) }
            pieces = applied
        }
        // Read the pieces back as edits over the original: every gap between
        // copied ranges, together with the text inserted there, is one edit.
        var composed: [WorkspaceSourceEdit] = []
        var base = 0
        var inserted = Data()
        func emit(_ end: Int) throws {
            if end > base || !inserted.isEmpty {
                guard let text = String(data: inserted, encoding: .utf8) else { throw WorkspacePatchError.invalidUTF8 }
                composed.append(WorkspaceSourceEdit(utf8Range: base..<end, replacement: text))
                inserted = Data()
            }
        }
        for piece in pieces {
            switch piece {
            case let .text(data): inserted.append(data)
            case let .copy(range): try emit(range.lowerBound); base = range.upperBound
            }
        }
        guard base == open else { throw WorkspacePatchError.invalidRange(base..<open) }
        return composed
    }
}

public struct WorkspaceDocumentPatch: Hashable, Codable, Sendable {
    public var baseContentRevision: String
    public var edits: [WorkspaceSourceEdit]

    public init(baseContentRevision: String, edits: [WorkspaceSourceEdit]) {
        self.baseContentRevision = baseContentRevision
        self.edits = edits
    }

    public func applying(to source: String) throws -> String {
        let original = Data(source.utf8)
        var priorEnd = 0
        for edit in edits {
            guard edit.utf8Range.lowerBound >= priorEnd,
                  edit.utf8Range.lowerBound >= 0,
                  edit.utf8Range.upperBound >= edit.utf8Range.lowerBound,
                  edit.utf8Range.upperBound <= original.count else {
                throw WorkspacePatchError.invalidRange(edit.utf8Range)
            }
            if let expected = edit.expected,
               original.subdata(in: edit.utf8Range) != Data(expected.utf8) {
                throw WorkspacePatchError.guardMismatch(edit.utf8Range)
            }
            let replacement = Data(edit.replacement.utf8)
            var outputEnd = 0
            var preserved: [Range<Int>] = []
            for part in edit.lineage ?? [] {
                guard part.document == nil, part.source.lowerBound >= edit.utf8Range.lowerBound,
                      part.source.upperBound <= edit.utf8Range.upperBound,
                      part.replacement.lowerBound >= outputEnd,
                      part.replacement.upperBound <= replacement.count,
                      part.source.count == part.replacement.count,
                      !preserved.contains(where: { $0.overlaps(part.source) }),
                      [part.source.lowerBound, part.source.upperBound].allSatisfy({ $0 == original.count || original[$0] & 0xc0 != 0x80 }),
                      [part.replacement.lowerBound, part.replacement.upperBound].allSatisfy({ $0 == replacement.count || replacement[$0] & 0xc0 != 0x80 }),
                      original.subdata(in: part.source) == replacement.subdata(in: part.replacement),
                      String(data: original.subdata(in: part.source), encoding: .utf8) != nil else {
                    throw WorkspacePatchError.invalidRange(part.source)
                }
                preserved.append(part.source); outputEnd = part.replacement.upperBound
            }
            var copiedEnd = 0
            for part in edit.copies ?? [] {
                let original = part.document.map { Data($0.source.utf8) } ?? original
                guard part.source.lowerBound >= 0, part.source.upperBound <= original.count,
                      !part.source.isEmpty, part.source.count == part.replacement.count,
                      part.replacement.lowerBound >= copiedEnd, part.replacement.upperBound <= replacement.count,
                      !(edit.lineage ?? []).contains(where: { $0.replacement.overlaps(part.replacement) }),
                      [part.source.lowerBound,part.source.upperBound].allSatisfy({ $0 == original.count || original[$0] & 0xc0 != 0x80 }),
                      [part.replacement.lowerBound,part.replacement.upperBound].allSatisfy({ $0 == replacement.count || replacement[$0] & 0xc0 != 0x80 }),
                      original.subdata(in:part.source) == replacement.subdata(in:part.replacement) else {
                    throw WorkspacePatchError.invalidRange(part.source)
                }
                copiedEnd = part.replacement.upperBound
            }
            priorEnd = edit.utf8Range.upperBound
        }

        let growth = edits.reduce(0) { $0 + $1.replacement.utf8.count - $1.utf8Range.count }
        var result = Data()
        result.reserveCapacity(max(0, original.count + growth))
        var cursor = 0
        for edit in edits {
            result.append(original.subdata(in: cursor..<edit.utf8Range.lowerBound))
            result.append(Data(edit.replacement.utf8))
            cursor = edit.utf8Range.upperBound
        }
        result.append(original.subdata(in: cursor..<original.count))
        guard let value = String(data: result, encoding: .utf8) else { throw WorkspacePatchError.invalidUTF8 }
        return value
    }
}

/// One editor generation inside a coalesced intent: the patch captured against
/// the previous generation's source and the exact source it produced.
public struct WorkspaceDocumentGeneration: Hashable, Codable, Sendable {
    public var patch: WorkspaceDocumentPatch
    public var source: String
    public init(patch: WorkspaceDocumentPatch, source: String) { self.patch = patch; self.source = source }
}

/// Exact authored source and its guarded edit, independent of the session's latest projection.
/// A provider must bind this basis to retained tree history before publishing it.
///
/// `patch` always takes the basis to `source` in one step; it is what a
/// provider without frame support applies and what a delta is built from.
/// `generations`, when present, is the same change as the editor captured it:
/// one patch per generation, each against the source the previous one
/// produced, ending at `source`. A publication queue emits one frame per
/// generation from it (spec/09), so no claim is ever re-derived across
/// generations.
public struct WorkspaceDocumentIntent: Hashable, Codable, Sendable {
    public let basis: WorkspaceDocumentSnapshot
    public let patch: WorkspaceDocumentPatch
    public let source: String
    public let generations: [WorkspaceDocumentGeneration]

    public init(basis: WorkspaceDocumentSnapshot, patch: WorkspaceDocumentPatch, source: String,
                generations: [WorkspaceDocumentGeneration] = []) throws {
        self.basis = basis
        self.patch = patch
        self.source = source
        self.generations = generations
        try validate()
    }

    private enum CodingKeys: String, CodingKey { case basis, patch, source, generations }

    public init(from decoder: any Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        try self.init(basis: values.decode(WorkspaceDocumentSnapshot.self, forKey: .basis),
                      patch: values.decode(WorkspaceDocumentPatch.self, forKey: .patch),
                      source: values.decode(String.self, forKey: .source),
                      generations: values.decodeIfPresent([WorkspaceDocumentGeneration].self, forKey: .generations) ?? [])
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(basis, forKey: .basis)
        try container.encode(patch, forKey: .patch)
        try container.encode(source, forKey: .source)
        if !generations.isEmpty { try container.encode(generations, forKey: .generations) }
    }

    /// The same invariant applies to fresh intents and recovered records.
    public func validate() throws {
        guard patch.baseContentRevision == basis.contentRevision else {
            throw WorkspacePatchError.staleRevision(expected: patch.baseContentRevision, actual: basis.contentRevision)
        }
        guard try Data(patch.applying(to: basis.source).utf8) == Data(source.utf8) else {
            throw WorkspaceProviderError.invalidAction("Source intent does not produce its declared candidate")
        }
        // Every generation reproduces the next exactly and the chain ends at the candidate.
        var previous = basis.source
        for generation in generations {
            guard generation.patch.baseContentRevision == basis.contentRevision else {
                throw WorkspacePatchError.staleRevision(expected: generation.patch.baseContentRevision, actual: basis.contentRevision)
            }
            guard try Data(generation.patch.applying(to: previous).utf8) == Data(generation.source.utf8) else {
                throw WorkspaceProviderError.invalidAction("Source generation does not produce its declared source")
            }
            previous = generation.source
        }
        guard generations.isEmpty || Data(previous.utf8) == Data(source.utf8) else {
            throw WorkspaceProviderError.invalidAction("Source generations do not end at the declared candidate")
        }
    }
}

public enum WorkspacePatchError: Error, Equatable, Sendable {
    case staleRevision(expected: String, actual: String)
    case invalidRange(Range<Int>)
    case guardMismatch(Range<Int>)
    case invalidUTF8
}

public enum WorkspaceAdmissionPolicy: Sendable {
    case compareAndSwap
    case retainedBasis
}

public protocol WorkspaceDocumentSession: Actor, Sendable {
    var admissionPolicy: WorkspaceAdmissionPolicy { get }
    var identity: WorkspaceIdentity { get }
    func snapshot() async throws -> WorkspaceDocumentSnapshot
    func updates() async throws -> AsyncThrowingStream<WorkspaceDocumentSnapshot, Error>
    func admit(source: String, baseContentRevision: String) async throws -> WorkspaceDocumentSnapshot
    func admit(patch: WorkspaceDocumentPatch) async throws -> WorkspaceDocumentSnapshot
    func admit(intent: WorkspaceDocumentIntent) async throws -> WorkspaceDocumentSnapshot
    func flush() async throws
    func createForEditor(parent: WorkspaceReference, name: String, source: String, transaction: String) async throws -> WorkspaceNode?
    func copyDocument() async throws -> WorkspaceCopyDocument?
    func history() async throws -> [WorkspaceHistoryEntry]
    func recover(revision: String) async throws -> WorkspaceDocumentSnapshot
    func close() async
}

public extension WorkspaceDocumentSession {
    func createForEditor(parent: WorkspaceReference, name: String, source: String, transaction: String) async throws -> WorkspaceNode? { nil }
    func copyDocument() async throws -> WorkspaceCopyDocument? { nil }
    var admissionPolicy: WorkspaceAdmissionPolicy { .compareAndSwap }
    /// Compatibility bridge for existing providers. It preserves their rejection/recovery
    /// behavior until their publication queues support independently retained bases.
    func admit(intent: WorkspaceDocumentIntent) async throws -> WorkspaceDocumentSnapshot {
        try intent.validate()
        guard intent.basis.reference.identity == identity else {
            throw WorkspaceProviderError.invalidAction("Source intent belongs to another document")
        }
        do {
            return try await admit(patch: intent.patch)
        } catch let conflict as WorkspaceDocumentConflict {
            // Older providers may try to reconstruct the submitted text from
            // their newer projection. The captured intent is authoritative.
            throw WorkspaceDocumentConflict(base: intent.basis, current: conflict.current,
                                            submittedSource: intent.source)
        }
    }

    func updates() async throws -> AsyncThrowingStream<WorkspaceDocumentSnapshot, Error> {
        AsyncThrowingStream { continuation in continuation.finish() }
    }

    func admit(patch: WorkspaceDocumentPatch) async throws -> WorkspaceDocumentSnapshot {
        let current = try await snapshot()
        guard current.contentRevision == patch.baseContentRevision else {
            throw WorkspacePatchError.staleRevision(expected: patch.baseContentRevision, actual: current.contentRevision)
        }
        return try await admit(
            source: patch.applying(to: current.source),
            baseContentRevision: patch.baseContentRevision
        )
    }
}

public protocol WorkspaceProvider: Sendable {
    func capabilities() async -> WorkspaceProviderCapabilities
    func resolve(_ reference: WorkspaceReference) async throws -> WorkspaceNode
    func children(of reference: WorkspaceReference) async throws -> [WorkspaceNode]
    func resolve(_ location: WorkspaceLocation) async throws -> WorkspaceNode
    func children(of location: WorkspaceLocation) async throws -> [WorkspaceNode]
    func search(_ query: String, in tree: TreeID) async throws -> [WorkspaceSearchResult]
    func backlinks(to reference: WorkspaceReference) async throws -> [WorkspaceSearchResult]
    func perform(_ action: WorkspaceStructuralAction) async throws -> WorkspaceNode?
    func store(asset: WorkspaceAsset, in parent: WorkspaceReference) async throws -> WorkspaceStoredAsset
    func readFile(_ reference: WorkspaceReference) async throws -> Data
    func openDocument(_ reference: WorkspaceReference) async throws -> any WorkspaceDocumentSession
}

public extension WorkspaceProvider {
    func capabilities() async -> WorkspaceProviderCapabilities { .full }

    func resolve(_ location: WorkspaceLocation) async throws -> WorkspaceNode {
        guard case let .reference(reference) = location else {
            throw WorkspaceProviderError.invalidAction("This provider does not support \(location.path)")
        }
        return try await resolve(reference)
    }

    func children(of location: WorkspaceLocation) async throws -> [WorkspaceNode] {
        guard case let .reference(reference) = location else {
            throw WorkspaceProviderError.invalidAction("This provider does not support \(location.path)")
        }
        return try await children(of: reference)
    }
}

public enum WorkspaceProviderError: LocalizedError, Equatable, Sendable {
    case notFound(WorkspaceReference)
    case notDocument(WorkspaceReference)
    case readOnly(WorkspaceReference)
    case invalidAction(String)

    public var errorDescription: String? {
        switch self {
        case .notFound(let reference):
            return "The item at \(reference.path) could not be found."
        case .notDocument(let reference):
            return "The item at \(reference.path) is not a document."
        case .readOnly(let reference):
            return "The item at \(reference.path) is read-only."
        case .invalidAction(let reason):
            return reason
        }
    }
}
