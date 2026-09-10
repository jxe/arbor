import Foundation

/// Direct Canopy synchronization: the state machine a durable replica runs
/// against Arbor Wire (Reliability 005, machine B).
///
/// The reducer is pure and language-neutral: roots, updates, cursors, and
/// request digests are opaque tokens. `UpdateCoordinator` maps its
/// `UpdateControl` onto these states, persists what each state retains,
/// and executes the effects the reducer returns. It executes the same fixture
/// scenarios as the TypeScript reducer in `@arbor/canopy-client`.
public enum UpdateMachine {
    /// Trailing delay before unsent durable local work is published.
    public static let publicationDelay: Duration = .milliseconds(250)
    /// Maximum delay from the first unsent durable head to its publication.
    public static let publicationMaxDelay: Duration = .seconds(1)

    public struct AcceptedBase: Sendable, Equatable {
        public var root: String
        public var update: String
        public var cursor: String?

        public init(root: String, update: String, cursor: String? = nil) {
            self.root = root
            self.update = update
            self.cursor = cursor
        }
    }

    public enum HeadOrigin: String, Sendable, Equatable {
        case editor
        case filesystem
        case api
    }

    public struct LocalHead: Sendable, Equatable {
        public var root: String
        public var origin: HeadOrigin

        public init(root: String, origin: HeadOrigin) {
            self.root = root
            self.origin = origin
        }
    }

    public struct PreparedRequest: Sendable, Equatable {
        /// Digest of the last element; the request's identity for response and watch correlation.
        public var id: String
        public var base: String
        public var candidate: String
        /// Every element digest in prefix order.
        public var digests: [String]

        public init(id: String, base: String, candidate: String, digests: [String]) {
            self.id = id
            self.base = base
            self.candidate = candidate
            self.digests = digests
        }
    }

    public struct AuthorityResult: Sendable, Equatable {
        public enum Kind: String, Sendable, Equatable {
            case accepted
            case merged
            case current
        }

        public var kind: Kind
        public var root: String
        public var update: String
        public var cursor: String?
        public var digests: [String]

        public init(kind: Kind, root: String, update: String, cursor: String? = nil, digests: [String] = []) {
            self.kind = kind
            self.root = root
            self.update = update
            self.cursor = cursor
            self.digests = digests
        }
    }

    public struct ConflictEvidence: Sendable, Equatable {
        public var current: AcceptedBase
        public var draft: String?
        public var localRoot: String
        public var failedIndex: Int

        public init(current: AcceptedBase, draft: String? = nil, localRoot: String, failedIndex: Int = 0) {
            self.current = current
            self.draft = draft
            self.localRoot = localRoot
            self.failedIndex = failedIndex
        }
    }

    public enum Availability: Sendable, Equatable {
        case transport
        case authentication(reason: String?)

        var kind: String {
            switch self {
            case .transport: "transport"
            case .authentication: "authentication"
            }
        }
    }

    public enum Phase: Sendable, Equatable {
        case unplaced
        case current
        case locallyPending(head: LocalHead, preparing: Bool)
        case prepared(request: PreparedRequest, head: LocalHead?)
        case submitting(request: PreparedRequest)
        case submittingPending(request: PreparedRequest, head: LocalHead)
        case acceptedPendingApply(result: AuthorityResult, request: PreparedRequest?, head: LocalHead?)
        case conflict(request: PreparedRequest, conflict: ConflictEvidence, head: LocalHead?)
        case conflictPreparing(request: PreparedRequest, conflict: ConflictEvidence, choice: Event.Resolution, head: LocalHead?)
        case offline(availability: Availability, request: PreparedRequest?, transmitted: Bool, head: LocalHead?)
        case terminal(reason: String)

        public var kind: String {
            switch self {
            case .unplaced: "unplaced"
            case .current: "current"
            case .locallyPending: "locally-pending"
            case .prepared: "prepared"
            case .submitting: "submitting"
            case .submittingPending: "submitting-pending"
            case .acceptedPendingApply: "accepted-pending-apply"
            case .conflict: "conflict"
            case .conflictPreparing: "conflict-preparing"
            case .offline: "offline"
            case .terminal: "terminal"
            }
        }
    }

