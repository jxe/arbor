#if os(macOS)
import StoryKit
import Darwin
import Foundation
import ServiceManagement

/// A connected control-mode daemon: the loopback origin every same-installation
/// client talks to for status, trees, accounts, conflicts, sync, pairing,
/// bootstrap, credential, objects, and events. The daemon owns no workspace and
/// has no editor path; the app opens trees through `bootstrap(tree:)`.
struct StorySyncControlRuntime: Sendable {
    let origin: URL
    let client: StorySyncRESTClient
    let status: StorySyncServiceStatus
    let attachedToExistingProcess: Bool

    init(origin: URL, client: StorySyncRESTClient, status: StorySyncServiceStatus, attachedToExistingProcess: Bool) {
        self.origin = origin
        self.client = client
        self.status = status
        self.attachedToExistingProcess = attachedToExistingProcess
    }
}

enum StorySyncSupervisorError: Error, LocalizedError, Sendable {
    case executableUnavailable
    case serviceUnavailable
    case incompatibleService(String)
    case launchFailed(String)
    case readinessTimedOut(String)

    var errorDescription: String? {
        switch self {
        case .executableUnavailable:
            "Story could not find its bundled story-sync helper. Rebuild the macOS app with the helper phase enabled."
        case .serviceUnavailable:
            "Story is not connected to story-sync. Reopen the saved tree or try again."
        case let .incompatibleService(detail): "The loopback service is not a compatible story-sync: \(detail)"
        case let .launchFailed(detail): "story-sync could not start: \(detail)"
        case let .readinessTimedOut(detail): "story-sync did not become ready: \(detail)"
        }
    }
}

enum StorySyncLaunchPolicy: Sendable, Equatable {
    case automatic
    case attachOnly
}

