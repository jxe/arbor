import Foundation

/// Provider-neutral filename proposals derived from an admitted page title.
public enum WorkspaceTitleSlug {
    public static func name(for title: String) -> String {
        let textOnly = String(title.filter { !isEmojiCluster($0) })
        let textSlug = slugCharacters(in: textOnly)
        if !textSlug.isEmpty { return textSlug }
        let emojiSlug = slugCharacters(in: expandingEmoji(in: title))
        return emojiSlug.isEmpty ? "Untitled" : emojiSlug
    }

    public static func matches(name current: String, title: String) -> Bool {
        let slug = name(for: title)
        if current.caseInsensitiveCompare(slug) == .orderedSame { return true }
        guard current.count > slug.count + 1,
              current.lowercased().hasPrefix(slug.lowercased() + "-") else { return false }
        return current.dropFirst(slug.count + 1).allSatisfy(\.isNumber)
    }

    private static func slugCharacters(in value: String) -> String {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_") )
        let characters = value.unicodeScalars.map { scalar -> Character in
            allowed.contains(scalar) ? Character(scalar) : "-"
        }
        return String(characters)
            .split(separator: "-", omittingEmptySubsequences: true)
            .joined(separator: "-")
    }

    private static func expandingEmoji(in title: String) -> String {
        title.reduce(into: "") { result, cluster in
            if let name = emojiName(cluster) { result += " \(name) " }
            else { result.append(cluster) }
        }
    }

    private static func emojiName(_ cluster: Character) -> String? {
        guard isEmojiCluster(cluster),
              let named = String(cluster).applyingTransform(.toUnicodeName, reverse: false) else { return nil }
        var words: [String] = []
        var rest = Substring(named)
        while let open = rest.firstIndex(of: "{"), let close = rest[open...].firstIndex(of: "}") {
            let name = rest[rest.index(after: open)..<close]
            let upper = name.uppercased()
            if !upper.contains("VARIATION SELECTOR"),
               !upper.contains("ZERO WIDTH"),
               !upper.contains("EMOJI MODIFIER"),
               !upper.contains("REGIONAL INDICATOR") {
                words.append(name.lowercased())
            }
            rest = rest[rest.index(after: close)...]
        }
        return words.isEmpty ? nil : words.joined(separator: " ")
    }

    private static func isEmojiCluster(_ cluster: Character) -> Bool {
        let scalars = cluster.unicodeScalars
        if scalars.contains(where: {
            $0.properties.isEmojiPresentation || ($0.properties.isEmoji && !$0.isASCII)
        }) { return true }
        return scalars.contains { $0.value == 0xFE0F || $0.value == 0x20E3 }
            && scalars.contains { $0.properties.isEmoji }
    }
}