    public struct State: Sendable, Equatable {
        public var phase: Phase
        public var base: AcceptedBase?
        public var transportAvailable: Bool

        public init(phase: Phase = .unplaced, base: AcceptedBase? = nil, transportAvailable: Bool = true) {
            self.phase = phase
            self.base = base
            self.transportAvailable = transportAvailable
        }

        public var kind: String { phase.kind }

        /// Whether the machine holds a request whose outcome may already be known to the authority.
        public var requestMayHaveReachedAuthority: Bool {
            switch phase {
            case .submitting, .submittingPending: true
            case let .offline(_, _, transmitted, _): transmitted
            default: false
            }
        }
    }

    public enum Timer: String, Sendable, Equatable {
        case trailing
        case max
    }

    public enum Event: Sendable, Equatable {
        case bootstrapInstalled(root: String, update: String, cursor: String?)
        case localHead(root: String, origin: HeadOrigin)
        case publishDelayElapsed
        case maxDelayElapsed
        case requestPersisted(PreparedRequest)
        case submitStarted(id: String)
        case accepted(id: String, result: AuthorityResult)
        case watch(cursor: String, root: String, update: String, digests: [String], transitions: Bool)
        case watchGap
        case conflicted(id: String, conflict: ConflictEvidence)
        case applied
        case transportFailed(id: String?)
        case authenticationFailed(reason: String?)
        case validationFailed(reason: String)
        case transportAvailable(Bool)
        case credentialsRefreshed
        case resolveConflict(Resolution)
        case conflictResolutionFailed

        public enum Resolution: String, Sendable, Equatable {
            case local
            case remote
            case draft
        }
    }

    public enum Effect: Sendable, Equatable {
        case schedule(Timer, Duration)
        case cancelTimers
        /// Persist one exact request from `base` to `candidate`; `extends` names the transmitted prefix it appends to.
        case persistRequest(base: AcceptedBase, candidate: String, extends: PreparedRequest?)
        case submit(PreparedRequest)
        /// Validate, durably materialize, then dispatch `applied`.
        case apply(AuthorityResult)
        /// Clean catch-up: apply a contiguous transition batch or pull the current snapshot, then dispatch `applied`.
        case catchUp(cursor: String?)
        case persistConflictResolution(request: PreparedRequest, conflict: ConflictEvidence, choice: Event.Resolution)
        case surfaceConflict(ConflictEvidence)
        case stop(reason: String)

        public var kind: String {
            switch self {
            case .schedule: "schedule"
            case .cancelTimers: "cancelTimers"
            case .persistRequest: "persistRequest"
            case .submit: "submit"
            case .apply: "apply"
            case .catchUp: "catchUp"
            case .persistConflictResolution: "persistConflictResolution"
            case .surfaceConflict: "surfaceConflict"
            case .stop: "stop"
            }
        }
    }

    public struct Options: Sendable, Equatable {
        public var publicationDelay: Duration
        public var publicationMaxDelay: Duration

        public init(publicationDelay: Duration = UpdateMachine.publicationDelay, publicationMaxDelay: Duration = UpdateMachine.publicationMaxDelay) {
            self.publicationDelay = publicationDelay
            self.publicationMaxDelay = publicationMaxDelay
        }
    }

