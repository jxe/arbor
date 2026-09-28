import Foundation

public struct ProtocolSSEFrame: Equatable, Sendable {
    public var id: String?
    public var event: String?
    public var data: String
}

public struct ProtocolSSEParser: Sendable {
    private var buffer = Data()
    private var scanned = 0
    private var line = Data()

    public init() {}

    /// Feed one byte of a stream. Bytes wait until their line ends, so a
    /// frame boundary is looked for once per line rather than once per byte.
    public mutating func append(byte: UInt8) throws -> [ProtocolSSEFrame] {
        line.append(byte)
        guard byte == 10 || byte == 13 else { return [] }
        let complete = line
        line.removeAll(keepingCapacity: true)
        return try append(complete)
    }

    public mutating func append(_ data: Data) throws -> [ProtocolSSEFrame] {
        buffer.append(data)
        var frames: [ProtocolSSEFrame] = []
        while let boundary = nextBoundary() {
            let bytes = buffer.prefix(boundary.start)
            buffer.removeSubrange(0..<boundary.end)
            if !bytes.isEmpty, let frame = try parse(Data(bytes)) { frames.append(frame) }
        }
        return frames
    }

    public mutating func finish() throws -> [ProtocolSSEFrame] {
        buffer.append(line)
        line.removeAll()
        guard !buffer.isEmpty else { return [] }
        defer { buffer.removeAll(); scanned = 0 }
        // A trailing comment carries no event; an unterminated event is malformed.
        let lines = String(decoding: buffer, as: UTF8.self).split(whereSeparator: \.isNewline)
        if lines.allSatisfy({ $0.hasPrefix(":") }) { return [] }
        throw ProtocolValidationError.malformedSSE("Unterminated SSE frame")
    }

    private mutating func nextBoundary() -> (start: Int, end: Int)? {
        // Scan only the unexamined suffix, retaining three bytes for a CRLF
        // boundary split across appends.
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
    private func parse(_ bytes: Data) throws -> ProtocolSSEFrame? {
        guard let string = String(data: bytes, encoding: .utf8) else {
            throw ProtocolValidationError.malformedSSE("Frame is not UTF-8")
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
            throw ProtocolValidationError.malformedSSE("Frame has no data")
        }
        return ProtocolSSEFrame(id: id, event: event, data: data.joined(separator: "\n"))
    }
}

/// How long an observation stream waits before reconnecting after `failures`
/// consecutive failed attempts: 250 ms, doubling per failure, capped at `maximum`.
/// A cleanly closed stream (no failures) still waits the base delay.
public func observationReconnectDelay(afterFailures failures: Int, maximum: Duration = .seconds(5)) -> Duration {
    min(.milliseconds(250 * (1 << min(max(failures, 0), 5))), maximum)
}

/// What an observation attempt asks of its loop.
public enum ObservationStep: Sendable {
    /// Wait out the backoff and connect again.
    case reconnect
    /// End the loop.
    case stop
}

/// The reconnect loop every observation stream shares. Runs `attempt` until
/// the task is cancelled or an attempt returns `.stop`, waiting
/// `observationReconnectDelay` between attempts. A thrown error counts as a
/// failure and lengthens the wait; `connected` resets it. Call `connected`
/// only once the stream has proved itself (an event, or a recovery that
/// reached the host): a streaming request returns before the host answers.
public func runObservationLoop(
    maximumDelay: Duration = .seconds(5),
    _ attempt: (_ connected: () -> Void) async throws -> ObservationStep
) async {
    var failures = 0
    while !Task.isCancelled {
        do {
            if try await attempt({ failures = 0 }) == .stop { return }
        } catch is CancellationError {
            return
        } catch {
            failures += 1
        }
        do { try await Task.sleep(for: observationReconnectDelay(afterFailures: failures, maximum: maximumDelay)) } catch { return }
    }
}

/// One `tree.update` frame of a tree watch (tree operations §1.1.3): its
/// cursor, which is the SSE `id`, and one transition. The tree's new
/// descriptor is the client's own with the frame's `access` and `canonical`
/// and the transition's update.
public struct ProtocolWatchEvent: Equatable, Sendable {
    public var cursor: String
    public var treeID: String
    public var access: String
    public var canonical: ProtocolCanonicalDescriptor?
    public var transition: ProtocolAcceptedTransition

    public var id: String { cursor }
    public var update: ProtocolAcceptedUpdate { transition.update }
    public var requestDigest: String? { transition.requestDigest }

    public init(cursor: String, treeID: String, access: String = "write", canonical: ProtocolCanonicalDescriptor? = nil, transition: ProtocolAcceptedTransition) {
        self.cursor = cursor
        self.treeID = treeID
        self.access = access
        self.canonical = canonical
        self.transition = transition
    }
}

/// A `tree.update` frame's data: the change alone.
public struct ProtocolTreeUpdateFrame: Codable, Sendable, Equatable {
    public var transition: ProtocolAcceptedTransition
    public var access: String
    public var canonical: ProtocolCanonicalDescriptor?

    private enum CodingKeys: String, CodingKey { case transition, access, canonical }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        transition = try values.decode(ProtocolAcceptedTransition.self, forKey: .transition)
        access = try values.decode(String.self, forKey: .access)
        guard values.contains(.canonical) else { throw ProtocolValidationError.malformedSSE("Tree update frame has no canonical placement") }
        canonical = try values.decodeIfPresent(ProtocolCanonicalDescriptor.self, forKey: .canonical)
    }

    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(transition, forKey: .transition)
        try values.encode(access, forKey: .access)
        try values.encode(canonical, forKey: .canonical)
    }

    /// One transition of `tree`, from `basis` when the caller knows its
    /// confirmed state. Identities compare by UTF-8 bytes, never
    /// Unicode-normalized.
    public func validated(tree: String, basis: ProtocolAcceptedLink? = nil) throws -> Self {
        guard access == "read" || access == "write" else {
            throw ProtocolValidationError.malformedSSE("Tree update access is neither read nor write")
        }
        _ = try transition.validated()
        guard transition.update.tree == tree else {
            throw ProtocolValidationError.malformedSSE("Tree update transition belongs to another tree")
        }
        guard let from = transition.transportBasis, !from.id.utf8.elementsEqual(transition.update.id.utf8) else {
            throw ProtocolValidationError.malformedSSE("Tree update transition has no distinct predecessor")
        }
        if let basis {
            guard from.root == basis.root, from.id.utf8.elementsEqual(basis.id.utf8) else {
                throw ProtocolValidationError.malformedSSE("Tree update transition does not start at the confirmed state")
            }
        }
        return self
    }
}

/// A `resync-required` frame's data. The frame has no `id`.
public struct ProtocolResyncChange: Codable, Sendable, Equatable {
    public var reason: String
}
