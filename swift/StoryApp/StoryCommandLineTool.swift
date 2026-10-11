#if os(macOS)
import AppKit
import SwiftUI

/// The `story` command the app ships, and the link that puts it on the PATH,
/// where editors put theirs: `/usr/local/bin`.
enum StoryCommandLineTool {
    static let link = URL(fileURLWithPath: "/usr/local/bin/story")

    /// The launcher inside this app bundle; nil in a build without one.
    static var launcher: URL? {
        guard let url = Bundle.main.resourceURL?.appending(path: "story-sync/story"),
              FileManager.default.isExecutableFile(atPath: url.path) else { return nil }
        return url
    }

    enum Failure: LocalizedError {
        case occupied
        case refused(String)

        var errorDescription: String? {
            switch self {
            case .occupied:
                "\(StoryCommandLineTool.link.path) is a file Story did not put there. Move it away, then try again."
            case let .refused(detail):
                detail.isEmpty ? "The link was not created." : detail
            }
        }
    }

    /// Link the command, asking for an administrator's password only when the folder needs one.
    static func install() async throws {
        guard let launcher else { throw Failure.refused("This build of Story has no story command inside it.") }
        let files = FileManager.default
        // Replace only a link, never somebody's file.
        if (try? files.attributesOfItem(atPath: link.path)[.type] as? FileAttributeType) == .typeRegular { throw Failure.occupied }
        do {
            try files.createDirectory(at: link.deletingLastPathComponent(), withIntermediateDirectories: true)
            if (try? files.destinationOfSymbolicLink(atPath: link.path)) != nil { try files.removeItem(at: link) }
            try files.createSymbolicLink(at: link, withDestinationURL: launcher)
        } catch {
            try await installAsAdministrator(launcher)
        }
    }

    private static func installAsAdministrator(_ launcher: URL) async throws {
        func quoted(_ value: String) -> String { "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'" }
        let command = "/bin/mkdir -p \(quoted(link.deletingLastPathComponent().path)) && /bin/ln -sfn \(quoted(launcher.path)) \(quoted(link.path))"
        let script = "do shell script \"\(command.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\""))\" with administrator privileges"
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        process.arguments = ["-e", script]
        let errors = Pipe()
        process.standardError = errors
        process.standardOutput = FileHandle.nullDevice
        let status: Int32 = try await withCheckedThrowingContinuation { continuation in
            process.terminationHandler = { continuation.resume(returning: $0.terminationStatus) }
            do { try process.run() } catch {
                process.terminationHandler = nil
                continuation.resume(throwing: error)
            }
        }
        guard status == 0 else {
            let detail = String(decoding: errors.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
            // Cancelling the password prompt is not a failure to report.
            if detail.contains("-128") { throw CancellationError() }
            throw Failure.refused(detail.trimmingCharacters(in: .whitespacesAndNewlines))
        }
    }

    /// Install and say what happened.
    @MainActor static func installAndReport() async {
        let alert = NSAlert()
        do {
            try await install()
            alert.messageText = "The story command is installed"
            alert.informativeText = "Open a new Terminal window and run “story --help”. It is a link at \(link.path) to this copy of Story."
        } catch is CancellationError {
            return
        } catch {
            alert.alertStyle = .warning
            alert.messageText = "The story command could not be installed"
            alert.informativeText = error.localizedDescription
        }
        alert.runModal()
    }
}
#endif
