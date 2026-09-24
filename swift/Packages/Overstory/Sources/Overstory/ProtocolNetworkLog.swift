import Foundation
import os

/// One network event as the client saw it. Durations are milliseconds. Entries
/// never contain document bytes, credentials, or object payloads; they name
/// trees, digests, update identities, and the server's own phase timings so a
/// client line can be matched to the server's request record.
public struct ProtocolNetworkLogEntry: Codable, Sendable, Identifiable, Equatable {
    public enum Kind: String, Codable, Sendable, CaseIterable {
        case update
        case watchConnect = "watch-connect"
        case watchFrame = "watch-frame"
        case watchDisconnect = "watch-disconnect"
        case read
        /// Client-side diagnostic with no request of its own (for example why a
        /// delta was not sent); `name` says what, `error` says why.
        case note
    }

    public var id: String
    public var at: Date
    public var kind: Kind
    public var tree: String?
    /// Request path or a short name for what happened (`objects`, `snapshot`, `descriptor`, …).
    public var name: String
    public var method: String?
    public var status: Int?
    public var durationMs: Double?
    public var bytesOut: Int?
    public var bytesIn: Int?
    /// The client-side attempt number for retried POSTs, starting at 1.
    public var attempt: Int?
    public var requestDigests: [String]?
    /// Accepted (or unchanged) update identities the server returned or streamed.
    public var updateIDs: [String]?
    public var root: String?
    public var cursor: String?
    /// Milliseconds from the originating POST being sent to this watch frame arriving.
    public var roundTripMs: Double?
    /// Milliseconds from the originating POST's response to this watch frame arriving.
    public var afterResponseMs: Double?
    /// Server phase timings copied from the `Server-Timing` response header.
    public var serverTiming: [String: Double]?
    public var error: String?

    public init(kind: Kind, name: String, tree: String? = nil, at: Date = Date()) {
        self.id = UUID().uuidString
        self.at = at
        self.kind = kind
        self.tree = tree
        self.name = name
    }
}

/// Append-only client network log: a bounded in-memory window plus one JSON
/// Lines file per day under `directory`. Recording never throws and never
/// blocks callers on disk I/O: appends run in order on a private serial queue.
public final class ProtocolNetworkLog: @unchecked Sendable {
    /// The process-wide log the wire client records to when the host installs one.
    public static let shared = OSAllocatedUnfairLock<ProtocolNetworkLog?>(initialState: nil)

    public static var current: ProtocolNetworkLog? { shared.withLock { $0 } }

    public static func install(_ log: ProtocolNetworkLog?) { shared.withLock { $0 = log } }

