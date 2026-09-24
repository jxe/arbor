import Foundation

/// Working-tree updates: the state machine a working tree runs against an
/// Overstory host (spec 09).
///
/// The reducer is pure and language-neutral: roots, updates, cursors, and
/// request digests are opaque tokens. `UpdateCoordinator` maps its
/// `UpdateControl` onto these states, persists what each state retains,
/// and executes the effects the reducer returns. It executes the same fixture
/// scenarios as the TypeScript reducer in `@overstory/client`.
public enum UpdateMachine {
    /// Trailing delay before unsent durable local work is published.
    public static let publicationDelay: Duration = .milliseconds(250)
    /// Maximum delay from the first unsent durable head to its publication.
    public static let publicationMaxDelay: Duration = .seconds(1)

    /// Select one contiguous authored branch. Persisted requests bypass this
    /// selector so new admissions cannot change an uncertain/in-flight body.
    public static func publicationTip(
        _ records: [(change: String, parent: String?)], accepted: Set<String>
    ) -> String? {
        var tip: String?
        for record in records {
            if accepted.contains(record.change) { continue }
            if let current = tip, record.parent != current { break }
            tip = record.change
        }
        return tip
    }

    public struct AcceptedBase: Sendable, Equatable {
        public var conflicted: Bool?
        public var root: String
        public var update: String
        public var cursor: String?

        public init(root: String, update: String, cursor: String? = nil, conflicted: Bool? = nil) {
            self.conflicted = conflicted
            self.root = root
            self.update = update
            self.cursor = cursor
        }
    }

    /// The newest durable local change in the working tree's change log:
    /// its authored identity and the root it produces. Editors and folders
    /// append changes the same way; the machine never sees their provenance.
    public struct LocalTip: Sendable, Equatable {
        public var change: String
        public var root: String

        public init(change: String, root: String) {
            self.change = change
            self.root = root
        }
    }

    public struct PreparedRequest: Sendable, Equatable {
        /// Digest of the last element; the request's identity for response and watch correlation.
        public var id: String
        public var base: String
        public var candidate: String
        /// The local change the request's last element carries.
        public var tip: String
        /// Every element digest in prefix order.
        public var digests: [String]

        public init(id: String, base: String, candidate: String, tip: String, digests: [String]) {
            self.id = id
            self.base = base
            self.candidate = candidate
            self.tip = tip
            self.digests = digests
        }
    }

    public struct AuthorityResult: Sendable, Equatable {
        public var conflicted: Bool?
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

        public init(kind: Kind, root: String, update: String, cursor: String? = nil, digests: [String] = [], conflicted: Bool? = nil) {
            self.conflicted = conflicted
            self.kind = kind
            self.root = root
            self.update = update
            self.cursor = cursor
            self.digests = digests
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

    /// Why a request is held: the host definitively refused it, or it uses an
    /// operation the host does not support. Neither is retried automatically.
    public enum HeldReason: String, Sendable, Equatable {
        case rejected
        case unsupported
    }

    public enum Phase: Sendable, Equatable {
        case unplaced
        case current
        case locallyPending(tip: LocalTip, preparing: Bool)
        case prepared(request: PreparedRequest, tip: LocalTip?)
        case submitting(request: PreparedRequest)
        case submittingPending(request: PreparedRequest, tip: LocalTip)
        case acceptedPendingApply(result: AuthorityResult, request: PreparedRequest?, tip: LocalTip?)
        case offline(availability: Availability, request: PreparedRequest?, transmitted: Bool, tip: LocalTip?)
        case held(reason: HeldReason, detail: String?, request: PreparedRequest, tip: LocalTip?)
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
            case .offline: "offline"
            case .held: "held"
            case .terminal: "terminal"
            }
        }

        /// The newest local change the phase retains, if any.
        public var tip: LocalTip? {
            switch self {
            case let .locallyPending(tip, _), let .submittingPending(_, tip): tip
            case let .prepared(_, tip), let .acceptedPendingApply(_, _, tip), let .offline(_, _, _, tip), let .held(_, _, _, tip): tip
            case .unplaced, .current, .submitting, .terminal: nil
            }
        }

