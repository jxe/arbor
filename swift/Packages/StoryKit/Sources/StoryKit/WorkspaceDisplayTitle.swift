import Foundation

/// Plain-text presentation for titles derived from Markdown source or indexes.
/// Source remains untouched; only title-shaped metadata loses inline syntax.
public enum WorkspaceDisplayTitle {
    public static func isEmoji(_ cluster: Character) -> Bool {
        let scalars = cluster.unicodeScalars
        if scalars.contains(where: {
            $0.properties.isEmojiPresentation || ($0.properties.isEmoji && !$0.isASCII)
        }) { return true }
        return scalars.contains { $0.value == 0xFE0F || $0.value == 0x20E3 }
            && scalars.contains { $0.properties.isEmoji }
    }

    /// Characters that can make Markdown inline syntax. A title without any
    /// is its own plain text, so Foundation's slow parser is skipped.
    private static let inlineSyntax: Set<Character> = ["*", "_", "`", "[", "]", "\\", "<", ">", "&", "!", "~"]

    public static func plainText(_ markdown: String) -> String {
        if !markdown.contains(where: inlineSyntax.contains) { return markdown }
        guard let parsed = try? AttributedString(
            markdown: markdown,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        ) else { return markdown }
        return String(parsed.characters)
    }

    public static func derived(from source: String?, fallback: String) -> String {
        if let source {
            // Line by line until the title, without splitting the whole page.
            var rest = source[...]
            while !rest.isEmpty {
                let end = rest.firstIndex(where: \.isNewline) ?? rest.endIndex
                let line = rest[..<end]
                if line.hasPrefix("# ") {
                    let markdown = line.dropFirst(2).trimmingCharacters(in: .whitespaces)
                    if !markdown.isEmpty { return plainText(markdown) }
                }
                rest = end < rest.endIndex ? rest[rest.index(after: end)...] : rest[rest.endIndex...]
            }
        }
        return fallback
    }
}
