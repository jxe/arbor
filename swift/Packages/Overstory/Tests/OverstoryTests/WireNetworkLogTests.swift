import Foundation
import Testing
@testable import Overstory

@Suite("Client network log")
struct WireNetworkLogTests {
    private func temporaryDirectory() -> URL {
        let url = FileManager.default.temporaryDirectory.appending(path: "network-log-\(UUID().uuidString)", directoryHint: .isDirectory)
        return url
    }

    @Test("Server-Timing headers become phase durations")
    func parsesServerTiming() {
        let phases = WireNetworkLog.parseServerTiming("total;dur=181.5, worker-worker-process;dur=32.3, body;dur=24, nodur")
        #expect(phases?["total"] == 181.5)
        #expect(phases?["worker-worker-process"] == 32.3)
        #expect(phases?["body"] == 24)
        #expect(phases?["nodur"] == nil)
        #expect(WireNetworkLog.parseServerTiming(nil) == nil)
        #expect(WireNetworkLog.parseServerTiming("") == nil)
    }

    @Test("A watch frame echoing a sent digest reports its round trip once")
    func roundTrips() {
        let log = WireNetworkLog(directory: temporaryDirectory())
        let sent = Date(timeIntervalSince1970: 1_000)
        log.noteUpdateSent(digests: ["sha256:a", "sha256:b"], at: sent)
        log.noteUpdateResponded(digests: ["sha256:a"], at: sent.addingTimeInterval(0.2))
        let trip = log.roundTrip(for: "sha256:a", at: sent.addingTimeInterval(0.5))
        #expect(abs((trip?.roundTripMs ?? 0) - 500) < 0.001)
        #expect(abs((trip?.afterResponseMs ?? 0) - 300) < 0.001)
        #expect(log.roundTrip(for: "sha256:a") == nil)
        let unanswered = log.roundTrip(for: "sha256:b", at: sent.addingTimeInterval(1))
        #expect(abs((unanswered?.roundTripMs ?? 0) - 1000) < 0.001)
        #expect(unanswered?.afterResponseMs == nil)
        #expect(log.roundTrip(for: "sha256:unknown") == nil)
    }

    @Test("Entries persist as JSON lines and reload newest-window on open")
    func persistsAndReloads() throws {
        let directory = temporaryDirectory()
        let log = WireNetworkLog(directory: directory, capacity: 3)
        for index in 0..<5 {
            var entry = WireNetworkLogEntry(kind: .read, name: "objects", tree: "tr_test")
            entry.status = 200
            entry.durationMs = Double(index)
            log.record(entry)
        }
        #expect(log.entries().count == 3)
        #expect(log.entries().map(\.durationMs) == [2, 3, 4])
        log.flush()
        #expect(log.fileURL.lastPathComponent == "network-\(Date().formatted(.iso8601.year().month().day())).jsonl")
        let text = try String(contentsOf: log.fileURL, encoding: .utf8)
        #expect(text.split(separator: "\n").count == 5)
        #expect(!text.contains("credential"))
        let reopened = WireNetworkLog(directory: directory, capacity: 2)
        #expect(reopened.entries().map(\.durationMs) == [3, 4])
        reopened.clear()
        #expect(reopened.entries().isEmpty)
        #expect(!FileManager.default.fileExists(atPath: reopened.fileURL.path))
    }

    @Test("Text rendering lists newest first with server phases")
    func rendersText() {
        var older = WireNetworkLogEntry(kind: .update, name: "updates", tree: "tr_one", at: Date(timeIntervalSince1970: 1))
        older.status = 201
        older.durationMs = 180.4
        older.serverTiming = ["total": 150, "body": 20]
        var newer = WireNetworkLogEntry(kind: .watchFrame, name: "watch", tree: "tr_one", at: Date(timeIntervalSince1970: 2))
        newer.roundTripMs = 640
        let text = WireNetworkLog.text([older, newer])
        let lines = text.split(separator: "\n")
        #expect(lines.count == 2)
        #expect(lines[0].contains("watch-frame"))
        #expect(lines[0].contains("roundTripMs=640"))
        #expect(lines[1].contains("status=201"))
        #expect(lines[1].contains("server=total:150 body:20"))
    }

    @Test("Comment-only SSE blocks are skipped; empty frames still fail")
    func skipsCommentBlocks() throws {
        var parser = ArborSSEParser()
        #expect(try parser.append(Data(": ready\n\n".utf8)).isEmpty)
        #expect(try parser.append(Data(": keepalive\n\n: another\n\n".utf8)).isEmpty)
        let frames = try parser.append(Data(": comment\nid: 7\nevent: tree.update\ndata: {}\n\n".utf8))
        #expect(frames.map(\.id) == ["7"])
        var strict = ArborSSEParser()
        #expect(throws: ArborWireValidationError.self) { try strict.append(Data("id: 8\n\n".utf8)) }
    }
}
