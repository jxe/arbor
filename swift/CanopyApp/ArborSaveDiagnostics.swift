import ArborSyncClient
import Foundation

enum ArborSyncProcessKind: Sendable, Equatable {
    case external
    case supervised
}

struct ArborSaveDiagnostic: Equatable {
    enum LocalRecovery: Equatable {
        case retained
        case failed
        case unavailable
        case unknown
    }

    enum Kind: Equatable {
        case daemonUnreachable
        case daemonTimedOut
        case requestRejected
        case providerFailure
    }

    let kind: Kind
    let bannerMessage: String
    let conditionLabel: String
    let explanation: String
    let recovery: String
    let editSafetyDetail: String
    let technicalDetail: String
    let synchronizationOverride: String?

    /// What failed. Retaining a document edit never touches the daemon: Native
    /// writes private recovery and working-tree update state, and the update
    /// machine talks to Canopy. Only
    /// opening a placed tree (`/v1/bootstrap`) or a placement depends on the
    /// daemon, and only there is a connection failure a daemon outage.
    enum Context: Equatable {
        case save
        case bootstrap
    }

    var help: String {
        "\(explanation) \(recovery) \(technicalDetail)"
    }

    static func describe(
        _ error: Error?,
        processKind: ArborSyncProcessKind?,
        context: Context = .save,
        localRecovery: LocalRecovery = .unknown
    ) -> ArborSaveDiagnostic? {
        guard let error else { return nil }

        if context == .bootstrap {
            if let serverError = error as? ArborSyncServerError {
                return ArborSaveDiagnostic(
                    kind: .requestRejected,
                    bannerMessage: "Arbor Sync could not open the tree: \(serverError.localizedDescription)",
                    conditionLabel: "Request rejected by Arbor Sync",
                    explanation: "The local daemon responded with HTTP \(serverError.status), so this is not a connection failure.",
                    recovery: "Correct the reported problem, then reconnect.",
                    editSafetyDetail: "The tree did not open.",
                    technicalDetail: "\(serverError.value.code): \(serverError.localizedDescription)",
                    synchronizationOverride: nil
                )
            }
            if let urlCode = urlErrorCode(error) {
                switch urlCode {
                case .timedOut:
                    return timedOut(error, processKind: processKind)
                case .cannotConnectToHost, .cannotFindHost, .networkConnectionLost, .notConnectedToInternet:
                    return unreachable(error, processKind: processKind)
                default:
                    break
                }
            }
            return ArborSaveDiagnostic(
                kind: .providerFailure,
                bannerMessage: "The tree could not be opened.",
                conditionLabel: "Tree could not be opened",
                explanation: "Opening the tree failed before a working tree existed. This is not known to be a local-daemon connection failure.",
                recovery: "Correct the reported problem, then reconnect to arborsync.",
                editSafetyDetail: "The tree did not open.",
                technicalDetail: error.localizedDescription,
                synchronizationOverride: nil
            )
        }

        switch localRecovery {
        case .retained:
            return ArborSaveDiagnostic(
                kind: .providerFailure,
                bannerMessage: "The latest edit is retained in local recovery, but working-tree admission failed.",
                conditionLabel: "Working-tree admission failed",
                explanation: "Native saved an exact private recovery copy on this device, but returned an error while retaining the working-tree update. It did not write the placed Arbor file, and this is not a daemon outage.",
                recovery: "Retry while this window remains open. If Arbor restarts first, reopening this document restores the private recovery copy.",
                editSafetyDetail: "The exact latest edit is recoverable on this device, but it has not reached the working tree or placed file.",
                technicalDetail: error.localizedDescription,
                synchronizationOverride: nil
            )
        case .failed:
            return ArborSaveDiagnostic(
                kind: .providerFailure,
                bannerMessage: "Arbor could not retain a private recovery copy of the latest edit.",
                conditionLabel: "Private recovery failed",
                explanation: "Native could not confirm an exact private recovery copy of the latest edit on this device. This does not by itself mean that working-tree admission failed; that status is reported separately.",
                recovery: "Keep this window open, correct the reported storage problem, then choose Retry before closing or navigating away unless the working tree has retained the edit.",
                editSafetyDetail: "Private recovery is unavailable. The edit is recoverable after this window closes only if working-tree admission succeeds.",
                technicalDetail: error.localizedDescription,
                synchronizationOverride: nil
            )
        case .unavailable:
            return ArborSaveDiagnostic(
                kind: .providerFailure,
                bannerMessage: "Working-tree admission failed, and no private recovery copy is available.",
                conditionLabel: "Working-tree admission failed",
                explanation: "Native returned an error while retaining the working-tree update, and this session has no exact private recovery copy. It did not write the placed Arbor file, and this is not a daemon outage.",
                recovery: "Keep this window open, correct the reported problem, then choose Retry before closing or navigating away.",
                editSafetyDetail: "The latest edit remains only in this editor session and may be lost if the window closes.",
                technicalDetail: error.localizedDescription,
                synchronizationOverride: nil
            )
        case .unknown:
            return ArborSaveDiagnostic(
                kind: .providerFailure,
                bannerMessage: "Native could not confirm local durability for the latest document edit.",
                conditionLabel: "Native durability failed",
                explanation: "Native returned an error while retaining private recovery or working-tree update state. It did not write the placed Arbor file, and this is not a daemon outage.",
                recovery: "Keep this window open, correct the reported problem, then choose Retry.",
                editSafetyDetail: "The latest edit remains in this editor session; its recovery status is unknown.",
                technicalDetail: error.localizedDescription,
                synchronizationOverride: nil
            )
        }
    }

