import Foundation

// Presence (spec 12): who is in a tree, on which page, and where their caret
// is. Ephemeral by construction: never part of a tree, its history or a watch.

/// Presence bounds (spec 12 §5).
public enum ProtocolPresenceLimits {
    /// Largest POST body, in bytes.
    public static let bodyBytes = 1024
    /// Longest status line, in characters.
    public static let statusCharacters = 140
    /// Longest agent label, in characters.
    public static let labelCharacters = 40
    /// Most cursor updates a client sends a second.
    public static let cursorsPerSecond = 4
    /// Largest plausible byte offset in a selection.
    public static let maxOffset: Int = 4_294_967_295
}

/// A page as a presence entry names it: its canonical node path, such as `/Groceries`.
public struct ProtocolPresencePage: Codable, Hashable, Sendable {
    public var path: String
    public var stableKey: String?

    public init(path: String, stableKey: String? = nil) {
        self.path = path
        self.stableKey = stableKey
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(path, forKey: .path)
        try container.encode(stableKey, forKey: .stableKey)
    }

    func validated() throws -> Self {
        guard !path.isEmpty, !path.contains("\0") else { throw ProtocolValidationError.invalidValue("page.path must be a non-empty path") }
        return self
    }
}

/// UTF-8 byte offsets into the file object whose hash is `source`.
public struct ProtocolPresenceSelection: Codable, Hashable, Sendable {
    public var source: String
    public var anchor: Int
    public var head: Int

    public init(source: String, anchor: Int, head: Int) {
        self.source = source
        self.anchor = anchor
        self.head = head
    }

    func validated() throws -> Self {
        guard source.hasPrefix("sha256:"), source.count == 71,
              source.dropFirst(7).allSatisfy({ $0.isHexDigit && !$0.isUppercase }) else {
            throw ProtocolValidationError.invalidValue("selection.source must be a sha256 hash")
        }
        for offset in [anchor, head] where offset < 0 || offset > ProtocolPresenceLimits.maxOffset {
            throw ProtocolValidationError.invalidValue("selection offsets must be byte offsets")
        }
        return self
    }
}

/// What an agent's entry says beyond a person's.
public struct ProtocolPresenceAgent: Codable, Hashable, Sendable {
    public var label: String
    public var status: String?

    public init(label: String, status: String? = nil) {
        self.label = label
        self.status = status
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(label, forKey: .label)
        try container.encode(status, forKey: .status)
    }

    func validated() throws -> Self {
        _ = try ProtocolPresence.line(label, what: "agent.label", max: ProtocolPresenceLimits.labelCharacters)
        if let status { _ = try ProtocolPresence.line(status, what: "status", max: ProtocolPresenceLimits.statusCharacters) }
        return self
    }
}

public struct ProtocolPresencePeer: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var profile: String
    public var name: String?
    public var page: ProtocolPresencePage?
    /// Nil for a person.
    public var agent: ProtocolPresenceAgent?
    /// What the client says it runs on (`mac`, `ios`); nil when it didn't say.
    public var device: String?

    public init(id: String, profile: String, name: String? = nil, page: ProtocolPresencePage? = nil, agent: ProtocolPresenceAgent? = nil, device: String? = nil) {
        self.id = id
        self.profile = profile
        self.name = name
        self.page = page
        self.agent = agent
        self.device = device
    }

    func validated() throws -> Self {
        guard !id.isEmpty, !profile.isEmpty else { throw ProtocolValidationError.invalidValue("peer.id and peer.profile must be non-empty") }
        var peer = self
        peer.page = try page?.validated()
        peer.agent = try agent?.validated()
        return peer
    }
}

public struct ProtocolPresenceReady: Codable, Hashable, Sendable {
    /// This stream's own entry; nil when the subscriber is not visible.
    public var selfID: String?
    public var peers: [ProtocolPresencePeer]

    public init(selfID: String?, peers: [ProtocolPresencePeer]) {
        self.selfID = selfID
        self.peers = peers
    }

    private enum CodingKeys: String, CodingKey {
        case selfID = "self"
        case peers
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        selfID = try container.decodeIfPresent(String.self, forKey: .selfID)
        peers = try container.decode([ProtocolPresencePeer].self, forKey: .peers)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(selfID, forKey: .selfID)
        try container.encode(peers, forKey: .peers)
    }
}

public struct ProtocolPresenceCursor: Codable, Hashable, Sendable {
    public var id: String
    public var selection: ProtocolPresenceSelection?

    public init(id: String, selection: ProtocolPresenceSelection?) {
        self.id = id
        self.selection = selection
    }
}

public enum ProtocolPresenceEvent: Hashable, Sendable {
    case ready(ProtocolPresenceReady)
    case peer(ProtocolPresencePeer)
    case cursor(ProtocolPresenceCursor)
    case leave(id: String)
}

