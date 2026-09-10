import CryptoKit
import Foundation

enum WorkingTreeWireValue {
    case unsigned(Int)
    case bytes(Data)
    case text(String)
    case array([WorkingTreeWireValue])
    case map([(String, WorkingTreeWireValue)])
}

enum WorkingTreeWireCodec {
    static func encode(_ value: WorkingTreeWireValue) -> Data {
        switch value {
        case let .unsigned(value): return head(major: 0, count: value)
        case let .bytes(bytes): return head(major: 2, count: bytes.count) + bytes
        case let .text(text): return head(major: 3, count: text.utf8.count) + Data(text.utf8)
        case let .array(values): return values.reduce(into: head(major: 4, count: values.count)) { $0.append(encode($1)) }
        case let .map(entries):
            return entries.map { (encode(.text($0.0)), $0.1) }
                .sorted { canonicalCompare($0.0, $1.0) }
                .reduce(into: head(major: 5, count: entries.count)) { result, entry in
                    result.append(entry.0)
                    result.append(encode(entry.1))
                }
        }
    }

    static func file(_ bytes: Data) -> Data {
        encode(.map([("type", .text("file")), ("bytes", .bytes(bytes))]))
    }

    static func directory(
        _ entries: [(name: String, hash: String?, tree: String?)],
        childrenSource: WorkingTreeCollectionFileDescriptor? = nil
    ) -> Data {
        var fields: [(String, WorkingTreeWireValue)] = [
            ("type", .text("directory")),
            ("entries", .array(entries.map { entry in
                .map([
                    ("name", .text(entry.name)),
                    entry.hash.map { ("hash", .text($0)) }
                        ?? ("tree", .text(entry.tree!))
                ])
            }))
        ]
        if let childrenSource { fields.append(("childrenSource", collectionFile(childrenSource))) }
        return encode(.map(fields))
    }

    private static func collectionFile(_ value: WorkingTreeCollectionFileDescriptor) -> WorkingTreeWireValue {
        .map([
            ("version", .unsigned(value.version)),
            ("type", .text(value.type)),
            ("format", .text(value.format)),
            ("source", .text(value.source)),
            ("schemaSource", .text(value.schemaSource)),
            ("schemaFingerprint", .text(value.schemaFingerprint)),
            ("childSetHash", .text(value.childSetHash)),
        ])
    }

    static func hash(_ bytes: Data) -> String { WorkingTreeSemantics.sha256(bytes) }

    static func snapshot(for state: WorkingTreeState) throws -> WorkingTreeSnapshot {
        let active = state.nodes.filter { $0.path != "/Trash" && !$0.path.hasPrefix("/Trash/") }
        guard active.contains(where: { $0.path == "/" && $0.kind == .directory }) else {
            throw WorkingTreeError.corruptState("Replica root directory is missing")
        }
        let paths = active.map(\.path)
        guard Set(paths).count == paths.count else {
            throw WorkingTreeError.corruptState("Duplicate logical path")
        }
        let byPath = Dictionary(uniqueKeysWithValues: active.map { ($0.path, $0) })
        var objects: [String: Data?] = [:]

        func store(_ bytes: Data) -> String {
            let hash = hash(bytes)
            objects[hash] = bytes
            return hash
        }

        func reference(_ ref: ContentRef?) -> String {
            switch ref {
            case let .inline(bytes)?: return store(file(bytes))
            case let .hash(hash, _, _)?:
                if objects[hash] == nil { objects[hash] = .some(nil) }
                return hash
            case nil: return store(file(Data()))
            }
        }

        func buildDirectory(at path: String) throws -> String {
            guard let node = byPath[path], node.kind == .directory else {
                throw WorkingTreeError.corruptState("Missing directory at \(path)")
            }
            if path == "/", node.directoryBodyPlacement != nil || node.shadowedSiblingMarkdownSource != nil {
                throw WorkingTreeError.corruptState("Replica root body must use _index.md")
            }
            if node.directoryBodyPlacement == .siblingMarkdown {
                guard node.source != nil, node.shadowedSiblingMarkdownSource == nil else {
                    throw WorkingTreeError.corruptState("Malformed sibling Markdown directory body")
                }
            } else if node.shadowedSiblingMarkdownSource != nil, node.source == nil {
                throw WorkingTreeError.corruptState("Shadowed sibling Markdown has no _index.md body")
            }
            var entries: [(name: String, hash: String?, tree: String?)] = []
            if let source = node.source, node.directoryBodyPlacement != .siblingMarkdown {
                entries.append(("_index.md", store(file(Data(source.utf8))), nil))
            }
            let children = active.filter { WorkingTreeSemantics.parent(of: $0.path) == path }
                .sorted { WorkingTreeSemantics.compareUTF8(WorkingTreeSemantics.name(of: $0.path), WorkingTreeSemantics.name(of: $1.path)) }
            for child in children {
                let name = WorkingTreeSemantics.name(of: child.path)
                switch child.kind {
                case .directory:
                    entries.append((name, try buildDirectory(at: child.path), nil))
                    if child.directoryBodyPlacement == .siblingMarkdown, let source = child.source {
                        entries.append((name + ".md", store(file(Data(source.utf8))), nil))
                    } else if let shadowed = child.shadowedSiblingMarkdownSource {
                        entries.append((name + ".md", store(file(Data(shadowed.utf8))), nil))
                    }
                case .markdown:
                    entries.append((name + ".md", store(file(Data((child.source ?? "").utf8))), nil))
                case .file:
                    entries.append((name, reference(child.ref), nil))
                case .boundary:
                    guard let tree = child.boundaryTree, !tree.isEmpty else {
                        throw WorkingTreeError.corruptState("Nested tree boundary is empty")
                    }
                    entries.append((name, nil, tree))
                }
            }
            entries.sort { WorkingTreeSemantics.compareUTF8($0.name, $1.name) }
            return store(Self.directory(entries, childrenSource: node.childrenSource))
        }

        let root = try buildDirectory(at: "/")
        return WorkingTreeSnapshot(
            root: root,
            objects: objects.map { WorkingTreeStoredObject(hash: $0.key, bytes: $0.value) }.sorted { $0.hash < $1.hash }
        )
    }

    private static func head(major: UInt8, count: Int) -> Data {
        precondition(count >= 0)
        let prefix = major << 5
        if count < 24 { return Data([prefix | UInt8(count)]) }
        if count <= 0xff { return Data([prefix | 24, UInt8(count)]) }
        if count <= 0xffff { return Data([prefix | 25, UInt8((count >> 8) & 0xff), UInt8(count & 0xff)]) }
        if UInt64(count) <= UInt64(UInt32.max) {
            return Data([
                prefix | 26,
                UInt8((count >> 24) & 0xff),
                UInt8((count >> 16) & 0xff),
                UInt8((count >> 8) & 0xff),
                UInt8(count & 0xff),
            ])
        }
        let value = UInt64(count)
        return Data([prefix | 27] + (0..<8).reversed().map { UInt8((value >> UInt64($0 * 8)) & 0xff) })
    }

    private static func canonicalCompare(_ left: Data, _ right: Data) -> Bool {
        left.count == right.count ? left.lexicographicallyPrecedes(right) : left.count < right.count
    }
}
