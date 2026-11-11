import Overstory
import Foundation

/// Follows one tree's presence stream (spec 12) and keeps this device's entry
/// in it: the page it is on and, while someone else is on that page, its
/// caret. Reconnects with backoff like `HostWatchRunner`; on every new stream
/// it sends its page and caret again, since presence keeps nothing between
/// streams. The app observes `onChange` and reads `roster`.
public actor HostPresence {
    public nonisolated let client: ProtocolClient
    public nonisolated let tree: String
    /// Not visible: watch the roster without joining it ("Show me to others" off).
    public nonisolated let visible: Bool
    /// What this client runs on (`mac`, `ios`), shown beside its entry.
    public nonisolated let device: String?
    private nonisolated let onChange: @Sendable (ProtocolPresenceRoster) async -> Void
    private nonisolated let maximumReconnectDelay: Duration

    public private(set) var roster = ProtocolPresenceRoster()
    private var page: ProtocolPresencePage?
    private var selection: ProtocolPresenceSelection?
    private var sentPage: ProtocolPresencePage??
    private var sentSelection: ProtocolPresenceSelection??
    private var lastCursorSent: ContinuousClock.Instant?
    private var flushTask: Task<Void, Never>?
    private var loop: Task<Void, Never>?

    public init(
        client: ProtocolClient,
        tree: String,
        visible: Bool = true,
        device: String? = nil,
        maximumReconnectDelay: Duration = .seconds(5),
        onChange: @escaping @Sendable (ProtocolPresenceRoster) async -> Void = { _ in }
    ) {
        self.client = client
        self.tree = tree
        self.visible = visible
        self.device = device
        self.maximumReconnectDelay = maximumReconnectDelay
        self.onChange = onChange
    }

    /// Start following; a second call restarts on a fresh stream.
    public func start() {
        loop?.cancel()
        loop = Task { await self.run() }
    }

    /// Leave the roster. The host drops the entry when the stream closes.
    public func stop() {
        loop?.cancel()
        loop = nil
        flushTask?.cancel()
        flushTask = nil
        roster = ProtocolPresenceRoster()
        sentPage = nil
        sentSelection = nil
    }

    /// The page this device shows, as a canonical node path; nil when none.
    /// Changing page clears the caret.
    public func setPage(_ next: ProtocolPresencePage?) {
        guard next != page else { return }
        page = next
        selection = nil
        scheduleFlush()
    }

    /// The caret or selection on the current page, in UTF-8 bytes of the
    /// page file whose hash is `source`. Sent at most four times a second, and
    /// only while someone else is on the page; the last one always arrives.
    public func setSelection(_ next: ProtocolPresenceSelection?) {
        guard next != selection else { return }
        selection = next
        scheduleFlush()
    }

    /// Send a message to another of this person's streams, from this one
    /// (spec 12 §6). Throws when the stream isn't open yet, or the host refuses.
    public func send(_ body: ProtocolPresenceMessageBody, to peer: String) async throws {
        guard let from = roster.selfID else { throw HostPresenceError.notConnected }
        try await client.sendPresenceMessage(tree: tree, from: from, to: peer, body: body)
    }

    private nonisolated func run() async {
        await runObservationLoop(maximumDelay: maximumReconnectDelay) { connected in
            defer { Task { await self.disconnected() } }
            let events = try await client.presence(tree: tree, visible: visible, device: device)
            for try await event in events {
                connected()
                try Task.checkCancellation()
                await self.receive(event)
            }
            return .reconnect
        }
    }

    private func receive(_ event: ProtocolPresenceEvent) async {
        roster.apply(event)
        if case .ready = event {
            // A new stream is a new entry: send the page and caret again.
            sentPage = nil
            sentSelection = nil
        }
        // Someone arriving or leaving can start or stop sharing the caret.
        scheduleFlush()
        await onChange(roster)
    }

    private func disconnected() async {
        roster = ProtocolPresenceRoster()
        sentPage = nil
        sentSelection = nil
        await onChange(roster)
    }

    private func scheduleFlush() {
        guard flushTask == nil else { return }
        flushTask = Task { await self.flush() }
    }

    /// Send whatever differs from what the host has, until nothing does. A
    /// caret-only update waits out the rate limit; the latest caret wins.
    private func flush() async {
        defer { flushTask = nil }
        let interval = Duration.milliseconds(1000 / ProtocolPresenceLimits.cursorsPerSecond)
        while !Task.isCancelled {
            // A hidden stream has an entry of its own too, but tells nobody where it is.
            guard visible, let id = roster.selfID else { return }
            let wanted = page.map { roster.anyoneElse(onPage: $0.path) } == true ? selection : nil
            let pageDue = sentPage != .some(page)
            // The host clears the caret when the page changes.
            let hostSelection: ProtocolPresenceSelection?? = pageDue ? .some(nil) : sentSelection
            let caretDue = hostSelection != .some(wanted)
            guard pageDue || caretDue else { return }
            if !pageDue, let last = lastCursorSent, last + interval > .now {
                try? await Task.sleep(for: last + interval - .now)
                continue
            }
            var update = ProtocolPresenceUpdate()
            if pageDue { update.page = page.map { .set($0) } ?? .clear }
            if caretDue { update.selection = wanted.map { .set($0) } ?? .clear }
            let sendingPage = page
            do {
                try await client.updatePresence(tree: tree, id: id, update: update)
                if pageDue { sentPage = .some(sendingPage) }
                sentSelection = caretDue ? .some(wanted) : hostSelection
                if caretDue { lastCursorSent = .now }
            } catch let error as ProtocolHTTPError where error.status == 429 {
                lastCursorSent = .now
            } catch {
                // The stream's end resets everything; a new ready sends again.
                return
            }
        }
    }
}

public enum HostPresenceError: Error, Equatable {
    /// The presence stream isn't open, so there is nothing to send from.
    case notConnected
}