/// The body of `POST …/presence/{PresenceID}`; a nil member is left unchanged,
/// and `.clear` sets it to null.
public struct ProtocolPresenceUpdate: Encodable, Sendable, Equatable {
    public enum Change<Value: Encodable & Sendable & Equatable>: Sendable, Equatable {
        case set(Value)
        case clear
    }

    public var page: Change<ProtocolPresencePage>?
    public var selection: Change<ProtocolPresenceSelection>?
    /// Accepted only on an agent stream.
    public var status: Change<String>?

    public init(page: Change<ProtocolPresencePage>? = nil, selection: Change<ProtocolPresenceSelection>? = nil, status: Change<String>? = nil) {
        self.page = page
        self.selection = selection
        self.status = status
    }

    private enum CodingKeys: String, CodingKey { case page, selection, status }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        func write<Value>(_ change: Change<Value>?, _ key: CodingKeys) throws {
            switch change {
            case nil: break
            case .clear: try container.encodeNil(forKey: key)
            case .set(let value): try container.encode(value, forKey: key)
            }
        }
        try write(page, .page)
        try write(selection, .selection)
        try write(status, .status)
    }
}

public enum ProtocolPresence {
    public static let eventKinds = ["presence.ready", "presence.peer", "presence.cursor", "presence.leave"]

    /// One presence frame's event and data, decoded; anything else is refused.
    public static func decodeEvent(event: String?, data: Data) throws -> ProtocolPresenceEvent {
        let decoder = JSONDecoder()
        switch event {
        case "presence.ready":
            let ready = try decoder.decode(ProtocolPresenceReady.self, from: data)
            return .ready(ProtocolPresenceReady(selfID: ready.selfID, peers: try ready.peers.map { try $0.validated() }))
        case "presence.peer":
            return .peer(try decoder.decode(ProtocolPresencePeer.self, from: data).validated())
        case "presence.cursor":
            let cursor = try decoder.decode(ProtocolPresenceCursor.self, from: data)
            guard !cursor.id.isEmpty else { throw ProtocolValidationError.invalidValue("cursor.id must be non-empty") }
            return .cursor(ProtocolPresenceCursor(id: cursor.id, selection: try cursor.selection?.validated()))
        case "presence.leave":
            let leave = try decoder.decode(Leave.self, from: data)
            guard !leave.id.isEmpty else { throw ProtocolValidationError.invalidValue("leave.id must be non-empty") }
            return .leave(id: leave.id)
        default:
            throw ProtocolValidationError.malformedSSE("Unsupported presence event \(event ?? "(none)")")
        }
    }

    private struct Leave: Decodable { var id: String }

    static func line(_ value: String, what: String, max: Int) throws -> String {
        guard !value.isEmpty, value.unicodeScalars.count <= max,
              !value.contains(where: { $0 == "\n" || $0 == "\r" || $0 == "\r\n" }) else {
            throw ProtocolValidationError.invalidValue("\(what) must be one line of at most \(max) characters")
        }
        return value
    }
}

/// One presence stream's view of its tree: the roster and each peer's caret.
/// A client folds every event into it; a new stream starts a new roster.
public struct ProtocolPresenceRoster: Hashable, Sendable {
    /// This stream's own entry, which `peers` never lists.
    public private(set) var selfID: String?
    public private(set) var peers: [String: ProtocolPresencePeer] = [:]
    /// Carets of peers on the subscriber's page; a peer that moves page drops its caret.
    public private(set) var cursors: [String: ProtocolPresenceSelection] = [:]

    public init() {}

    public mutating func apply(_ event: ProtocolPresenceEvent) {
        switch event {
        case .ready(let ready):
            selfID = ready.selfID
            peers = Dictionary(ready.peers.filter { $0.id != ready.selfID }.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
            cursors = [:]
        case .peer(let peer):
            guard peer.id != selfID else { return }
            if peers[peer.id]?.page != peer.page { cursors[peer.id] = nil }
            peers[peer.id] = peer
        case .cursor(let cursor):
            guard peers[cursor.id] != nil else { return }
            cursors[cursor.id] = cursor.selection
        case .leave(let id):
            peers[id] = nil
            cursors[id] = nil
        }
    }

    /// Entries on `path` (a canonical node path), people before agents, then by name.
    public func peers(onPage path: String) -> [ProtocolPresencePeer] {
        peers.values
            .filter { $0.page?.path == path }
            .sorted { ($0.agent != nil ? 1 : 0, $0.name ?? "", $0.id) < ($1.agent != nil ? 1 : 0, $1.name ?? "", $1.id) }
    }

    /// Whether anyone other than this stream, person or agent, is on `path`.
    public func anyoneElse(onPage path: String) -> Bool {
        peers.values.contains { $0.page?.path == path }
    }
}
