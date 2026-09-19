import Foundation

/// Document admission: the state machine every editor talking to a
/// `WorkspaceDocumentSession` runs (Reliability 005, machine A).
///
/// The reducer is pure and owns every timer, in-flight, successor, flush,
/// observation, failure, and conflict transition. The host runs the effects.
/// It lives in ArborKit because the editor binding drives a provider-agnostic
/// session: on iOS and on the Mac the same machine runs against the working
/// tree. Admission is working-tree durability, not accepted history: the
/// update machine (`UpdateMachine` in `ArborWorkingTree`, spec/09) publishes
/// the durable heads afterwards, and the two machines compose in sequence.
/// It executes the same `document-admission` fixture scenarios as the
/// TypeScript reducer in `@arbor/core`.
///
/// A submission is the list of editor generations since the last admission,
/// each with the patch the editor captured against its predecessor. The host
/// admits the whole list at once and emits one frame per generation (plan
/// 010 Phase 3), so nothing is re-derived across a debounced burst.
public enum DocumentAdmissionMachine {
    /// Reference debounce for the current native and web editors.
    public static let debounce: Duration = .milliseconds(250)

    public struct Accepted: Sendable, Equatable {
        public var source: String
        public var revision: String

        public init(source: String, revision: String) {
            self.source = source
            self.revision = revision
        }
    }

    /// One editor generation: the source it produced and, when the editor
    /// captured one, the patch from the previous generation's source to it.
    public struct Generation: Sendable, Equatable {
        public var generation: Int
        public var source: String
        public var preservesIntent: Bool
        public var patch: WorkspaceDocumentPatch?

        public init(generation: Int, source: String, preservesIntent: Bool = false, patch: WorkspaceDocumentPatch? = nil) {
            self.generation = generation
            self.source = source
            self.preservesIntent = preservesIntent
            self.patch = patch
        }
    }

    /// The generations since the last admission, in authored order; never empty.
    public struct Submission: Sendable, Equatable {
        public var generations: [Generation]

        public init(generations: [Generation]) {
            precondition(!generations.isEmpty, "A submission carries at least one generation")
            self.generations = generations
        }

        public init(generation: Int, source: String, preservesIntent: Bool = false, patch: WorkspaceDocumentPatch? = nil) {
            self.init(generations: [Generation(generation: generation, source: source, preservesIntent: preservesIntent, patch: patch)])
        }

        /// The newest generation number: what an acknowledgement must name.
        public var generation: Int { generations.last!.generation }
        /// The newest source: the candidate this submission produces.
        public var source: String { generations.last!.source }
        /// Whether any generation carries lineage or copy intent that equal bytes must not erase.
        public var preservesIntent: Bool { generations.contains { $0.preservesIntent } }

        func appending(_ generation: Generation) -> Submission { Submission(generations: generations + [generation]) }
        func appending(_ later: Submission?) -> Submission { later.map { Submission(generations: generations + $0.generations) } ?? self }
    }

    public struct Observation: Sendable, Equatable {
        public var source: String
        public var revision: String

        public init(source: String, revision: String) {
            self.source = source
            self.revision = revision
        }
    }

    /// Captured before an asynchronous read so a stale result can be discarded.
    public struct Anchor: Sendable, Equatable {
        public var generation: Int
        public var revision: String

        public init(generation: Int, revision: String) {
            self.generation = generation
            self.revision = revision
        }
    }

    public struct Result: Sendable, Equatable {
        public var source: String
        public var revision: String

        public init(source: String, revision: String) {
            self.source = source
            self.revision = revision
        }
    }

    public struct Failure: Sendable, Equatable {
        public var message: String
        public var retryable: Bool

        public init(message: String, retryable: Bool) {
            self.message = message
            self.retryable = retryable
        }
    }

