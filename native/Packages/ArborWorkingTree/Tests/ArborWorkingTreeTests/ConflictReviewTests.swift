import ArborWire
import Foundation
import Testing
@testable import ArborWorkingTree

@Suite("Accepted choice review")
struct ConflictReviewTests {
    private func inspection(state: String = "accepted-1", dependencies: [String] = []) throws -> ConflictReviewSnapshot {
        let root = "sha256:" + String(repeating: "a", count: 64)
        let parent: [String: Any] = ["material": ["kind": "basis", "path": "/", "object": root], "within": ["nested"]]
        let alternatives: [[String: Any]] = (0..<3).map { index in
            ["id": "alternative-\(index)", "revision": "revision-\(index)",
             "value": ["file": "sha256:" + String(repeating: String(index), count: 64)],
             "placement": ["parent": parent, "name": "page.md"], "contributions": []]
        }
        let data = try JSONSerialization.data(withJSONObject: ["tree": "tr_review", "state": state, "root": root, "conflicted": true,
            "decisions": [["id": "decision", "kind": "entry", "affected": [parent], "selected": "alternative-0",
                           "alternatives": alternatives, "dependencies": dependencies, "actions": ["resolveConflict"]]], "next": NSNull()])
        // Apply the Wire validator before consuming its extensible read contract.
        let page = try JSONDecoder().decode(WireDecisionPageContract.self, from: data)
        guard case let .array(decisions) = page.fields["decisions"] else { throw ConflictReviewError.unavailable }
        return .init(tree: "tr_review", state: state, root: root, decisions: try decisions.map {
            try JSONDecoder().decode(ConflictReviewDecision.self, from: JSONEncoder().encode($0))
        })
    }

    @Test("Review exposes all alternatives and complete nested scope")
    func alternatives() throws {
        let snapshot = try inspection()
        let decision = try #require(snapshot.decisions.first)
        #expect(decision.path == "/nested/page.md")
        #expect(decision.alternatives.count == 3)
        #expect(decision.supportsIndependentResolution)
        #expect(try inspection(dependencies: ["other-choice"]).decisions.first?.supportsIndependentResolution == false)
    }

    @Test("Equal projection bytes do not retarget an older draft's accepted-state guard")
    func stateIdentity() throws {
        let old = try inspection()
        let draft = ConflictReviewDraft(snapshot: old, decision: old.decisions[0], alternative: "alternative-1", source: "Retained draft")
        let next = try inspection(state: "accepted-2")
        #expect(old.root == next.root)
        #expect(draft.isCurrent(in: old))
        #expect(!draft.isCurrent(in: next))
        let composed = try inspection(state: "accepted-é")
        let decomposed = try inspection(state: "accepted-e\u{301}")
        #expect(!ConflictReviewDraft(snapshot: composed, decision: composed.decisions[0], alternative: "alternative-0").isCurrent(in: decomposed))
    }

    @Test("A draft rebases onto a new accepted state only when its evidence is unchanged")
    func rebaseUnchangedEvidence() throws {
        let old = try inspection()
        var draft = ConflictReviewDraft(snapshot: old, decision: old.decisions[0], alternative: "alternative-1", source: "Composed")
        draft.remove = false
        let next = try inspection(state: "accepted-2")
        let rebased = try #require(draft.rebased(onto: next))
        #expect(rebased.isCurrent(in: next))
        #expect(rebased.selection(for: draft.id) == draft.selection(for: draft.id))
        #expect(draft.rebased(onto: try inspection(state: "accepted-2", dependencies: ["other-choice"])) == nil)
    }

    @Test("Durable draft round trips preserve whitespace, line endings and scalar spelling")
    func draftRecovery() throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "review-draft-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let snapshot = try inspection()
        let source = "  Cafe\u{301}\r\n\tCafé  \r\n"
        let draft = ConflictReviewDraft(snapshot: snapshot, decision: snapshot.decisions[0], alternative: "alternative-2", source: source)
        let files = try UpdateControlFiles(root: root)
        try files.writeReview(.init(drafts: [draft]))
        let reopened = try UpdateControlFiles(root: root).loadReview()
        #expect(reopened.drafts.count == 1)
        #expect(reopened.drafts[0].source.map { Data($0.utf8) } == Data(source.utf8))
        #expect(reopened.drafts[0].snapshot.state == snapshot.state)
        #expect(reopened.drafts[0].decision.alternatives == draft.decision.alternatives)
    }
}
