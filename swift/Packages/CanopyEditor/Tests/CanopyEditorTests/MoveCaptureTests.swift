import CanopyAppKit
@testable import CanopyEditor
import Foundation
import Quagmire
import Testing

@MainActor
@Test("Cached move validation preserves exact patches across repeated rearrangements", arguments: [
    "Same\n\nSame\n\nThird\n\nLast\n\n",
    "---\r\ntitle: Test\r\n---\r\n\r\nCafé **bold**\r\n\r\nCafe\u{301} [link](other.md)\r\n\r\nLast\r\n\r\n",
    "# First\n\nText *one*\n\n## Child\n\nChild text\n\n# Second\n\nSecond text\n\n# Third\n\nLast text\n\n",
    "- First **item**\n  - Nested\n- Second\n- Third\n",
    "```swift\nlet n = 1\n```\n\n<table>raw</table>\n\n![image](asset.png)\n\nParagraph\n\n",
    "First\n\n\nSecond\n\nThird\n\nFourth\n"
])
func cachedMoveMatchesFullParse(source: String) throws {
    let opened = CanopyMarkdownCodec.open(source: source, revision: "r", identitySeed: "cache-equivalence")
    let document = Document(id: DocumentID("cache"), children: opened.blocks)
    var movable: [BlockID] = []
    document.walk { block, _, _ in
        if document.canSlideSiblings([block.id], by: 1) { movable.append(block.id) }
    }
    let selected = try #require(movable.first)
    var ledger = opened.ledger
    var captures = 0
    document.didCommitTransaction = { _ in
        var uncached = ledger
        uncached.parsedKinds = [:]
        let cold = CanopyMarkdownCodec.admission(blocks: document.children, ledger: uncached, moved: document.movedBlocksForCurrentCommit)
        let warm = CanopyMarkdownCodec.admission(blocks: document.children, ledger: ledger, moved: document.movedBlocksForCurrentCommit)
        #expect(warm.0.patch == cold.0.patch)
        #expect(warm.0.source.utf8.elementsEqual(cold.0.source.utf8))
        if warm.0.patch.moves?.isEmpty == false {
            #expect(warm.1.parsedKinds == cold.1.parsedKinds)
        }
        #expect(Set(warm.1.records.keys) == Set(cold.1.records.keys))
        for (id, record) in warm.1.records {
            #expect(record.range == cold.1.records[id]?.range)
            #expect(record.raw.utf8.elementsEqual(cold.1.records[id]!.raw.utf8))
        }
        ledger = warm.1
        captures += 1
    }
    for direction in [1, 1, -1, -1] {
        if document.canSlideSiblings([selected], by: direction) {
            document.transaction(name: "Move") { _ = document.slideSiblings([selected], by: direction) }
        }
    }
    #expect(captures >= 2)
    // A changed leaf must not inherit its previous parse.
    document.transaction(name: "Edit") {
        document.mutate(selected) { $0.kind = .paragraph(text: AttributedString("Changed **literal** text")) }
    }
}

@MainActor @Test("Ordinary captures retain validated leaves without caching unparsed edits")
func editThenMoveKeepsCachedLeaves() throws {
    let original = "First **bold**\n\nSecond [link](page)\n\nThird\n\n"
    let opened = CanopyMarkdownCodec.open(source: original, revision: "r", identitySeed: "edit-move")
    let document = Document(id: DocumentID("edit-move"), children: opened.blocks)
    let edited = opened.blocks[0].id
    var ledger = opened.ledger
    for index in 0..<20 {
        document.mutate(edited) { $0.kind = .paragraph(text: AttributedString("Changed \(index) **literal** text")) }
        let (captured, next) = CanopyMarkdownCodec.admission(blocks: document.children, ledger: ledger)
        #expect(try captured.patch.applying(to: ledger.source) == captured.source)
        #expect(next.parsedKinds == opened.ledger.parsedKinds)
        ledger = next
    }
    document.transaction(name: "Move") { _ = document.slideSiblings([edited], by: 1) }
    var uncached = ledger
    uncached.parsedKinds = [:]
    let cold = CanopyMarkdownCodec.admission(blocks: document.children, ledger: uncached, moved: [edited])
    let warm = CanopyMarkdownCodec.admission(blocks: document.children, ledger: ledger, moved: [edited])
    #expect(warm.0.patch == cold.0.patch)
    #expect(warm.0.patch.moves?.count == 1)
    #expect(warm.0.source.utf8.elementsEqual(cold.0.source.utf8))
    #expect(warm.1.parsedKinds == cold.1.parsedKinds)
    #expect(warm.1.parsedKinds[Data("First **bold**\n".utf8)] == nil)
    #expect(warm.1.parsedKinds[Data("Second [link](page)\n".utf8)] != nil)
}

