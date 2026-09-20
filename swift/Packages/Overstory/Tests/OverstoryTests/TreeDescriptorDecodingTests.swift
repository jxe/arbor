import Foundation
import Testing
@testable import Overstory

@Suite("Tree descriptor decoding")
struct TreeDescriptorDecodingTests {
    @Test("A descriptor saved before the conflicted flag existed decodes as not conflicted")
    func legacyDescriptorWithoutConflicted() throws {
        let json = """
        {"id":"tr_abc","kind":"ordinary","access":"write","root":"sha256:0","update":"u1",
         "canonical":{"path":"/~joe","endpoint":"https://garden.example"}}
        """
        let descriptor = try JSONDecoder().decode(WireTreeDescriptor.self, from: Data(json.utf8))
        #expect(descriptor.conflicted == false)
        #expect(descriptor.id == "tr_abc")
        #expect(descriptor.canonicalPath == "/~joe")
    }

    @Test("A present conflicted flag is honored and round-trips")
    func conflictedRoundTrip() throws {
        let original = WireTreeDescriptor(id: "tr_abc", kind: "ordinary", root: "sha256:0", access: "read", canonical: nil, update: "u2", conflicted: true)
        let decoded = try JSONDecoder().decode(WireTreeDescriptor.self, from: try JSONEncoder().encode(original))
        #expect(decoded == original)
    }
}
