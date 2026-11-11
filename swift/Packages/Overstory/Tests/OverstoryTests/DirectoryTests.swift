import Foundation
import Testing
@testable import Overstory

@Suite("Profile directory wire model")
struct ProfileDirectoryProtocolTests {
    @Test("Shared directory fixture decodes description as summary")
    func fixture() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appending(path: "../../../../../tests/fixtures/overstoryd/directory.json").standardizedFileURL
        let value = try JSONDecoder().decode(ProtocolPeopleList.self, from: Data(contentsOf: url))
        #expect(value.people.first?.summary == "Builds shared gardens.")
        #expect(value.people.first?.avatar?.path == "images/avatar.webp")
    }
}