    public enum Phase: Sendable, Equatable {
        case clean
        case dirty(latest: Submission)
        case submitting(submitted: Submission)
        case submittingDirty(submitted: Submission, latest: Submission)
        case conflict(submitted: Submission, current: Observation?, latest: Submission?)
        case failed(pending: Submission, error: Failure, latest: Submission?)
        case closed

        public var kind: String {
            switch self {
            case .clean: "clean"
            case .dirty: "dirty"
            case .submitting: "submitting"
            case .submittingDirty: "submitting-dirty"
            case .conflict: "conflict"
            case .failed: "failed"
            case .closed: "closed"
            }
        }
    }

    public struct State: Sendable, Equatable {
        public var phase: Phase
        public var accepted: Accepted
        /// Monotonic editor generation; every edit increments it.
        public var generation: Int

        public init(accepted: Accepted) {
            self.phase = .clean
            self.accepted = accepted
            self.generation = 0
        }

        public var kind: String { phase.kind }

        /// Whether the machine still holds authored intent that is not locally durable.
        public var isDirty: Bool {
            switch phase {
            case .dirty, .submitting, .submittingDirty, .failed, .conflict: true
            case .clean, .closed: false
            }
        }

        /// Whether a request is in flight or a timer may still start one.
        public var isSettled: Bool {
            switch phase {
            case .dirty, .submitting, .submittingDirty: false
            default: true
            }
        }

        public var anchor: Anchor { Anchor(generation: generation, revision: accepted.revision) }

        /// Every generation since `accepted`, in authored order: what a
        /// recovery checkpoint retains and what the next admission will carry.
        public var pendingGenerations: [Generation] {
            switch phase {
            case .clean, .closed: []
            case let .dirty(latest): latest.generations
            case let .submitting(submitted): submitted.generations
            case let .submittingDirty(submitted, latest): submitted.generations + latest.generations
            case let .conflict(submitted, _, latest): submitted.generations + (latest?.generations ?? [])
            case let .failed(pending, _, latest): pending.generations + (latest?.generations ?? [])
            }
        }
    }

    public enum Event: Sendable, Equatable {
        /// A committed editor generation. `patch` is the edit as captured
        /// against the previous generation's source, when the editor has one.
        case edit(source: String, preservesIntent: Bool = false, patch: WorkspaceDocumentPatch? = nil)
        case debounceElapsed
        /// Explicit Save, navigation, focus loss, backgrounding, or close: admit the latest source now.
        case flush
        case admitted(generation: Int, result: Result)
        case admissionConflicted(generation: Int, current: Observation?)
        case admissionFailed(generation: Int, error: Failure)
        case observed(observation: Observation, anchor: Anchor?)
        case retry
        case resolveConflict(keepSubmitted: Bool)
        case close
    }

    public enum Effect: Sendable, Equatable {
        case schedule(Duration)
        case cancelTimer
        /// Admit every generation since the base, in order; the last one is the candidate.
        case admit(generations: [Generation], baseRevision: String, baseSource: String)
        /// The working tree acknowledged the exact tree already in the editor; advance source authority without replacing it.
        case acknowledge(Result)
        /// Replace the editor with authoritative content.
        case apply(source: String, revision: String)
        /// The working tree rejected the write; the host may run its explicit local merge helper or surface the conflict.
        case mergeLocally(current: Observation?, submitted: String, base: String)
        case surfaceFailure(Failure)
        case stop

        public var kind: String {
            switch self {
            case .schedule: "schedule"
            case .cancelTimer: "cancelTimer"
            case .admit: "admit"
            case .acknowledge: "acknowledge"
            case .apply: "apply"
            case .mergeLocally: "mergeLocally"
            case .surfaceFailure: "surfaceFailure"
            case .stop: "stop"
            }
        }
    }

