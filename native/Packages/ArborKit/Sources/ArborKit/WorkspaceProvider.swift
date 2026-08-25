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
    public var current: WorkspaceDocumentSnapshot
    public var submittedSource: String

    public init(current: WorkspaceDocumentSnapshot, submittedSource: String) {
        self.current = current
        self.submittedSource = submittedSource
    }
}

public struct WorkspaceSourceEdit: Hashable, Codable, Sendable {
    public var utf8Range: Range<Int>
    public var replacement: String
    public var expected: String?

    public init(utf8Range: Range<Int>, replacement: String, expected: String? = nil) {
        self.utf8Range = utf8Range
        self.replacement = replacement
        self.expected = expected
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

public enum WorkspacePatchError: Error, Equatable, Sendable {
    case staleRevision(expected: String, actual: String)
    case invalidRange(Range<Int>)
    case guardMismatch(Range<Int>)
    case invalidUTF8
}

public protocol WorkspaceDocumentSession: Actor, Sendable {
    var identity: WorkspaceIdentity { get }
    func snapshot() async throws -> WorkspaceDocumentSnapshot
    func updates() async throws -> AsyncThrowingStream<WorkspaceDocumentSnapshot, Error>
    func admit(source: String, baseContentRevision: String) async throws -> WorkspaceDocumentSnapshot
    func admit(patch: WorkspaceDocumentPatch) async throws -> WorkspaceDocumentSnapshot
    func flush() async throws
    func history() async throws -> [WorkspaceHistoryEntry]
    func recover(revision: String) async throws -> WorkspaceDocumentSnapshot
    func close() async
}

public extension WorkspaceDocumentSession {
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
    func search(_ query: String, in tree: TreeID) async throws -> [WorkspaceSearchResult]
    func backlinks(to reference: WorkspaceReference) async throws -> [WorkspaceSearchResult]
    func perform(_ action: WorkspaceStructuralAction) async throws -> WorkspaceNode?
    func store(asset: WorkspaceAsset, in parent: WorkspaceReference) async throws -> WorkspaceStoredAsset
    func readFile(_ reference: WorkspaceReference) async throws -> Data
    func openDocument(_ reference: WorkspaceReference) async throws -> any WorkspaceDocumentSession
}

public extension WorkspaceProvider {
    func capabilities() async -> WorkspaceProviderCapabilities { .full }
}

public enum WorkspaceProviderError: Error, Equatable, Sendable {
    case notFound(WorkspaceReference)
    case notDocument(WorkspaceReference)
    case readOnly(WorkspaceReference)
    case invalidAction(String)
}
