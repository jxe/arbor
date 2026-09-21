import Foundation
import Testing
@testable import CanopyAppKit

/// Executes every `document-admission` scenario from the shared
/// conformance fixture against the Swift reducer.
@Suite("Document admission machine fixtures")
struct DocumentAdmissionMachineTests {
    private var conformanceFixtures: URL {
        if let path = ProcessInfo.processInfo.environment["ARBOR_PROTOCOL_FIXTURES"] {
            return URL(fileURLWithPath: path, isDirectory: true)
        }
        return URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appending(path: "../../../../../docs/overstory-spec/conformance")
            .standardizedFileURL
    }

    @Test("Every shared admission scenario transitions identically")
    func sharedScenarios() throws {
        let data = try Data(contentsOf: conformanceFixtures.appending(path: "client-state-machines.json"))
        let fixture = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        let machines = try #require(fixture["machines"] as? [String: Any])
        let machine = try #require(machines["document-admission"] as? [String: Any])
        let scenarios = try #require(machine["scenarios"] as? [[String: Any]])
        #expect(scenarios.count >= 10)
        for scenario in scenarios {
            let name = try #require(scenario["name"] as? String)
            let initial = try #require(scenario["initial"] as? [String: Any])
            let accepted = try #require(initial["accepted"] as? [String: Any])
            var state = DocumentAdmissionMachine.State(
                accepted: .init(
                    source: try #require(accepted["source"] as? String),
                    revision: try #require(accepted["revision"] as? String)
                )
            )
            let steps = try #require(scenario["steps"] as? [[String: Any]])
            for (index, step) in steps.enumerated() {
                let event = try Self.event(from: try #require(step["event"] as? [String: Any]))
                let policy: WorkspaceAdmissionPolicy = scenario["admissionPolicy"] as? String == "retained-basis" ? .retainedBasis : .compareAndSwap
                let (nextState, effects) = DocumentAdmissionMachine.reduce(state, event, admissionPolicy: policy)
                state = nextState
                let label = "\(name) / step \(index + 1)"
                #expect(state.kind == step["state"] as? String, Comment(rawValue: label))
                #expect(effects.map(\.kind) == (step["effects"] as? [String] ?? []), Comment(rawValue: label))
                var effectValues: [String: Any] = [:]
                for (i, effect) in effects.enumerated() {
                    if let representation = effect.fixtureRepresentation { effectValues[String(i)] = representation }
                }
                for (path, expected) in step["effectExpect"] as? [String: Any] ?? [:] {
                    #expect(Self.equal(Self.value(at: path, in: effectValues), expected), Comment(rawValue: "\(label): effect \(path)"))
                }
                let representation = state.fixtureRepresentation
                for (path, expected) in step["expect"] as? [String: Any] ?? [:] {
                    let actual = Self.value(at: path, in: representation)
                    #expect(Self.equal(actual, expected), Comment(rawValue: "\(label): \(path) = \(String(describing: actual)), expected \(expected)"))
                }
            }
        }
    }

    private static func event(from json: [String: Any]) throws -> DocumentAdmissionMachine.Event {
        switch json["type"] as? String {
        case "edit":
            return .edit(source: try #require(json["source"] as? String), preservesIntent: json["preservesIntent"] as? Bool ?? false)
        case "debounceElapsed":
            return .debounceElapsed
        case "flush":
            return .flush
        case "admitted":
            let result = try #require(json["result"] as? [String: Any])
            return .admitted(
                generation: try #require(json["generation"] as? Int),
                result: .init(
                    source: try #require(result["source"] as? String),
                    revision: try #require(result["revision"] as? String)
                )
            )
        case "admissionConflicted":
            return .admissionConflicted(
                generation: try #require(json["generation"] as? Int),
                current: try (json["current"] as? [String: Any]).map(observation)
            )
        case "admissionFailed":
            let error = try #require(json["error"] as? [String: Any])
            return .admissionFailed(
                generation: try #require(json["generation"] as? Int),
                error: .init(message: try #require(error["message"] as? String), retryable: try #require(error["retryable"] as? Bool))
            )
        case "observed":
            let anchor = try (json["anchor"] as? [String: Any]).map { value in
                DocumentAdmissionMachine.Anchor(
                    generation: try #require(value["generation"] as? Int),
                    revision: try #require(value["revision"] as? String)
                )
            }
            return .observed(observation: try observation(try #require(json["observation"] as? [String: Any])), anchor: anchor)
        case "retry":
            return .retry
        case "resolveConflict":
            return .resolveConflict(keepSubmitted: try #require(json["choice"] as? String) == "keep-submitted")
        case "close":
            return .close
        default:
            throw FixtureError.unknownEvent(String(describing: json["type"]))
        }
    }

    private static func observation(_ json: [String: Any]) throws -> DocumentAdmissionMachine.Observation {
        .init(
            source: try #require(json["source"] as? String),
            revision: try #require(json["revision"] as? String)
        )
    }

    private static func value(at path: String, in representation: [String: Any]) -> Any? {
        var current: Any? = representation
        for key in path.split(separator: ".") {
            if let list = current as? [Any], let index = Int(key) {
                current = list.indices.contains(index) ? list[index] : nil
            } else if let dictionary = current as? [String: Any] {
                current = dictionary[String(key)]
            } else { return nil }
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

    enum FixtureError: Error {
        case unknownEvent(String)
    }
}

@Test("Legacy admission errors preserve the captured candidate instead of reconstructing it from the peer")
func legacyIntentConflictEvidence() async throws {
    let session = LegacyIntentSession()
    let basis = WorkspaceDocumentSnapshot(reference: .init(tree: "tr_one", path: "/page"), source: "R1", contentRevision: "r1")
    let intent = try WorkspaceDocumentIntent(basis: basis,
        patch: .init(baseContentRevision: "r1", edits: [.init(utf8Range: 0..<2, replacement: "Mine", expected: "R1")]), source: "Mine")
    do {
        _ = try await session.admit(intent: intent)
        Issue.record("Expected legacy rejection")
    } catch let conflict as WorkspaceDocumentConflict {
        #expect(conflict.base == basis)
        #expect(conflict.submittedSource == "Mine")
        #expect(conflict.current.source == "Peer")
    }
}

private actor LegacyIntentSession: WorkspaceDocumentSession {
    nonisolated let identity = WorkspaceReference(tree: "tr_one", path: "/page").identity
    func snapshot() -> WorkspaceDocumentSnapshot {
        .init(reference: .init(tree: "tr_one", path: "/page"), source: "Peer", contentRevision: "r2")
    }
    func admit(source: String, baseContentRevision: String) throws -> WorkspaceDocumentSnapshot {
        throw WorkspaceDocumentConflict(current: snapshot(), submittedSource: "Incorrectly reconstructed")
    }
    func admit(patch: WorkspaceDocumentPatch) throws -> WorkspaceDocumentSnapshot {
        try admit(source: "", baseContentRevision: patch.baseContentRevision)
    }
    func flush() {}
    func history() -> [WorkspaceHistoryEntry] { [] }
    func recover(revision: String) -> WorkspaceDocumentSnapshot { snapshot() }
    func close() {}
}
