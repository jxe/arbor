@testable import CanopyWorkingTree
import Overstory
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
            .appending(path: "../../../../../docs/overstory-spec/conformance")
            .standardizedFileURL
    }

    @Test("Publication selection agrees with the shared client-machine vectors")
    func publicationSelection() throws {
        struct Fixture: Decodable {
            struct Scenario: Decodable {
                struct Record: Decodable { let change: String; let parent: String? }
                let name: String; let records: [Record]; let accepted: [String]; let tip: String?
            }
            let scenarios: [Scenario]
        }
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf:
            URL(fileURLWithPath: #filePath).deletingLastPathComponent()
                .appending(path: "../../../../../tests/fixtures/source-publication.json")))
        for scenario in fixture.scenarios {
            #expect(UpdateMachine.publicationTip(scenario.records.map { ($0.change, $0.parent) },
                accepted: Set(scenario.accepted)) == scenario.tip, Comment(rawValue: scenario.name))
        }
    }

    @Test("Every shared working-tree update scenario transitions identically")
    func sharedScenarios() throws {
        let data = try Data(contentsOf: conformanceFixtures.appending(path: "client-state-machines.json"))
        let fixture = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        let machines = try #require(fixture["machines"] as? [String: Any])
        let machine = try #require(machines["working-tree-updates"] as? [String: Any])
        let scenarios = try #require(machine["scenarios"] as? [[String: Any]])
        #expect(!scenarios.isEmpty)
        for scenario in scenarios {
            let name = try #require(scenario["name"] as? String)
            var state = try Self.state(from: try #require(scenario["initial"] as? [String: Any]))
            var options = UpdateMachine.Options()
            if let poll = (scenario["options"] as? [String: Any])?["pollIntervalMs"] as? Int {
                options.pollInterval = .milliseconds(poll)
            }
            let steps = try #require(scenario["steps"] as? [[String: Any]])
            for (index, step) in steps.enumerated() {
                let event = try Self.event(from: try #require(step["event"] as? [String: Any]))
                let (nextState, effects) = UpdateMachine.reduce(state, event, options: options)
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

    @Test("Element digests are independent of complete or sparse transport")
    func envelopeIndependence() throws {
        let data = try Data(contentsOf: conformanceFixtures.appending(path: "protocol-authored-transport.json"))
        let fixture = try #require(JSONSerialization.jsonObject(with:data) as? [String: Any])
        let tree = try #require(fixture["tree"] as? String)
        let cases = try #require(fixture["cases"] as? [[String: Any]])
        var digests: [[String]] = []
        for row in cases.prefix(3) {
            let body = try JSONSerialization.data(withJSONObject: #require(row["value"]))
            let request = try JSONDecoder().decode(WireUpdateRequest.self,from:body)
            digests.append(updateRequestDigests(tree:tree,base:request.base,updates:request.updates))
        }
        #expect(digests[0] == digests[1])
        #expect(digests[0] == digests[2])
    }

    private static func base(_ json: [String: Any]) throws -> UpdateMachine.AcceptedBase {
        .init(
            root: try #require(json["root"] as? String),
            update: try #require(json["update"] as? String),
            cursor: json["cursor"] as? String,
            conflicted: json["conflicted"] as? Bool
        )
    }

    private static func tip(_ json: [String: Any]?) throws -> UpdateMachine.LocalTip? {
        guard let json else { return nil }
        return .init(change: try #require(json["change"] as? String), root: try #require(json["root"] as? String))
    }

    private static func request(_ json: [String: Any]?) throws -> UpdateMachine.PreparedRequest? {
        guard let json else { return nil }
        return .init(
            id: try #require(json["id"] as? String),
            base: try #require(json["base"] as? String),
            candidate: try #require(json["candidate"] as? String),
            tip: try #require(json["tip"] as? String),
            digests: try #require(json["digests"] as? [String])
        )
    }

    private static func result(_ json: [String: Any]) throws -> UpdateMachine.AuthorityResult {
        .init(
            kind: try Self.enumValue(UpdateMachine.AuthorityResult.Kind.self, from: json, key: "kind"),
            root: try #require(json["root"] as? String),
            update: try #require(json["update"] as? String),
            cursor: json["cursor"] as? String,
            digests: json["digests"] as? [String] ?? [],
            conflicted: json["conflicted"] as? Bool
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
            phase = .locallyPending(tip: try #require(try tip(json["tip"] as? [String: Any])), preparing: json["preparing"] as? Bool ?? false)
        case "prepared":
            phase = .prepared(request: try #require(try request(json["request"] as? [String: Any])), tip: try tip(json["tip"] as? [String: Any]))
        case "submitting":
            phase = .submitting(request: try #require(try request(json["request"] as? [String: Any])))
        case "submitting-pending":
            phase = .submittingPending(
                request: try #require(try request(json["request"] as? [String: Any])),
                tip: try #require(try tip(json["tip"] as? [String: Any]))
            )
        case "accepted-pending-apply":
            phase = .acceptedPendingApply(
                result: try result(try #require(json["result"] as? [String: Any])),
                request: try request(json["request"] as? [String: Any]),
                tip: try tip(json["tip"] as? [String: Any])
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
                tip: try tip(json["tip"] as? [String: Any])
            )
        case "held":
            phase = .held(
                reason: try Self.enumValue(UpdateMachine.HeldReason.self, from: json, key: "reason"),
                detail: json["detail"] as? String,
                request: try #require(try request(json["request"] as? [String: Any])),
                tip: try tip(json["tip"] as? [String: Any])
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
                cursor: json["cursor"] as? String,
            conflicted: json["conflicted"] as? Bool
            )
        case "recovered":
            return .recovered(
                request: try #require(try request(json["request"] as? [String: Any])),
                held: try (json["held"] as? String).map { try #require(UpdateMachine.HeldReason(rawValue: $0)) },
                detail: json["detail"] as? String
            )
        case "localChange":
            return .localChange(change: try #require(json["change"] as? String), root: try #require(json["root"] as? String))
        case "pollElapsed":
            return .pollElapsed
        case "rejected":
            return .rejected(id: try #require(json["id"] as? String), detail: json["detail"] as? String)
        case "unsupported":
            return .unsupported(id: try #require(json["id"] as? String), detail: json["detail"] as? String)
        case "heldDiscarded":
            return .heldDiscarded
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
                transitions: json["transitions"] as? Bool ?? false,
                conflicted: json["conflicted"] as? Bool
            )
        case "watchGap":
            return .watchGap
        case "applied":
            return .applied(installed: try (json["installed"] as? [String: Any]).map(base))
        case "syncRequested":
            return .syncRequested
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
