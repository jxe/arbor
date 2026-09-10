#if os(macOS)
import ArborKit
import Darwin
import Foundation
import ServiceManagement

/// A connected control-mode daemon: the loopback origin every same-installation
/// client talks to for status, trees, accounts, conflicts, sync, pairing,
/// bootstrap, credential, objects, and events. The daemon owns no workspace and
/// has no editor path; the app opens trees through `bootstrap(tree:)`.
public struct ArborSyncControlRuntime: Sendable {
    public let origin: URL
    public let client: ArborSyncRESTClient
    public let status: ArborSyncStatus
    public let attachedToExistingProcess: Bool

    public init(origin: URL, client: ArborSyncRESTClient, status: ArborSyncStatus, attachedToExistingProcess: Bool) {
        self.origin = origin
        self.client = client
        self.status = status
        self.attachedToExistingProcess = attachedToExistingProcess
    }
}

public enum ArborSyncSupervisorError: Error, LocalizedError, Sendable {
    case executableUnavailable
    case serviceUnavailable
    case incompatibleService(String)
    case launchFailed(String)
    case readinessTimedOut(String)

    public var errorDescription: String? {
        switch self {
        case .executableUnavailable:
            "Arbor could not find its bundled arborsync helper. Rebuild the macOS app with the helper phase enabled."
        case .serviceUnavailable:
            "Arbor is not connected to arborsync. Reopen the saved tree or try again."
        case let .incompatibleService(detail): "The loopback service is not a compatible arborsync: \(detail)"
        case let .launchFailed(detail): "arborsync could not start: \(detail)"
        case let .readinessTimedOut(detail): "arborsync did not become ready: \(detail)"
        }
    }
}

public enum ArborSyncLaunchPolicy: Sendable, Equatable {
    case automatic
    case attachOnly
}

