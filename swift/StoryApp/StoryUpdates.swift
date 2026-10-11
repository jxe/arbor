#if os(macOS)
import Sparkle
import SwiftUI

/// Updates for the downloaded Mac app, through Sparkle and the feed named in
/// Info.plist. A development build has no updater: it would replace itself
/// with the released app.
@MainActor
struct StoryUpdates {
    private let controller: SPUStandardUpdaterController?

    init() {
#if DEBUG
        controller = nil
#else
        controller = SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: nil, userDriverDelegate: nil)
#endif
    }

    var isAvailable: Bool { controller != nil }

    func check() { controller?.checkForUpdates(nil) }
}

struct StoryUpdateCommands: Commands {
    let updates: StoryUpdates

    var body: some Commands {
        CommandGroup(after: .appInfo) {
            if updates.isAvailable {
                Button("Check for Updates…") { updates.check() }
            }
        }
    }
}
#endif
