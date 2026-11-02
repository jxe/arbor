import XCTest
@testable import StoryKit

final class CrossTreeMoveTests: XCTestCase {
    private let move = CrossTreePageMove(
        sourceTree: "tr_todos",
        sourceRoot: "/Work/Plan",
        destinationTree: "tr_shared",
        destinationRoot: "/Plan"
    )

    func testAMovedPagesIDIsReadFromItsFrontmatter() {
        XCTAssertEqual(CrossTreePageMove.pageID(in: "---\nid: pg_1\n---\n\n# Plan\n"), "pg_1")
        XCTAssertNil(CrossTreePageMove.pageID(in: "# Plan\n\nid: pg_1\n"))
    }

    func testPathsUnderThePageMoveAndOthersStay() {
        XCTAssertTrue(move.moves("/Work/Plan"))
        XCTAssertTrue(move.moves("/Work/Plan/Agenda"))
        XCTAssertFalse(move.moves("/Work/Planning"))
        XCTAssertFalse(move.moves("/Work"))
        XCTAssertEqual(move.destinationPath(of: "/Work/Plan"), "/Plan")
        XCTAssertEqual(move.destinationPath(of: "/Work/Plan.md"), "/Plan.md")
        XCTAssertEqual(move.destinationPath(of: "/Work/Plan/Agenda.md"), "/Plan/Agenda.md")
        XCTAssertEqual(move.destinationPath(of: "/Work/Plan/_index.md"), "/Plan/_index.md")
        XCTAssertNil(move.destinationPath(of: "/Work/Planning.md"))
    }

    func testAMovedPageKeepsLinksAmongMovedPagesAndPointsTheRestBack() {
        let source = "See [agenda](Plan/Agenda.md) and [budget](Budget.md#overstory-key=id:b1) and [web](https://example.org).\n"
        let moved = move.movedSource(source, sourceDirectory: "/Work")
        XCTAssertEqual(moved, "See [agenda](Plan/Agenda.md) and [budget](overstory://tr_todos/Work/Budget;overstory-key=id:b1) and [web](https://example.org).\n")
        XCTAssertEqual(move.linksLeaving(source, sourceDirectory: "/Work"), ["/Work/Budget"])
    }

    func testASubpageLinkingUpToItsPageStaysRelative() {
        let source = "[up](../Plan.md) [other](../../Home.md)\n"
        XCTAssertEqual(move.movedSource(source, sourceDirectory: "/Work/Plan"),
                       "[up](../Plan.md) [other](overstory://tr_todos/Home)\n")
    }

    func testStayingPagesPointAtTheNewTree() {
        let source = "- [Plan](Work/Plan.md)\n- [Agenda](Work/Plan/Agenda.md#overstory-key=id:a1)\n- [Other](Work/Other.md)\n"
        let edits = move.retargetingEdits(source, sourceDirectory: "/")
        XCTAssertEqual(edits.map(\.replacement), [
            "overstory://tr_shared/Plan",
            "overstory://tr_shared/Plan/Agenda;overstory-key=id:a1",
        ])
        XCTAssertTrue(move.linksToRoot(source, sourceDirectory: "/"))
        XCTAssertFalse(move.linksToRoot("[Other](Work/Other.md)", sourceDirectory: "/"))
        XCTAssertEqual(move.destinationLocator, "overstory://tr_shared/Plan")
    }

    func testASameTreeLocatorIsRetargetedToo() {
        let source = "[Plan](overstory://tr_todos/Work/Plan)\n"
        XCTAssertEqual(move.retargetingEdits(source, sourceDirectory: "/").map(\.replacement), ["overstory://tr_shared/Plan"])
    }
}