public actor ArborSyncProcessSupervisor {
    private static let serviceLabel = "org.nxhx.Arbor.arborsync"
    private static let servicePlist = "org.nxhx.Arbor.arborsync.plist"

    /// How the daemon is launched: `arborsync --control`, no session, no folder of its own.
    private enum Mode: Sendable {
        case control
    }

    private let launchPolicy: ArborSyncLaunchPolicy
    private var process: Process?
    private var mode: Mode?
    private var executable: URL?
    private var preferredPort: Int = 4317
    private var logURL: URL?
    private var controlRuntime: ArborSyncControlRuntime?
    private var serviceRegistrationFailure: String?

    public init(launchPolicy: ArborSyncLaunchPolicy = .automatic) {
        self.launchPolicy = launchPolicy
    }

    // MARK: Control mode

    /// Connect to the installation's control-mode daemon, launching one when
    /// the policy allows and none is listening. The daemon owns no workspace;
    /// clients open trees through `bootstrap(tree:)`.
    public func start(
        executable explicitExecutable: URL? = nil,
        preferredPort: Int = 4317
    ) async throws -> ArborSyncControlRuntime {
        if let controlRuntime { return controlRuntime }
        self.mode = .control
        self.preferredPort = preferredPort
        let runtime = try await connect(
            mode: .control,
            explicitExecutable: explicitExecutable,
            preferredPort: preferredPort
        ) { client, origin, status, attached in
            ArborSyncControlRuntime(origin: origin, client: client, status: status, attachedToExistingProcess: attached)
        }
        controlRuntime = runtime
        return runtime
    }

    // MARK: Lifecycle

    public func stop() async {
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
    public func restartControl() async throws -> ArborSyncControlRuntime {
        guard case .control? = mode else {
            throw ArborSyncSupervisorError.launchFailed("Arbor Sync has not been started in control mode")
        }
        let executable = process?.executableURL ?? self.executable
        await stop()
        return try await start(executable: executable, preferredPort: preferredPort)
    }

    public func logs() -> String {
        guard let logURL, let data = try? Data(contentsOf: logURL) else {
            let persistent = canonicalServiceLog()
            if let failure = serviceRegistrationFailure {
                return "Persistent service registration failed: \(failure)\n\n\(persistent)"
            }
            return persistent
        }
        return String(decoding: data.suffix(32_768), as: UTF8.self)
    }

    // MARK: Shared attach-or-launch path

    private typealias MakeRuntime<R> = @Sendable (
        _ client: ArborSyncRESTClient,
        _ origin: URL,
        _ status: ArborSyncStatus,
        _ attached: Bool
    ) async throws -> R

    private func connect<R: Sendable>(
        mode: Mode,
        explicitExecutable: URL?,
        preferredPort: Int,
        make: MakeRuntime<R>
    ) async throws -> R {
        if let attached = try await attachIfCompatible(port: preferredPort, make: make) {
            return attached
        }

        guard launchPolicy == .automatic else {
            throw ArborSyncSupervisorError.serviceUnavailable
        }

        if explicitExecutable == nil, preferredPort == 4317, shouldUsePersistentService {
            if kickstartInstalledService() {
                if let attached = try await waitForService(port: preferredPort, make: make) { return attached }
                throw ArborSyncSupervisorError.readinessTimedOut(canonicalServiceLog())
            }
            do {
                if try registerBundledService() {
                    if let attached = try await waitForService(port: preferredPort, make: make) { return attached }
                    throw ArborSyncSupervisorError.readinessTimedOut(canonicalServiceLog())
                }
            } catch {
                serviceRegistrationFailure = String(describing: error)
                if installedServiceExists() { throw error }
            }
        }

        let executable = try explicitExecutable ?? locateExecutable()
        self.executable = executable
        var lastFailure = "No available loopback port"

        for port in preferredPort..<(preferredPort + 20) {
            if let attached = try await attachIfCompatible(port: port, make: make) { return attached }
            do {
                let launched = try launch(executable: executable, mode: mode, port: port)
                process = launched
                let origin = URL(string: "http://127.0.0.1:\(port)")!
                let client = ArborSyncRESTClient(baseURL: origin)
                for _ in 0..<100 {
                    if !launched.isRunning {
                        lastFailure = logs()
                        break
                    }
                    if let status = try? await client.status() {
                        try validate(status)
                        return try await make(client, origin, status, false)
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

        throw ArborSyncSupervisorError.readinessTimedOut(lastFailure)
    }

    private func attachIfCompatible<R: Sendable>(port: Int, make: MakeRuntime<R>) async throws -> R? {
        let origin = URL(string: "http://127.0.0.1:\(port)")!
        let client = ArborSyncRESTClient(baseURL: origin)
        guard let status = try? await client.status() else { return nil }
        try validate(status)
        return try await make(client, origin, status, true)
    }

    private func waitForService<R: Sendable>(port: Int, make: MakeRuntime<R>) async throws -> R? {
        for _ in 0..<100 {
            if let attached = try await attachIfCompatible(port: port, make: make) { return attached }
            try await Task.sleep(for: .milliseconds(100))
        }
        return nil
    }

    private var shouldUsePersistentService: Bool {
        let environment = ProcessInfo.processInfo.environment
        if environment["ARBOR_DISABLE_PERSISTENT_DAEMON"] == "1" { return false }
        if environment["XCTestConfigurationFilePath"] != nil && environment["ARBOR_TEST_PERSISTENT_DAEMON"] != "1" {
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
            throw ArborSyncSupervisorError.launchFailed(
                "Allow Arbor Sync in System Settings > General > Login Items, then reconnect"
            )
        case .notFound:
            return false
        @unknown default:
            throw ArborSyncSupervisorError.launchFailed("macOS returned an unknown Arbor Sync service state")
        }
    }

    private func installedServiceExists() -> Bool {
        launchctl(["print", serviceTarget()]) == 0
    }

    private func kickstartInstalledService() -> Bool {
        guard installedServiceExists() else { return false }
        _ = launchctl(["kickstart", serviceTarget()])
        return true
    }

    private func serviceTarget() -> String {
        "gui/\(getuid())/\(Self.serviceLabel)"
    }

    private func launchctl(_ arguments: [String]) -> Int32 {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = arguments
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            process.waitUntilExit()
            return process.terminationStatus
        } catch {
            return -1
        }
    }

    private func canonicalServiceLog() -> String {
        let url = FileManager.default.homeDirectoryForCurrentUser
            .appending(path: "Library/Logs/Arbor/arborsync.log")
        guard let data = try? Data(contentsOf: url), !data.isEmpty else {
            return "No Arbor Sync log output at \(url.path)"
        }
        return String(decoding: data.suffix(32_768), as: UTF8.self)
    }

    private func validate(_ status: ArborSyncStatus) throws {
        guard status.service == "arborsync", status.protocolVersion == "v1" else {
            throw ArborSyncSupervisorError.incompatibleService("\(status.service) \(status.protocolVersion)")
        }
    }

    private func launch(executable: URL, mode: Mode, port: Int) throws -> Process {
        let logs = FileManager.default.temporaryDirectory
            .appending(path: "Arbor-arborsync-\(UUID().uuidString).log")
        FileManager.default.createFile(atPath: logs.path, contents: nil)
        let handle = try FileHandle(forWritingTo: logs)
        let process = Process()
        process.executableURL = executable
        let command: [String]
        switch mode {
        case .control: command = ["--control", "--port", String(port)]
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
            throw ArborSyncSupervisorError.launchFailed(String(describing: error))
        }
        try? handle.close()
        logURL = logs
        return process
    }

    private func locateExecutable() throws -> URL {
        let environment = ProcessInfo.processInfo.environment
        if let configured = environment["ARBOR_SYNC_EXECUTABLE"], FileManager.default.isExecutableFile(atPath: configured) {
            return URL(fileURLWithPath: configured)
        }
        if let bundled = Bundle.main.url(forAuxiliaryExecutable: "arborsync"),
           FileManager.default.isExecutableFile(atPath: bundled.path) {
            return bundled
        }
        for directory in (environment["PATH"] ?? "").split(separator: ":") {
            let candidate = URL(fileURLWithPath: String(directory)).appending(path: "arborsync")
            if FileManager.default.isExecutableFile(atPath: candidate.path) { return candidate }
        }
        throw ArborSyncSupervisorError.executableUnavailable
    }

    private func bundledScript(for executable: URL) -> URL? {
        guard let bundled = Bundle.main.url(forAuxiliaryExecutable: "arborsync"),
              bundled.standardizedFileURL == executable.standardizedFileURL,
              let resources = Bundle.main.resourceURL else { return nil }
        let script = resources.appending(path: "arborsync/arborsync.js")
        return FileManager.default.fileExists(atPath: script.path) ? script : nil
    }
}
#endif