@Test("Cached replacements match a fresh parse when boundaries, nesting or bytes change", arguments: [
    ("First\n\nSecond\n\n", "First\nSecond\n\n"),
    ("# Title\n\n## Section\n\nBody **bold**\n\n", "# Title\n\nSection\n\nBody **bold**\n\n"),
    ("- Parent\n  - Child\n- Last\n", "- Parent\n- Child\n- Last\n"),
    ("```swift\nText\n```\n\nAfter\n", "Text\n\nAfter\n"),
    ("---\r\ntitle: Old\r\n---\r\n\r\nCafé\r\n\r\nCafe\u{301}\r\n\r\n", "---\r\ntitle: New\r\n---\r\n\r\nCafe\u{301}\r\n\r\nCafé\r\n\r\n"),
    ("Same\n\nSame\n\n<table>raw</table>\n", "Same\n\n\n<table>raw</table>\n\nSame\n")
])
func cachedReplacementMatchesFreshParse(pair: (String, String)) {
    let previous = CanopyMarkdownCodec.open(source: pair.0, revision: "r0", identitySeed: "before")
    let cold = CanopyMarkdownCodec.open(source: pair.1, revision: "r1", identitySeed: "after")
    let warm = CanopyMarkdownCodec.open(source: pair.1, revision: "r1", identitySeed: "after", reusing: previous.ledger.parsedKinds)
    #expect(warm.blocks == cold.blocks)
    #expect(warm.ledger.source.utf8.elementsEqual(cold.ledger.source.utf8))
    #expect(warm.ledger.envelope == cold.ledger.envelope)
    #expect(warm.ledger.parsedKinds == cold.ledger.parsedKinds)
    #expect(Set(warm.ledger.records.keys) == Set(cold.ledger.records.keys))
    for (id, record) in warm.ledger.records {
        #expect(record.block == cold.ledger.records[id]?.block)
        #expect(record.depth == cold.ledger.records[id]?.depth)
        #expect(record.indent == cold.ledger.records[id]?.indent)
        #expect(record.range == cold.ledger.records[id]?.range)
        #expect(record.raw.utf8.elementsEqual(cold.ledger.records[id]!.raw.utf8))
    }
    // Removed material must not accumulate through a sequence of replacements.
    let empty = CanopyMarkdownCodec.open(source: "", revision: "r2", identitySeed: "after", reusing: warm.ledger.parsedKinds)
    #expect(empty.ledger.parsedKinds.isEmpty)
}

@MainActor @Test("A binding retains parses across typing and refreshes them on accepted replacement")
func bindingCacheSurvivesEditAndReplacement() async throws {
    let reference = WorkspaceReference(tree: "tr_cache", path: "/note")
    let original = "First **bold**\n\nSecond [link](page)\n\nThird\n\n"
    let session = InMemoryDocumentSession(snapshot: .init(reference: reference, source: original, contentRevision: "r0"))
    let binding = try await CanopyDocumentBinding.open(reference: reference, session: session)
    let initialCache = binding.ledger.parsedKinds
    let kept = binding.document.children[1].id
    binding.document.setText(binding.document.children[0].id, AttributedString("Local edit"))
    binding.appendCurrentGeneration()
    await binding.flush()
    #expect(binding.ledger.parsedKinds == initialCache)
    let base = try await session.snapshot()
    let replacement = "Second [link](page)\n\nExternally added\n\n"
    let accepted = try await session.admit(source: replacement, baseContentRevision: base.contentRevision)
    await binding.applyAcceptedReplacement(accepted)
    #expect(binding.ledger.source == replacement)
    #expect(binding.document.children.first?.id == kept)
    let fresh = CanopyMarkdownCodec.open(source: replacement, revision: accepted.contentRevision, identitySeed: "comparison")
    #expect(binding.ledger.parsedKinds == fresh.ledger.parsedKinds)
    #expect(binding.ledger.parsedKinds[Data("First **bold**\n".utf8)] == nil)
    #expect(binding.lastError == nil)
    await binding.close()
}
