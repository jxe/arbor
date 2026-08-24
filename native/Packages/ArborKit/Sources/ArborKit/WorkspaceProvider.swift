import Foundation

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

public protocol WorkspaceDocumentSession: Actor, Sendable {
    var identity: WorkspaceIdentity { get }
    func snapshot() async throws -> WorkspaceDocumentSnapshot
    func admit(source: String, baseContentRevision: String) async throws -> WorkspaceDocumentSnapshot
    func flush() async throws
    func history() async throws -> [WorkspaceHistoryEntry]
    func recover(revision: String) async throws -> WorkspaceDocumentSnapshot
    func close() async
}

public protocol WorkspaceProvider: Sendable {
    func resolve(_ reference: WorkspaceReference) async throws -> WorkspaceNode
    func children(of reference: WorkspaceReference) async throws -> [WorkspaceNode]
    func search(_ query: String, in tree: TreeID) async throws -> [WorkspaceSearchResult]
    func backlinks(to reference: WorkspaceReference) async throws -> [WorkspaceSearchResult]
    func perform(_ action: WorkspaceStructuralAction) async throws -> WorkspaceNode?
    func store(asset: WorkspaceAsset, in parent: WorkspaceReference) async throws -> WorkspaceReference
    func openDocument(_ reference: WorkspaceReference) async throws -> any WorkspaceDocumentSession
}

public enum WorkspaceProviderError: Error, Equatable, Sendable {
    case notFound(WorkspaceReference)
    case notDocument(WorkspaceReference)
    case readOnly(WorkspaceReference)
    case invalidAction(String)
}
