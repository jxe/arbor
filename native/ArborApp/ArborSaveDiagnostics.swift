import ArborSyncClient
import Foundation

enum ArborSyncProcessKind: Sendable, Equatable {
    case external
    case supervised
}

struct ArborSaveDiagnostic: Equatable {
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
    let technicalDetail: String
    let synchronizationOverride: String?

    /// What failed. A document save never touches the daemon: the editor
    /// writes its own working tree and the update machine talks to Canopy, so
    /// a save failure is a provider failure whatever its error domain. Only
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
        context: Context = .save
    ) -> ArborSaveDiagnostic? {
        guard let error else { return nil }

        if context == .bootstrap {
            if let serverError = error as? ArborSyncServerError {
                return ArborSaveDiagnostic(
                    kind: .requestRejected,
                    bannerMessage: "Arbor Sync refused to open the tree.",
                    conditionLabel: "Request rejected by Arbor Sync",
                    explanation: "The local daemon responded with HTTP \(serverError.status), so this is not a connection failure.",
                    recovery: "Inspect the response or Arbor Sync logs, correct the reported problem, then reconnect.",
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
                technicalDetail: error.localizedDescription,
                synchronizationOverride: nil
            )
        }

        return ArborSaveDiagnostic(
            kind: .providerFailure,
            bannerMessage: "The working tree could not save the latest document edit.",
            conditionLabel: "Provider save failed",
            explanation: "The working tree returned an error while saving. Saves never go through the local daemon, so this is not a daemon outage.",
            recovery: "Keep this window open, correct the reported problem, then choose Retry.",
            technicalDetail: error.localizedDescription,
            synchronizationOverride: nil
        )
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
            technicalDetail: error.localizedDescription,
            synchronizationOverride: "Unavailable"
        )
    }

    private static func urlErrorCode(_ error: Error) -> URLError.Code? {
        if let urlError = error as? URLError { return urlError.code }
        let value = error as NSError
        guard value.domain == NSURLErrorDomain else { return nil }
        return URLError.Code(rawValue: value.code)
    }
}
