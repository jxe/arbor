import Foundation
import Testing
@testable import Overstory

@Suite("Profile directory wire model")
struct ProfileDirectoryProtocolTests {
    @Test("Shared directory fixture decodes description as summary")
    func fixture() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appending(path: "../../../../../tests/fixtures/overstoryd/directory.json").standardizedFileURL
        // The shared fixture still lists its entries under `snapshot`; the host now answers `{ people }`.
        struct Fixture: Decodable { var snapshot: [ProtocolProfileDirectoryEntry] }
        let entries = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url)).snapshot
        let value = try JSONDecoder().decode(ProtocolPeopleList.self, from: JSONEncoder().encode(ProtocolPeopleList(people: entries)))
        #expect(value.people.first?.summary == "Builds shared gardens.")
        #expect(value.people.first?.avatar?.path == "images/avatar.webp")
    }
}
