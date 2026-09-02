import Foundation

public enum WireTransitionReplay {
    public static func applying(
        _ transitions: [WireAcceptedTransition],
        to basis: WireSnapshot
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
            snapshot = try applying(transition, to: snapshot)
            tree = transition.update.tree
        }
        return snapshot
    }

    public static func applying(
        _ transition: WireAcceptedTransition,
        to basis: WireSnapshot
    ) throws -> WireSnapshot {
        _ = try transition.validated()
        guard transition.update.previousRoot == basis.root else {
            throw ArborWireValidationError.invalidValue("Accepted transition basis root mismatch")
        }
        return try applying(
            WireTransitionPayload(objects: transition.objects, deltas: transition.deltas),
            to: basis,
            root: transition.update.root
        )
    }

    /// Apply one transition payload to a basis graph and require the result to be the complete graph at `root`.
    public static func applying(
        _ payload: WireTransitionPayload,
        to basis: WireSnapshot,
        root: String
    ) throws -> WireSnapshot {
        let basisObjects = try WireObjectGraph.validate(basis)
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
            guard let bytes = bytesByHash[hash] else { throw ArborWireValidationError.incompleteGraph(hash) }
            let object = try WireObjectCodec.decode(bytes)
            visiting.insert(hash)
            if case let .directory(entries) = object {
                for entry in entries {
                    if let child = entry.hash { try visit(child) }
                    if let rollup = entry.rollup {
                        try visit(rollup.source)
                        try visit(rollup.schemaSource)
                    }
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
            objects: visited.sorted().map { WireObjectEnvelope(hash: $0, bytes: bytesByHash[$0]!) }
        )
        _ = try WireObjectGraph.validate(result)
        return result
    }
}