        /// The exact request the phase retains, if any.
        public var request: PreparedRequest? {
            switch self {
            case let .prepared(request, _), let .submitting(request), let .submittingPending(request, _), let .held(_, _, request, _): request
            case let .acceptedPendingApply(_, request, _), let .offline(_, request, _, _): request
            case .unplaced, .current, .locallyPending, .terminal: nil
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
    }

    public enum Timer: String, Sendable, Equatable {
        case trailing
        case max
        /// Freshness and retry; armed only when `Options.pollInterval` is set.
        case poll
    }

    public enum Event: Sendable, Equatable {
        case bootstrapInstalled(root: String, update: String, cursor: String?, conflicted: Bool? = nil)
        /// A retained request found at startup: held again, or resubmitted exactly.
        case recovered(request: PreparedRequest, held: HeldReason?, detail: String? = nil)
        /// A local change is durable in the change log.
        case localChange(change: String, root: String)
        case publishDelayElapsed
        case maxDelayElapsed
        case pollElapsed
        /// Explicit synchronization or a shutdown drain: publish now, retry, or catch up.
        case syncRequested
        case requestPersisted(PreparedRequest)
        case submitStarted(id: String)
        case accepted(id: String, result: AuthorityResult)
        /// The host definitively refused the request.
        case rejected(id: String, detail: String?)
        /// The request uses an operation the host does not support.
        case unsupported(id: String, detail: String?)
        /// The runner durably discarded the held request and every change authored on it.
        case heldDiscarded
        case watch(cursor: String, root: String, update: String, digests: [String], transitions: Bool, conflicted: Bool? = nil)
        case watchGap
        /// The apply or catch-up is durable; `installed` names the accepted state
        /// actually installed when it differs from the result the machine expected.
        case applied(installed: AcceptedBase? = nil)
        case transportFailed(id: String?)
        case authenticationFailed(reason: String?)
        case validationFailed(reason: String)
        case transportAvailable(Bool)
        case credentialsRefreshed
    }

    public enum Effect: Sendable, Equatable {
        case schedule(Timer, Duration)
        /// Cancel the trailing and maximum publication timers; the poll timer is independent.
        case cancelTimers
        /// Persist one exact request: the change log's chain from `base` through
        /// `tip`. `extends` names a transmitted request the new one repeats
        /// exactly as its prefix.
        case persistRequest(base: AcceptedBase, tip: LocalTip, extends: PreparedRequest?)
        case submit(PreparedRequest)
        /// Validate, durably materialize, then dispatch `applied`.
        case apply(AuthorityResult)
        /// Clean catch-up: apply a contiguous transition batch or pull the current snapshot, then dispatch `applied`.
        case catchUp(cursor: String?)
        /// The chain through `tip` reproduces the accepted root: acknowledge it locally without a request.
        case settle(tip: LocalTip)
        case stop(reason: String)

        public var kind: String {
            switch self {
            case .schedule: "schedule"
            case .cancelTimers: "cancelTimers"
            case .persistRequest: "persistRequest"
            case .submit: "submit"
            case .apply: "apply"
            case .catchUp: "catchUp"
            case .settle: "settle"
            case .stop: "stop"
            }
        }
    }

    public struct Options: Sendable, Equatable {
        public var publicationDelay: Duration
        public var publicationMaxDelay: Duration
        /// When set, the machine polls for freshness and retries transport failures at this interval.
        public var pollInterval: Duration?

        public init(
            publicationDelay: Duration = UpdateMachine.publicationDelay,
            publicationMaxDelay: Duration = UpdateMachine.publicationMaxDelay,
            pollInterval: Duration? = nil
        ) {
            self.publicationDelay = publicationDelay
            self.publicationMaxDelay = publicationMaxDelay
            self.pollInterval = pollInterval
        }

        var pollEffects: [Effect] { pollInterval.map { [.schedule(.poll, $0)] } ?? [] }
    }

    // swiftlint:disable:next cyclomatic_complexity function_body_length
    public static func reduce(_ state: State, _ event: Event, options: Options = Options()) -> (State, [Effect]) {
        var next = state
        if case .terminal = state.phase { return (state, []) }

        switch event {
        case let .bootstrapInstalled(root, update, cursor, conflicted):
            guard case .unplaced = state.phase else { return (state, []) }
            next.base = AcceptedBase(root: root, update: update, cursor: cursor, conflicted: conflicted)
            next.phase = state.transportAvailable ? .current : .offline(availability: .transport, request: nil, transmitted: false, tip: nil)
            return (next, options.pollEffects)

        case let .recovered(request, held, detail):
            switch state.phase {
            case .current, .offline(.transport, nil, _, nil): break
            default: return (state, [])
            }
            if let held {
                next.phase = .held(reason: held, detail: detail, request: request, tip: nil)
                return (next, [])
            }
            guard state.transportAvailable else {
                // A retained request may have reached the host before the restart.
                next.phase = .offline(availability: .transport, request: request, transmitted: true, tip: nil)
                return (next, [])
            }
            next.phase = .prepared(request: request, tip: nil)
            return (next, [.submit(request)])

        case let .localChange(change, root):
            let latest = LocalTip(change: change, root: root)
            switch state.phase {
            case .unplaced, .terminal:
                return (state, [])
            case .current:
                return pending(next, latest, options: options)
            case let .locallyPending(_, preparing):
                next.phase = .locallyPending(tip: latest, preparing: preparing)
                return (next, preparing ? [] : [.schedule(.trailing, options.publicationDelay)])
            case let .prepared(request, _):
                next.phase = .prepared(request: request, tip: latest)
                return (next, [])
            case let .submitting(request), let .submittingPending(request, _):
                next.phase = .submittingPending(request: request, tip: latest)
                return (next, [])
            case let .acceptedPendingApply(result, request, _):
                next.phase = .acceptedPendingApply(result: result, request: request, tip: latest)
                return (next, [])
            case let .offline(availability, request, transmitted, _):
                // Later local work replaces one successor tip; the log keeps every change.
                next.phase = .offline(availability: availability, request: request, transmitted: transmitted, tip: latest)
                return (next, [])
            case let .held(reason, detail, request, _):
                // Work authored on a held request stays durable and waits with it.
                next.phase = .held(reason: reason, detail: detail, request: request, tip: latest)
                return (next, [])
            }

        case .publishDelayElapsed, .maxDelayElapsed:
            guard case let .locallyPending(tip, preparing) = state.phase, !preparing else { return (state, []) }
            return prepare(next, tip)

        case .pollElapsed:
            let (polled, effects) = poll(next)
            return (polled, effects + options.pollEffects)

        case .syncRequested:
            return poll(next)

        case let .requestPersisted(request):
            switch state.phase {
            case let .locallyPending(tip, _):
                next.phase = .prepared(request: request, tip: successor(tip, of: request))
                return (next, [.submit(request)])
            case let .offline(_, _, _, tip) where state.transportAvailable:
                next.phase = .prepared(request: request, tip: tip.flatMap { successor($0, of: request) })
                return (next, [.submit(request)])
            default:
                return (state, [])
            }

        case let .submitStarted(id):
            guard case let .prepared(request, tip) = state.phase, request.id == id else { return (state, []) }
            if let tip {
                next.phase = .submittingPending(request: request, tip: tip)
            } else {
                next.phase = .submitting(request: request)
            }
            return (next, [])

        case let .accepted(id, result):
            let request: PreparedRequest
            var retained: LocalTip?
            switch state.phase {
            case let .submitting(value): request = value
            case let .submittingPending(value, tip): request = value; retained = tip
            default: return (state, [])
            }
            guard request.id == id else { return (state, []) }
            next.phase = .acceptedPendingApply(result: result, request: request, tip: retained)
            return (next, [.apply(result)])

        case let .rejected(id, detail):
            return hold(next, id: id, reason: .rejected, detail: detail)

        case let .unsupported(id, detail):
            return hold(next, id: id, reason: .unsupported, detail: detail)

        case .heldDiscarded:
            guard case .held = state.phase, let base = state.base else { return (state, []) }
            // The discarded chain leaves no local work; the host may have moved meanwhile.
            return catchUp(next, cursor: base.cursor)

        case let .watch(cursor, root, update, digests, _, conflicted):
            let result = AuthorityResult(kind: .accepted, root: root, update: update, cursor: cursor, digests: digests, conflicted: conflicted)
            switch state.phase {
            case .current:
                guard let base = state.base, cursor != base.cursor else { return (state, []) }
                if update == base.update {
                    // Our own or an already installed update: only observation progress is new.
                    guard root == base.root else { return (state, []) }
                    next.base?.cursor = cursor
                    return (next, [])
                }
                next.phase = .acceptedPendingApply(result: result, request: nil, tip: nil)
                return (next, [.catchUp(cursor: cursor)])
            case let .submitting(request):
                guard digests.contains(where: request.digests.contains) else { return (state, []) }
                next.phase = .acceptedPendingApply(result: result, request: request, tip: nil)
                return (next, [.apply(result)])
            case let .submittingPending(request, tip):
                guard digests.contains(where: request.digests.contains) else { return (state, []) }
                next.phase = .acceptedPendingApply(result: result, request: request, tip: tip)
                return (next, [.apply(result)])
            case let .locallyPending(tip, preparing):
                guard !preparing else { return (state, []) }
                // Remote history advanced under local work: publish now; the authority merges.
                return prepare(next, tip)
            case let .offline(availability, request, transmitted, tip):
                if let request, transmitted, digests.contains(where: request.digests.contains) {
                    next.phase = .acceptedPendingApply(result: result, request: request, tip: tip)
                    return (next, [.apply(result)])
                }
                // A watch frame is evidence that transport works again.
                guard case .transport = availability else { return (state, []) }
                next.transportAvailable = true
                return resume(next, availability: availability, request: request, transmitted: transmitted, tip: tip)
            default:
                return (state, [])
            }

        case .watchGap:
            guard case .current = state.phase else { return (state, []) }
            return catchUp(next, cursor: nil)

        case let .applied(installed):
            guard case let .acceptedPendingApply(result, _, tip) = state.phase else { return (state, []) }
            let base = installed ?? AcceptedBase(root: result.root, update: result.update, cursor: result.cursor, conflicted: result.conflicted)
            next.base = base
            if let tip {
                // Publish the retained successor against the new applied base without waiting.
                next.phase = .locallyPending(tip: tip, preparing: false)
                return (next, [.schedule(.trailing, .zero)])
            }
            next.phase = .current
            return (next, [])

        case let .transportFailed(id):
            switch state.phase {
            case let .prepared(request, tip):
                next.phase = .offline(availability: .transport, request: request, transmitted: false, tip: tip)
                return (next, [])
            case let .submitting(request):
                if let id, id != request.id { return (state, []) }
                next.phase = .offline(availability: .transport, request: request, transmitted: true, tip: nil)
                return (next, [])
            case let .submittingPending(request, tip):
                if let id, id != request.id { return (state, []) }
                next.phase = .offline(availability: .transport, request: request, transmitted: true, tip: tip)
                return (next, [])
            case let .locallyPending(tip, _):
                next.phase = .offline(availability: .transport, request: nil, transmitted: false, tip: tip)
                return (next, [.cancelTimers])
            default:
                return (state, [])
            }

        case let .authenticationFailed(reason):
            let availability = Availability.authentication(reason: reason)
            switch state.phase {
            case let .prepared(request, tip):
                next.phase = .offline(availability: availability, request: request, transmitted: false, tip: tip)
                return (next, [])
            case let .submitting(request):
                next.phase = .offline(availability: availability, request: request, transmitted: true, tip: nil)
                return (next, [])
            case let .submittingPending(request, tip):
                next.phase = .offline(availability: availability, request: request, transmitted: true, tip: tip)
                return (next, [])
            case let .locallyPending(tip, _):
                next.phase = .offline(availability: availability, request: nil, transmitted: false, tip: tip)
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
                switch state.phase {
                case let .locallyPending(tip, _):
                    next.phase = .offline(availability: .transport, request: nil, transmitted: false, tip: tip)
                    return (next, [.cancelTimers])
                case .current:
                    // A clean tree offline may fall behind; reconnection catches it up.
                    next.phase = .offline(availability: .transport, request: nil, transmitted: false, tip: nil)
                    return (next, [])
                case let .prepared(request, tip):
                    next.phase = .offline(availability: .transport, request: request, transmitted: false, tip: tip)
                    return (next, [])
                case let .submitting(request), let .submittingPending(request, _):
                    // A hanging attempt may or may not have reached the host.
                    next.phase = .offline(availability: .transport, request: request, transmitted: true, tip: state.phase.tip)
                    return (next, [])
                default:
                    return (next, [])
                }
            }
            guard case let .offline(availability, request, transmitted, tip) = state.phase else { return (next, []) }
            if case .authentication = availability { return (next, []) }
            return resume(next, availability: availability, request: request, transmitted: transmitted, tip: tip)

        case .credentialsRefreshed:
            guard case let .offline(availability, request, transmitted, tip) = state.phase,
                  case .authentication = availability else { return (state, []) }
            next.transportAvailable = true
            return resume(next, availability: availability, request: request, transmitted: transmitted, tip: tip)
        }
    }

    private static func successor(_ tip: LocalTip, of request: PreparedRequest) -> LocalTip? {
        tip.change != request.tip ? tip : nil
    }

    private static func pending(_ state: State, _ latest: LocalTip, options: Options) -> (State, [Effect]) {
        var next = state
        if !state.transportAvailable {
            next.phase = .offline(availability: .transport, request: nil, transmitted: false, tip: latest)
            return (next, [])
        }
        next.phase = .locallyPending(tip: latest, preparing: false)
        return (next, [.schedule(.trailing, options.publicationDelay), .schedule(.max, options.publicationMaxDelay)])
    }

    private static func prepare(_ state: State, _ tip: LocalTip) -> (State, [Effect]) {
        var next = state
        guard let base = state.base else { return (state, []) }
        if tip.root == base.root {
            next.phase = .current
            return (next, [.cancelTimers, .settle(tip: tip)])
        }
        next.phase = .locallyPending(tip: tip, preparing: true)
        return (next, [.cancelTimers, .persistRequest(base: base, tip: tip, extends: nil)])
    }

    private static func catchUp(_ state: State, cursor: String?) -> (State, [Effect]) {
        var next = state
        guard let base = state.base else { return (state, []) }
        next.phase = .acceptedPendingApply(result: AuthorityResult(kind: .current, root: base.root, update: base.update), request: nil, tip: nil)
        return (next, [.catchUp(cursor: cursor)])
    }

    private static func hold(_ state: State, id: String, reason: HeldReason, detail: String?) -> (State, [Effect]) {
        var next = state
        let request: PreparedRequest
        var tip: LocalTip?
        switch state.phase {
        case let .prepared(value, retained): request = value; tip = retained
        case let .submitting(value): request = value
        case let .submittingPending(value, retained): request = value; tip = retained
        case let .offline(_, value?, _, retained): request = value; tip = retained
        default: return (state, [])
        }
        guard request.id == id else { return (state, []) }
        next.phase = .held(reason: reason, detail: detail, request: request, tip: tip)
        return (next, [])
    }

    /// A freshness tick or explicit synchronization: catch up when clean,
    /// publish unsent work, repeat an unfinished apply, and retry a transport
    /// failure while the network is believed available.
    private static func poll(_ state: State) -> (State, [Effect]) {
        switch state.phase {
        case .current:
            return catchUp(state, cursor: state.base?.cursor)
        case let .acceptedPendingApply(result, request, _):
            // The decision is durable knowledge; only its local apply is repeated.
            return (state, [request == nil ? .catchUp(cursor: result.cursor) : .apply(result)])
        case let .locallyPending(tip, preparing):
            guard !preparing else { return (state, []) }
            return prepare(state, tip)
        case let .offline(availability, request, transmitted, tip):
            guard state.transportAvailable, case .transport = availability else { return (state, []) }
            return resume(state, availability: availability, request: request, transmitted: transmitted, tip: tip)
        default:
            return (state, [])
        }
    }

    /// Reconnection: retry the exact retained request, or append the latest tip to an ambiguous prefix once.
    private static func resume(
        _ state: State,
        availability: Availability,
        request: PreparedRequest?,
        transmitted: Bool,
        tip: LocalTip?
    ) -> (State, [Effect]) {
        var next = state
        guard let base = state.base else { return (state, []) }
        if let request {
            if transmitted, let tip, tip.change != request.tip {
                // Ambiguous-recovery transition: the only place a longer append-only request is issued.
                next.phase = .offline(availability: availability, request: request, transmitted: true, tip: tip)
                return (next, [.persistRequest(base: base, tip: tip, extends: request)])
            }
            next.phase = .prepared(request: request, tip: tip.flatMap { successor($0, of: request) })
            return (next, [.submit(request)])
        }
        if let tip {
            if tip.root == base.root {
                next.phase = .current
                return (next, [.settle(tip: tip)])
            }
            // Bypass the trailing delay: reconnection is a publication boundary.
            next.phase = .locallyPending(tip: tip, preparing: true)
            return (next, [.persistRequest(base: base, tip: tip, extends: nil)])
        }
        // A clean offline replica may still be behind: reconnection is an authoritative catch-up boundary.
        return catchUp(next, cursor: base.cursor)
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
        if let tip = phase.tip { value["tip"] = ["change": tip.change, "root": tip.root] }
        if let request = phase.request {
            value["request"] = ["id": request.id, "base": request.base, "candidate": request.candidate, "tip": request.tip, "digests": request.digests]
        }
        switch phase {
        case .unplaced, .current, .prepared, .submitting, .submittingPending:
            break
        case let .locallyPending(_, preparing):
            value["preparing"] = preparing
        case let .acceptedPendingApply(result, _, _):
            var resultValue: [String: Any] = ["kind": result.kind.rawValue, "root": result.root, "update": result.update, "digests": result.digests]
            if let cursor = result.cursor { resultValue["cursor"] = cursor }
            if let conflicted = result.conflicted { resultValue["conflicted"] = conflicted }
            value["result"] = resultValue
        case let .offline(availability, _, transmitted, _):
            value["availability"] = ["kind": availability.kind]
            value["transmitted"] = transmitted
        case let .held(reason, detail, _, _):
            value["reason"] = reason.rawValue
            if let detail { value["detail"] = detail }
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
        if let conflicted { value["conflicted"] = conflicted }
        return value
    }
}
