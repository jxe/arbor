import Foundation
import Overstory
import Testing

@Suite("Entry times")
struct EntryTimesTests {
    let a = "sha256:" + String(repeating: "a", count: 64)
    let b = "sha256:" + String(repeating: "b", count: 64)

    @Test("An at reads as Unix milliseconds and back, as JavaScript reads it")
    func atText() {
        #expect(ProtocolEntryTime.milliseconds("2026-11-11T12:00:00.000Z") == 1_794_398_400_000)
        #expect(ProtocolEntryTime.milliseconds("2026-11-11T12:00:00Z") == 1_794_398_400_000)
        #expect(ProtocolEntryTime.milliseconds("2026-11-11T12:00:00.5Z") == 1_794_398_400_500)
        #expect(ProtocolEntryTime.milliseconds("2026-11-11T12:00:00.123999Z") == 1_794_398_400_123)
        #expect(ProtocolEntryTime.milliseconds("1969-12-31T23:59:59.999Z") == -1)
        #expect(ProtocolEntryTime.string(1_794_398_400_500) == "2026-11-11T12:00:00.500Z")
        #expect(ProtocolEntryTime.string(-1) == "1969-12-31T23:59:59.999Z")
        for invalid in ["2026-11-11T12:00:00.000+01:00", "2026-11-11 12:00:00Z", "2026-02-30T00:00:00Z", "2026-11-11T12:00:00.Z",
                        "2026-11-11T12:00:00.1234567890Z", "2026-11-11T24:00:00Z"] {
            #expect(ProtocolEntryTime.milliseconds(invalid) == nil, Comment(rawValue: invalid))
        }
        let now = ProtocolEntryTime.now()
        #expect(ProtocolEntryTime.string(ProtocolEntryTime.milliseconds(now)!) == now)
    }

    @Test("Stamping keeps, changes or creates an entry's times (data model §6)")
    func stamping() {
        let before = ProtocolDirectoryEntry(name: "x.md", file: a, created: 10, modified: 20)
        // The same object keeps both times.
        #expect(ProtocolDirectoryEntry.stamped(.file, name: "x.md", object: a, previous: before, at: 99) == before)
        // A different object keeps created and is modified at.
        #expect(ProtocolDirectoryEntry.stamped(.file, name: "x.md", object: b, previous: before, at: 99)
            == .init(name: "x.md", file: b, created: 10, modified: 99))
        // A move or conversion keeps both, whatever the object.
        #expect(ProtocolDirectoryEntry.stamped(.page, name: "y.md", object: b, previous: before, at: 99, keep: true)
            == .init(name: "y.md", page: b, created: 10, modified: 20))
        // New content is created and modified at.
        #expect(ProtocolDirectoryEntry.stamped(.file, name: "x.md", object: b, previous: nil, at: 99)
            == .init(name: "x.md", file: b, created: 99, modified: 99))
        // A directory before is no earlier content.
        #expect(ProtocolDirectoryEntry.stamped(.file, name: "x.md", object: b, previous: .init(name: "x.md", directory: a), at: 99)
            == .init(name: "x.md", file: b, created: 99, modified: 99))
        // A scan's file date is used, never past at, and pulls created back.
        #expect(ProtocolDirectoryEntry.stamped(.file, name: "x.md", object: b, previous: before, at: 99, source: 5)
            == .init(name: "x.md", file: b, created: 5, modified: 5))
        #expect(ProtocolDirectoryEntry.stamped(.file, name: "x.md", object: b, previous: nil, at: 99, source: 500)
            == .init(name: "x.md", file: b, created: 99, modified: 99))
        // A copy is a new entry.
        #expect(before.copied(at: 7) == .init(name: "x.md", file: a, created: 7, modified: 7))
        #expect(before.untimed == .init(name: "x.md", file: a))
    }

    @Test("A merge keeps the basis's created and the later modified of the sides that changed")
    func merging() {
        let base = ProtocolDirectoryEntry(name: "x.md", file: a, created: 10, modified: 20)
        let left = ProtocolDirectoryEntry(name: "x.md", file: b, created: 10, modified: 30)
        let right = ProtocolDirectoryEntry(name: "x.md", file: b, created: 10, modified: 25)
        #expect(ProtocolDirectoryEntry.mergedTimes(base: base, candidate: left, current: right)! == (10, 30))
        #expect(ProtocolDirectoryEntry.mergedTimes(base: base, candidate: base, current: right)! == (10, 25))
        #expect(ProtocolDirectoryEntry.mergedTimes(base: base, candidate: base, current: base)! == (10, 20))
        #expect(ProtocolDirectoryEntry.mergedTimes(base: nil, candidate: left, current: .init(name: "x.md", file: b, created: 5, modified: 25))! == (5, 30))
        #expect(ProtocolDirectoryEntry.mergedTimes(base: nil, candidate: nil, current: nil) == nil)
    }

    @Test("A request's ats are each no earlier than the one before")
    func orderedAts() throws {
        func element(_ change: String, _ at: String) -> ProtocolSemanticValue {
            .object(["change": .string(change), "at": .string(at), "candidate": .string("sha256:" + String(repeating: "1", count: 64)),
                     "trace": .null, "resolves": .array([])])
        }
        _ = try ProtocolAuthoredRequestIntent(["base": .string("u1"), "updates": .array([
            element("c1", "2026-11-11T12:00:00.000Z"), element("c2", "2026-11-11T12:00:00.000Z"), element("c3", "2026-11-11T12:00:01.000Z")])])
        #expect(throws: (any Error).self) {
            try ProtocolAuthoredRequestIntent(["base": .string("u1"), "updates": .array([
                element("c1", "2026-11-11T12:00:01.000Z"), element("c2", "2026-11-11T12:00:00.000Z")])])
        }
        #expect(throws: (any Error).self) {
            try ProtocolAuthoredRequestIntent(["base": .string("u1"), "updates": .array([element("c1", "yesterday")])])
        }
    }

    @Test("A page property operation may state its own at, never later than its update's")
    func pageOperationTimes() throws {
        func element(opAt: String?) -> ProtocolSemanticValue {
            var op: [String: ProtocolSemanticValue] = ["key": .string("p"), "kind": .string("set"), "field": .string("title"),
                "before": .null, "value": .string("New"),
                "page": .object(["path": .string("/a.md"), "object": .string("sha256:" + String(repeating: "2", count: 64))])]
            if let opAt { op["at"] = .string(opAt) }
            return .object(["change": .string("c1"), "at": .string("2026-11-11T12:00:00.000Z"), "candidate": .null,
                            "trace": .array([.object(["operations": .array([.object(op)])])])])
        }
        for at in [nil, "2026-11-11T11:59:00.000Z", "2026-11-11T12:00:00.000Z"] {
            _ = try ProtocolAuthoredRequestIntent(["base": .string("u1"), "updates": .array([element(opAt: at)])])
        }
        for at in ["2026-11-11T12:00:01.000Z", "noon"] {
            #expect(throws: (any Error).self) { try ProtocolAuthoredRequestIntent(["base": .string("u1"), "updates": .array([element(opAt: at)])]) }
        }
    }
}
