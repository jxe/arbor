import Foundation

enum ArborSupportDirectories {
    static let root: URL = {
        let fileManager = FileManager.default
        let base = (try? fileManager.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )) ?? fileManager.urls(for: .documentDirectory, in: .userDomainMask).first
            ?? fileManager.temporaryDirectory
        return base.appending(path: "Arbor", directoryHint: .isDirectory)
    }()

    static let linkPreviews = root.appending(path: "LinkPreviews", directoryHint: .isDirectory)
    static let pendingVoiceRecordings = root.appending(
        path: "Pending Voice Recordings",
        directoryHint: .isDirectory
    )
}
