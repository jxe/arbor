import Foundation

/// Path reads (tree operations §1.2.4): the directory objects from an accepted
/// root down to one logical path and the objects of the entries it names, in
/// one bundle. The walk is the TypeScript `pathReadObjects` exactly; both run
/// `protocol-path-reads.json`.
public enum ProtocolPathRead {
    /// A directory's page; `.mdx` is a plain file (Apps 011).
    private static let indexNames: Set<String> = ["_index.md"]

    /// The components the walk follows; `/` has none. `x.md`, `x/` and
    /// `x/_index.md` name node `x`; a file such as `photo.bin` stays itself.
    public static func components(_ path: String) throws -> [String] {
        var parts = path.replacingOccurrences(of: "\\", with: "/").split(separator: "/", omittingEmptySubsequences: true).map(String.init)
        guard !parts.contains(where: { $0 == "." || $0 == ".." || $0.contains("\0") }) else {
            throw ProtocolValidationError.invalidValue("Unsafe tree path: \(path)")
        }
        if let last = parts.last {
            if indexNames.contains(last) {
                parts.removeLast()
            } else if last.hasSuffix(".md") {
                parts[parts.count - 1] = String(last.dropLast(3))
            }
        }
        return parts
    }

    /// The URL suffix for a path read of `path`: each segment encoded once.
    public static func urlSuffix(_ path: String) throws -> String {
        let segments = path.replacingOccurrences(of: "\\", with: "/").split(separator: "/", omittingEmptySubsequences: true).map(String.init)
        guard !segments.contains(where: { $0 == "." || $0 == ".." || $0.contains("\0") }) else {
            throw ProtocolValidationError.invalidValue("Unsafe tree path: \(path)")
        }
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))
        return segments.map { "/" + $0.addingPercentEncoding(withAllowedCharacters: allowed)! }.joined()
    }

    /// The objects a path read of `path` under `root` holds. `read` returns nil
    /// for an object it does not have, which ends the walk there.
    public static func objects(
        root: String,
        path: String,
        read: (String) async throws -> Data?
    ) async throws -> [String: Data] {
        var objects: [String: Data] = [:]
        func load(_ hash: String) async throws -> Data? {
            if let known = objects[hash] { return known }
            guard let bytes = try await read(hash) else { return nil }
            let actual = ProtocolObjectCodec.hash(bytes)
            guard actual == hash else { throw ProtocolValidationError.objectHashMismatch(expected: hash, actual: actual) }
            objects[hash] = bytes
            return bytes
        }
        func directory(_ bytes: Data) throws -> [ProtocolDirectoryEntry] {
            guard case let .directory(entries, _) = try ProtocolObjectCodec.decode(bytes, kind: .directory) else {
                throw ProtocolValidationError.invalidValue("Path read expected a directory")
            }
            return entries
        }
        func addIndex(_ entries: [ProtocolDirectoryEntry]) async throws {
            for entry in entries where indexNames.contains(entry.name) {
                if let hash = entry.hash { _ = try await load(hash) }
            }
        }
        guard let rootBytes = try await load(root) else {
            throw ProtocolValidationError.incompleteGraph(root)
        }
        var entries = try directory(rootBytes)
        let parts = try components(path)
        if parts.isEmpty {
            try await addIndex(entries)
            return objects
        }
        for (index, component) in parts.enumerated() {
            if index < parts.count - 1 {
                guard let next = entries.first(where: { $0.name == component })?.directory,
                      let bytes = try await load(next) else { return objects }
                entries = try directory(bytes)
                continue
            }
            let names: Set<String> = [component, component + ".md"]
            for entry in entries where names.contains(entry.name) {
                guard let hash = entry.hash, let bytes = try await load(hash) else { continue }
                if entry.directory != nil { try await addIndex(try directory(bytes)) }
            }
        }
        return objects
    }

    /// Decode and check a path read's bundle: hash-ordered canonical CBOR,
    /// holding exactly the objects the walk of `path` from `root` reaches.
    public static func decode(_ data: Data, root: String, path: String) async throws -> [String: Data] {
        try validateObjectHash(root)
        guard case let .map(fields) = try CanonicalCBOR.decode(data) else {
            throw ProtocolValidationError.invalidCBOR("Path read bundle is not a map")
        }
        let values = Dictionary(uniqueKeysWithValues: fields)
        guard values.count == 2, case .unsigned(1)? = values["version"], case let .array(encoded)? = values["objects"] else {
            throw ProtocolValidationError.invalidCBOR("Path read bundle fields are invalid")
        }
        var supplied: [String: Data] = [:]
        var previous: String?
        for value in encoded {
            guard case let .bytes(bytes) = value else { throw ProtocolValidationError.invalidCBOR("Path read object is not a byte string") }
            let hash = ProtocolObjectCodec.hash(bytes)
            if let previous, hash <= previous { throw ProtocolValidationError.invalidValue("Path read objects are not ordered by hash") }
            previous = hash
            supplied[hash] = bytes
        }
        guard supplied[root] != nil else { throw ProtocolValidationError.invalidValue("Path read bundle does not hold its root") }
        var missing: String?
        let walked = try await objects(root: root, path: path) { hash in
            if supplied[hash] == nil, missing == nil { missing = hash }
            return supplied[hash]
        }
        if let missing { throw ProtocolValidationError.invalidValue("Path read bundle is missing \(missing)") }
        if let extra = supplied.keys.first(where: { walked[$0] == nil }) {
            throw ProtocolValidationError.invalidValue("Path read bundle holds an object off the path: \(extra)")
        }
        return supplied
    }
}