    private static func unreachable(
        _ error: Error,
        processKind: ArborSyncProcessKind?
    ) -> ArborSaveDiagnostic {
        let values: (banner: String, condition: String, explanation: String) = switch processKind {
        case .external:
            (
                "The external Arbor Sync daemon is unreachable; the tree could not be opened.",
                "External daemon unreachable",
                "This window attached to an Arbor Sync daemon started outside Arbor. Nothing is responding at that connection; the daemon may have stopped or restarted on a different port."
            )
        case .supervised:
            (
                "Arbor’s local daemon is unreachable; the tree could not be opened.",
                "Supervised daemon unreachable",
                "The Arbor Sync helper launched by this app is no longer responding and may have exited."
            )
        case nil:
            (
                "Arbor Sync is unreachable; the tree could not be opened.",
                "Daemon unreachable",
                "Nothing is responding at the loopback connection Arbor Sync should be listening on."
            )
        }
        return ArborSaveDiagnostic(
            kind: .daemonUnreachable,
            bannerMessage: values.banner,
            conditionLabel: values.condition,
            explanation: values.explanation,
            recovery: processKind == .external
                ? "Restart the external daemon at the same loopback address, then reconnect to arborsync."
                : "Reconnect to arborsync from Sync Status; the app relaunches its helper when none is listening.",
            editSafetyDetail: "The tree did not open.",
            technicalDetail: error.localizedDescription,
            synchronizationOverride: "Unavailable"
        )
    }

    private static func timedOut(
        _ error: Error,
        processKind: ArborSyncProcessKind?
    ) -> ArborSaveDiagnostic {
        let management = switch processKind {
        case .external: "The externally started local daemon did not respond before the request timed out."
        case .supervised: "The local daemon managed by Arbor did not respond before the request timed out."
        case nil: "Arbor Sync did not respond before the request timed out."
        }
        return ArborSaveDiagnostic(
            kind: .daemonTimedOut,
            bannerMessage: "Arbor Sync did not respond; the tree could not be opened.",
            conditionLabel: "Local daemon timed out",
            explanation: management,
            recovery: "Check that Arbor Sync is responsive, then reconnect to arborsync.",
            editSafetyDetail: "The tree did not open.",
            technicalDetail: error.localizedDescription,
            synchronizationOverride: "Unavailable"
        )
    }

    static func urlErrorCode(_ error: Error) -> URLError.Code? {
        if let urlError = error as? URLError { return urlError.code }
        let value = error as NSError
        guard value.domain == NSURLErrorDomain else { return nil }
        return URLError.Code(rawValue: value.code)
    }
}
