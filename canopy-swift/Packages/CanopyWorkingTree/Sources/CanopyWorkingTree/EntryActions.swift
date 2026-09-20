import Overstory
import Foundation

/// One atomic editor action on independent physical entries, all bound to the
/// same authored graph. A sibling Markdown body and its directory are one action.
public struct EntryActions: Codable, Equatable, Sendable {
    public var transfers: [EntryTransfer]
    public var removals: [String]
    public init(transfers: [EntryTransfer] = [], removals: [String] = []) {
        self.transfers = transfers; self.removals = removals
    }

    public func prepare(graph: WireSnapshot, candidate: WireSnapshot? = nil, changeID: String) throws -> (candidate: WireSnapshot, operations: [WireSourceOperation]) {
        _ = try WireObjectGraph.validate(graph, mode: .sparseFiles)
        func invalid() -> ArborWireValidationError { .invalidValue("Invalid compound entry action") }
        guard !transfers.isEmpty || !removals.isEmpty else { throw invalid() }
        // Dependent operations need explicit result references; this capture API
        // deliberately represents independent entries in one original basis.
        let sources = transfers.map(\.source) + removals
        let destinations = transfers.map { ($0.parent == "/" ? "" : $0.parent) + "/" + $0.name }
        func overlaps(_ a: String, _ b: String) -> Bool { a == b || a.hasPrefix(b + "/") || b.hasPrefix(a + "/") }
        for (i, path) in sources.enumerated() {
            guard !sources.dropFirst(i + 1).contains(where: { overlaps(path,$0) }),
                  !destinations.contains(where: { overlaps(path,$0) }) else { throw invalid() }
        }
        for (i, path) in destinations.enumerated() {
            guard !destinations.dropFirst(i + 1).contains(where: { overlaps(path,$0) }) else { throw invalid() }
        }
        var current = graph
        var operations: [WireSourceOperation] = []
        for (index, transfer) in transfers.enumerated() {
            let original = try transfer.prepare(graph: graph, candidate: candidate, changeID: changeID)
            current = try transfer.prepare(graph: current, candidate: candidate, changeID: changeID).candidate
            // Only keys and same-change operation references are renamed. Basis
            // references remain the original graph, never intermediate hashes.
            func bind(_ value: WireSemanticValue) -> WireSemanticValue {
                switch value {
                case var .object(fields):
                    if fields["kind"] == .string("operation"), fields["change"] == .string(changeID), case let .string(key)? = fields["operation"] {
                        fields["operation"] = .string("entry-\(index)-" + key)
                    }
                    return .object(fields.mapValues(bind))
                case let .array(values): return .array(values.map(bind))
                default: return value
                }
            }
            for op in original.operations {
                guard case let .object(bound) = bind(.object(op.fields)), case let .string(key)? = bound["key"] else { throw invalid() }
                var fields = bound; fields["key"] = .string("entry-\(index)-" + key)
                operations.append(try WireSourceOperation(fields))
            }
        }
        var objects = Dictionary(uniqueKeysWithValues: current.objects.map { ($0.hash,$0.bytes) })
        let basisObjects = Dictionary(uniqueKeysWithValues: graph.objects.map { ($0.hash,$0.bytes) })
        func remove(_ hash: String, _ parts: ArraySlice<String>) throws -> String {
            guard let bytes = objects[hash], case let .directory(original, descriptor) = try WireObjectCodec.decode(bytes,kind:.directory),
                  let first = parts.first, let index = original.firstIndex(where: { $0.name == first }) else { throw invalid() }
            var entries = original
            if parts.count == 1 { entries.remove(at:index) }
            else {
                guard let child = entries[index].directory else { throw invalid() }
                entries[index].directory = try remove(child,parts.dropFirst())
            }
            let bytesOut = try WireObjectCodec.encode(.directory(entries,childrenSource:descriptor)), result = WireObjectCodec.hash(bytesOut)
            objects[result] = bytesOut; return result
        }
        for (index, path) in removals.enumerated() {
            let parts = path.dropFirst().split(separator:"/",omittingEmptySubsequences:false).map(String.init)
            guard path.hasPrefix("/"), parts.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." && !$0.contains("\\") && !$0.contains("\0") && Data($0.utf8) == Data($0.precomposedStringWithCanonicalMapping.utf8) }) else { throw invalid() }
            var hash = graph.root
            for (i, part) in parts.enumerated() {
                guard let bytes = basisObjects[hash], case let .directory(entries,_) = try WireObjectCodec.decode(bytes,kind:.directory), let entry = entries.first(where: { $0.name == part }), let next = entry.hash,
                      i == parts.count - 1 || entry.directory != nil else { throw invalid() }
                hash = next
            }
            operations.append(try WireSourceOperation(["key":.string("remove-\(index)"),"kind":.string("removeEntry"),"source":.object(["material":.object(["kind":.string("basis"),"path":.string(path),"object":.string(hash)])])]))
            current.root = try remove(current.root,parts[...])
        }
        var reachable = Set<String>()
        func visit(_ hash: String, directory: Bool) throws {
            guard reachable.insert(hash).inserted else { return }
            if directory {
                guard let bytes = objects[hash], case let .directory(entries,_) = try WireObjectCodec.decode(bytes,kind:.directory) else { throw invalid() }
                for e in entries { if let h = e.file { try visit(h,directory:false) }; if let h = e.directory { try visit(h,directory:true) } }
            }
        }
        try visit(current.root,directory:true)
        return (.init(root:current.root,objects:reachable.sorted().compactMap { h in objects[h].map { .init(hash:h,bytes:$0) } }),operations)
    }
}
