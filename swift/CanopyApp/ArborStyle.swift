import Foundation
import Quagmire
import SwiftUI

/// Arbor-owned editor and shell presentation. Quagmire stays reusable and
/// quiet; Arbor opts into the document rhythm and physical feedback that make
/// editing feel immediate on Apple platforms.
enum ArborStyle {
    static let editorTheme = EditorTheme(
        typography: EditorTheme.Typography(
            bodySize: 16,
            bodyLineSpacing: 3.5,
            headingWeight: .semibold,
            headingLineSpacing: 1,
            pageTitleSize: 40,
            h1Size: 30,
            h2Size: 24,
            h3Size: 20,
            h4Size: 18,
            h5Size: 17,
            h6Size: 16,
            inlineCodeSize: 13.6
        ),
        layout: EditorTheme.Layout(
            maxContentWidth: 708,
            minimumHorizontalPadding: 20,
            maximumHorizontalPadding: 48,
            proportionalHorizontalPadding: 0.055,
            indentStep: 24,
            listMarkerGap: 10,
            listMarkerColumnWidth: 24
        )
    )

    static var editorConfiguration: EditorConfiguration {
        EditorConfiguration(
            theme: editorTheme,
            isAudioFeedbackEnabled: UserDefaults.standard.object(forKey: "arbor.uiSoundsEnabled") as? Bool ?? true,
            isHapticFeedbackEnabled: true,
            loggingSubsystem: Bundle.main.bundleIdentifier
        )
    }

    static func shellFont(size: CGFloat = 13, weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight)
    }
}