    public let directory: URL
    private let capacity: Int
    private let maximumFileBytes: Int
    private let state: OSAllocatedUnfairLock<State>
    private let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }()
    /// Serializes every file operation; `file` is only touched on this queue.
    private let writer = DispatchQueue(label: "org.nxhx.Arbor.network-log")
    private var file = FileState()

    private struct Sent { var sentAt: Date; var respondedAt: Date? }
    private struct State {
        var entries: [ProtocolNetworkLogEntry] = []
        var sent: [String: Sent] = [:]
        var sentOrder: [String] = []
    }
    private struct FileState {
        var handle: FileHandle?
        var day: String?
        var writtenBytes = 0
    }

    public init(directory: URL, capacity: Int = 2_000, maximumFileBytes: Int = 8 * 1024 * 1024) {
        self.directory = directory
        self.capacity = capacity
        self.maximumFileBytes = maximumFileBytes
        self.state = OSAllocatedUnfairLock(initialState: State())
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        state.withLock { $0.entries = Self.loadRecent(from: Self.fileURL(directory: directory, day: Self.day(Date())), limit: capacity) }
    }

    /// Today's file. Older days remain beside it as `network-YYYY-MM-DD.jsonl`.
    public var fileURL: URL { Self.fileURL(directory: directory, day: Self.day(Date())) }

    public func entries() -> [ProtocolNetworkLogEntry] { state.withLock { $0.entries } }

    public func clear() {
        state.withLock { $0.entries.removeAll() }
        writer.sync {
            try? file.handle?.close()
            file = FileState()
            try? FileManager.default.removeItem(at: fileURL)
        }
    }

    public func record(_ entry: ProtocolNetworkLogEntry) {
        state.withLock { state in
            state.entries.append(entry)
            if state.entries.count > capacity { state.entries.removeFirst(state.entries.count - capacity) }
        }
        guard let line = try? encoder.encode(entry) else { return }
        let day = Self.day(entry.at)
        writer.async { self.append(line + Data("\n".utf8), day: day) }
    }

    /// Wait until every entry recorded so far has been written.
    func flush() { writer.sync {} }

    private func append(_ data: Data, day: String) {
        if file.day != day || file.handle == nil {
            try? file.handle?.close()
            let url = Self.fileURL(directory: directory, day: day)
            if !FileManager.default.fileExists(atPath: url.path) { FileManager.default.createFile(atPath: url.path, contents: nil) }
            file.handle = try? FileHandle(forWritingTo: url)
            file.day = day
            file.writtenBytes = Int((try? file.handle?.seekToEnd()) ?? 0)
        }
        guard let handle = file.handle, file.writtenBytes < maximumFileBytes else { return }
        do {
            try handle.write(contentsOf: data)
            file.writtenBytes += data.count
        } catch {
            // A failed append (for example a full disk) drops this entry; the next reopens the file.
            try? handle.close()
            file.handle = nil
        }
    }

    /// Remember when an update carrying these digests was sent, so a later watch
    /// frame echoing one of them can report its round trip.
    public func noteUpdateSent(digests: [String], at: Date = Date()) {
        state.withLock { state in
            for digest in digests {
                if state.sent[digest] == nil { state.sentOrder.append(digest) }
                state.sent[digest] = Sent(sentAt: at, respondedAt: nil)
            }
            while state.sentOrder.count > 256 {
                state.sent.removeValue(forKey: state.sentOrder.removeFirst())
            }
        }
    }

    public func noteUpdateResponded(digests: [String], at: Date = Date()) {
        state.withLock { state in
            for digest in digests where state.sent[digest] != nil { state.sent[digest]?.respondedAt = at }
        }
    }

    /// Round trip and after-response intervals for a frame echoing `digest`, if this
    /// process sent that update. The record is consumed so a repeated echo is not
    /// reported twice.
    public func roundTrip(for digest: String, at: Date = Date()) -> (roundTripMs: Double, afterResponseMs: Double?)? {
        state.withLock { state in
            guard let sent = state.sent.removeValue(forKey: digest) else { return nil }
            state.sentOrder.removeAll { $0 == digest }
            return (at.timeIntervalSince(sent.sentAt) * 1000, sent.respondedAt.map { at.timeIntervalSince($0) * 1000 })
        }
    }

    /// Parse a `Server-Timing` header value (`name;dur=1.2, other;dur=3`) into phases.
    public static func parseServerTiming(_ header: String?) -> [String: Double]? {
        guard let header else { return nil }
        var phases: [String: Double] = [:]
        for metric in header.split(separator: ",") {
            let parts = metric.split(separator: ";").map { $0.trimmingCharacters(in: .whitespaces) }
            guard let name = parts.first, !name.isEmpty else { continue }
            for part in parts.dropFirst() where part.lowercased().hasPrefix("dur=") {
                if let value = Double(part.dropFirst(4)) { phases[name] = value }
            }
        }
        return phases.isEmpty ? nil : phases
    }

    /// A readable multi-line rendering, newest first, for copying and sharing.
    public static func text(_ entries: [ProtocolNetworkLogEntry]) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return entries.reversed().map { entry in
            var parts = ["\(formatter.string(from: entry.at))", entry.kind.rawValue, entry.name]
            if let tree = entry.tree { parts.append("tree=\(tree)") }
            if let status = entry.status { parts.append("status=\(status)") }
            if let ms = entry.durationMs { parts.append("ms=\(Int(ms.rounded()))") }
            if let ms = entry.roundTripMs { parts.append("roundTripMs=\(Int(ms.rounded()))") }
            if let ms = entry.afterResponseMs { parts.append("afterResponseMs=\(Int(ms.rounded()))") }
            if let attempt = entry.attempt, attempt > 1 { parts.append("attempt=\(attempt)") }
            if let bytes = entry.bytesOut { parts.append("out=\(bytes)") }
            if let bytes = entry.bytesIn { parts.append("in=\(bytes)") }
            if let ids = entry.updateIDs, !ids.isEmpty { parts.append("updates=\(ids.joined(separator: ","))") }
            if let cursor = entry.cursor { parts.append("cursor=\(cursor)") }
            if let timing = entry.serverTiming, !timing.isEmpty {
                let ordered = timing.sorted { $0.key == "total" ? true : $1.key == "total" ? false : $0.value > $1.value }
                parts.append("server=" + ordered.map { "\($0.key):\(Int($0.value.rounded()))" }.joined(separator: " "))
            }
            if let error = entry.error { parts.append("error=\(error)") }
            return parts.joined(separator: " ")
        }.joined(separator: "\n")
    }

    private static let dayFormat = Date.ISO8601FormatStyle(timeZone: .gmt).year().month().day()

    private static func day(_ date: Date) -> String { date.formatted(dayFormat) }

    private static func fileURL(directory: URL, day: String) -> URL {
        directory.appending(path: "network-\(day).jsonl")
    }

    private static func loadRecent(from url: URL, limit: Int) -> [ProtocolNetworkLogEntry] {
        guard let data = try? Data(contentsOf: url), let text = String(data: data, encoding: .utf8) else { return [] }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let lines = text.split(separator: "\n", omittingEmptySubsequences: true).suffix(limit)
        return lines.compactMap { line in try? decoder.decode(ProtocolNetworkLogEntry.self, from: Data(line.utf8)) }
    }
}
