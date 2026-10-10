import Foundation

enum StorySyncProcessKind: Sendable, Equatable {
    case external
    case supervised
}

struct StorySaveDiagnostic: Equatable {
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
    /// appends it to the working tree's change log, and the update machine
    /// talks to the host. Only
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
        processKind: StorySyncProcessKind?,
        context: Context = .save
    ) -> StorySaveDiagnostic? {
        guard let error else { return nil }

        if context == .bootstrap {
#if os(macOS)
            if let serverError = error as? StorySyncServerError {
                return StorySaveDiagnostic(
                    kind: .requestRejected,
                    bannerMessage: "Story Sync could not open the tree: \(serverError.localizedDescription)",
                    conditionLabel: "Request rejected by Story Sync",
                    explanation: "The local daemon responded with HTTP \(serverError.status), so this is not a connection failure.",
                    recovery: "Correct the reported problem, then reconnect.",
                    editSafetyDetail: "The tree did not open.",
                    technicalDetail: "\(serverError.value.code): \(serverError.localizedDescription)",
                    synchronizationOverride: nil
                )
            }
#endif
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
            return StorySaveDiagnostic(
                kind: .providerFailure,
                bannerMessage: "The tree could not be opened.",
                conditionLabel: "Tree could not be opened",
                explanation: "Opening the tree failed before a working tree existed. This is not known to be a local-daemon connection failure.",
                recovery: "Correct the reported problem, then reconnect to Story Sync.",
                editSafetyDetail: "The tree did not open.",
                technicalDetail: error.localizedDescription,
                synchronizationOverride: nil
            )
        }

        return StorySaveDiagnostic(
            kind: .providerFailure,
            bannerMessage: "The latest edit could not be retained on this device.",
            conditionLabel: "Change log append failed",
            explanation: "Native could not append the edit to the working tree's change log. It did not write the placed tree file, and this is not a daemon outage.",
            recovery: "Keep this window open, correct the reported problem, then choose Retry before closing or navigating away.",
            editSafetyDetail: "The latest edit remains only in this editor session and may be lost if the window closes.",
            technicalDetail: error.localizedDescription,
            synchronizationOverride: nil
        )
    }

    private static func unreachable(
        _ error: Error,
        processKind: StorySyncProcessKind?
    ) -> StorySaveDiagnostic {
        let values: (banner: String, condition: String, explanation: String) = switch processKind {
        case .external:
            (
                "The external Story Sync daemon is unreachable; the tree could not be opened.",
                "External daemon unreachable",
                "This window attached to a Story Sync daemon started outside Story. Nothing is responding at that connection; the daemon may have stopped or restarted on a different port."
            )
        case .supervised:
            (
                "Story’s local daemon is unreachable; the tree could not be opened.",
                "Supervised daemon unreachable",
                "The Story Sync helper launched by this app is no longer responding and may have exited."
            )
        case nil:
            (
                "Story Sync is unreachable; the tree could not be opened.",
                "Daemon unreachable",
                "Nothing is responding at the loopback connection Story Sync should be listening on."
            )
        }
        return StorySaveDiagnostic(
            kind: .daemonUnreachable,
            bannerMessage: values.banner,
            conditionLabel: values.condition,
            explanation: values.explanation,
            recovery: processKind == .external
                ? "Restart the external daemon at the same loopback address, then reconnect to Story Sync."
                : "Reconnect to Story Sync from Sync Status; the app relaunches its helper when none is listening.",
            editSafetyDetail: "The tree did not open.",
            technicalDetail: error.localizedDescription,
            synchronizationOverride: "Unavailable"
        )
    }

    private static func timedOut(
        _ error: Error,
        processKind: StorySyncProcessKind?
    ) -> StorySaveDiagnostic {
        let management = switch processKind {
        case .external: "The externally started local daemon did not respond before the request timed out."
        case .supervised: "The local daemon managed by Story did not respond before the request timed out."
        case nil: "Story Sync did not respond before the request timed out."
        }
        return StorySaveDiagnostic(
            kind: .daemonTimedOut,
            bannerMessage: "Story Sync did not respond; the tree could not be opened.",
            conditionLabel: "Local daemon timed out",
            explanation: management,
            recovery: "Check that Story Sync is responsive, then reconnect to Story Sync.",
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
