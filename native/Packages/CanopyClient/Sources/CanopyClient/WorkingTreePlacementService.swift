import ArborKit
import ArborWorkingTree
import ArborWire
import Foundation

/// Place a tree from Canopy: install its current complete snapshot as the
/// accepted base of a fresh working tree.
public enum WorkingTreePlacementService {
    public static func place(
        tree: WireTreeDescriptor,
        at replicaRoot: URL,
        transport: any UpdateTransport
    ) async throws -> WorkingTree {
        let current = try await transport.descriptor(tree: tree.id)
        let snapshot = try await transport.snapshot(tree: tree.id, root: current.tree.root)
        let update = current.tree.update
        guard !update.isEmpty else { throw UpdateError.replicaIsNotPlaced }
        let workingTree = try await WorkingTree.open(at: replicaRoot, tree: TreeID(rawValue: tree.id))
        let replacement = try SnapshotBridge.replacement(
            snapshot: snapshot,
            tree: TreeID(rawValue: tree.id),
            update: update,
            cursor: current.observedThrough
        )
        try await workingTree.initializeFromSystem(replacement)
        return workingTree
    }
}
