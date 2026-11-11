import Foundation

/// Entry times (data model §6) and an update's `at` (updates and merging §1).
/// An entry time is Unix milliseconds in UTC; an `at` is the same instant as
/// RFC 3339 UTC text with milliseconds, such as `2026-11-11T12:00:00.000Z`.
public enum ProtocolEntryTime {
    /// Unix milliseconds of `date`, floored.
    public static func milliseconds(_ date: Date) -> Int {
        Int((date.timeIntervalSince1970 * 1000).rounded(.down))
    }

    /// Now as an `at`.
    public static func now() -> String { string(milliseconds(Date())) }

    /// `milliseconds` as an `at`: RFC 3339 UTC with exactly three fractional digits.
    public static func string(_ milliseconds: Int) -> String {
        let seconds = Int((Double(milliseconds) / 1000).rounded(.down))
        let fraction = milliseconds - seconds * 1000
        var time = time_t(seconds)
        var parts = tm()
        gmtime_r(&time, &parts)
        let year = Int(parts.tm_year) + 1900
        let yearText = year >= 0 ? String(format: "%04d", year) : String(format: "-%06d", -year)
        return yearText + String(format: "-%02d-%02dT%02d:%02d:%02d.%03dZ",
                                 Int(parts.tm_mon) + 1, Int(parts.tm_mday), Int(parts.tm_hour), Int(parts.tm_min), Int(parts.tm_sec), fraction)
    }

    /// An `at` as Unix milliseconds, or nil unless it is RFC 3339 UTC
    /// (`YYYY-MM-DDTHH:MM:SS[.fraction]Z`, at most nine fractional digits).
    /// Digits past milliseconds are dropped, as JavaScript's `Date.parse` does.
    public static func milliseconds(_ at: String) -> Int? {
        let bytes = Array(at.utf8)
        func digits(_ start: Int, _ count: Int) -> Int? {
            guard start + count <= bytes.count else { return nil }
            var value = 0
            for byte in bytes[start..<start + count] {
                guard (48...57).contains(byte) else { return nil }
                value = value * 10 + Int(byte - 48)
            }
            return value
        }
        guard bytes.count >= 20, bytes[4] == 45, bytes[7] == 45, bytes[10] == 84, bytes[13] == 58, bytes[16] == 58,
              let year = digits(0, 4), let month = digits(5, 2), let day = digits(8, 2),
              let hour = digits(11, 2), let minute = digits(14, 2), let second = digits(17, 2) else { return nil }
        var index = 19
        var fraction = 0
        if bytes[index] == 46 {
            let start = index + 1
            var end = start
            while end < bytes.count, (48...57).contains(bytes[end]) { end += 1 }
            guard end > start, end - start <= 9 else { return nil }
            let kept = Array(bytes[start..<min(end, start + 3)]) + Array(repeating: UInt8(48), count: max(0, 3 - (end - start)))
            fraction = kept.reduce(0) { $0 * 10 + Int($1 - 48) }
            index = end
        }
        guard index == bytes.count - 1, bytes[index] == 90,
              (1...12).contains(month), hour <= 23, minute <= 59, second <= 59 else { return nil }
        let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
        let lengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
        guard (1...lengths[month - 1]).contains(day) else { return nil }
        // Days from the civil date (Howard Hinnant's algorithm).
        let y = month <= 2 ? year - 1 : year
        let era = (y >= 0 ? y : y - 399) / 400
        let yearOfEra = y - era * 400
        let dayOfYear = (153 * (month + (month > 2 ? -3 : 9)) + 2) / 5 + day - 1
        let dayOfEra = yearOfEra * 365 + yearOfEra / 4 - yearOfEra / 100 + dayOfYear
        let days = era * 146_097 + dayOfEra - 719_468
        return ((days * 86_400 + hour * 3600 + minute * 60 + second) * 1000) + fraction
    }

    /// Whether `at` is an update time: RFC 3339 UTC, as `milliseconds` reads it.
    public static func isValid(_ at: String) -> Bool { milliseconds(at) != nil }
}

public extension ProtocolDirectoryEntry {
    /// A merged entry's times (data model §6): `created` is the basis's, or
    /// the earlier of the sides' when both created it; `modified` is the later
    /// of the sides that changed the entry, or the basis's when neither did. A
    /// side changed the entry when it differs from the basis in object or times.
    static func mergedTimes(base: ProtocolDirectoryEntry?, candidate: ProtocolDirectoryEntry?, current: ProtocolDirectoryEntry?) -> (created: Int, modified: Int)? {
        func times(_ entry: ProtocolDirectoryEntry?) -> ProtocolDirectoryEntry? {
            entry.flatMap { $0.created != nil && $0.modified != nil ? $0 : nil }
        }
        let b = times(base)
        let sides = [times(candidate), times(current)].compactMap { $0 }
        guard !sides.isEmpty else { return b.map { ($0.created!, $0.modified!) } }
        let changed = sides.filter { entry in
            guard let b else { return true }
            return entry.hash != b.hash || entry.created != b.created || entry.modified != b.modified
        }
        let created = b?.created ?? sides.map { $0.created! }.min()!
        let modified = changed.isEmpty ? b!.modified! : changed.map { $0.modified! }.max()!
        return (min(created, modified), modified)
    }

    /// This entry as a new copy made at `at` (a copy is a new entry, data
    /// model §6): a file or page entry takes `at` for both times; a directory
    /// or tree entry is unchanged.
    func copied(at: Int) -> ProtocolDirectoryEntry {
        guard isContent else { return self }
        var entry = self
        entry.created = at
        entry.modified = at
        return entry
    }
}

public extension ProtocolSnapshot {
    /// The newest `modified` of any file or page entry the snapshot's
    /// directories hold, or nil when they hold none: the earliest `at` an
    /// update proposing this snapshot may state.
    var newestEntryTime: Int? {
        var newest: Int?
        for envelope in objects {
            guard let object = try? ProtocolObjectCodec.decode(envelope.bytes, kind: .directory),
                  case let .directory(entries, _) = object else { continue }
            for modified in entries.compactMap(\.modified) { newest = max(newest ?? modified, modified) }
        }
        return newest
    }
}
