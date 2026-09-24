import Overstory
import CanopyWorkingTree
import Foundation

/// Follows one tree's protocol watch stream and feeds every event to an
/// `UpdateCoordinator`, reconnecting with backoff and recovering an expired
/// cursor through the coordinator's gap recovery. iOS, the Mac, and visits run
/// the same loop; the app only observes `onChange`.
public struct HostWatchRunner: Sendable {
    public var client: ProtocolClient
    public var tree: String
    public var coordinator: UpdateCoordinator
    /// Called after every applied event or recovery so the host can refresh its presentation.
    public var onChange: @Sendable () async -> Void
    public var maximumReconnectDelay: Duration

    public init(
        client: ProtocolClient,
        tree: String,
        coordinator: UpdateCoordinator,
        maximumReconnectDelay: Duration = .seconds(5),
        onChange: @escaping @Sendable () async -> Void = {}
    ) {
        self.client = client
        self.tree = tree
        self.coordinator = coordinator
        self.maximumReconnectDelay = maximumReconnectDelay
        self.onChange = onChange
    }

    /// Start the loop in its own task. Cancel the task to stop watching.
    public func start() -> Task<Void, Never> {
        Task { await run() }
    }

    /// Run the loop until the surrounding task is cancelled.
    public func run() async {
        var lastEventID = try? await coordinator.watchCursor()
        var reconnectAttempt = 0
        while !Task.isCancelled {
            do {
                if lastEventID == nil {
                    _ = try await coordinator.recoverWatchGap()
                    lastEventID = try await coordinator.watchCursor()
                }
                let events = try await client.watch(tree: tree, lastEventID: lastEventID)
                reconnectAttempt = 0
                for try await event in events {
                    try Task.checkCancellation()
                    guard event.tree.id == tree else { continue }
                    _ = try await coordinator.observe(event)
                    lastEventID = try await coordinator.watchCursor()
                    if lastEventID == nil {
                        _ = try await coordinator.recoverWatchGap()
                        lastEventID = try await coordinator.watchCursor()
                    }
                    await onChange()
                }
            } catch is CancellationError {
                return
            } catch let error as ProtocolHTTPError where error.code == "resync-required" {
                do {
                    _ = try await coordinator.recoverWatchGap()
                    lastEventID = try await coordinator.watchCursor()
                    reconnectAttempt = 0
                    await onChange()
                } catch {
                    reconnectAttempt += 1
                }
            } catch {
                reconnectAttempt += 1
            }
            do {
                try await Task.sleep(for: observationReconnectDelay(afterFailures: reconnectAttempt, maximum: maximumReconnectDelay))
            } catch {
                return
            }
        }
    }
}
