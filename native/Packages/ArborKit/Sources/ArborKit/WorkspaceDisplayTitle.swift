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

    public static func plainText(_ markdown: String) -> String {
        guard let parsed = try? AttributedString(
            markdown: markdown,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        ) else { return markdown }
        return String(parsed.characters)
    }

    public static func derived(from source: String?, fallback: String) -> String {
        if let source {
            for line in source.split(whereSeparator: \.isNewline) where line.hasPrefix("# ") {
                let markdown = line.dropFirst(2).trimmingCharacters(in: .whitespaces)
                if !markdown.isEmpty { return plainText(markdown) }
            }
        }
        return fallback
    }
}
