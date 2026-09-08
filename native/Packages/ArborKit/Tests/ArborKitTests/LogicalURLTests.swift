import Foundation
import XCTest
@testable import ArborKit

final class LogicalURLTests: XCTestCase {
    private var referenceFixtures: URL {
        if let path = ProcessInfo.processInfo.environment["ARBOR_REFERENCE_FIXTURES"] {
            return URL(fileURLWithPath: path, isDirectory: true)
        }
        return URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appending(path: "../../../../../tests/fixtures")
            .standardizedFileURL
    }

    private var fixtures: URL { referenceFixtures.appending(path: "arborsync", directoryHint: .isDirectory) }

    private var conformanceFixtures: URL {
        if let path = ProcessInfo.processInfo.environment["ARBOR_PROTOCOL_FIXTURES"] {
            return URL(fileURLWithPath: path, isDirectory: true)
        }
        return URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appending(path: "../../../../../conformance")
            .standardizedFileURL
    }

    private func decode<T: Decodable>(_ type: T.Type, _ name: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(contentsOf: fixtures.appending(path: name)))
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
            var legacyStableKeyCandidate: String?
            var authority: Authority?
            var raw: String?
            var href: String?
        }
        var base: String
        var href: String
        var expected: Expected?
        var rewritePath: String?
        var expectedRewritten: String?
    }

    func testSharedURLResolutionFixturesResolveIdentically() throws {
        let cases = try JSONDecoder().decode(
            [URLFixture].self,
            from: Data(contentsOf: conformanceFixtures.appending(path: "url-resolution.json"))
        )
        XCTAssertGreaterThan(cases.count, 20)
        for fixture in cases {
            let label = "\(fixture.base) + \(fixture.href)"
            let resolved = resolveLogicalURL(base: fixture.base, href: fixture.href)
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
            case .fragment(let contentFragment, let legacyStableKeyCandidate):
                XCTAssertEqual(expected.kind, "fragment", label)
                XCTAssertEqual(contentFragment, expected.contentFragment, label)
                XCTAssertEqual(legacyStableKeyCandidate, expected.legacyStableKeyCandidate, label)
            case nil:
                XCTFail("Expected \(expected.kind) for \(label), resolved nil")
            }
            if let rewritePath = fixture.rewritePath {
                XCTAssertEqual(
                    rewriteLocalLinkPath(base: fixture.base, href: fixture.href, newPath: rewritePath),
                    fixture.expectedRewritten,
                    label
                )
            }
        }
    }

    private struct NodeTargetFixture: Decodable {
        var base: String
        var href: String
        var expected: ResolvedNodeTarget?
    }

    func testSharedNodeTargetFixturesResolveIdentically() throws {
        let cases = try JSONDecoder().decode(
            [NodeTargetFixture].self,
            from: Data(contentsOf: conformanceFixtures.appending(path: "node-targets.json"))
        )
        XCTAssertGreaterThan(cases.count, 10)
        for fixture in cases {
            XCTAssertEqual(
                resolveNodeTarget(base: fixture.base, href: fixture.href),
                fixture.expected,
                "\(fixture.base) + \(fixture.href)"
            )
        }
    }

    func testArborLocatorRoundTripsThroughNodeTargetResolution() throws {
        let key = pageIDStableKey("x6baw0")
        let locator = try XCTUnwrap(buildArborLocator(tree: "tr_sample", path: "/notes/deep", stableKey: key))
        XCTAssertEqual(locator, "arbor://tr_sample/notes/deep;arbor-key=\(try XCTUnwrap(encodeStableKey(key)))")
        XCTAssertEqual(
            resolveNodeTarget(base: "/", href: locator),
            ResolvedNodeTarget(tree: "tr_sample", path: "/notes/deep", stableKey: key)
        )
    }

    func testRenameRewritesArborLocatorsInPlace() throws {
        let legacy = "arbor://tr_sample/node/old?stableKey=%5B%5B%22id%22,%22x6baw0%22%5D%5D"
        XCTAssertEqual(
            rewriteLocalLinkPath(base: "/", href: legacy, newPath: "/new"),
            "arbor://tr_sample/new;arbor-key=W1siaWQiLCJ4NmJhdzAiXV0"
        )
        XCTAssertNil(rewriteLocalLinkPath(base: "/", href: "arbor://example.com/old", newPath: "/new"))
    }

    private func assertLocator(_ locator: ResolvedLocatorState, equals expected: URLFixture.Expected, label: String) {
        XCTAssertEqual(locator.stableKey, expected.stableKey, label)
        XCTAssertEqual(locator.revision, expected.revision, label)
        XCTAssertEqual(locator.applicationQuery, expected.applicationQuery, label)
        XCTAssertEqual(locator.contentFragment, expected.contentFragment, label)
        XCTAssertEqual(locator.legacyStableKeyCandidate, expected.legacyStableKeyCandidate, label)
    }

    func testStableKeyAndLocatorWritersMatchTypeScriptVectors() throws {
        let stableKey = #"[["id","x7f3q2"]]"#
        let encoded = try XCTUnwrap(encodeStableKey(stableKey))
        XCTAssertEqual(encoded, "W1siaWQiLCJ4N2YzcTIiXV0")
        XCTAssertEqual(decodeStableKey(encoded), stableKey)
        XCTAssertNil(decodeStableKey(encoded + "="))
        XCTAssertEqual(
            buildCanonicalLink(
                from: "/projects/atlas",
                toPath: "/projects/roadmap",
                stableKey: stableKey,
                applicationQuery: "view=board&edit"
            ),
            "../roadmap?view=board&edit#arbor-key=\(encoded)"
        )
        XCTAssertEqual(
            buildNetworkLocator(
                rawPath: "../roadmap",
                stableKey: stableKey,
                applicationQuery: "view=board&edit",
                contentFragment: "implementation"
            ),
            "../roadmap;arbor-key=\(encoded)?view=board&edit#implementation"
        )
    }
}