    // swiftlint:disable:next cyclomatic_complexity function_body_length
    public static func reduce(_ state: State, _ event: Event, options: Options = Options()) -> (State, [Effect]) {
        var next = state
        if case .terminal = state.phase { return (state, []) }

        switch event {
        case let .bootstrapInstalled(root, update, cursor):
            guard case .unplaced = state.phase else { return (state, []) }
            next.base = AcceptedBase(root: root, update: update, cursor: cursor)
            next.phase = .current
            return (next, [])

        case let .localHead(root, origin):
            let latest = LocalHead(root: root, origin: origin)
            switch state.phase {
            case .unplaced, .terminal:
                return (state, [])
            case .current:
                return pending(next, latest, options: options)
            case let .locallyPending(_, preparing):
                next.phase = .locallyPending(head: latest, preparing: preparing)
                return (next, preparing ? [] : [.schedule(.trailing, options.publicationDelay)])
            case let .prepared(request, _):
                next.phase = .prepared(request: request, head: latest)
                return (next, [])
            case let .submitting(request):
                next.phase = .submittingPending(request: request, head: latest)
                return (next, [])
            case let .submittingPending(request, _):
                next.phase = .submittingPending(request: request, head: latest)
                return (next, [])
            case let .acceptedPendingApply(result, request, _):
                next.phase = .acceptedPendingApply(result: result, request: request, head: latest)
                return (next, [])
            case let .conflict(request, conflict, _):
                next.phase = .conflict(request: request, conflict: conflict, head: latest)
                return (next, [])
            case let .conflictPreparing(request, conflict, choice, _):
                next.phase = .conflictPreparing(request: request, conflict: conflict, choice: choice, head: latest)
                return (next, [])
            case let .offline(availability, request, transmitted, _):
                // Later local work replaces one successor head; intermediate generations are compacted.
                next.phase = .offline(availability: availability, request: request, transmitted: transmitted, head: latest)
                return (next, [])
            }

        case .publishDelayElapsed, .maxDelayElapsed:
            guard case let .locallyPending(head, preparing) = state.phase, !preparing else { return (state, []) }
            return prepare(next, head)

        case let .requestPersisted(request):
            switch state.phase {
            case let .conflictPreparing(_, conflict, _, head):
                next.base = conflict.current
                next.phase = .prepared(request: request, head: head?.root == request.candidate ? nil : head)
                return (next, [.submit(request)])
            case let .locallyPending(head, _):
                let successor = head.root != request.candidate ? head : nil
                next.phase = .prepared(request: request, head: successor)
                return (next, [.submit(request)])
            case let .offline(_, _, _, head) where state.transportAvailable:
                let successor = head.flatMap { $0.root != request.candidate ? $0 : nil }
                next.phase = .prepared(request: request, head: successor)
                return (next, [.submit(request)])
            default:
                return (state, [])
            }

        case let .submitStarted(id):
            guard case let .prepared(request, head) = state.phase, request.id == id else { return (state, []) }
            if let head {
                next.phase = .submittingPending(request: request, head: head)
            } else {
                next.phase = .submitting(request: request)
            }
            return (next, [])

        case let .accepted(id, result):
            let request: PreparedRequest
            var successor: LocalHead?
            switch state.phase {
            case let .submitting(value): request = value
            case let .submittingPending(value, head): request = value; successor = head
            default: return (state, [])
            }
            guard request.id == id else { return (state, []) }
            next.phase = .acceptedPendingApply(result: result, request: request, head: successor)
            return (next, [.apply(result)])

        case let .watch(cursor, root, update, digests, _):
            let result = AuthorityResult(kind: .accepted, root: root, update: update, cursor: cursor, digests: digests)
            switch state.phase {
            case .current:
                guard let base = state.base, cursor != base.cursor, update != base.update else { return (state, []) }
                next.phase = .acceptedPendingApply(result: result, request: nil, head: nil)
                return (next, [.catchUp(cursor: cursor)])
            case let .submitting(request):
                guard digests.contains(where: request.digests.contains) else { return (state, []) }
                next.phase = .acceptedPendingApply(result: result, request: request, head: nil)
                return (next, [.apply(result)])
            case let .submittingPending(request, head):
                guard digests.contains(where: request.digests.contains) else { return (state, []) }
                next.phase = .acceptedPendingApply(result: result, request: request, head: head)
                return (next, [.apply(result)])
            case let .locallyPending(head, preparing):
                guard !preparing else { return (state, []) }
                // Remote history advanced under local work: publish now; the authority merges.
                return prepare(next, head)
            case let .offline(_, request, transmitted, head):
                guard let request, transmitted, digests.contains(where: request.digests.contains) else { return (state, []) }
                next.phase = .acceptedPendingApply(result: result, request: request, head: head)
                return (next, [.apply(result)])
            default:
                return (state, [])
            }

        case .watchGap:
            guard case .current = state.phase, let base = state.base else { return (state, []) }
            next.phase = .acceptedPendingApply(result: AuthorityResult(kind: .current, root: base.root, update: base.update), request: nil, head: nil)
            return (next, [.catchUp(cursor: nil)])

        case let .conflicted(id, conflict):
            let request: PreparedRequest
            var successor: LocalHead?
            switch state.phase {
            case let .submitting(value): request = value
            case let .submittingPending(value, head): request = value; successor = head
            default: return (state, [])
            }
            guard request.id == id else { return (state, []) }
            next.phase = .conflict(request: request, conflict: conflict, head: successor)
            return (next, [.surfaceConflict(conflict)])

        case .applied:
            guard case let .acceptedPendingApply(result, _, head) = state.phase else { return (state, []) }
            let base = AcceptedBase(root: result.root, update: result.update, cursor: result.cursor)
            next.base = base
            if let head, head.root != base.root {
                // Publish the retained successor against the new applied base without waiting.
                next.phase = .locallyPending(head: head, preparing: false)
                return (next, [.schedule(.trailing, .zero)])
            }
            next.phase = .current
            return (next, [])

        case let .transportFailed(id):
            switch state.phase {
            case let .prepared(request, head):
                next.phase = .offline(availability: .transport, request: request, transmitted: false, head: head)
                return (next, [])
            case let .submitting(request):
                if let id, id != request.id { return (state, []) }
                next.phase = .offline(availability: .transport, request: request, transmitted: true, head: nil)
                return (next, [])
            case let .submittingPending(request, head):
                if let id, id != request.id { return (state, []) }
                next.phase = .offline(availability: .transport, request: request, transmitted: true, head: head)
                return (next, [])
            case let .locallyPending(head, _):
                next.phase = .offline(availability: .transport, request: nil, transmitted: false, head: head)
                return (next, [.cancelTimers])
            default:
                return (state, [])
            }

        case let .authenticationFailed(reason):
            let availability = Availability.authentication(reason: reason)
            switch state.phase {
            case let .prepared(request, head):
                next.phase = .offline(availability: availability, request: request, transmitted: false, head: head)
                return (next, [])
            case let .submitting(request):
                next.phase = .offline(availability: availability, request: request, transmitted: true, head: nil)
                return (next, [])
            case let .submittingPending(request, head):
                next.phase = .offline(availability: availability, request: request, transmitted: true, head: head)
                return (next, [])
            case let .locallyPending(head, _):
                next.phase = .offline(availability: availability, request: nil, transmitted: false, head: head)
                return (next, [.cancelTimers])
            default:
                return (state, [])
            }

        case let .validationFailed(reason):
            next.phase = .terminal(reason: reason)
            return (next, [.cancelTimers, .stop(reason: reason)])

        case let .transportAvailable(available):
            next.transportAvailable = available
            if !available {
                if case let .locallyPending(head, _) = state.phase {
                    next.phase = .offline(availability: .transport, request: nil, transmitted: false, head: head)
                    return (next, [.cancelTimers])
                }
                return (next, [])
            }
            guard case let .offline(availability, request, transmitted, head) = state.phase else { return (next, []) }
            if case .authentication = availability { return (next, []) }
            return resume(next, availability: availability, request: request, transmitted: transmitted, head: head)

        case .credentialsRefreshed:
            guard case let .offline(availability, request, transmitted, head) = state.phase,
                  case .authentication = availability else { return (state, []) }
            next.transportAvailable = true
            return resume(next, availability: availability, request: request, transmitted: transmitted, head: head)

        case let .resolveConflict(choice):
            guard case let .conflict(request, conflict, head) = state.phase else { return (state, []) }
            next.phase = .conflictPreparing(request: request, conflict: conflict, choice: choice, head: head)
            return (next, [.persistConflictResolution(request: request, conflict: conflict, choice: choice)])

        case .conflictResolutionFailed:
            guard case let .conflictPreparing(request, conflict, _, head) = state.phase else { return (state, []) }
            next.phase = .conflict(request: request, conflict: conflict, head: head)
            return (next, [.surfaceConflict(conflict)])
        }
    }

