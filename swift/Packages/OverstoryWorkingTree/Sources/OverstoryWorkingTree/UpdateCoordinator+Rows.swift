import StoryKit
import Overstory
import Foundation

/// Edits to one collection's rows, as Story made them, waiting for the host.
struct PendingRowEdits: Codable, Equatable, Sendable {
    var id: String
    /// The collection folder's path in the tree.
    var collection: String
    /// Each edit as `RowEdit.json` spells it.
    var edits: [JSONValue]
}

/// The request carrying some pending batches: one derived element whose one
/// frame holds every batch's row operations in order (source intent §2.2).
/// Its body is fixed, so every retry is the same request.
struct RowSubmission: Codable, Equatable, Sendable {
    var tree: String
    var batches: [String]
    var base: ProtocolUpdateBase
    var body: Data
    var contentType: String?
    var requestDigests: [String]
    /// Set once the host accepted it: its update, the head the response
    /// reported, and the tree's accepted update then. The batches stay shown
    /// until the tree installs the result or anything after it.
    var accepted: Accepted?

    struct Accepted: Codable, Equatable, Sendable {
        var update: String
        var head: String
        var installed: String?
    }

    var prepared: PreparedProtocolUpdate {
        PreparedProtocolUpdate(tree: tree, body: body, requestDigests: requestDigests, contentType: contentType)
    }
}

/// The durable row queue (Schema language 007): edits wait here, shown over
/// the rows last received, until the tree installs the host's result. Story
/// never encodes a collection's tables; the host derives them.
struct RowQueueState: Codable, Equatable, Sendable {
    var pending: [PendingRowEdits] = []
    var submission: RowSubmission?
    /// Why the last batches were dropped, for presentation.
    var refused: String?
}

extension UpdateCoordinator {
    var rowQueueURL: URL { files.directory.appending(path: "row-changes.json") }

    func rowQueue() throws -> RowQueueState {
        if let rowState { return rowState }
        let state = FileManager.default.fileExists(atPath: rowQueueURL.path)
            ? try JSONDecoder().decode(RowQueueState.self, from: Data(contentsOf: rowQueueURL))
            : RowQueueState()
        rowState = state
        return state
    }

    func writeRowQueue(_ state: RowQueueState) throws {
        try DurableFile.atomicWrite(try sortedKeysJSON(state), to: rowQueueURL)
        rowState = state
    }

    /// Queue `edits` to the collection folder at `collection` and send them
    /// when the host can be reached. They show at once over the rows last
    /// received (`pendingRowEdits`).
    public func appendRows(collection: String, _ edits: [RowEdit]) async throws {
        try requireOpen()
        guard !edits.isEmpty else { return }
        var state = try rowQueue()
        state.pending.append(PendingRowEdits(id: "rows-\(UUID().uuidString)", collection: collection, edits: edits.map(\.json)))
        state.refused = nil
        try writeRowQueue(state)
        await workingTree.invalidateDocumentViews()
        startRowPump()
    }

    /// The edits still waiting for the tree to install their result, in order.
    public func pendingRowEdits(collection: String) -> [RowEdit] {
        guard let state = try? rowQueue() else { return [] }
        return state.pending.filter { $0.collection == collection }.flatMap { $0.edits.compactMap { try? RowEdit(json: $0) } }
    }

    /// Why the host refused the last row edits, if it did.
    public func refusedRowEdits() -> String? { (try? rowQueue())?.refused }

    func startRowPump() {
        guard rowPump == nil, (try? requireOpen()) != nil else { return }
        rowPump = Task { [weak self] in
            await self?.pumpRows()
            await self?.rowPumpEnded()
        }
    }

    private func rowPumpEnded() {
        rowPump = nil
        // An append that arrived as the pump finished starts it again.
        if let state = try? rowQueue(), !state.pending.isEmpty { startRowPump() }
    }