actor StorySyncProcessSupervisor {
    private static let serviceLabel = "org.nxhx.story.sync"
    private static let servicePlist = "org.nxhx.story.sync.plist"
    /// The loopback port the persistent service listens on.
    static let defaultPort = 4317
    /// How much of a log's end `logs()` shows.
    private static let logTailBytes = 32_768

    private let launchPolicy: StorySyncLaunchPolicy
    private var process: Process?
    /// Whether `start` has run, so `restartControl` knows what to restart.
    private var started = false
    private var executable: URL?
    private var preferredPort = StorySyncProcessSupervisor.defaultPort
    private var logURL: URL?
    private var controlRuntime: StorySyncControlRuntime?
    private var serviceRegistrationFailure: String?

    init(launchPolicy: StorySyncLaunchPolicy = .automatic) {
        self.launchPolicy = launchPolicy
    }

    // MARK: Control mode

    /// Connect to the installation's control-mode daemon, launching one when
    /// the policy allows and none is listening. The daemon owns no workspace;
    /// clients open trees through `bootstrap(tree:)`.
    func start(
        executable explicitExecutable: URL? = nil,
        preferredPort: Int = StorySyncProcessSupervisor.defaultPort
    ) async throws -> StorySyncControlRuntime {
        if let controlRuntime { return controlRuntime }
        started = true
        self.preferredPort = preferredPort
        let runtime = try await connect(explicitExecutable: explicitExecutable, preferredPort: preferredPort)
        controlRuntime = runtime
        return runtime
    }

    // MARK: Lifecycle

    func stop() async {
        controlRuntime = nil
        guard let process else { return }
        if process.isRunning {
            process.interrupt()
            for _ in 0..<20 where process.isRunning {
                try? await Task.sleep(for: .milliseconds(100))
            }
            if process.isRunning { process.terminate() }
        }
        self.process = nil
    }

    /// Stop and reconnect the control-mode daemon.
    func restartControl() async throws -> StorySyncControlRuntime {
        guard started else {
            throw StorySyncSupervisorError.launchFailed("Story Sync has not been started in control mode")
        }
        let executable = process?.executableURL ?? self.executable
        await stop()
        return try await start(executable: executable, preferredPort: preferredPort)
    }

    func logs() -> String {
        guard let logURL, let data = try? Data(contentsOf: logURL) else {
            let persistent = canonicalServiceLog()
            if let failure = serviceRegistrationFailure {
                return "Persistent service registration failed: \(failure)\n\n\(persistent)"
            }
            return persistent
        }
        return String(decoding: data.suffix(Self.logTailBytes), as: UTF8.self)
    }

    // MARK: Shared attach-or-launch path

    private func connect(explicitExecutable: URL?, preferredPort: Int) async throws -> StorySyncControlRuntime {
        if let attached = try await attachIfCompatible(port: preferredPort) {
            return attached
        }

        guard launchPolicy == .automatic else {
            throw StorySyncSupervisorError.serviceUnavailable
        }

        if explicitExecutable == nil, preferredPort == Self.defaultPort, shouldUsePersistentService {
            if await kickstartInstalledService() {
                if let attached = try await waitForService(port: preferredPort) { return attached }
                throw StorySyncSupervisorError.readinessTimedOut(canonicalServiceLog())
            }
            do {
                if try registerBundledService() {
                    if let attached = try await waitForService(port: preferredPort) { return attached }
                    throw StorySyncSupervisorError.readinessTimedOut(canonicalServiceLog())
                }
            } catch {
                serviceRegistrationFailure = String(describing: error)
                if await installedServiceExists() { throw error }
            }
        }

        let executable = try explicitExecutable ?? locateExecutable()
        self.executable = executable
        var lastFailure = "No available loopback port"

        for port in preferredPort..<(preferredPort + 20) {
            if let attached = try await attachIfCompatible(port: port) { return attached }
            do {
                let launched = try launch(executable: executable, port: port)
                process = launched
                let origin = URL(string: "http://127.0.0.1:\(port)")!
                let client = StorySyncRESTClient(baseURL: origin)
                for _ in 0..<100 {
                    if !launched.isRunning {
                        lastFailure = logs()
                        break
                    }
                    if let status = try? await client.status() {
                        try validate(status)
                        return StorySyncControlRuntime(origin: origin, client: client, status: status, attachedToExistingProcess: false)
                    }
                    try await Task.sleep(for: .milliseconds(100))
                }
                if launched.isRunning { launched.terminate() }
                process = nil
            } catch {
                lastFailure = String(describing: error)
                process = nil
            }
        }

        throw StorySyncSupervisorError.readinessTimedOut(lastFailure)
    }

    private func attachIfCompatible(port: Int) async throws -> StorySyncControlRuntime? {
        let origin = URL(string: "http://127.0.0.1:\(port)")!
        let client = StorySyncRESTClient(baseURL: origin)
        guard let status = try? await client.status() else { return nil }
        try validate(status)
        return StorySyncControlRuntime(origin: origin, client: client, status: status, attachedToExistingProcess: true)
    }

    private func waitForService(port: Int) async throws -> StorySyncControlRuntime? {
        for _ in 0..<100 {
            if let attached = try await attachIfCompatible(port: port) { return attached }
            try await Task.sleep(for: .milliseconds(100))
        }
        return nil
    }

    private var shouldUsePersistentService: Bool {
        let environment = ProcessInfo.processInfo.environment
        if environment["STORY_DISABLE_PERSISTENT_DAEMON"] == "1" { return false }
        if environment["XCTestConfigurationFilePath"] != nil && environment["STORY_TEST_PERSISTENT_DAEMON"] != "1" {
            return false
        }
        let plist = Bundle.main.bundleURL
            .appending(path: "Contents/Library/LaunchAgents")
            .appending(path: Self.servicePlist)
        return FileManager.default.fileExists(atPath: plist.path)
    }

    private func registerBundledService() throws -> Bool {
        guard shouldUsePersistentService else { return false }
        let service = SMAppService.agent(plistName: Self.servicePlist)
        switch service.status {
        case .enabled:
            return true
        case .notRegistered:
            try service.register()
            return true
        case .requiresApproval:
            throw StorySyncSupervisorError.launchFailed(
                "Allow Story Sync in System Settings > General > Login Items, then reconnect"
            )
        case .notFound:
            return false
        @unknown default:
            throw StorySyncSupervisorError.launchFailed("macOS returned an unknown Story Sync service state")
        }
    }

    private func installedServiceExists() async -> Bool {
        await launchctl(["print", serviceTarget()]) == 0
    }

    private func kickstartInstalledService() async -> Bool {
        guard await installedServiceExists() else { return false }
        _ = await launchctl(["kickstart", serviceTarget()])
        return true
    }

    private func serviceTarget() -> String {
        "gui/\(getuid())/\(Self.serviceLabel)"
    }

    /// Run `launchctl`, awaiting its exit instead of blocking the actor's thread.
    private func launchctl(_ arguments: [String]) async -> Int32 {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = arguments
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        return await withCheckedContinuation { continuation in
            process.terminationHandler = { continuation.resume(returning: $0.terminationStatus) }
            do {
                try process.run()
            } catch {
                process.terminationHandler = nil
                continuation.resume(returning: -1)
            }
        }
    }

    private func canonicalServiceLog() -> String {
        let url = FileManager.default.homeDirectoryForCurrentUser
            .appending(path: "Library/Logs/Story/story-sync.log")
        guard let data = try? Data(contentsOf: url), !data.isEmpty else {
            return "No Story Sync log output at \(url.path)"
        }
        return String(decoding: data.suffix(Self.logTailBytes), as: UTF8.self)
    }

    private func validate(_ status: StorySyncServiceStatus) throws {
        guard status.service == "story-sync", status.protocolVersion == "v1" else {
            throw StorySyncSupervisorError.incompatibleService("\(status.service) \(status.protocolVersion)")
        }
    }

    /// Launch `story-sync --control`: no session and no folder of its own.
    private func launch(executable: URL, port: Int) throws -> Process {
        let logs = FileManager.default.temporaryDirectory
            .appending(path: "Story-story-sync-\(UUID().uuidString).log")
        FileManager.default.createFile(atPath: logs.path, contents: nil)
        let handle = try FileHandle(forWritingTo: logs)
        let process = Process()
        process.executableURL = executable
        var command = ["--control", "--port", String(port)]
        // A hosted test app's helper must not outlive the test run that owns it.
        if ProcessInfo.processInfo.environment["STORY_TEST_BUNDLED_HELPER"] == "1" {
            command += ["--parent-pid", String(ProcessInfo.processInfo.processIdentifier)]
        }
        if let script = bundledScript(for: executable) {
            process.arguments = [script.path] + command
        } else {
            process.arguments = command
        }
        process.standardOutput = handle
        process.standardError = handle
        do { try process.run() }
        catch {
            try? handle.close()
            throw StorySyncSupervisorError.launchFailed(String(describing: error))
        }
        try? handle.close()
        logURL = logs
        return process
    }

    private func locateExecutable() throws -> URL {
        let environment = ProcessInfo.processInfo.environment
        if let configured = environment["STORY_SYNC_EXECUTABLE"], FileManager.default.isExecutableFile(atPath: configured) {
            return URL(fileURLWithPath: configured)
        }
        if let bundled = Bundle.main.url(forAuxiliaryExecutable: "story-sync"),
           FileManager.default.isExecutableFile(atPath: bundled.path) {
            return bundled
        }
        for directory in (environment["PATH"] ?? "").split(separator: ":") {
            let candidate = URL(fileURLWithPath: String(directory)).appending(path: "story-sync")
            if FileManager.default.isExecutableFile(atPath: candidate.path) { return candidate }
        }
        throw StorySyncSupervisorError.executableUnavailable
    }

    private func bundledScript(for executable: URL) -> URL? {
        guard let bundled = Bundle.main.url(forAuxiliaryExecutable: "story-sync"),
              bundled.standardizedFileURL == executable.standardizedFileURL,
              let resources = Bundle.main.resourceURL else { return nil }
        let script = resources.appending(path: "story-sync/story-sync.js")
        return FileManager.default.fileExists(atPath: script.path) ? script : nil
    }
}
#endif
