import Overstory
import Foundation

extension WorkingTree {
    /// Install a watch event's transition batch when it chains from this
    /// replica's accepted state: fetch only the delta bases the replica lacks,
    /// replay sparse, and replace (or, when the result is already materialized,
    /// just record) the accepted state. Throws when the batch does not chain,
    /// so the caller can fall back to reading the host's current state.
    public func applyAcceptedTransitions(_ event: ProtocolWatchEvent) async throws -> ProtocolAcceptedUpdate {
        let heads = try heads()
        guard let final = event.transitions.last,
              final.update.id.utf8.elementsEqual(event.tree.update.utf8),
              final.update.root == event.tree.root else {
            throw ProtocolValidationError.invalidValue("Watch transition batch does not match its descriptor")
        }
        guard let first = event.transitions.first,
              first.transportBasis?.id.utf8.elementsEqual((heads.acceptedUpdate ?? "").utf8) == true,
              first.transportBasis?.root == heads.acceptedRoot else {
            throw ProtocolValidationError.invalidValue("Watch predecessor differs from confirmed accepted state")
        }
        let basis = try await sparseBasis(deltaBases: Set(event.transitions.flatMap { $0.deltas.map(\.base) }))
        let accepted = try ProtocolTransitionReplay.applying(event.transitions, to: basis, mode: .sparseFiles)
        if accepted.root == heads.materializedRoot {
            try recordAccepted(root: accepted.root, update: final.update.id, cursor: event.id)
        } else {
            try replaceFromSystem(SnapshotBridge.replacement(
                snapshot: accepted, tree: treeID(), update: final.update.id, cursor: event.id,
                mode: .sparseFiles, acceptedAt: Date(timeIntervalSince1970: final.update.acceptedAt / 1_000)))
        }
        return final.update
    }

    /// The tree's own sparse graph plus the bytes every delta in a transition
    /// needs, fetched through the object store once each. Files the transition
    /// does not touch stay absent; the replay and the bridge both run sparse.
    private func sparseBasis(deltaBases: Set<String>) async throws -> ProtocolSnapshot {
        var basis = try localSnapshot()
        let present = Set(basis.objects.map(\.hash))
        for hash in deltaBases.sorted() where !present.contains(hash) {
            basis.objects.append(ProtocolObjectEnvelope(hash: hash, bytes: try await objectBytes(hash: hash)))
        }
        return basis
    }
}