    /// Send pending row edits one request at a time, wait for the tree to
    /// install each result, then drop the batches it carried.
    private func pumpRows() async {
        var delay: Duration = .seconds(1)
        var waits = 0
        while (try? requireOpen()) != nil {
            do {
                var state = try rowQueue()
                if let submission = state.submission {
                    if let accepted = submission.accepted {
                        let heads = try await workingTree.heads()
                        // Update ids are opaque: the tree has the result once it
                        // installs it, the reported head, or any later state.
                        if heads.acceptedUpdate == accepted.update || heads.acceptedUpdate == accepted.head || heads.acceptedUpdate != accepted.installed {
                            // Appends may have landed while this awaited; write over the latest.
                            state = try rowQueue()
                            state.pending.removeAll { submission.batches.contains($0.id) }
                            state.submission = nil
                            try writeRowQueue(state)
                            waits = 0
                            await workingTree.invalidateDocumentViews()
                            continue
                        }
                        // The watch brings the result; ask for it if it's slow.
                        waits += 1
                        if waits % 20 == 1 { nudgeFreshness() }
                        try? await Task.sleep(for: .milliseconds(250))
                        continue
                    }
                    do {
                        let response = try await transport.submit(submission.prepared)
                        guard response.results.map(\.requestDigest) == submission.requestDigests, let last = response.results.last else {
                            throw UpdateError.returnedRequestDigestMismatch
                        }
                        let update: ProtocolAcceptedUpdate
                        switch last.result { case let .accepted(value), let .unchanged(value): update = value }
                        let installed = try await workingTree.heads().acceptedUpdate
                        state = try rowQueue()
                        state.submission?.accepted = .init(update: update.id, head: response.head.update, installed: installed)
                        try writeRowQueue(state)
                        delay = .seconds(1)
                        nudgeFreshness()
                    } catch let http as ProtocolHTTPError where http.code == "base-not-retained" {
                        // Rebuild on the tree's current accepted state.
                        state = try rowQueue()
                        state.submission = nil
                        try writeRowQueue(state)
                    } catch let http as ProtocolHTTPError where (400..<500).contains(http.status) && ![401, 403, 408, 429].contains(http.status) && http.code != "http-error" && !http.retryable {
                        // The host refused these edits; repeating them can't change that.
                        state = try rowQueue()
                        state.pending.removeAll { submission.batches.contains($0.id) }
                        state.submission = nil
                        state.refused = http.message ?? http.code
                        try writeRowQueue(state)
                        await workingTree.invalidateDocumentViews()
                    } catch {
                        await Self.pause(&delay)
                    }
                    continue
                }
                guard !state.pending.isEmpty else { return }
                let heads = try await workingTree.heads()
                guard let root = heads.acceptedRoot, let update = heads.acceptedUpdate else { await Self.pause(&delay); continue }
                let base = ProtocolUpdateBase(root: root, update: update)
                var operations: [ProtocolSourceOperation] = []
                var objects: [String: String] = [:]
                var current: [String: WorkspaceCollectionRows] = [:]
                let treeID = await workingTree.treeID()
                for batch in state.pending {
                    if objects[batch.collection] == nil {
                        objects[batch.collection] = try await directoryObject(at: batch.collection, in: root)
                        current[batch.collection] = try? await workingTree.collectionRows(
                            for: try await workingTree.resolve(WorkspaceReference(tree: treeID, path: batch.collection)))
                    }
                    for edit in batch.edits {
                        let rowEdit = try RowEdit(json: edit)
                        // An edit the rows no longer allow, such as making a row
                        // another device made meanwhile, is left out, as the view
                        // leaves it out, rather than have the host refuse the rest.
                        if var collection = current[batch.collection] {
                            guard let rows = try? applyRowEdits(collection.schema, collection.rows, [rowEdit]) else { continue }
                            collection.rows = rows
                            current[batch.collection] = collection
                        }
                        operations.append(try Self.rowOperation(rowEdit, key: "op-\(operations.count)",
                            collection: batch.collection, object: objects[batch.collection]!))
                    }
                }
                guard !operations.isEmpty else {
                    // The rows allow none of these edits now; drop their batches, keeping any appended meanwhile.
                    let batches = Set(state.pending.map(\.id))
                    var latest = try rowQueue()
                    latest.pending.removeAll { batches.contains($0.id) }
                    try writeRowQueue(latest)
                    await workingTree.invalidateDocumentViews()
                    return
                }
                let element = try ProtocolDerivedUpdate(change: "rows-\(UUID().uuidString)", frames: [operations])
                let tree = await workingTree.treeID().rawValue
                let encoding = ProtocolWireEncoding.cbor
                let batches = state.pending.map(\.id)
                state = try rowQueue()
                state.submission = RowSubmission(
                    tree: tree, batches: batches, base: base,
                    body: try encoding.encode(ProtocolDerivedUpdateRequest(base: update, updates: [element])),
                    contentType: encoding.storedContentType,
                    requestDigests: derivedUpdateRequestDigests(tree: tree, base: update, updates: [element]))
                try writeRowQueue(state)
            } catch {
                Self.syncLog.error("row edits not sent: \(String(describing: error), privacy: .public)")
                await Self.pause(&delay)
            }
        }
    }

    /// Wait out `delay`, then double it, up to a minute.
    private static func pause(_ delay: inout Duration) async {
        try? await Task.sleep(for: delay)
        delay = min(delay * 2, .seconds(60))
    }

    /// The directory object at `path` below the accepted `root`.
    private func directoryObject(at path: String, in root: String) async throws -> String {
        var object = root
        for name in path.split(separator: "/").map(String.init) {
            guard case let .directory(entries, _) = try ProtocolObjectCodec.decode(try await workingTree.objectBytes(hash: object), kind: .directory),
                  let next = entries.first(where: { $0.name == name })?.directory else {
                throw WorkspaceCollectionError.notCollection
            }
            object = next
        }
        return object
    }

    /// `edit` as a row operation on the collection at `collection`, whose
    /// directory object in the request's basis is `object`.
    static func rowOperation(_ edit: RowEdit, key: String, collection: String, object: String) throws -> ProtocolSourceOperation {
        guard case var .object(fields) = semantic(edit.json) else { throw UpdateError.requestEmpty }
        fields["model"] = fields.removeValue(forKey: "table")
        fields["key"] = .string(key)
        fields["collection"] = .object(["material": .object(["kind": .string("basis"), "path": .string(collection), "object": .string(object)])])
        return try ProtocolSourceOperation(fields)
    }

    static func semantic(_ value: JSONValue) -> ProtocolSemanticValue {
        switch value {
        case .null: .null
        case .bool(let b): .bool(b)
        case .number(let n): n.rounded() == n && abs(n) <= 9_007_199_254_740_991 ? .integer(Int(n)) : .number(n)
        case .string(let s): .string(s)
        case .array(let items): .array(items.map(semantic))
        case .object(let members): .object(members.mapValues(semantic))
        }
    }
}