    private static func pending(_ state: State, _ latest: LocalHead, options: Options) -> (State, [Effect]) {
        var next = state
        if !state.transportAvailable {
            next.phase = .offline(availability: .transport, request: nil, transmitted: false, head: latest)
            return (next, [])
        }
        next.phase = .locallyPending(head: latest, preparing: false)
        return (next, [.schedule(.trailing, options.publicationDelay), .schedule(.max, options.publicationMaxDelay)])
    }

    private static func prepare(_ state: State, _ head: LocalHead) -> (State, [Effect]) {
        var next = state
        guard let base = state.base else { return (state, []) }
        if head.root == base.root {
            next.phase = .current
            return (next, [.cancelTimers])
        }
        next.phase = .locallyPending(head: head, preparing: true)
        return (next, [.cancelTimers, .persistRequest(base: base, candidate: head.root, extends: nil)])
    }

    /// Reconnection: retry the exact retained request, or append the latest head to an ambiguous prefix once.
    private static func resume(
        _ state: State,
        availability: Availability,
        request: PreparedRequest?,
        transmitted: Bool,
        head: LocalHead?
    ) -> (State, [Effect]) {
        var next = state
        guard let base = state.base else { return (state, []) }
        if let request {
            if transmitted, let head, head.root != request.candidate {
                // Ambiguous-recovery transition: the only place a longer append-only request is issued.
                next.phase = .offline(availability: availability, request: request, transmitted: true, head: head)
                return (next, [.persistRequest(base: base, candidate: head.root, extends: request)])
            }
            let successor = head.flatMap { $0.root != request.candidate ? $0 : nil }
            next.phase = .prepared(request: request, head: successor)
            return (next, [.submit(request)])
        }
        if let head {
            if head.root == base.root {
                next.phase = .current
                return (next, [])
            }
            // Bypass the trailing delay: reconnection is a publication boundary.
            next.phase = .locallyPending(head: head, preparing: true)
            return (next, [.persistRequest(base: base, candidate: head.root, extends: nil)])
        }
        // A clean offline replica may still be behind: reconnection is an authoritative catch-up boundary.
        next.phase = .acceptedPendingApply(result: AuthorityResult(kind: .current, root: base.root, update: base.update), request: nil, head: nil)
        return (next, [.catchUp(cursor: base.cursor)])
    }
}

