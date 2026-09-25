import Foundation
import Testing
@testable import CanopyWorkingTree

/// Runs `tests/fixtures/ignore-policy/cases.json`, the cases the TypeScript
/// policy in `packages/fs` also runs, so the preview and the folder client
/// agree on which paths belong to a tree.
@Suite("Ignore policy")
struct IgnorePolicyTests {
    struct Case: Decodable {
        var name: String
        var files: [String: String]
        var bytes: [String: String]?
        var excludedRoots: [String]?
        var path: String
        var isDirectory: Bool
        var decision: String
        var diagnostics: [String]?
    }

    struct Fixture: Decodable {
        var cases: [Case]
    }

    static func cases() throws -> [Case] {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appending(path: "../../../../../tests/fixtures/ignore-policy/cases.json")
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url)).cases
    }

    private func place(_ path: String, _ data: Data, in root: URL) throws {
        let url = root.appending(path: path)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: url)
    }

    @Test("The shared fixture decides every case as the TypeScript policy does")
    func sharedFixture() throws {
        let cases = try Self.cases()
        #expect(!cases.isEmpty)
        for item in cases {
            let root = FileManager.default.temporaryDirectory.appending(path: "ignore-\(UUID().uuidString)", directoryHint: .isDirectory)
            defer { try? FileManager.default.removeItem(at: root) }
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            for (path, text) in item.files { try place(path, Data(text.utf8), in: root) }
            for (path, base64) in item.bytes ?? [:] { try place(path, try #require(Data(base64Encoded: base64)), in: root) }
            let excluded = (item.excludedRoots ?? []).map { root.appending(path: $0, directoryHint: .isDirectory) }
            for url in excluded { try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true) }

            let policy = IgnorePolicy(root: root, excludedRoots: excluded)
            let decision = policy.decision(item.path, isDirectory: item.isDirectory)
            #expect(decision.membership.rawValue == item.decision, "\(item.name)")
            if decision.membership == .ignored {
                #expect(decision.source?.hasSuffix("ignore") == true, "\(item.name)")
                #expect(decision.pattern != nil, "\(item.name)")
            }
            #expect(policy.diagnostics.map(\.path) == (item.diagnostics ?? []), "\(item.name)")
        }
    }

    @Test("A diagnostic names an ignore file that is not UTF-8 without its contents")
    func invalidUTF8() throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "ignore-\(UUID().uuidString)", directoryHint: .isDirectory)
        defer { try? FileManager.default.removeItem(at: root) }
        try place("sub/.gitignore", Data([0xFF, 0x73, 0x65, 0x63, 0x72, 0x65, 0x74, 0x0A]), in: root)
        let policy = IgnorePolicy(root: root)
        #expect(policy.decision("/sub/secret", isDirectory: false).membership == .included)
        #expect(policy.diagnostics == [IgnorePolicy.Diagnostic(
            code: "ignore-file-not-utf8",
            path: "/sub/.gitignore",
            message: "/sub/.gitignore is not valid UTF-8, so none of its ignore rules apply."
        )])
    }

    @Test("A preview leaves out what a first placement would not publish")
    func previewFollowsRules() throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "ignore-preview-\(UUID().uuidString)", directoryHint: .isDirectory)
        defer { try? FileManager.default.removeItem(at: root) }
        try place(".gitignore", Data("build/\n".utf8), in: root)
        try place("notes/.arborignore", Data("draft.md\n".utf8), in: root)
        try place("build/out.md", Data("# Built\n".utf8), in: root)
        try place("notes/draft.md", Data("# Draft\n".utf8), in: root)
        try place("notes/kept.md", Data("# Kept\n".utf8), in: root)
        try place("node_modules/pkg/readme.md", Data("# Package\n".utf8), in: root)
        let paths = try LocalFolderPreview.nodes(in: root).map(\.path).sorted()
        #expect(paths == ["/", "/notes", "/notes/kept"])
    }
}
