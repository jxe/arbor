import CanopyAppKit
import Overstory
import Foundation

extension LocalChange {
    /// Digest of a captured transfer, for exact-retry recognition without sources.
    public static func transferDigest(_ transfer: WorkspaceDocumentTransfer) -> String {
        ProtocolObjectCodec.hash((try? sortedKeysJSON(transfer)) ?? Data())
    }

    /// One record for a Move to Document: a single frame in which the origin's
    /// moved material leaves it and lands in the destination, as `moveSource`
    /// operations followed by the ordinary edits the move needs. `graph` must
    /// hold both documents exactly as the transfer read them.
    public init(change: String = UUID().uuidString, tree: String, basis: LocalChangeBasis, graph: ProtocolSnapshot,
                originPath: String, destinationPath: String, transfer: WorkspaceDocumentTransfer) throws {
        try transfer.validate()
        guard transfer.origin.reference.tree.rawValue == tree else { throw ProtocolValidationError.invalidValue("Wrong tree") }
        guard originPath != destinationPath else { throw ProtocolValidationError.invalidValue("A transfer names two documents") }
        guard Set(graph.objects.map(\.hash)).count == graph.objects.count else { throw ProtocolValidationError.invalidValue("Duplicate basis object") }
        var decoded = try ProtocolObjectGraph.validate(graph, mode: .sparseFiles)
        var bytes = Dictionary(uniqueKeysWithValues: graph.objects.map { ($0.hash, $0.bytes) })
        func store(_ object: ProtocolObject) throws -> String {
            let value = try ProtocolObjectCodec.encode(object), hash = ProtocolObjectCodec.hash(value)
            bytes[hash] = value; decoded[hash] = object
            return hash
        }
        func components(_ path: String) throws -> [String] {
            let parts = path.dropFirst().split(separator: "/", omittingEmptySubsequences: false).map(String.init)
            guard path.hasPrefix("/"), !parts.isEmpty, parts.allSatisfy(ProtocolGraph.isPathComponent) else { throw ProtocolValidationError.invalidValue("Invalid source path") }
            return parts
        }
        /// Replace the file at `parts` below `hash`, returning the new
        /// directory and the file's basis object.
        func replace(_ hash: String, _ parts: ArraySlice<String>, from previous: String, to source: String) throws -> (root: String, file: String) {
            guard case let .directory(original, descriptor)? = decoded[hash],
                  let index = original.firstIndex(where: { $0.name == parts.first }) else { throw ProtocolValidationError.invalidValue("Source path is not in basis") }
            var entries = original, file: String
            if parts.count == 1 {
                guard let current = entries[index].file, case let .file(value)? = decoded[current], value == Data(previous.utf8) else {
                    throw ProtocolValidationError.invalidValue("Source bytes do not match basis")
                }
                file = current
                entries[index].file = try store(.file(Data(source.utf8)))
            } else {
                guard let directory = entries[index].directory else { throw ProtocolValidationError.invalidValue("Source path crosses a file or tree boundary") }
                let replaced = try replace(directory, parts.dropFirst(), from: previous, to: source)
                entries[index].directory = replaced.root; file = replaced.file
            }
            return (try store(.directory(entries, childrenSource: descriptor)), file)
        }
        let origin = try replace(graph.root, try components(originPath)[...], from: transfer.origin.source, to: transfer.originSource)
        let destination = try replace(origin.root, try components(destinationPath)[...], from: transfer.destination.source, to: transfer.destinationSource)
        func ref(_ document: WorkspaceDocumentTransfer.Document, _ range: Range<Int>) -> ProtocolSemanticValue {
            let (path, object) = document == .origin ? (originPath, origin.file) : (destinationPath, destination.file)
            return .object(["material": .object(["kind": .string("basis"), "path": .string(path), "object": .string(object)]),
                            "range": .array([.integer(range.lowerBound), .integer(range.upperBound)])])
        }
        var operations = try transfer.moves.enumerated().map { index, move in
            try ProtocolSourceOperation(["key": .string("move-0-\(index)"), "kind": .string("moveSource"),
                "source": ref(.origin, move.source), "at": ref(move.anchor.document, move.anchor.range), "side": .string(move.side.rawValue)])
        }
        for (index, edit) in transfer.edits.enumerated() {
            var fields: [String: ProtocolSemanticValue] = ["key": .string("edit-0-\(index)"), "kind": .string("editSource"),
                "source": ref(edit.document, edit.edit.utf8Range), "text": .string(edit.edit.replacement)]
            if let lineage = edit.edit.lineage, !lineage.isEmpty {
                fields["lineage"] = .array(lineage.map { .object(["source": ref(edit.document, $0.source),
                    "range": .array([.integer($0.replacement.lowerBound), .integer($0.replacement.upperBound)])]) })
            }
            operations.append(try ProtocolSourceOperation(fields))
        }
        let root = destination.root
        let candidate = try ProtocolGraph.reachable(from: root, in: bytes)
        _ = try ProtocolObjectGraph.validate(candidate, mode: .sparseFiles)
        let known = Set(graph.objects.map(\.hash))
        let update = ProtocolCandidateUpdate(candidate: root, change: change,
            trace: [ProtocolTraceFrame(before: graph.root, after: root, operations: operations)],
            objects: candidate.objects.filter { !known.contains($0.hash) }.sorted { $0.hash < $1.hash })
        _ = try JSONEncoder().encode(update)
        try self.init(change: change, tree: tree, basis: basis, graph: graph, candidate: candidate, update: update,
                      sourcePath: originPath,
                      document: SourceDocumentCapture(reference: transfer.origin.reference, basisRevision: transfer.origin.contentRevision,
                                                      intentDigest: Self.transferDigest(transfer)),
                      entryTransfer: nil, entryActions: nil, creation: nil, localTrash: nil,
                      transfer: SourceTransferCapture(reference: transfer.destination.reference, path: destinationPath,
                                                      basisRevision: transfer.destination.contentRevision))
    }
}
