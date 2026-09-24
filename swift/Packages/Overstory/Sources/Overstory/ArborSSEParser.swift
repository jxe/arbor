import Foundation

public struct ArborSSEFrame: Equatable, Sendable {
    public var id: String?
    public var event: String?
    public var data: String
}

public struct ArborSSEParser: Sendable {
    private var buffer = Data()
    private var scanned = 0

    public init() {}

    public mutating func append(_ data: Data) throws -> [ArborSSEFrame] {
        buffer.append(data)
        var frames: [ArborSSEFrame] = []
        while let boundary = nextBoundary() {
            let bytes = buffer.prefix(boundary.start)
            buffer.removeSubrange(0..<boundary.end)
            if !bytes.isEmpty, let frame = try parse(Data(bytes)) { frames.append(frame) }
        }
        return frames
    }

    public mutating func finish() throws -> [ArborSSEFrame] {
        guard !buffer.isEmpty else { return [] }
        defer { buffer.removeAll(); scanned = 0 }
        throw ArborWireValidationError.malformedSSE("Unterminated SSE frame")
    }

    private mutating func nextBoundary() -> (start: Int, end: Int)? {
        // URLSession delivers individual bytes. Scan only the unexamined suffix,
        // retaining three bytes for a CRLF boundary split across appends.
        let bytes = buffer
        let start = bytes.startIndex
        for index in scanned..<bytes.count {
            if index + 1 < bytes.count, bytes[start + index] == 10, bytes[start + index + 1] == 10 {
                scanned = 0
                return (index, index + 2)
            }
            if index + 3 < bytes.count, bytes[start + index] == 13, bytes[start + index + 1] == 10,
               bytes[start + index + 2] == 13, bytes[start + index + 3] == 10 {
                scanned = 0
                return (index, index + 4)
            }
        }
        scanned = max(0, bytes.count - 3)
        return nil
    }

    /// Comment-only blocks (`: ready`, `: keepalive`) carry no event.
    private func parse(_ bytes: Data) throws -> ArborSSEFrame? {
        guard let string = String(data: bytes, encoding: .utf8) else {
            throw ArborWireValidationError.malformedSSE("Frame is not UTF-8")
        }
        var id: String?
        var event: String?
        var data: [String] = []
        var sawComment = false
        for rawLine in string.replacingOccurrences(of: "\r\n", with: "\n").split(separator: "\n", omittingEmptySubsequences: false) {
            let line = String(rawLine)
            if line.hasPrefix(":") { sawComment = true; continue }
            let parts = line.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
            let field = String(parts[0])
            var value = parts.count == 2 ? String(parts[1]) : ""
            if value.hasPrefix(" ") { value.removeFirst() }
            switch field {
            case "id": id = value
            case "event": event = value
            case "data": data.append(value)
            case "retry", "": break
            default: break
            }
        }
        guard !data.isEmpty else {
            if sawComment && id == nil && event == nil { return nil }
            throw ArborWireValidationError.malformedSSE("Frame has no data")
        }
        return ArborSSEFrame(id: id, event: event, data: data.joined(separator: "\n"))
    }
}

/// How long an observation stream waits before reconnecting after `failures`
/// consecutive failed attempts: 250 ms, doubling per failure, capped at `maximum`.
/// A cleanly closed stream (no failures) still waits the base delay.
public func observationReconnectDelay(afterFailures failures: Int, maximum: Duration = .seconds(5)) -> Duration {
    min(.milliseconds(250 * (1 << min(max(failures, 0), 5))), maximum)
}

public struct WireWatchEvent: Equatable, Sendable {
    public var id: String
    public var cursor: String
    public var kind: String
    public var treeID: String
    public var tree: WireTreeDescriptor
    public var requestDigest: String?
    public var transitions: [WireAcceptedTransition]

    public init(id: String, tree: WireTreeDescriptor, requestDigest: String? = nil, transitions: [WireAcceptedTransition] = []) {
        self.id = id
        self.cursor = id
        self.kind = "tree.update"
        self.treeID = tree.id
        self.tree = tree
        self.requestDigest = requestDigest
        self.transitions = transitions
    }

    public init(cursor: String, treeID: String, kind: String, tree: WireTreeDescriptor, requestDigest: String? = nil, transitions: [WireAcceptedTransition] = []) {
        self.id = cursor
        self.cursor = cursor
        self.kind = kind
        self.treeID = treeID
        self.tree = tree
        self.requestDigest = requestDigest
        self.transitions = transitions
    }
}

public struct WireTreeRefChange: Codable, Sendable, Equatable {
    public var descriptor: WireTreeDescriptor
    public var requestDigest: String?
    public var transitions: [WireAcceptedTransition]
}

public struct WireTreeRefObservation: Codable, Sendable, Equatable {
    public var cursor: String
    public var tree: String
    public var kind: String
    public var change: WireTreeRefChange
}

public struct WireResyncChange: Codable, Sendable, Equatable {
    public var reason: String
}

public struct WireResyncObservation: Codable, Sendable, Equatable {
    public var cursor: String
    public var tree: String
    public var kind: String
    public var change: WireResyncChange
}