extension UpdateMachine.State {
    /// A dictionary view used by the shared fixture to check retained fields by dotted path.
    public var fixtureRepresentation: [String: Any] {
        var value: [String: Any] = [
            "kind": kind,
            "transportAvailable": transportAvailable,
        ]
        if let base { value["base"] = base.fixtureRepresentation }
        func put(_ head: UpdateMachine.LocalHead?) {
            if let head { value["head"] = ["root": head.root, "origin": head.origin.rawValue] }
        }
        func put(_ request: UpdateMachine.PreparedRequest?) {
            if let request {
                value["request"] = ["id": request.id, "base": request.base, "candidate": request.candidate, "digests": request.digests]
            }
        }
        switch phase {
        case .unplaced, .current:
            break
        case let .locallyPending(head, preparing):
            put(head)
            value["preparing"] = preparing
        case let .prepared(request, head):
            put(request)
            put(head)
        case let .submitting(request):
            put(request)
        case let .submittingPending(request, head):
            put(request)
            put(head)
        case let .acceptedPendingApply(result, request, head):
            var resultValue: [String: Any] = ["kind": result.kind.rawValue, "root": result.root, "update": result.update, "digests": result.digests]
            if let cursor = result.cursor { resultValue["cursor"] = cursor }
            value["result"] = resultValue
            put(request)
            put(head)
        case let .conflict(request, conflict, head),
             let .conflictPreparing(request, conflict, _, head):
            put(request)
            var conflictValue: [String: Any] = ["current": conflict.current.fixtureRepresentation, "localRoot": conflict.localRoot]
            if let draft = conflict.draft { conflictValue["draft"] = draft }
            conflictValue["failedIndex"] = conflict.failedIndex
            value["conflict"] = conflictValue
            if case let .conflictPreparing(_, _, choice, _) = phase { value["choice"] = choice.rawValue }
            put(head)
        case let .offline(availability, request, transmitted, head):
            value["availability"] = ["kind": availability.kind]
            put(request)
            value["transmitted"] = transmitted
            put(head)
        case let .terminal(reason):
            value["reason"] = reason
        }
        return value
    }
}

extension UpdateMachine.AcceptedBase {
    var fixtureRepresentation: [String: Any] {
        var value: [String: Any] = ["root": root, "update": update]
        if let cursor { value["cursor"] = cursor }
        return value
    }
}
