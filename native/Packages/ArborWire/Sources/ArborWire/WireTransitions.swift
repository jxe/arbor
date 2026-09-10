import Foundation

public enum WireTransitionReplay {
    /// Replay an ordered transition batch onto `basis`. With `mode` `.sparseFiles`
    /// the basis may omit file objects that are resolvable elsewhere; every
    /// delta base must still be present, and the result is sparse in the same way.
    public static func applying(
        _ transitions: [WireAcceptedTransition],
        to basis: WireSnapshot,
        mode: WireObjectGraph.ValidationMode = .complete
    ) throws -> WireSnapshot {
        guard !transitions.isEmpty else {
            throw ArborWireValidationError.invalidValue("Accepted transition batch is empty")
        }
        var snapshot = basis
        var tree: String?
        for transition in transitions {
            if let tree, transition.update.tree != tree {
                throw ArborWireValidationError.invalidValue("Accepted transition batch crosses trees")
            }
            snapshot = try applying(transition, to: snapshot, mode: mode)
            tree = transition.update.tree
        }
        return snapshot
    }

    public static func applying(
        _ transition: WireAcceptedTransition,
        to basis: WireSnapshot,
        mode: WireObjectGraph.ValidationMode = .complete
    ) throws -> WireSnapshot {
        _ = try transition.validated()
        guard transition.update.previousRoot == basis.root else {
            throw ArborWireValidationError.invalidValue("Accepted transition basis root mismatch")
        }
        return try applying(
            WireTransitionPayload(objects: transition.objects, deltas: transition.deltas),
            to: basis,
            root: transition.update.root,
            mode: mode
        )
    }

    /// Apply one transition payload to a basis graph and require the result to
    /// be the graph at `root`: complete, or (`.sparseFiles`) a validated spine
    /// whose absent hashes are files resolvable elsewhere.
    public static func applying(
        _ payload: WireTransitionPayload,
        to basis: WireSnapshot,
        root: String,
        mode: WireObjectGraph.ValidationMode = .complete
    ) throws -> WireSnapshot {
        let basisObjects = try WireObjectGraph.validate(basis, mode: mode)
        var bytesByHash = Dictionary(uniqueKeysWithValues: basis.objects.map { ($0.hash, $0.bytes) })
        let basisHashes = Set(basisObjects.keys)
        var suppliedResults = Set<String>()

        for envelope in payload.objects {
            if let existing = bytesByHash[envelope.hash], existing != envelope.bytes {
                throw ArborWireValidationError.invalidValue("Transition object changes immutable bytes")
            }
            bytesByHash[envelope.hash] = envelope.bytes
            suppliedResults.insert(envelope.hash)
        }

        for delta in payload.deltas {
            guard basisHashes.contains(delta.base), let base = bytesByHash[delta.base] else {
                throw ArborWireValidationError.invalidValue("Object delta base is not reachable from the transition basis")
            }
            let encoded = try delta.apply(to: base)
            _ = try WireObjectCodec.decode(encoded)
            guard bytesByHash[delta.result] == nil else {
                throw ArborWireValidationError.invalidValue("Object delta result was already supplied")
            }
            bytesByHash[delta.result] = encoded
            suppliedResults.insert(delta.result)
        }

        var visiting = Set<String>()
        var visited = Set<String>()
        func visit(_ hash: String) throws {
            if visiting.contains(hash) { throw ArborWireValidationError.cyclicGraph(hash) }
            if visited.contains(hash) { return }
            guard let bytes = bytesByHash[hash] else {
                if mode == .sparseFiles { visited.insert(hash); return }
                throw ArborWireValidationError.incompleteGraph(hash)
            }
            let object = try WireObjectCodec.decode(bytes)
            visiting.insert(hash)
            if case let .directory(entries, _) = object {
                for entry in entries {
                    if let child = entry.hash { try visit(child) }
                }
            }
            visiting.remove(hash)
            visited.insert(hash)
        }
        try visit(root)
        if let unreachable = suppliedResults.subtracting(visited).sorted().first {
            throw ArborWireValidationError.unreachableObject(unreachable)
        }
        let result = WireSnapshot(
            root: root,
            objects: visited.sorted().compactMap { hash in bytesByHash[hash].map { WireObjectEnvelope(hash: hash, bytes: $0) } }
        )
        _ = try WireObjectGraph.validate(result, mode: mode)
        return result
    }
}
