import Foundation
import Testing
@testable import CanopyAppKit

@Suite("Draft document session")
struct DraftDocumentSessionTests {
    private let parent = WorkspaceReference(tree: "tr_draft", path: "/notes")

    /// The session of the page created from `draft`, holding `source`.
    private func created(from draft: DraftDocumentSession, name: String, source: String) async throws -> InMemoryDocumentSession {
        let reference = WorkspaceReference(tree: parent.tree, path: "\(parent.path)/\(name)", stableKey: markdownStableKey(draft.pageID))
        return InMemoryDocumentSession(snapshot: .init(reference: reference, source: source, contentRevision: "r1"))
    }

    @Test("A draft starts as an empty H1 under its PageID and keeps edits in memory")
    func startsEmpty() async throws {
        let draft = DraftDocumentSession(parent: parent, pageID: "pg_draft")
        let opened = try await draft.snapshot()
        #expect(opened.source == "---\nid: pg_draft\n---\n\n# \n")
        #expect(opened.reference.identity == .key(tree: parent.tree, stableKey: markdownStableKey("pg_draft")))
        #expect(DraftDocumentSession.title(in: opened.source) == nil)

        let edited = try await draft.admit(source: "---\nid: pg_draft\n---\n\n# Plans\n", baseContentRevision: opened.contentRevision)
        #expect(edited.contentRevision != opened.contentRevision)
        #expect(DraftDocumentSession.title(in: edited.source) == "Plans")
        #expect(await draft.isPromoted == false)
        await #expect(throws: WorkspaceDocumentConflict.self) {
            try await draft.admit(source: "stale", baseContentRevision: opened.contentRevision)
        }
    }

    @Test("Only a leading H1 with text is a title")
    func titles() {
        #expect(DraftDocumentSession.title(in: "# Plans\n\nBody\n") == "Plans")
        #expect(DraftDocumentSession.title(in: "---\nid: pg_x\n---\n\n#   \n") == nil)
        #expect(DraftDocumentSession.title(in: "Body\n\n# Later\n") == nil)
        #expect(DraftDocumentSession.title(in: "## Plans\n") == nil)
        #expect(DraftDocumentSession.title(in: "# **Bold** plans\n") == "Bold plans")
    }

    @Test("Promotion carries over edits made after the page was created and forwards later changes")
    func promotion() async throws {
        let draft = DraftDocumentSession(parent: parent, pageID: "pg_draft")
        let opened = try await draft.snapshot()
        let titled = try await draft.admit(source: "---\nid: pg_draft\n---\n\n# Plans\n", baseContentRevision: opened.contentRevision)
        // The page is created from `titled`; the editor keeps typing meanwhile.
        let page = try await created(from: draft, name: "Plans", source: titled.source)
        let typed = try await draft.admit(source: titled.source + "\nFirst\n", baseContentRevision: titled.contentRevision)

        let promoted = try await draft.promote(to: page)
        #expect(promoted.source == typed.source)
        #expect(promoted.reference.path == "/notes/Plans")
        #expect(await draft.isPromoted)
        #expect(try await page.snapshot().source == typed.source)

        // The editor's next change is still stated against the draft.
        let next = try await draft.admit(source: typed.source + "Second\n", baseContentRevision: typed.contentRevision)
        #expect(next.reference.path == "/notes/Plans")
        #expect(try await page.snapshot().source == typed.source + "Second\n")
        // Then against the created page's own revisions.
        let last = try await draft.admit(source: next.source + "Third\n", baseContentRevision: next.contentRevision)
        #expect(try await page.snapshot() == last)
        #expect(try await draft.snapshot() == last)
    }

    @Test("A change stated as an intent against the draft lands on the created page")
    func intentAfterPromotion() async throws {
        let draft = DraftDocumentSession(parent: parent, pageID: "pg_draft")
        let opened = try await draft.snapshot()
        let titled = try await draft.admit(source: opened.source.replacingOccurrences(of: "# \n", with: "# Plans\n"),
                                           baseContentRevision: opened.contentRevision)
        let page = try await created(from: draft, name: "Plans", source: titled.source)
        try await draft.promote(to: page)

        let end = titled.source.utf8.count
        let patch = WorkspaceDocumentPatch(baseContentRevision: titled.contentRevision,
                                           edits: [.init(utf8Range: end..<end, replacement: "\nBody\n")])
        let intent = try WorkspaceDocumentIntent(basis: titled, patch: patch, source: titled.source + "\nBody\n")
        let admitted = try await draft.admit(intent: intent)
        #expect(admitted.source == titled.source + "\nBody\n")
        #expect(try await page.snapshot().source == admitted.source)
    }

    @Test("A session for another page is refused")
    func refusesAnotherPage() async throws {
        let draft = DraftDocumentSession(parent: parent, pageID: "pg_draft")
        let other = InMemoryDocumentSession(snapshot: .init(
            reference: WorkspaceReference(tree: parent.tree, path: "/notes/Other", stableKey: markdownStableKey("pg_other")),
            source: "# Other\n",
            contentRevision: "r1"
        ))
        await #expect(throws: WorkspaceProviderError.self) { try await draft.promote(to: other) }
        #expect(await draft.isPromoted == false)
    }
}
