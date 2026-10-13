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
            "Story could not find its bundled Story Sync helper. Rebuild the macOS app with the helper phase enabled."
        case .serviceUnavailable:
            "Story is not connected to Story Sync. Reopen the saved tree or try again."
        case let .incompatibleService(detail): "The loopback service is not a compatible Story Sync: \(detail)"
        case let .launchFailed(detail): "Story Sync could not start: \(detail)"
        case let .readinessTimedOut(detail): "Story Sync did not become ready: \(detail)"
        }
    }
}

/// The data home's caller token and the origin its Story Sync last recorded
/// (docs/architecture/story-sync/data-home.md). Story Sync writes the file;
/// only the data home's own user can read it, which is what makes a caller
/// that holds the token that user.
struct StorySyncAccess: Decodable, Sendable, Equatable {
    var version: Int
    var token: String
    var origin: String?

    /// Read from the data home `STORY_HOME` selects now, so a test that changes it is followed.
    static func load() -> StorySyncAccess? {
        let environment = ProcessInfo.processInfo.environment
        let dataHome = environment["STORY_HOME"].flatMap { $0.isEmpty ? nil : URL(fileURLWithPath: $0, isDirectory: true) }
            ?? FileManager.default.homeDirectoryForCurrentUser.appending(path: ".story", directoryHint: .isDirectory)
        guard let data = try? Data(contentsOf: dataHome.appending(path: ".state/story-sync.json")),
              let access = try? JSONDecoder().decode(StorySyncAccess.self, from: data),
              access.version == 1 else { return nil }
        return access
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
        if let attached = try await attachOwn(preferredPort: preferredPort) {
            // The launch agent outlives the app, so an updated app finds the helper of the build it replaced.
            guard explicitExecutable == nil, preferredPort == Self.defaultPort, shouldUsePersistentService,
                  attached.status.runtimeKind == "persistent",
                  Self.isStaleHelper(running: attached.status.version, bundled: Self.bundledHelperVersion),
                  await installedServiceExists() else { return attached }
            _ = await launchctl(["kickstart", "-k", serviceTarget()])
            for _ in 0..<100 {
                if let restarted = try await attachOwn(preferredPort: preferredPort),
                   restarted.status.instanceID != attached.status.instanceID { return restarted }
                try await Task.sleep(for: .milliseconds(100))
            }
            throw StorySyncSupervisorError.readinessTimedOut(canonicalServiceLog())
        }

        guard launchPolicy == .automatic else {
            throw StorySyncSupervisorError.serviceUnavailable
        }

        if explicitExecutable == nil, preferredPort == Self.defaultPort, shouldUsePersistentService {
            if await restartInstalledService() {
                if let attached = try await waitForService(preferredPort: preferredPort) { return attached }
                throw StorySyncSupervisorError.readinessTimedOut(canonicalServiceLog())
            }
            do {
                if try registerBundledService() {
                    if let attached = try await waitForService(preferredPort: preferredPort) { return attached }
                    throw StorySyncSupervisorError.readinessTimedOut(canonicalServiceLog())
                }
            } catch {
                serviceRegistrationFailure = String(describing: error)
                if await installedServiceExists() { throw error }
            }
        }

        let executable = try explicitExecutable ?? locateExecutable()
        self.executable = executable
        // Story Sync takes the next free port itself when another user's holds this one,
        // and records where it listens; the instance ID tells our launch from anyone else's.
        let instanceID = UUID().uuidString
        let launched = try launch(executable: executable, port: preferredPort, instanceID: instanceID)
        process = launched
        var lastFailure = "Story Sync did not answer with this data home's token"
        for _ in 0..<100 {
            if !launched.isRunning {
                lastFailure = logs()
                break
            }
            if let attached = try await attachOwn(preferredPort: preferredPort, recordedFirst: true),
               attached.status.instanceID == instanceID {
                return StorySyncControlRuntime(origin: attached.origin, client: attached.client, status: attached.status, attachedToExistingProcess: false)
            }
            try await Task.sleep(for: .milliseconds(100))
        }
        if launched.isRunning { launched.terminate() }
        process = nil
        throw StorySyncSupervisorError.readinessTimedOut(lastFailure)
    }

    /// The stamp this app's bundled helper reports: `<version>+<build>`, as the build script defines it.
    static var bundledHelperVersion: String? {
        let info = Bundle.main.infoDictionary
        guard let version = info?["CFBundleShortVersionString"] as? String,
              let build = info?["CFBundleVersion"] as? String else { return nil }
        return "\(version)+\(build)"
    }

    /// Whether a running helper shipped in another build of the app. A helper
    /// without a build stamp was started from a checkout or by the CLI, and is left alone.
    static func isStaleHelper(running: String, bundled: String?) -> Bool {
        guard let bundled, running.contains("+") else { return false }
        return running != bundled
    }

    /// Attach to this data home's own Story Sync: the one that answers its caller
    /// token. Another user's refuses the token, and an older build that checks no
    /// caller says nothing of `access`; neither is attached to. At the default
    /// port the origin Story Sync recorded comes first, since a second account on
    /// the Mac listens elsewhere; a test's explicit port is asked only after a launch.
    private func attachOwn(preferredPort: Int, recordedFirst: Bool = false) async throws -> StorySyncControlRuntime? {
        guard let access = StorySyncAccess.load() else { return nil }
        var origins: [URL] = []
        if preferredPort == Self.defaultPort || recordedFirst, let recorded = access.origin.flatMap(URL.init(string:)) {
            origins.append(recorded)
        }
        if let fixed = URL(string: "http://127.0.0.1:\(preferredPort)"), preferredPort != 0, !origins.contains(fixed) {
            origins.append(fixed)
        }
        for origin in origins {
            let client = StorySyncRESTClient(baseURL: origin, token: access.token)
            guard let status = try? await client.status(), status.access == "token" else { continue }
            try validate(status)
            return StorySyncControlRuntime(origin: origin, client: client, status: status, attachedToExistingProcess: true)
        }
        return nil
    }

    private func waitForService(preferredPort: Int) async throws -> StorySyncControlRuntime? {
        for _ in 0..<100 {
            if let attached = try await attachOwn(preferredPort: preferredPort) { return attached }
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

    /// Start the installed service, restarting it if it runs: reaching here means it
    /// did not answer this data home's token, so it is stopped, wedged, or an older build.
    private func restartInstalledService() async -> Bool {
        guard await installedServiceExists() else { return false }
        _ = await launchctl(["kickstart", "-k", serviceTarget()])
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
    private func launch(executable: URL, port: Int, instanceID: String) throws -> Process {
        let logs = FileManager.default.temporaryDirectory
            .appending(path: "Story-story-sync-\(UUID().uuidString).log")
        FileManager.default.createFile(atPath: logs.path, contents: nil)
        let handle = try FileHandle(forWritingTo: logs)
        let process = Process()
        process.executableURL = executable
        var command = ["--control", "--port", String(port), "--instance-id", instanceID]
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
