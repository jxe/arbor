@testable import StoryEditor
import Testing

@Suite("Presence carets meet the editor's UTF-16 text and the page's UTF-8 source")
struct PresenceCaretTests {
    @Test("a caret in plain text skips the block's marker")
    func plain() {
        #expect(StoryPresenceCaret.rawOffset(text: "milk", utf16Offset: 0, raw: "- milk\n") == 2)
        #expect(StoryPresenceCaret.rawOffset(text: "milk", utf16Offset: 2, raw: "- milk\n") == 4)
        #expect(StoryPresenceCaret.rawOffset(text: "milk", utf16Offset: 4, raw: "- milk\n") == 6)
        #expect(StoryPresenceCaret.rawOffset(text: "", utf16Offset: 0, raw: "- \n") == 2)
    }

    @Test("mark delimiters and multi-byte text count in their own units")
    func marks() {
        // "café **au** lait": the caret after "au" sits before the closing delimiter.
        let raw = "café **au** lait"
        #expect(StoryPresenceCaret.rawOffset(text: "café au lait", utf16Offset: 7, raw: raw) == 10)
        #expect(StoryPresenceCaret.textOffset(text: "café au lait", rawOffset: 10, raw: raw) == 7)
        #expect(StoryPresenceCaret.textOffset(text: "café au lait", rawOffset: 5, raw: raw) == 4)
        #expect(StoryPresenceCaret.textOffset(text: "milk", rawOffset: 0, raw: "- milk") == 0)
        #expect(StoryPresenceCaret.textOffset(text: "milk", rawOffset: 99, raw: "- milk") == 4)
    }
}