    public static func reduce(_ state: State, _ event: Event, debounce: Duration = debounce,
                              admissionPolicy: WorkspaceAdmissionPolicy = .compareAndSwap) -> (State, [Effect]) {
        var next = state
        if case .closed = state.phase { return (state, []) }

        switch event {
        case let .edit(source, preservesIntent, patch):
            next.generation = state.generation + 1
            let generation = Generation(generation: next.generation, source: source, preservesIntent: preservesIntent, patch: patch)
            switch state.phase {
            case .clean:
                next.phase = .dirty(latest: Submission(generations: [generation]))
                return (next, [.schedule(debounce)])
            case let .dirty(latest):
                next.phase = .dirty(latest: latest.appending(generation))
                return (next, [.schedule(debounce)])
            case let .submitting(submitted):
                next.phase = .submittingDirty(submitted: submitted, latest: Submission(generations: [generation]))
                return (next, [])
            case let .submittingDirty(submitted, latest):
                next.phase = .submittingDirty(submitted: submitted, latest: latest.appending(generation))
                return (next, [])
            case let .conflict(submitted, current, latest):
                next.phase = .conflict(submitted: submitted, current: current,
                                       latest: latest?.appending(generation) ?? Submission(generations: [generation]))
                return (next, [])
            case let .failed(pending, error, latest):
                next.phase = .failed(pending: pending, error: error,
                                     latest: latest?.appending(generation) ?? Submission(generations: [generation]))
                return (next, [])
            case .closed:
                return (state, [])
            }

        case .debounceElapsed:
            guard case let .dirty(latest) = state.phase else { return (state, []) }
            return submit(next, latest)

        case .flush:
            switch state.phase {
            case let .dirty(latest):
                let (submitted, effects) = submit(next, latest)
                return (submitted, [.cancelTimer] + effects)
            case let .failed(pending, _, latest):
                // Generations edited after the failure continue the pending chain.
                return submit(next, pending.appending(latest))
            default:
                return (state, [])
            }

        case let .admitted(generation, result):
            let submitted: Submission
            var latest: Submission?
            switch state.phase {
            case let .submitting(value): submitted = value
            case let .submittingDirty(value, dirty): submitted = value; latest = dirty
            default: return (state, [])
            }
            guard generation == submitted.generation else { return (state, []) }
            next.accepted = Accepted(source: result.source, revision: result.revision)
            let effects: [Effect] = [.acknowledge(result)]
            if let latest {
                next.phase = .clean
                let (successor, more) = submit(next, latest)
                return (successor, effects + more)
            }
            next.phase = .clean
            return (next, effects)

        case let .admissionConflicted(generation, current):
            let submitted: Submission
            var latest: Submission?
            switch state.phase {
            case let .submitting(value): submitted = value
            case let .submittingDirty(value, dirty): submitted = value; latest = dirty
            default: return (state, [])
            }
            guard generation == submitted.generation else { return (state, []) }
            if admissionPolicy == .retainedBasis {
                let error = Failure(message: "Retained-basis admission cannot require local conflict resolution", retryable: false)
                next.phase = .failed(pending: submitted, error: error, latest: latest)
                return (next, [.surfaceFailure(error)])
            }
            next.phase = .conflict(submitted: submitted, current: current, latest: latest)
            return (next, [.mergeLocally(current: current, submitted: submitted.source, base: state.accepted.source)])

        case let .admissionFailed(generation, error):
            let submitted: Submission
            var latest: Submission?
            switch state.phase {
            case let .submitting(value): submitted = value
            case let .submittingDirty(value, dirty): submitted = value; latest = dirty
            default: return (state, [])
            }
            guard generation == submitted.generation else { return (state, []) }
            next.phase = .failed(pending: submitted, error: error, latest: latest)
            return (next, [.surfaceFailure(error)])

        case let .observed(observation, anchor):
            if let anchor, anchor.generation != state.generation || anchor.revision != state.accepted.revision {
                return (state, [])
            }
            switch state.phase {
            case .clean:
                guard observation.revision != state.accepted.revision else { return (state, []) }
                next.accepted = accepted(from: observation)
                return (next, [.apply(source: observation.source, revision: observation.revision)])
            case let .dirty(latest):
                // External change while local intent is coalescing: make the
                // local intent durable now so the working tree reconciles.
                guard observation.revision != state.accepted.revision else { return (state, []) }
                let (submitted, effects) = submit(next, latest)
                return (submitted, [.cancelTimer] + effects)
            default:
                return (state, [])
            }

        case .retry:
            guard case let .failed(pending, _, latest) = state.phase else { return (state, []) }
            return submit(next, pending.appending(latest))

        case let .resolveConflict(keepSubmitted):
            guard case let .conflict(submitted, current, latest) = state.phase else { return (state, []) }
            if !keepSubmitted {
                guard let current else { return (state, []) }
                next.accepted = accepted(from: current)
                next.phase = .clean
                return (next, [.apply(source: current.source, revision: current.revision)])
            }
            if let current { next.accepted = accepted(from: current) }
            next.phase = .clean
            return submit(next, submitted.appending(latest))

        case .close:
            next.phase = .closed
            return (next, [.cancelTimer, .stop])
        }
    }

