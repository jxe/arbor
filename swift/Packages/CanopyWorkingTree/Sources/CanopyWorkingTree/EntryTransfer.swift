import Overstory
import Foundation

/// An explicit editor action, never inferred from matching before/after bytes.
public struct EntryTransfer: Codable, Equatable, Sendable {
    public enum Kind: String, Codable, Sendable { case moveEntry, copyEntry }
    public var kind: Kind
    public var source: String
    public var parent: String
    public var name: String
    public var rewrites: [String: String]?
    public init(kind: Kind, source: String, parent: String, name: String) {
        self.kind = kind; self.source = source; self.parent = parent; self.name = name
    }

    /// Copying a Native page also authors fresh page metadata. Capture those
    /// exact file edits after the copy instead of discarding the copy provenance.
    func capturingRewrites(graph: WireSnapshot, candidate: WireSnapshot) throws -> EntryTransfer {
        let projected = try prepare(graph: graph).candidate
        let before = Dictionary(uniqueKeysWithValues: projected.objects.map { ($0.hash,$0.bytes) })
        let after = Dictionary(uniqueKeysWithValues: candidate.objects.map { ($0.hash,$0.bytes) })
        func entry(_ root: String, _ objects: [String:Data]) throws -> WireDirectoryEntry {
            var hash = root
            let parts = (parent == "/" ? name : String(parent.dropFirst()) + "/" + name).split(separator:"/").map(String.init)
            var result: WireDirectoryEntry?
            for part in parts {
                guard let bytes = objects[hash], case let .directory(entries,_) = try WireObjectCodec.decode(bytes,kind:.directory), let found = entries.first(where:{$0.name == part}) else { throw ArborWireValidationError.invalidValue("Copy destination disappeared") }
                result = found; hash = found.hash ?? ""
            }
            return result!
        }
        var changes: [String:String] = [:]
        func compare(_ a:WireDirectoryEntry,_ b:WireDirectoryEntry,_ path:[String]) throws {
            if a == b { return }
            if let old = a.file, let file = b.file {
                if old != file { changes[path.joined(separator:"/")] = file }; return
            }
            guard let x = a.directory,let y = b.directory,let xb = before[x],let yb = after[y],
                  case let .directory(xs,xd) = try WireObjectCodec.decode(xb,kind:.directory),
                  case let .directory(ys,yd) = try WireObjectCodec.decode(yb,kind:.directory), xd == yd,
                  xs.map(\.name) == ys.map(\.name) else { throw ArborWireValidationError.invalidValue("Copy changes structural shape") }
            for (x,y) in zip(xs,ys) { try compare(x,y,path+[x.name]) }
        }
        try compare(entry(projected.root,before),entry(candidate.root,after),[])
        var result = self; result.rewrites = changes.isEmpty ? nil : changes
        return result
    }

