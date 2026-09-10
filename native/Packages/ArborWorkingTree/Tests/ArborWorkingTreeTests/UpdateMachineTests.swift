@testable import ArborWorkingTree
import ArborWire
import Foundation
import Testing

/// Executes every `working-tree-updates` scenario from the shared
/// conformance fixture against the Swift `UpdateMachine` reducer.
@Suite("Update machine fixtures")
struct UpdateMachineTests {
    private var conformanceFixtures: URL {
        if let path = ProcessInfo.processInfo.environment["ARBOR_PROTOCOL_FIXTURES"] {
            return URL(fileURLWithPath: path, isDirectory: true)
        }
        return URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appending(path: "../../../../../conformance")
            .standardizedFileURL
    }

    @Test("Every shared working-tree update scenario transitions identically")
    func sharedScenarios() throws {
        let data = try Data(contentsOf: conformanceFixtures.appending(path: "client-state-machines.json"))
        let fixture = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        let machines = try #require(fixture["machines"] as? [String: Any])
        let machine = try #require(machines["working-tree-updates"] as? [String: Any])
        let scenarios = try #require(machine["scenarios"] as? [[String: Any]])
        #expect(scenarios.count >= 20)
        for scenario in scenarios {
            let name = try #require(scenario["name"] as? String)
            var state = try Self.state(from: try #require(scenario["initial"] as? [String: Any]))
            let steps = try #require(scenario["steps"] as? [[String: Any]])
            for (index, step) in steps.enumerated() {
                let event = try Self.event(from: try #require(step["event"] as? [String: Any]))
                let (nextState, effects) = UpdateMachine.reduce(state, event)
                state = nextState
                let label = "\(name) / step \(index + 1)"
                #expect(state.kind == step["state"] as? String, Comment(rawValue: label))
                #expect(effects.map(\.kind) == (step["effects"] as? [String] ?? []), Comment(rawValue: label))
                let representation = state.fixtureRepresentation
                for (path, expected) in step["expect"] as? [String: Any] ?? [:] {
                    let actual = Self.value(at: path, in: representation)
                    #expect(Self.equal(actual, expected), Comment(rawValue: "\(label): \(path) = \(String(describing: actual)), expected \(expected)"))
                }
            }
        }
    }

    @Test("Element digests are independent of how object envelopes are packed")
    func envelopeIndependence() throws {
        let data = try Data(contentsOf: conformanceFixtures.appending(path: "wire-update-intent.json"))
        let fixture = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        let vector = try #require(fixture["envelopeIndependence"] as? [String: Any])
        let tree = try #require(vector["tree"] as? String)
        let candidates = try #require(vector["candidates"] as? [String])
        let base = WireUpdateBase(root: candidates[0], update: try #require(vector["base"] as? String))
        let expected = try #require(vector["digests"] as? [String])
        let ifMatch = try #require(vector["ifMatch"] as? String)
        let packings = try #require(vector["packings"] as? [[[[String: String]]]])
        for packing in packings {
            var updates: [WireCandidateUpdate] = []
            for (index, candidate) in candidates.enumerated() {
                var objects: [WireObjectEnvelope] = []
                for envelope in index < packing.count ? packing[index] : [] {
                    let hash = try #require(envelope["hash"])
                    let encoded = try #require(envelope["bytes"])
                    let bytes = try #require(Data(base64Encoded: encoded))
                    objects.append(WireObjectEnvelope(hash: hash, bytes: bytes))
                }
                updates.append(WireCandidateUpdate(
                    candidate: candidate,
                    ifMatch: ifMatch,
                    onConflict: vector["onConflict"] as? String,
                    objects: objects
                ))
            }
            #expect(updateRequestDigests(tree: tree, base: base, updates: updates) == expected)
        }
    }

    // MARK: Decoding

    private static func base(_ json: [String: Any]) throws -> UpdateMachine.AcceptedBase {
        .init(
            root: try #require(json["root"] as? String),
            update: try #require(json["update"] as? String),
            cursor: json["cursor"] as? String
        )
    }

    private static func head(_ json: [String: Any]?) throws -> UpdateMachine.LocalHead? {
        guard let json else { return nil }
        return .init(
            root: try #require(json["root"] as? String),
            origin: try Self.enumValue(UpdateMachine.HeadOrigin.self, from: json, key: "origin")
        )
    }

    private static func request(_ json: [String: Any]?) throws -> UpdateMachine.PreparedRequest? {
        guard let json else { return nil }
        return .init(
            id: try #require(json["id"] as? String),
            base: try #require(json["base"] as? String),
            candidate: try #require(json["candidate"] as? String),
            digests: try #require(json["digests"] as? [String])
        )
    }

    private static func result(_ json: [String: Any]) throws -> UpdateMachine.AuthorityResult {
        .init(
            kind: try Self.enumValue(UpdateMachine.AuthorityResult.Kind.self, from: json, key: "kind"),
            root: try #require(json["root"] as? String),
            update: try #require(json["update"] as? String),
            cursor: json["cursor"] as? String,
            digests: json["digests"] as? [String] ?? []
        )
    }

    private static func conflict(_ json: [String: Any]) throws -> UpdateMachine.ConflictEvidence {
        .init(
            current: try base(try #require(json["current"] as? [String: Any])),
            draft: json["draft"] as? String,
            localRoot: try #require(json["localRoot"] as? String),
            failedIndex: json["failedIndex"] as? Int ?? 0
        )
    }

    private static func state(from json: [String: Any]) throws -> UpdateMachine.State {
        let kind = try #require(json["kind"] as? String)
        let phase: UpdateMachine.Phase
        switch kind {
        case "unplaced":
            phase = .unplaced
        case "current":
            phase = .current
        case "locally-pending":
            phase = .locallyPending(head: try #require(try head(json["head"] as? [String: Any])), preparing: json["preparing"] as? Bool ?? false)
        case "prepared":
            phase = .prepared(request: try #require(try request(json["request"] as? [String: Any])), head: try head(json["head"] as? [String: Any]))
        case "submitting":
            phase = .submitting(request: try #require(try request(json["request"] as? [String: Any])))
        case "submitting-pending":
            phase = .submittingPending(
                request: try #require(try request(json["request"] as? [String: Any])),
                head: try #require(try head(json["head"] as? [String: Any]))
            )
        case "accepted-pending-apply":
            phase = .acceptedPendingApply(
                result: try result(try #require(json["result"] as? [String: Any])),
                request: try request(json["request"] as? [String: Any]),
                head: try head(json["head"] as? [String: Any])
            )
        case "conflict":
            phase = .conflict(
                request: try #require(try request(json["request"] as? [String: Any])),
                conflict: try conflict(try #require(json["conflict"] as? [String: Any])),
                head: try head(json["head"] as? [String: Any])
            )
        case "conflict-preparing":
            phase = .conflictPreparing(
                request: try #require(try request(json["request"] as? [String: Any])),
                conflict: try conflict(try #require(json["conflict"] as? [String: Any])),
                choice: try Self.enumValue(UpdateMachine.Event.Resolution.self, from: json, key: "choice"),
                head: try head(json["head"] as? [String: Any])
            )
        case "offline":
            let availability = try #require(json["availability"] as? [String: Any])
            let availabilityValue: UpdateMachine.Availability = availability["kind"] as? String == "authentication"
                ? .authentication(reason: availability["reason"] as? String)
                : .transport
            phase = .offline(
                availability: availabilityValue,
                request: try request(json["request"] as? [String: Any]),
                transmitted: json["transmitted"] as? Bool ?? false,
                head: try head(json["head"] as? [String: Any])
            )
        default:
            throw FixtureError.unknownState(kind)
        }
        return UpdateMachine.State(
            phase: phase,
            base: try (json["base"] as? [String: Any]).map(base),
            transportAvailable: json["transportAvailable"] as? Bool ?? true
        )
    }

    private static func event(from json: [String: Any]) throws -> UpdateMachine.Event {
        switch json["type"] as? String {
        case "bootstrapInstalled":
            return .bootstrapInstalled(
                root: try #require(json["root"] as? String),
                update: try #require(json["update"] as? String),
                cursor: json["cursor"] as? String
            )
        case "localHead":
            return .localHead(
                root: try #require(json["root"] as? String),
                origin: try Self.enumValue(UpdateMachine.HeadOrigin.self, from: json, key: "origin")
            )
        case "publishDelayElapsed":
            return .publishDelayElapsed
        case "maxDelayElapsed":
            return .maxDelayElapsed
        case "requestPersisted":
            return .requestPersisted(try #require(try request(json["request"] as? [String: Any])))
        case "submitStarted":
            return .submitStarted(id: try #require(json["id"] as? String))
        case "accepted":
            return .accepted(id: try #require(json["id"] as? String), result: try result(try #require(json["result"] as? [String: Any])))
        case "watch":
            return .watch(
                cursor: try #require(json["cursor"] as? String),
                root: try #require(json["root"] as? String),
                update: try #require(json["update"] as? String),
                digests: json["digests"] as? [String] ?? [],
                transitions: json["transitions"] as? Bool ?? false
            )
        case "watchGap":
            return .watchGap
        case "conflicted":
            return .conflicted(id: try #require(json["id"] as? String), conflict: try conflict(try #require(json["conflict"] as? [String: Any])))
        case "applied":
            return .applied
        case "transportFailed":
            return .transportFailed(id: json["id"] as? String)
        case "authenticationFailed":
            return .authenticationFailed(reason: json["reason"] as? String)
        case "validationFailed":
            return .validationFailed(reason: try #require(json["reason"] as? String))
        case "transportAvailable":
            return .transportAvailable(try #require(json["available"] as? Bool))
        case "credentialsRefreshed":
            return .credentialsRefreshed
        case "resolveConflict":
            return .resolveConflict(try Self.enumValue(UpdateMachine.Event.Resolution.self, from: json, key: "choice"))
        case "conflictResolutionFailed":
            return .conflictResolutionFailed
        default:
            throw FixtureError.unknownEvent(String(describing: json["type"]))
        }
    }

    private static func value(at path: String, in representation: [String: Any]) -> Any? {
        var current: Any? = representation
        for key in path.split(separator: ".") {
            guard let dictionary = current as? [String: Any] else { return nil }
            current = dictionary[String(key)]
        }
        return current
    }

    private static func equal(_ actual: Any?, _ expected: Any) -> Bool {
        switch (actual, expected) {
        case let (left as String, right as String): left == right
        case let (left as Int, right as Int): left == right
        case let (left as Bool, right as Bool): left == right
        case let (left as [String], right as [String]): left == right
        default: false
        }
    }

    private static func enumValue<T: RawRepresentable>(_: T.Type, from json: [String: Any], key: String) throws -> T where T.RawValue == String {
        let raw = try #require(json[key] as? String)
        return try #require(T(rawValue: raw))
    }

    enum FixtureError: Error {
        case unknownState(String)
        case unknownEvent(String)
    }
}