    private static func submit(_ state: State, _ latest: Submission) -> (State, [Effect]) {
        var next = state
        // Editing back to the accepted bytes is an idempotent local success.
        if latest.source == state.accepted.source && !latest.preservesIntent {
            next.phase = .clean
            return (next, [])
        }
        next.phase = .submitting(submitted: latest)
        return (next, [.admit(
            generations: latest.generations,
            baseRevision: state.accepted.revision,
            baseSource: state.accepted.source
        )])
    }

    private static func accepted(from observation: Observation) -> Accepted {
        Accepted(source: observation.source, revision: observation.revision)
    }
}

extension DocumentAdmissionMachine.State {
    /// A dictionary view used by the shared fixture to check retained fields by dotted path.
    public var fixtureRepresentation: [String: Any] {
        var value: [String: Any] = [
            "kind": kind,
            "generation": generation,
            "accepted": accepted.fixtureRepresentation,
        ]
        switch phase {
        case .clean, .closed:
            break
        case let .dirty(latest):
            value["latest"] = latest.fixtureRepresentation
        case let .submitting(submitted):
            value["submitted"] = submitted.fixtureRepresentation
        case let .submittingDirty(submitted, latest):
            value["submitted"] = submitted.fixtureRepresentation
            value["latest"] = latest.fixtureRepresentation
        case let .conflict(submitted, current, latest):
            value["submitted"] = submitted.fixtureRepresentation
            if let current { value["current"] = current.fixtureRepresentation }
            if let latest { value["latest"] = latest.fixtureRepresentation }
        case let .failed(pending, error, latest):
            value["pending"] = pending.fixtureRepresentation
            value["error"] = ["message": error.message, "retryable": error.retryable]
            if let latest { value["latest"] = latest.fixtureRepresentation }
        }
        return value
    }
}

extension DocumentAdmissionMachine.Accepted {
    var fixtureRepresentation: [String: Any] { ["source": source, "revision": revision] }
}

extension DocumentAdmissionMachine.Generation {
    var fixtureRepresentation: [String: Any] { ["generation": generation, "source": source] }
}

extension DocumentAdmissionMachine.Submission {
    var fixtureRepresentation: [String: Any] {
        ["generation": generation, "source": source, "generations": generations.map(\.fixtureRepresentation)]
    }
}

extension DocumentAdmissionMachine.Effect {
    /// A dictionary view of an `admit` effect for the shared fixture.
    public var fixtureRepresentation: [String: Any]? {
        guard case let .admit(generations, baseRevision, baseSource) = self else { return nil }
        return ["generation": generations.last!.generation, "source": generations.last!.source,
                "baseRevision": baseRevision, "baseSource": baseSource,
                "generations": generations.map(\.fixtureRepresentation)]
    }
}

extension DocumentAdmissionMachine.Observation {
    var fixtureRepresentation: [String: Any] { ["source": source, "revision": revision] }
}