    public func prepare(graph: WireSnapshot, candidate: WireSnapshot? = nil, changeID: String = "entry-transfer") throws -> (candidate: WireSnapshot, operations: [WireSourceOperation]) {
        _ = try WireObjectGraph.validate(graph, mode:.sparseFiles)
        func invalid() -> ArborWireValidationError { .invalidValue("Invalid entry transfer") }
        func components(_ path: String) throws -> [String] {
            if path == "/" { return [] }
            let parts = path.dropFirst().split(separator:"/",omittingEmptySubsequences:false).map(String.init)
            guard path.hasPrefix("/"), parts.allSatisfy(WireGraph.isPathComponent) else { throw invalid() }
            return parts
        }
        let sourceParts = try components(source), parentParts = try components(parent)
        guard !sourceParts.isEmpty, try components("/"+name).count == 1, parent != source, !parent.hasPrefix(source+"/") else { throw invalid() }
        var objects = Dictionary(uniqueKeysWithValues:graph.objects.map { ($0.hash,$0.bytes) })
        for envelope in candidate?.objects ?? [] {
            guard WireObjectCodec.hash(envelope.bytes) == envelope.hash else { throw invalid() }
            objects[envelope.hash] = envelope.bytes
        }
        func directory(_ hash:String) throws -> ([WireDirectoryEntry], WireCollectionFileDescriptor?) {
            guard let bytes = objects[hash], case let .directory(entries,descriptor) = try WireObjectCodec.decode(bytes,kind:.directory) else { throw invalid() }
            return (entries,descriptor)
        }
        func locate(_ parts:[String]) throws -> String {
            var hash = graph.root
            for part in parts {
                guard let next = try directory(hash).0.first(where:{$0.name == part})?.directory else { throw invalid() }
                hash = next
            }
            return hash
        }
        let sourceParent = try locate(Array(sourceParts.dropLast())), destination = try locate(parentParts)
        guard let entry = try directory(sourceParent).0.first(where:{$0.name == sourceParts.last}), entry.tree == nil,
              !(try directory(destination).0.contains(where:{$0.name == name})), let object = entry.hash else { throw invalid() }
        func change(_ hash:String,_ parts:[String],_ mutate:(inout [WireDirectoryEntry])->Void) throws -> String {
            var (entries,descriptor) = try directory(hash)
            if parts.isEmpty { mutate(&entries) }
            else {
                guard let i = entries.firstIndex(where:{$0.name == parts.first}),let child = entries[i].directory else { throw invalid() }
                entries[i].directory = try change(child,Array(parts.dropFirst()),mutate)
            }
            entries.sort { Array($0.name.utf8).lexicographicallyPrecedes(Array($1.name.utf8)) }
            let bytes = try WireObjectCodec.encode(.directory(entries,childrenSource:descriptor)), next = WireObjectCodec.hash(bytes)
            objects[next] = bytes; return next
        }
        var root = graph.root
        if kind == .moveEntry { root = try change(root,Array(sourceParts.dropLast())) { $0.removeAll(where:{$0.name == sourceParts.last}) } }
        root = try change(root,parentParts) { entries in var moved = entry; moved.name = name; entries.append(moved) }
        func ref(_ path:String,_ hash:String) -> WireSemanticValue { .object(["material":.object(["kind":.string("basis"),"path":.string(path),"object":.string(hash)])]) }
        let operation = try WireSourceOperation(["key":.string("entry-transfer"),"kind":.string(kind.rawValue),"source":ref(source,object),"destination":.object(["parent":ref(parent,destination),"name":.string(name)])])
        var operations = [operation]
        let target = parentParts + [name]
        for (index, rewrite) in (rewrites ?? [:]).sorted(by: { $0.key < $1.key }).enumerated() {
            let relative = rewrite.key.isEmpty ? [] : try components("/" + rewrite.key)
            var selected = entry
            for part in relative {
                guard let directoryHash = selected.directory, let next = try directory(directoryHash).0.first(where: { $0.name == part }) else { throw invalid() }
                selected = next
            }
            guard let hash = selected.file, let old = objects[hash], let new = objects[rewrite.value], let oldText = String(data: old, encoding: .utf8), let text = String(data: new, encoding: .utf8) else { throw invalid() }
            var start = 0, end = 0
            let a = Array(oldText.unicodeScalars), b = Array(text.unicodeScalars)
            while start < min(a.count,b.count), a[start] == b[start] { start += 1 }
            while end < min(a.count,b.count)-start, a[a.count-1-end] == b[b.count-1-end] { end += 1 }
            let lower = a.prefix(start).reduce(0) { $0 + String($1).utf8.count }
            let upper = old.count - a.suffix(end).reduce(0) { $0 + String($1).utf8.count }
            let replacement = b[start..<(b.count-end)].map(String.init).joined()
            var source: [String: WireSemanticValue] = ["material": .object(["kind": .string("operation"), "change": .string(changeID), "operation": .string("entry-transfer")]), "range": .array([.integer(lower),.integer(upper)])]
            if !relative.isEmpty { source["within"] = .array(relative.map(WireSemanticValue.string)) }
            operations.append(try WireSourceOperation(["key":.string("copy-edit-\(index)"),"kind":.string("editSource"),"source":.object(source),"text":.string(replacement)]))
            let filePath = target + relative
            root = try change(root,Array(filePath.dropLast())) { entries in
                if let i = entries.firstIndex(where: { $0.name == filePath.last }) { entries[i].file = rewrite.value }
            }
        }
        let result = try WireGraph.reachable(from: root, in: objects) { _, kind in if kind == .directory { throw invalid() } }
        return (result, operations)
    }
}
