import SwiftUI

@main
struct ArborApplication: App {
    var body: some Scene {
        WindowGroup {
            ArborRootView()
        }
        .commands {
            ArborNavigationCommands()
        }
    }
}

private struct ArborNavigationCommands: Commands {
    var body: some Commands {
        CommandGroup(after: .sidebar) {
            Button("Home") {}
                .keyboardShortcut("h", modifiers: [.command, .shift])
                .disabled(true)
        }
    }
}
