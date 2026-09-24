import CanopyAppKit
import Overstory
@testable import CanopyWorkingTree
import Foundation
import Testing

@Test("Shared source preservation fixtures validate exact identity claims")
func sourcePreservationFixtures() throws {
    struct Part: Decodable { let source: [Int]; let replacement: [Int] }
    struct Case: Decodable { let name: String; let source: String; let replacement: String; let lineage: [Part]; let valid: Bool }
    struct Fixture: Decodable { let cases: [Case] }
    let path = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appending(path:"../../../../../docs/overstory-spec/conformance/source-preservation.json")
    for value in try JSONDecoder().decode(Fixture.self, from: Data(contentsOf:path)).cases {
        let patch = WorkspaceDocumentPatch(baseContentRevision:"r", edits:[WorkspaceSourceEdit(utf8Range:0..<value.source.utf8.count,replacement:value.replacement,lineage:value.lineage.map { .init(source:$0.source[0]..<$0.source[1],replacement:$0.replacement[0]..<$0.replacement[1]) })])
        if value.valid {
            #expect(try patch.applying(to:value.source) == value.replacement)
            let file = Data(value.source.utf8), hash = WireObjectCodec.hash(file)
            let directory = try WireObjectCodec.encode(.directory([.init(name:"note.md",file:hash)]))
            let graph = WireSnapshot(root:WireObjectCodec.hash(directory),objects:[.init(hash:hash,bytes:file),.init(hash:WireObjectCodec.hash(directory),bytes:directory)])
            let reference = WorkspaceReference(tree:"tr_lineage",path:"/note")
            let intent = try WorkspaceDocumentIntent(basis:.init(reference:reference,source:value.source,contentRevision:"r"),patch:patch,source:value.replacement)
            let record = try LocalChange(tree:"tr_lineage",basis:.accepted(.init(root:graph.root,update:"basis")),graph:graph,sourcePath:"/note.md",intent:intent)
            try record.validate()
            #expect(record.update.trace?.first?.operations.first?.fields["lineage"] == .array(value.lineage.map { part in .object([
                "source":.object(["material":.object(["kind":.string("basis"),"path":.string("/note.md"),"object":.string(hash)]),"range":.array(part.source.map(WireSemanticValue.integer))]),
                "range":.array(part.replacement.map(WireSemanticValue.integer))
            ]) }))
            #expect(try JSONDecoder().decode(LocalChange.self,from:JSONEncoder().encode(record)) == record)
        }
        else { #expect(throws:(any Error).self) { try patch.applying(to:value.source) } }
    }
}

@Test("Shared source-copy fixtures validate and retain exact operation evidence")
func sourceCopyFixtures() async throws {
    struct Part: Decodable { let source:[Int]; let replacement:[Int]
        var value: WorkspaceSourceLineage { .init(source:source[0]..<source[1],replacement:replacement[0]..<replacement[1]) }
    }
    struct Case: Decodable { let source:String; let replacement:String; let copies:[Part]; let lineage:[Part]?; let valid:Bool }
    struct Fixture: Decodable { let cases:[Case] }
    let path = URL(fileURLWithPath:#filePath).deletingLastPathComponent().appending(path:"../../../../../docs/overstory-spec/conformance/source-copy.json")
    for value in try JSONDecoder().decode(Fixture.self,from:Data(contentsOf:path)).cases {
        let patch = WorkspaceDocumentPatch(baseContentRevision:"r",edits:[.init(utf8Range:0..<value.source.utf8.count,replacement:value.replacement,lineage:value.lineage?.map(\.value),copies:value.copies.map(\.value))])
        if !value.valid { #expect(throws:(any Error).self) { try patch.applying(to:value.source) }; continue }
        let bytes = Data(value.source.utf8), file = WireObjectCodec.hash(bytes)
        let directory = try WireObjectCodec.encode(.directory([.init(name:"note.md",file:file)])), hash = WireObjectCodec.hash(directory)
        let graph = WireSnapshot(root:hash,objects:[.init(hash:file,bytes:bytes),.init(hash:hash,bytes:directory)])
        let reference = WorkspaceReference(tree:"tr_copy",path:"/note")
        let intent = try WorkspaceDocumentIntent(basis:.init(reference:reference,source:value.source,contentRevision:"r"),patch:patch,source:value.replacement)
        let record = try LocalChange(tree:"tr_copy",basis:.accepted(.init(root:hash,update:"basis")),graph:graph,sourcePath:"/note.md",intent:intent)
        #expect(record.update.trace?.flatMap(\.operations).filter { $0.kind == "copySource" }.count == value.copies.count)
        let root = FileManager.default.temporaryDirectory.appending(path:UUID().uuidString)
        defer { try? FileManager.default.removeItem(at:root) }
        try await ChangeLog(tree:"tr_copy",stateRoot:root).retain(record)
        #expect(try await ChangeLog(tree:"tr_copy",stateRoot:root).retained() == [record])
    }
}
