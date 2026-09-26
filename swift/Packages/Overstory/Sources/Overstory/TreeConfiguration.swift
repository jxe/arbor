import CryptoKit
import Foundation

/// The segment parameter that addresses a tree's configuration: `tr_x;arbor-config`.
public let treeConfigurationParameter = "arbor-config"

/// The TreeID of a tree's configuration: `tr_` and the unpadded lowercase
/// base32 of `SHA-256("arbor-tree-config-v1\0" || TreeID)`. Anyone can derive
/// it, so there is no pointer to keep consistent.
public func treeConfigurationID(_ tree: String) -> String {
    var input = Data("arbor-tree-config-v1\0".utf8)
    input.append(Data(tree.utf8))
    return "tr_" + lowercaseBase32(Data(SHA256.hash(data: input)))
}

func lowercaseBase32(_ data: Data) -> String {
    let alphabet = Array("abcdefghijklmnopqrstuvwxyz234567")
    var accumulator = 0
    var bits = 0
    var output = ""
    for byte in data {
        accumulator = (accumulator << 8) | Int(byte)
        bits += 8
        while bits >= 5 {
            bits -= 5
            output.append(alphabet[(accumulator >> bits) & 31])
        }
        accumulator &= bits == 0 ? 0 : (1 << bits) - 1
    }
    if bits > 0 { output.append(alphabet[(accumulator << (5 - bits)) & 31]) }
    return output
}

public extension ProtocolClient {
    /// Declare a tree: the null-base first snapshot of its configuration,
    /// addressed as `tr_x;arbor-config` and answered under the configuration's
    /// derived TreeID. The tree then awaits its own first snapshot.
    func declareTree(_ tree: String, configuration: ProtocolSnapshot) async throws -> ProtocolUpdateResult {
        _ = try ProtocolObjectGraph.validate(configuration)
        let update = ProtocolCandidateUpdate(candidate: configuration.root, objects: configuration.objects)
        let request = ProtocolUpdateRequest(base: nil, updates: [update])
        let prepared = PreparedProtocolUpdate(
            tree: "\(tree);\(treeConfigurationParameter)",
            body: try JSONEncoder().encode(request),
            requestDigests: updateRequestDigests(tree: treeConfigurationID(tree), base: nil, updates: [update])
        )
        return try await submitUpdate(prepared)
    }
}

public extension ProtocolSnapshot {
    /// This snapshot with its root directory's file `name` set to `bytes`,
    /// added when the root has no such entry.
    func settingRootFile(named name: String, to bytes: Data) throws -> ProtocolSnapshot {
        if (try? rootFile(named: name)) != nil { return try replacingRootFile(named: name, with: bytes) }
        let objects = try ProtocolObjectGraph.validate(self)
        guard case let .directory(entries, childrenSource)? = objects[root] else { throw ProtocolValidationError.incompleteGraph("/") }
        let file = try ProtocolObjectCodec.object(.file(bytes))
        let nextEntries = (entries + [ProtocolDirectoryEntry(name: name, file: file.hash)]).sorted { $0.name.utf8.lexicographicallyPrecedes($1.name.utf8) }
        let nextRoot = try ProtocolObjectCodec.object(.directory(nextEntries, childrenSource: childrenSource))
        return ProtocolSnapshot(root: nextRoot.hash, objects: self.objects.filter { $0.hash != root } + [
            ProtocolObjectEnvelope(hash: file.hash, bytes: file.bytes),
            ProtocolObjectEnvelope(hash: nextRoot.hash, bytes: nextRoot.bytes),
        ])
    }
}
