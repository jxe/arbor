import Foundation

public enum ProtocolTransitionReplay {
    /// Replay an ordered transition batch onto `basis`. With `mode` `.sparseFiles`
    /// the basis may omit file objects that are resolvable elsewhere; every
    /// delta base must still be present, and the result is sparse in the same way.
    public static func applying(
        _ transitions: [ProtocolAcceptedTransition],
        to basis: ProtocolSnapshot,
        mode: ProtocolObjectGraph.ValidationMode = .complete
    ) throws -> ProtocolSnapshot {
        guard !transitions.isEmpty else {
            throw ProtocolValidationError.invalidValue("Accepted transition batch is empty")
        }
        var snapshot = basis
        var tree: String?
        var previous: ProtocolAcceptedUpdate?
        var seen = Set<Data>()
        for transition in transitions {
            guard seen.insert(Data(transition.update.id.utf8)).inserted else { throw ProtocolValidationError.invalidValue("Repeated accepted identity") }
            if let previous {
                guard transition.transportBasis?.id.utf8.elementsEqual(previous.id.utf8) == true else {
                    throw ProtocolValidationError.invalidValue("Accepted predecessor identity mismatch")
                }
            }
            previous = transition.update
            if let tree, transition.update.tree != tree {
                throw ProtocolValidationError.invalidValue("Accepted transition batch crosses trees")
            }
            snapshot = try applying(transition, to: snapshot, mode: mode)
            tree = transition.update.tree
        }
        return snapshot
    }

    public static func applying(
        _ transition: ProtocolAcceptedTransition,
        to basis: ProtocolSnapshot,
        mode: ProtocolObjectGraph.ValidationMode = .complete
    ) throws -> ProtocolSnapshot {
        _ = try transition.validated()
        guard transition.transportBasis?.root == basis.root else {
            throw ProtocolValidationError.invalidValue("Accepted transition basis root mismatch")
        }
        return try applying(
            ProtocolTransitionPayload(objects: transition.objects, deltas: transition.deltas),
            to: basis,
            root: transition.update.root,
            mode: mode
        )
    }

    /// Apply one transition payload to a basis graph and require the result to
    /// be the graph at `root`: complete, or (`.sparseFiles`) a validated spine
    /// whose absent hashes are files resolvable elsewhere.
    public static func applying(
        _ payload: ProtocolTransitionPayload,
        to basis: ProtocolSnapshot,
        root: String,
        mode: ProtocolObjectGraph.ValidationMode = .complete
    ) throws -> ProtocolSnapshot {
        let basisObjects = try ProtocolObjectGraph.validate(basis, mode: mode)
        var bytesByHash = Dictionary(uniqueKeysWithValues: basis.objects.map { ($0.hash, $0.bytes) })
        let basisHashes = Set(basisObjects.keys)
        var suppliedResults = Set<String>()

        for envelope in payload.objects {
            if let existing = bytesByHash[envelope.hash], existing != envelope.bytes {
                throw ProtocolValidationError.invalidValue("Transition object changes immutable bytes")
            }
            bytesByHash[envelope.hash] = envelope.bytes
            suppliedResults.insert(envelope.hash)
        }

        for delta in payload.deltas {
            guard basisHashes.contains(delta.base), let base = bytesByHash[delta.base] else {
                throw ProtocolValidationError.invalidValue("Object delta base is not reachable from the transition basis")
            }
            let encoded = try delta.apply(to: base)
            guard bytesByHash[delta.result] == nil else {
                throw ProtocolValidationError.invalidValue("Object delta result was already supplied")
            }
            bytesByHash[delta.result] = encoded
            suppliedResults.insert(delta.result)
        }

        var visiting = Set<String>()
        var visited = Set<String>()
        func visit(_ hash: String, kind: ProtocolEntryKind) throws {
            if visiting.contains(hash) { throw ProtocolValidationError.cyclicGraph(hash) }
            if visited.contains(hash) { return }
            guard let bytes = bytesByHash[hash] else {
                if mode == .sparseFiles && kind == .file { visited.insert(hash); return }
                throw ProtocolValidationError.incompleteGraph(hash)
            }
            let object = try ProtocolObjectCodec.decode(bytes, kind: kind)
            visiting.insert(hash)
            if case let .directory(entries, _) = object {
                for entry in entries {
                    if let child = entry.hash, let kind = entry.kind { try visit(child, kind: kind) }
                }
            }
            visiting.remove(hash)
            visited.insert(hash)
        }
        try visit(root, kind: .directory)
        if let unreachable = suppliedResults.subtracting(visited).sorted().first {
            throw ProtocolValidationError.unreachableObject(unreachable)
        }
        let result = ProtocolSnapshot(
            root: root,
            objects: visited.sorted().compactMap { hash in bytesByHash[hash].map { ProtocolObjectEnvelope(hash: hash, bytes: $0) } }
        )
        _ = try ProtocolObjectGraph.validate(result, mode: mode)
        return result
    }
}
