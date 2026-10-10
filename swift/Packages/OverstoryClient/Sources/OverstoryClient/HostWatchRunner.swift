import Overstory
import OverstoryWorkingTree
import Foundation
import os

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
        var cursor = try? await coordinator.watchCursor()
        await runObservationLoop(maximumDelay: maximumReconnectDelay) { connected in
            do {
                if cursor == nil {
                    _ = try await coordinator.recoverWatchGap()
                    cursor = try await coordinator.watchCursor()
                }
                let opened = OSAllocatedUnfairLock(initialState: false)
                let events = try await client.watch(tree: tree, after: cursor, onOpen: {
                    opened.withLock { $0 = true }
                    await coordinator.setWatching(true)
                })
                // However this connection ends, the tree polls again until the next one opens.
                defer { Task { await coordinator.setWatching(false) } }
                // A stream the host answered has proved itself even if it then
                // drops before any event, as an idle tree's often does.
                defer { if opened.withLock({ $0 }) { connected() } }
                for try await event in events {
                    connected()
                    try Task.checkCancellation()
                    guard event.treeID == tree else { continue }
                    _ = try await coordinator.observe(event)
                    cursor = try await coordinator.watchCursor()
                    if cursor == nil {
                        _ = try await coordinator.recoverWatchGap()
                        cursor = try await coordinator.watchCursor()
                    }
                    await onChange()
                }
            } catch let error as ProtocolHTTPError where error.code == "resync-required" {
                _ = try await coordinator.recoverWatchGap()
                cursor = try await coordinator.watchCursor()
                connected()
                await onChange()
            }
            return .reconnect
        }
    }
}
