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
        var previousSequence: Int?
        var tree: String?
        for transition in transitions {
            if let tree, transition.update.tree != tree {
                throw ArborWireValidationError.invalidValue("Accepted transition batch crosses trees")
            }
            if let previousSequence, transition.update.sequence != previousSequence + 1 {
                throw ArborWireValidationError.invalidValue("Accepted transition sequence has a gap")
            }
            snapshot = try applying(transition, to: snapshot)
            previousSequence = transition.update.sequence
            tree = transition.update.tree
        }
        return snapshot
    }

    public static func applying(
        _ transition: WireAcceptedTransition,
        to basis: WireSnapshot
    ) throws -> WireSnapshot {
        _ = try transition.validated()
        let basisObjects = try WireObjectGraph.validate(basis)
        guard transition.update.previousRoot == basis.root else {
            throw ArborWireValidationError.invalidValue("Accepted transition basis root mismatch")
        }
        var bytesByHash = Dictionary(uniqueKeysWithValues: basis.objects.map { ($0.hash, $0.bytes) })
        let basisHashes = Set(basisObjects.keys)
        var suppliedResults = Set<String>()

        for envelope in transition.objects {
            if let existing = bytesByHash[envelope.hash], existing != envelope.bytes {
                throw ArborWireValidationError.invalidValue("Transition object changes immutable bytes")
            }
            bytesByHash[envelope.hash] = envelope.bytes
            suppliedResults.insert(envelope.hash)
        }

        for patch in transition.filePatches {
            guard basisHashes.contains(patch.base), let encodedBase = bytesByHash[patch.base],
                  case let .file(base) = try WireObjectCodec.decode(encodedBase) else {
                throw ArborWireValidationError.invalidValue("File patch base is not reachable from the transition basis")
            }
            var output = Data()
            var cursor = 0
            for edit in patch.edits {
                let end = edit.offset + edit.length
                guard edit.offset >= cursor, end <= base.count else {
                    throw ArborWireValidationError.invalidValue("File patch edit is out of bounds")
                }
                output.append(base[cursor..<edit.offset])
                output.append(edit.bytes)
                cursor = end
            }
            output.append(base[cursor..<base.count])
            let encoded = try WireObjectCodec.encode(.file(output))
            let actual = WireObjectCodec.hash(encoded)
            guard actual == patch.result else {
                throw ArborWireValidationError.objectHashMismatch(expected: patch.result, actual: actual)
            }
            guard bytesByHash[patch.result] == nil else {
                throw ArborWireValidationError.invalidValue("File patch result was already supplied")
            }
            bytesByHash[patch.result] = encoded
            suppliedResults.insert(patch.result)
        }

        for delta in transition.fileDeltas {
            guard basisHashes.contains(delta.base), let encodedBase = bytesByHash[delta.base],
                  case let .file(base) = try WireObjectCodec.decode(encodedBase) else {
                throw ArborWireValidationError.invalidValue("File delta base is not reachable from the transition basis")
            }
            var output = Data()
            for instruction in delta.instructions {
                switch instruction {
                case let .copy(offset, length):
                    guard offset <= base.count, length <= base.count - offset else {
                        throw ArborWireValidationError.invalidValue("File delta copy is out of bounds")
                    }
                    output.append(base[offset..<(offset + length)])
                case let .insert(bytes):
                    output.append(bytes)
                }
                guard output.count <= 1_000_000_000 else {
                    throw ArborWireValidationError.invalidValue("File delta result exceeds the storage quota")
                }
            }
            let encoded = try WireObjectCodec.encode(.file(output))
            let actual = WireObjectCodec.hash(encoded)
            guard actual == delta.result else {
                throw ArborWireValidationError.objectHashMismatch(expected: delta.result, actual: actual)
            }
            guard bytesByHash[delta.result] == nil else {
                throw ArborWireValidationError.invalidValue("File delta result was already supplied")
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
        try visit(transition.update.root)
        if let unreachable = suppliedResults.subtracting(visited).sorted().first {
            throw ArborWireValidationError.unreachableObject(unreachable)
        }
        let result = WireSnapshot(
            root: transition.update.root,
            objects: visited.sorted().map { WireObjectEnvelope(hash: $0, bytes: bytesByHash[$0]!) }
        )
        _ = try WireObjectGraph.validate(result)
        return result
    }
}
