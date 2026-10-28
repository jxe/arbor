import Foundation
import Testing
@testable import Overstory

@Suite("Pages")
struct PageTests {
    private static func vectors() throws -> [String: Any] {
        let root = ProcessInfo.processInfo.environment["STORY_PROTOCOL_FIXTURES"].map { URL(fileURLWithPath: $0) }
            ?? URL(fileURLWithPath: #filePath).deletingLastPathComponent().appending(path: "../../../../../docs/overstory-spec/conformance").standardizedFileURL
        return try #require(JSONSerialization.jsonObject(with: Data(contentsOf: root.appending(path: "pages.json"))) as? [String: Any])
    }

    /// A vector's page value: `{"$date": text}` and `{"$dateTime": text}` are timestamps.
    private static func value(_ raw: Any) throws -> PageValue {
        switch raw {
        case is NSNull: return .null
        case let number as NSNumber where CFGetTypeID(number) == CFBooleanGetTypeID(): return .bool(number.boolValue)
        case let number as NSNumber:
            let double = number.doubleValue
            if double.rounded() == double, abs(double) <= 9_007_199_254_740_991 { return .integer(Int(double)) }
            return .float(double)
        case let text as String: return .string(text)
        case let items as [Any]: return .array(try items.map(value))
        case let map as [String: Any]:
            if map.count == 1, let date = map["$date"] as? String { return .date(date) }
            if map.count == 1, let dateTime = map["$dateTime"] as? String { return .dateTime(dateTime) }
            return .map(try map.mapValues(value))
        default: throw ProtocolValidationError.invalidValue("Unknown vector value")
        }
    }

    private static func page(_ raw: [String: Any]) throws -> ProtocolPage {
        let properties = try #require(raw["properties"] as? [[Any]]).map { pair in
            ProtocolPage.Property(try #require(pair[0] as? String), try value(pair[1]))
        }
        return ProtocolPage(id: raw["id"] as? String, properties: properties, body: Data(try #require(raw["body"] as? String).utf8))
    }

    @Test("Files read as the shared vectors' pages, objects and canonical files")
    func reads() throws {
        for item in try #require(Self.vectors()["reads"] as? [[String: Any]]) {
            let name = item["name"] as? String ?? "case"
            let file = Data(try #require(item["file"] as? String).utf8)
            let parsed = ProtocolPage.parse(file)
            guard let expected = item["page"] as? [String: Any] else {
                #expect(parsed == nil, "\(name)")
                continue
            }
            let page = try #require(parsed, "\(name)")
            #expect(page == (try Self.page(expected)), "\(name)")
            let bytes = try page.encoded()
            #expect(bytes.base64EncodedString() == item["object"] as? String, "\(name)")
            #expect(ProtocolObjectCodec.hash(bytes) == item["hash"] as? String, "\(name)")
            #expect(try ProtocolPage.decode(bytes) == page, "\(name)")
            #expect(String(decoding: page.canonicalFile, as: UTF8.self) == item["canonical"] as? String, "\(name)")
            #expect(ProtocolPage.parse(page.canonicalFile) == page, "\(name)")
            #expect(page.file(keeping: file) == file, "\(name)")
        }
    }

    @Test("Invalid page objects are rejected")
    func invalidObjects() throws {
        for item in try #require(Self.vectors()["invalidObjects"] as? [[String: Any]]) {
            let base64 = try #require(item["object"] as? String)
            let bytes = try #require(Data(base64Encoded: base64))
            #expect(throws: (any Error).self, "\(item["name"] ?? "case")") { try ProtocolPage.decode(bytes) }
        }
    }

    @Test("Numbers are written in ECMAScript's shortest form")
    func numbers() {
        #expect(ProtocolPage.numberText(1.5) == "1.5")
        #expect(ProtocolPage.numberText(0.000001) == "0.000001")
        #expect(ProtocolPage.numberText(1e-7) == "1e-7")
        #expect(ProtocolPage.numberText(1e20) == "1e+20")
        #expect(ProtocolPage.numberText(-0.25) == "-0.25")
        #expect(ProtocolPage.numberText(123.456) == "123.456")
    }

    @Test("A directory names a page entry, and Markdown is a page once a tree holds one")
    func pageEntries() throws {
        let page = ProtocolPage(id: "p1", properties: [.init("title", .string("A"))], body: Data("Body\n".utf8))
        let bytes = try ProtocolObjectCodec.encode(.page(page)), hash = ProtocolObjectCodec.hash(bytes)
        #expect(try ProtocolObjectCodec.decode(bytes, kind: .page) == .page(page))
        let directory = try ProtocolObjectCodec.encode(.directory([.init(name: "a.md", page: hash)]))
        guard case let .directory(entries, _) = try ProtocolObjectCodec.decode(directory, kind: .directory) else { Issue.record("Not a directory"); return }
        #expect(entries == [.init(name: "a.md", page: hash)])
        #expect(entries[0].kind == .page && entries[0].hash == hash)
        let snapshot = ProtocolSnapshot(root: ProtocolObjectCodec.hash(directory),
                                        objects: [bytes, directory].map { .init(hash: ProtocolObjectCodec.hash($0), bytes: $0) })
        #expect(ProtocolObjectGraph.holdsPages(snapshot.root, in: try ProtocolObjectGraph.validate(snapshot)))

        var stored: [String: Data] = [:]
        func store(_ data: Data) -> String { let hash = ProtocolObjectCodec.hash(data); stored[hash] = data; return hash }
        let file = Data("---\nid: p1\ntitle: 'A'\n---\nBody\n".utf8)
        #expect(ProtocolDirectoryEntry.markdown(name: "a.md", bytes: file, pages: true, store: store) == .init(name: "a.md", page: hash))
        #expect(ProtocolDirectoryEntry.markdown(name: "a.md", bytes: file, pages: false, store: store).file != nil)
        #expect(ProtocolDirectoryEntry.markdown(name: "a.md", bytes: Data("---\ntitle: [\n---\n".utf8), pages: true, store: store).file != nil)
        #expect(ProtocolDirectoryEntry.markdown(name: "a.txt", bytes: file, pages: true, store: store).file != nil)
    }
}
