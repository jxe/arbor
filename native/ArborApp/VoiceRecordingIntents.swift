import AppIntents
import QuagmireExtras

/// Xcode extracts shortcut phrases only from an application-target provider.
/// The reusable intent and launch handoff remain in QuagmireExtras.
struct ArborAppShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: StartVoiceRecordingIntent(),
            phrases: [
                "Start recording in \(.applicationName)",
                "Record audio in \(.applicationName)",
                "Start a voice note in \(.applicationName)"
            ],
            shortTitle: "Record",
            systemImageName: "mic"
        )
    }

    static var shortcutTileColor: ShortcutTileColor { .blue }
}
