#if os(macOS)
import ArborClient
import ArborKit
import Foundation

public struct ArbordRuntime: Sendable {
    public let origin: URL
    public let provider: ArbordWorkspaceProvider
    public let home: WorkspaceReference
    public let launchLocation: WorkspaceLocation
    public let attachedToExistingProcess: Bool

    public init(
        origin: URL,
        provider: ArbordWorkspaceProvider,
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

public enum ArbordSupervisorError: Error, LocalizedError, Sendable {
    case executableUnavailable
    case serviceUnavailable
    case incompatibleService(String)
    case launchFailed(String)
    case readinessTimedOut(String)

    public var errorDescription: String? {
        switch self {
        case .executableUnavailable:
            "Arbor could not find its bundled arbord helper. Rebuild the macOS app with the helper phase enabled."
        case .serviceUnavailable:
            "Arbor is not connected to arbord. Reopen the saved workspace or try again."
        case let .incompatibleService(detail): "The loopback service is not a compatible arbord: \(detail)"
        case let .launchFailed(detail): "arbord could not start: \(detail)"
        case let .readinessTimedOut(detail): "arbord did not become ready: \(detail)"
        }
    }
}

public enum ArbordLaunchPolicy: Sendable, Equatable {
    case automatic
    case attachOnly
}

public actor ArbordProcessSupervisor {
    private let launchPolicy: ArbordLaunchPolicy
    private var process: Process?
    private var workspace: URL?
    private var accessedSecurityScope = false
    private var logURL: URL?
    private var runtime: ArbordRuntime?

    public init(launchPolicy: ArbordLaunchPolicy = .automatic) {
        self.launchPolicy = launchPolicy
    }

    public func start(
        workspace: URL,
        executable explicitExecutable: URL? = nil,
        preferredPort: Int = 4317
    ) async throws -> ArbordRuntime {
        if let runtime { return runtime }
        let normalized = workspace.standardizedFileURL
        guard normalized.isFileURL else {
            throw ArbordSupervisorError.launchFailed("Workspace access requires a local folder URL")
        }
        self.workspace = normalized

        if let attached = try await attachIfCompatible(port: preferredPort, workspace: normalized) {
            runtime = attached
            return attached
        }

        guard launchPolicy == .automatic else {
            throw ArbordSupervisorError.serviceUnavailable
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
                let client = ArborClient(baseURL: origin)
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
        throw ArbordSupervisorError.readinessTimedOut(lastFailure)
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

    public func restart() async throws -> ArbordRuntime {
        guard let workspace else {
            throw ArbordSupervisorError.launchFailed("No workspace has been opened")
        }
        let executable = process?.executableURL
        await stop()
        return try await start(workspace: workspace, executable: executable)
    }

    public func logs() -> String {
        guard let logURL, let data = try? Data(contentsOf: logURL) else {
            return runtime?.attachedToExistingProcess == true
                ? "This app is attached to the user arbord. Its output is in the terminal where arbor browse is running."
                : "No arbord log output"
        }
        let suffix = data.suffix(32_768)
        var value = String(decoding: suffix, as: UTF8.self)
        if let workspace { value = value.replacingOccurrences(of: workspace.path, with: "<workspace>") }
        return value
    }

    private func attachIfCompatible(port: Int, workspace: URL) async throws -> ArbordRuntime? {
        let origin = URL(string: "http://127.0.0.1:\(port)")!
        let client = ArborClient(baseURL: origin)
        guard let status = try? await client.status() else { return nil }
        try validate(status)
        return try await makeRuntime(client: client, origin: origin, workspace: workspace, attached: true)
    }

    private func validate(_ status: ArbordStatus) throws {
        guard status.service == "arbord", status.protocolVersion == "v1" else {
            throw ArbordSupervisorError.incompatibleService("\(status.service) \(status.protocolVersion)")
        }
    }

    private func makeRuntime(
        client: ArborClient,
        origin: URL,
        workspace: URL,
        attached: Bool
    ) async throws -> ArbordRuntime {
        let snapshot = try await client.node(.path(workspace.path, tree: "local"))
        let home = WorkspaceReference(
            tree: TreeID(rawValue: snapshot.tree),
            path: snapshot.path,
            pageID: snapshot.ref.pageID.map(PageID.init(rawValue:))
        )
        return ArbordRuntime(
            origin: origin,
            provider: ArbordWorkspaceProvider(client: client),
            home: home,
            launchLocation: .local(workspace.path),
            attachedToExistingProcess: attached
        )
    }

    private func launch(executable: URL, workspace: URL, port: Int) throws -> Process {
        let logs = FileManager.default.temporaryDirectory
            .appending(path: "Arbor-arbord-\(UUID().uuidString).log")
        FileManager.default.createFile(atPath: logs.path, contents: nil)
        let handle = try FileHandle(forWritingTo: logs)
        let process = Process()
        process.executableURL = executable
        let command = ["browse", workspace.path, "--port", String(port), "--no-open"]
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
            throw ArbordSupervisorError.launchFailed(String(describing: error))
        }
        try? handle.close()
        logURL = logs
        return process
    }

    private func locateExecutable() throws -> URL {
        let environment = ProcessInfo.processInfo.environment
        if let configured = environment["ARBOR_EXECUTABLE"], FileManager.default.isExecutableFile(atPath: configured) {
            return URL(fileURLWithPath: configured)
        }
        if let bundled = Bundle.main.url(forAuxiliaryExecutable: "arbord"),
           FileManager.default.isExecutableFile(atPath: bundled.path) {
            return bundled
        }
        for directory in (environment["PATH"] ?? "").split(separator: ":") {
            let candidate = URL(fileURLWithPath: String(directory)).appending(path: "arbor")
            if FileManager.default.isExecutableFile(atPath: candidate.path) { return candidate }
        }
        throw ArbordSupervisorError.executableUnavailable
    }

    private func bundledScript(for executable: URL) -> URL? {
        guard let bundled = Bundle.main.url(forAuxiliaryExecutable: "arbord"),
              bundled.standardizedFileURL == executable.standardizedFileURL,
              let resources = Bundle.main.resourceURL else { return nil }
        let script = resources.appending(path: "arbord/arbord.js")
        return FileManager.default.fileExists(atPath: script.path) ? script : nil
    }

    private func releaseWorkspaceAccess() {
        if accessedSecurityScope { workspace?.stopAccessingSecurityScopedResource() }
        accessedSecurityScope = false
    }
}
#endif
