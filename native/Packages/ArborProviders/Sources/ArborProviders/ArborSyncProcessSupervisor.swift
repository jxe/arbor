#if os(macOS)
import ArborClient
import ArborKit
import Darwin
import Foundation
import ServiceManagement

public struct ArborSyncRuntime: Sendable {
    public let origin: URL
    public let provider: ArborSyncWorkspaceProvider
    public let home: WorkspaceReference
    public let launchLocation: WorkspaceLocation
    public let attachedToExistingProcess: Bool

    public init(
        origin: URL,
        provider: ArborSyncWorkspaceProvider,
        home: WorkspaceReference,
        launchLocation: WorkspaceLocation,
        attachedToExistingProcess: Bool
    ) {
        self.origin = origin
        self.provider = provider
        self.home = home
        self.launchLocation = launchLocation
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
            "Arbor is not connected to arborsync. Reopen the saved workspace or try again."
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
    private let launchPolicy: ArborSyncLaunchPolicy
    private var process: Process?
    private var workspace: URL?
    private var accessedSecurityScope = false
    private var logURL: URL?
    private var runtime: ArborSyncRuntime?
    private var serviceRegistrationFailure: String?

    public init(launchPolicy: ArborSyncLaunchPolicy = .automatic) {
        self.launchPolicy = launchPolicy
    }

    public func start(
        workspace: URL,
        executable explicitExecutable: URL? = nil,
        preferredPort: Int = 4317
    ) async throws -> ArborSyncRuntime {
        if let runtime { return runtime }
        let normalized = workspace.standardizedFileURL
        guard normalized.isFileURL else {
            throw ArborSyncSupervisorError.launchFailed("Workspace access requires a local folder URL")
        }
        self.workspace = normalized

        if let attached = try await attachIfCompatible(port: preferredPort, workspace: normalized) {
            runtime = attached
            return attached
        }

        guard launchPolicy == .automatic else {
            throw ArborSyncSupervisorError.serviceUnavailable
        }

        if explicitExecutable == nil, preferredPort == 4317, shouldUsePersistentService {
            if kickstartInstalledService() {
                if let attached = try await waitForService(port: preferredPort, workspace: normalized) {
                    runtime = attached
                    return attached
                }
                throw ArborSyncSupervisorError.readinessTimedOut(canonicalServiceLog())
            }
            do {
                if try registerBundledService() {
                    if let attached = try await waitForService(port: preferredPort, workspace: normalized) {
                        runtime = attached
                        return attached
                    }
                    throw ArborSyncSupervisorError.readinessTimedOut(canonicalServiceLog())
                }
            } catch {
                serviceRegistrationFailure = String(describing: error)
                if installedServiceExists() { throw error }
            }
        }

        let executable = try explicitExecutable ?? locateExecutable()
        accessedSecurityScope = normalized.startAccessingSecurityScopedResource()
        var lastFailure = "No available loopback port"

        for port in preferredPort..<(preferredPort + 20) {
            if let attached = try await attachIfCompatible(port: port, workspace: normalized) {
                runtime = attached
                return attached
            }
            do {
                let launched = try launch(executable: executable, workspace: normalized, port: port)
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
                        let value = try await makeRuntime(
                            client: client,
                            origin: origin,
                            workspace: normalized,
                            attached: false
                        )
                        runtime = value
                        return value
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

        releaseWorkspaceAccess()
        throw ArborSyncSupervisorError.readinessTimedOut(lastFailure)
    }

    public func stop() async {
        runtime = nil
        guard let process else {
            releaseWorkspaceAccess()
            return
        }
        if process.isRunning {
            process.interrupt()
            for _ in 0..<20 where process.isRunning {
                try? await Task.sleep(for: .milliseconds(100))
            }
            if process.isRunning { process.terminate() }
        }
        self.process = nil
        releaseWorkspaceAccess()
    }

    public func restart() async throws -> ArborSyncRuntime {
        guard let workspace else {
            throw ArborSyncSupervisorError.launchFailed("No workspace has been opened")
        }
        let executable = process?.executableURL
        await stop()
        return try await start(workspace: workspace, executable: executable)
    }

    public func logs() -> String {
        guard let logURL, let data = try? Data(contentsOf: logURL) else {
            let persistent = canonicalServiceLog()
            if let failure = serviceRegistrationFailure {
                return "Persistent service registration failed: \(failure)\n\n\(persistent)"
            }
            return persistent
        }
        let suffix = data.suffix(32_768)
        var value = String(decoding: suffix, as: UTF8.self)
        if let workspace { value = value.replacingOccurrences(of: workspace.path, with: "<workspace>") }
        return value
    }

    private func attachIfCompatible(port: Int, workspace: URL) async throws -> ArborSyncRuntime? {
        let origin = URL(string: "http://127.0.0.1:\(port)")!
        let client = ArborSyncRESTClient(baseURL: origin)
        guard let status = try? await client.status() else { return nil }
        try validate(status)
        return try await makeRuntime(client: client, origin: origin, workspace: workspace, attached: true)
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

    private func waitForService(port: Int, workspace: URL) async throws -> ArborSyncRuntime? {
        for _ in 0..<100 {
            if let attached = try await attachIfCompatible(port: port, workspace: workspace) { return attached }
            try await Task.sleep(for: .milliseconds(100))
        }
        return nil
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

    private func makeRuntime(
        client: ArborSyncRESTClient,
        origin: URL,
        workspace: URL,
        attached: Bool
    ) async throws -> ArborSyncRuntime {
        let snapshot = try await client.openSession(workspace.path)
        let home = WorkspaceReference(
            tree: TreeID(rawValue: snapshot.ref.tree),
            path: snapshot.ref.path,
            stableKey: snapshot.ref.stableKey
        )
        return ArborSyncRuntime(
            origin: origin,
            provider: ArborSyncWorkspaceProvider(client: client),
            home: home,
            launchLocation: .local(workspace.path),
            attachedToExistingProcess: attached
        )
    }

    private func launch(executable: URL, workspace: URL, port: Int) throws -> Process {
        let logs = FileManager.default.temporaryDirectory
            .appending(path: "Arbor-arborsync-\(UUID().uuidString).log")
        FileManager.default.createFile(atPath: logs.path, contents: nil)
        let handle = try FileHandle(forWritingTo: logs)
        let process = Process()
        process.executableURL = executable
        let command = [workspace.path, "--port", String(port)]
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

    private func releaseWorkspaceAccess() {
        if accessedSecurityScope { workspace?.stopAccessingSecurityScopedResource() }
        accessedSecurityScope = false
    }
}
#endif
