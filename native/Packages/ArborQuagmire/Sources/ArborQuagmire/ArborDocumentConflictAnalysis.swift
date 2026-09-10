import ArborKit
import Foundation

public struct ArborDocumentConflictAnalysis: Sendable, Equatable {
    public let headline: String
    public let explanation: String
    public let automaticMergeSource: String?

    public init(_ conflict: WorkspaceDocumentConflict) {
        let context = conflict.context
        let overlappingLocalEdit = context?.reason == "overlapping-source-edits"
            || context?.message == "Another local editor changed the submitted patch range"

        if overlappingLocalEdit {
            headline = "A newer editor generation changed the same source range."
            explanation = "Arbor kept the current version and your edit, but cannot safely infer which overlapping text should win."
        } else if context?.kind == "server-update" || context?.kind == "account-configuration" {
            headline = "Canopy found changes it could not merge safely."
            explanation = "Canopy returned the conflicting paths and a preserved draft for review."
        } else if let message = context?.message, !message.isEmpty {
            headline = message
            explanation = "Arbor kept the current version and your edit for review."
        } else {
            headline = "This document changed outside the current edit session."
            explanation = "Arbor kept the current version and your edit for review."
        }

        automaticMergeSource = Self.merge(conflict)
    }

    private static func merge(_ conflict: WorkspaceDocumentConflict) -> String? {
        // A Canopy conflict means its representation rule already examined the
        // complete graphs and declined an automatic resolution. Do not replace
        // that authoritative decision with a weaker client-side text heuristic.
        if conflict.context?.kind == "server-update" || conflict.context?.kind == "account-configuration" {
            return nil
        }
        guard let base = conflict.base else { return nil }
        if conflict.current.source == base.source { return conflict.submittedSource }
        if conflict.submittedSource == base.source { return conflict.current.source }
        if conflict.submittedSource == conflict.current.source { return conflict.current.source }

        let current = ArborMarkdownCodec.patch(from: base.source, to: conflict.current.source, revision: base.contentRevision).edits
        let submitted = ArborMarkdownCodec.patch(from: base.source, to: conflict.submittedSource, revision: base.contentRevision).edits
        guard let currentEdit = current.only, let submittedEdit = submitted.only,
              safelyDisjoint(currentEdit.utf8Range, submittedEdit.utf8Range) else { return nil }
        let edits = [currentEdit, submittedEdit].sorted { $0.utf8Range.lowerBound < $1.utf8Range.lowerBound }
        return try? WorkspaceDocumentPatch(baseContentRevision: base.contentRevision, edits: edits).applying(to: base.source)
    }

    private static func safelyDisjoint(_ lhs: Range<Int>, _ rhs: Range<Int>) -> Bool {
        guard lhs != rhs else { return false }
        if lhs.isEmpty, rhs.isEmpty { return lhs.lowerBound != rhs.lowerBound }
        return lhs.upperBound <= rhs.lowerBound || rhs.upperBound <= lhs.lowerBound
    }
}

private extension Array {
    var only: Element? { count == 1 ? self[0] : nil }
}
