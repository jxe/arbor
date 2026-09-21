import Foundation
import Testing
@testable import Overstory

@Suite("Profile directory wire model")
struct ProfileDirectoryWireTests {
    @Test("Shared directory fixture decodes description as summary")
    func fixture() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appending(path: "../../../../../tests/fixtures/canopy/directory.json").standardizedFileURL
        let value = try JSONDecoder().decode(
            WireSnapshotEnvelope<[WireProfileDirectoryEntry]>.self,
            from: Data(contentsOf: url)
        )
        #expect(value.observedThrough == "42")
        #expect(value.snapshot.first?.summary == "Builds shared gardens.")
        #expect(value.snapshot.first?.avatar?.path == "images/avatar.webp")
    }
}
