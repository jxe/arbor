import ArborClient
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

    var help: String {
        "\(explanation) \(recovery) \(technicalDetail)"
    }

    static func describe(
        _ error: Error?,
        processKind: ArborSyncProcessKind?
    ) -> ArborSaveDiagnostic? {
        guard let error else { return nil }

        if let serverError = error as? ArborSyncServerError {
            return ArborSaveDiagnostic(
                kind: .requestRejected,
                bannerMessage: "Arbor Sync rejected the latest document edit; it is still unsaved.",
                conditionLabel: "Request rejected by Arbor Sync",
                explanation: "The local daemon responded with HTTP \(serverError.status), so this is not a connection failure.",
                recovery: "Inspect the response or Arbor Sync logs, correct the reported problem, then choose Retry.",
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
            bannerMessage: "The storage provider could not save the latest document edit.",
            conditionLabel: "Provider save failed",
            explanation: "The provider returned an error while saving. This is not known to be a local-daemon connection failure.",
            recovery: "Keep this window open, correct the provider problem, then choose Retry.",
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
                "The external Arbor Sync daemon is unreachable; the latest edit is still unsaved.",
                "External daemon unreachable",
                "This window attached to an Arbor Sync daemon started outside Arbor. Nothing is responding at that connection; the daemon may have stopped or restarted on a different port."
            )
        case .supervised:
            (
                "Arbor’s local daemon is unreachable; the latest edit is still unsaved.",
                "Supervised daemon unreachable",
                "The Arbor Sync helper launched by this app is no longer responding and may have exited."
            )
        case nil:
            (
                "The storage provider is unreachable; the latest edit is still unsaved.",
                "Provider unreachable",
                "Nothing is responding at the provider connection used by this window."
            )
        }
        return ArborSaveDiagnostic(
            kind: .daemonUnreachable,
            bannerMessage: values.banner,
            conditionLabel: values.condition,
            explanation: values.explanation,
            recovery: processKind == .external
                ? "Restart the external daemon at the same loopback address, then choose Retry. Do not close or navigate away first."
                : "Restore the provider connection, then choose Retry. Do not close or navigate away first.",
            technicalDetail: error.localizedDescription,
            synchronizationOverride: "Unavailable"
        )
    }

    private static func timedOut(
        _ error: Error,
        processKind: ArborSyncProcessKind?
    ) -> ArborSaveDiagnostic {
        let subject = processKind == nil ? "The storage provider" : "Arbor Sync"
        let management = switch processKind {
        case .external: "The externally started local daemon did not respond before the request timed out."
        case .supervised: "The local daemon managed by Arbor did not respond before the request timed out."
        case nil: "The provider did not respond before the request timed out."
        }
        return ArborSaveDiagnostic(
            kind: .daemonTimedOut,
            bannerMessage: "\(subject) did not respond; the latest edit is still unsaved.",
            conditionLabel: processKind == nil ? "Provider timed out" : "Local daemon timed out",
            explanation: management,
            recovery: "Keep this window open, check that the provider is responsive, then choose Retry.",
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
