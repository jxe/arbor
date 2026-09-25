import Foundation
import XCTest
@testable import CanopyAppKit

final class LogicalURLTests: XCTestCase {
    private var conformanceFixtures: URL {
        if let path = ProcessInfo.processInfo.environment["ARBOR_PROTOCOL_FIXTURES"] {
            return URL(fileURLWithPath: path, isDirectory: true)
        }
        return URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appending(path: "../../../../../docs/overstory-spec/conformance")
            .standardizedFileURL
    }

    private func conformance<T: Decodable>(_ type: T.Type, _ name: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(contentsOf: conformanceFixtures.appending(path: name)))
    }

    private struct URLFixture: Decodable {
        struct Authority: Decodable {
            var dns: String?
            var treeID: String?
        }
        struct Expected: Decodable {
            var kind: String
            var path: String?
            var stableKey: String?
            var revision: String?
            var applicationQuery: String?
            var contentFragment: String?
            var authority: Authority?
            var raw: String?
            var href: String?
        }
        var sourceDirectory: String
        var href: String
        var expected: Expected?
        var rewriteTarget: MarkdownLinkTarget?
        var expectedRewritten: String?
    }

    func testSharedURLResolutionFixturesResolveIdentically() throws {
        let cases = try conformance([URLFixture].self, "url-resolution.json")
        XCTAssertGreaterThan(cases.count, 20)
        for fixture in cases {
            let label = "\(fixture.sourceDirectory) + \(fixture.href)"
            let resolved = resolveLogicalURL(sourceDirectory: fixture.sourceDirectory, href: fixture.href)
            guard let expected = fixture.expected else {
                XCTAssertNil(resolved, label)
                continue
            }
            switch resolved {
            case .local(let path, let locator):
                XCTAssertEqual(expected.kind, "local", label)
                XCTAssertEqual(path, expected.path, label)
                assertLocator(locator, equals: expected, label: label)
            case .arbor(let authority, let path, let locator):
                XCTAssertEqual(expected.kind, "arbor", label)
                XCTAssertEqual(path, expected.path, label)
                assertLocator(locator, equals: expected, label: label)
                switch authority {
                case .dns(let dns): XCTAssertEqual(dns, expected.authority?.dns, label)
                case .treeID(let treeID): XCTAssertEqual(treeID, expected.authority?.treeID, label)
                }
            case .system(let raw):
                XCTAssertEqual(expected.kind, "system", label)
                XCTAssertEqual(raw, expected.raw, label)
            case .overlay(let raw):
                XCTAssertEqual(expected.kind, "overlay", label)
                XCTAssertEqual(raw, expected.raw, label)
            case .external(let href):
                XCTAssertEqual(expected.kind, "external", label)
                XCTAssertEqual(href, expected.href, label)
            case .fragment(let contentFragment):
                XCTAssertEqual(expected.kind, "fragment", label)
                XCTAssertEqual(contentFragment, expected.contentFragment, label)
            case nil:
                XCTFail("Expected \(expected.kind) for \(label), resolved nil")
            }
            if let rewriteTarget = fixture.rewriteTarget {
                XCTAssertNotNil(fixture.expectedRewritten, "\(label) rewrite fixture")
                XCTAssertEqual(
                    rewriteLocalLinkPath(sourceDirectory: fixture.sourceDirectory, href: fixture.href, target: rewriteTarget),
                    fixture.expectedRewritten,
                    label
                )
            }
        }
    }

    private struct NodeTargetFixture: Decodable {
        var sourceDirectory: String
        var href: String
        var expected: ResolvedNodeTarget?
    }

    func testSharedNodeTargetFixturesResolveIdentically() throws {
        let cases = try conformance([NodeTargetFixture].self, "node-targets.json")
        XCTAssertGreaterThan(cases.count, 10)
        for fixture in cases {
            XCTAssertEqual(
                resolveNodeTarget(sourceDirectory: fixture.sourceDirectory, href: fixture.href),
                fixture.expected,
                "\(fixture.sourceDirectory) + \(fixture.href)"
            )
        }
    }

    private struct KeyTokenFixtures: Decodable {
        struct Valid: Decodable { var key: String; var token: String }
        var valid: [Valid]
        var invalid: [String]
    }

    func testSharedKeyTokensEncodeAndDecode() throws {
        let fixtures = try conformance(KeyTokenFixtures.self, "stable-key-tokens.json")
        XCTAssertFalse(fixtures.valid.isEmpty)
        for fixture in fixtures.valid {
            XCTAssertEqual(encodeStableKey(fixture.key), fixture.token, fixture.key)
            XCTAssertEqual(decodeStableKey(fixture.token), fixture.key, fixture.token)
        }
        for token in fixtures.invalid {
            XCTAssertNil(decodeStableKey(token), token)
        }
    }

    private struct SourceDirectoryFixture: Decodable {
        var path: String
        var body: MarkdownBodyOrigin?
        var sourceDirectory: String
        var linkFile: String
    }

    func testSharedSourceDirectoriesAndLinkFiles() throws {
        let cases = try conformance([SourceDirectoryFixture].self, "markdown-source-directories.json")
        XCTAssertFalse(cases.isEmpty)
        for fixture in cases {
            let label = "\(fixture.path) \(fixture.body?.rawValue ?? "null")"
            XCTAssertEqual(markdownSourceDirectory(nodePath: fixture.path, body: fixture.body), fixture.sourceDirectory, label)
            XCTAssertEqual(markdownLinkFile(nodePath: fixture.path, body: fixture.body), fixture.linkFile, label)
        }
    }

    private struct MarkdownLinkFixture: Decodable {
        var sourceDirectory: String
        var target: MarkdownLinkTarget
        var expected: String
    }

    func testSharedMarkdownLinksAreWrittenAndResolveBack() throws {
        let cases = try conformance([MarkdownLinkFixture].self, "markdown-links.json")
        XCTAssertFalse(cases.isEmpty)
        for fixture in cases {
            let label = "\(fixture.sourceDirectory) -> \(fixture.target.path)"
            XCTAssertEqual(buildMarkdownLink(from: fixture.sourceDirectory, to: fixture.target), fixture.expected, label)
            guard case let .local(path, locator) = resolveLogicalURL(sourceDirectory: fixture.sourceDirectory, href: fixture.expected) else {
                XCTFail("\(fixture.expected) does not resolve locally: \(label)")
                continue
            }
            XCTAssertEqual(path, fixture.target.path, label)
            XCTAssertEqual(locator, ResolvedLocatorState(
                stableKey: fixture.target.stableKey,
                revision: fixture.target.revision,
                applicationQuery: fixture.target.applicationQuery,
                contentFragment: fixture.target.contentFragment
            ), label)
        }
    }

    private struct HealingFixture: Decodable {
        struct Node: Decodable {
            var path: String
            var body: MarkdownBodyOrigin?
            var stableKey: String?
        }
        var name: String
        var source: String
        var resolveFrom: String
        var writeFrom: String
        var tree: String
        var nodes: [Node]
        var expected: String
    }

    func testSharedMarkdownSourcesHeal() throws {
        let cases = try conformance([HealingFixture].self, "markdown-link-healing.json")
        XCTAssertFalse(cases.isEmpty)
        for fixture in cases {
            let healed = healMarkdownLinks(
                fixture.source,
                resolveFrom: fixture.resolveFrom,
                writeFrom: fixture.writeFrom,
                tree: fixture.tree
            ) { path, stableKey in
                let node = stableKey.map { key in fixture.nodes.first { $0.stableKey == key } }
                    ?? fixture.nodes.first { $0.path == path }
                return node.map { MarkdownLinkTarget(path: $0.path, body: $0.body, stableKey: $0.stableKey) }
            }
            XCTAssertEqual(healed, fixture.expected, fixture.name)
        }
    }

    private struct DestinationFixture: Decodable {
        struct Destination: Decodable, Equatable {
            var href: String
            var image: Bool
        }
        var source: String
        var destinations: [Destination]
    }

    func testSharedLinkDestinationsAreFound() throws {
        let cases = try conformance([DestinationFixture].self, "markdown-link-destinations.json")
        XCTAssertFalse(cases.isEmpty)
        for fixture in cases {
            let found = markdownLinkDestinations(in: fixture.source)
            XCTAssertEqual(found.map { DestinationFixture.Destination(href: $0.href, image: $0.image) }, fixture.destinations, fixture.source)
            for destination in found {
                XCTAssertEqual(String(fixture.source[destination.range]), destination.href)
            }
        }
    }

    func testArborLocatorRoundTripsThroughNodeTargetResolution() throws {
        let key = markdownStableKey("x6baw0")
        let locator = try XCTUnwrap(buildArborLocator(tree: "tr_sample", path: "/notes/deep", stableKey: key))
        XCTAssertEqual(locator, "arbor://tr_sample/notes/deep;arbor-key=id:x6baw0")
        XCTAssertEqual(
            resolveNodeTarget(sourceDirectory: "/", href: locator),
            ResolvedNodeTarget(tree: "tr_sample", path: "/notes/deep", stableKey: key)
        )
        XCTAssertEqual(
            rewriteLocalLinkPath(sourceDirectory: "/", href: locator, target: MarkdownLinkTarget(path: "/new", body: .sibling)),
            "arbor://tr_sample/new;arbor-key=id:x6baw0"
        )
        XCTAssertNil(rewriteLocalLinkPath(
            sourceDirectory: "/",
            href: "arbor://example.com/old",
            target: MarkdownLinkTarget(path: "/new", body: .sibling)
        ))
    }

    func testABareFragmentIsOnlyAContentFragment() {
        XCTAssertEqual(resolveLogicalURL(sourceDirectory: "/", href: "#x7f3q2"), .fragment(contentFragment: "x7f3q2"))
        XCTAssertEqual(
            resolveLogicalURL(sourceDirectory: "/", href: "Calendar.md#h31mlm"),
            .local(path: "/Calendar", locator: ResolvedLocatorState(contentFragment: "h31mlm"))
        )
        XCTAssertNil(resolveNodeTarget(sourceDirectory: "/", href: "#x7f3q2"))
    }

    func testRelativeFileReferencesInvertResolution() {
        for (from, file, node) in [
            ("/projects/atlas", "/projects/atlas/notes.md", "/projects/atlas/notes"),
            ("/a/b/c", "/a/x/y/_index.md", "/a/x/y"),
            ("/", "/_index.md", "/"),
            ("/a", "/a", "/a"),
            ("/", "/a b/c;d.md", "/a b/c;d"),
            ("/", "/100%/é!'()*.md", "/100%/é!'()*"),
        ] {
            let reference = relativeFileReference(from: from, toFile: file)
            guard case let .local(path, _) = resolveLogicalURL(sourceDirectory: from, href: reference) else {
                XCTFail("\(from) -> \(file) wrote \(reference), which does not resolve")
                continue
            }
            XCTAssertEqual(path, node, "\(from) -> \(file)")
        }
        XCTAssertEqual(relativeFileReference(from: "/", toFile: "/100%/é!'()*.md"), "100%25/%C3%A9%21%27%28%29%2A.md")
    }

    func testPageIDStableKeysAreCanonicalForEveryCharacter() throws {
        XCTAssertEqual(markdownStableKey("a/b"), #"[["id","a/b"]]"#)
        XCTAssertEqual(markdownStableKey("é\"q"), #"[["id","é\"q"]]"#)
        for pageID in ["a/b", "é", "\u{2028}", "line\nbreak\u{1}", "\u{7f}", "tab\t\\"] {
            let key = markdownStableKey(pageID)
            XCTAssertEqual(try canonicalStableKey([("id", .string(pageID))]), key, pageID)
            XCTAssertEqual(decodeStableKey(try XCTUnwrap(encodeStableKey(key), pageID)), key, pageID)
            XCTAssertEqual(markdownID(fromStableKey: key), pageID)
        }
        XCTAssertEqual(
            try canonicalStableKey([("n", .number(1)), ("b", .bool(true)), ("s", .string("/"))]),
            #"[["n",1],["b",true],["s","/"]]"#
        )
        XCTAssertEqual(encodeStableKey(#"[["n",1],["b",true],["s","/"]]"#), "n=1,b=true,s:%2F")
        XCTAssertThrowsError(try canonicalStableKey([("n", .number(.infinity))]))
        XCTAssertThrowsError(try canonicalStableKey([("n", .null)]))
    }

    func testTreeIDsAreBase32() {
        XCTAssertTrue(TreeID.isWellFormed("tr_abc27"))
        for invalid in ["tr_", "tr_ABC", "tr_ab1", "tr_abc\n", "xtr_abc", "dv_abc"] {
            XCTAssertFalse(TreeID.isWellFormed(invalid), invalid)
        }
    }

    private func assertLocator(_ locator: ResolvedLocatorState, equals expected: URLFixture.Expected, label: String) {
        XCTAssertEqual(locator.stableKey, expected.stableKey, label)
        XCTAssertEqual(locator.revision, expected.revision, label)
        XCTAssertEqual(locator.applicationQuery, expected.applicationQuery, label)
        XCTAssertEqual(locator.contentFragment, expected.contentFragment, label)
    }

    func testKeySpellingsCarryTheSameToken() throws {
        let stableKey = #"[["id","x7f3q2"]]"#
        XCTAssertEqual(
            buildNetworkLocator(
                rawPath: "../roadmap.md",
                stableKey: stableKey,
                applicationQuery: "view=board&edit",
                contentFragment: "implementation"
            ),
            "../roadmap.md;arbor-key=id:x7f3q2?view=board&edit#implementation"
        )
        XCTAssertEqual(
            buildMarkdownLink(
                from: "/projects/atlas",
                to: MarkdownLinkTarget(path: "/projects/roadmap", body: .sibling, stableKey: stableKey, applicationQuery: "view=board&edit")
            ),
            "../roadmap.md?view=board&edit#arbor-key=id:x7f3q2"
        )
    }
}
