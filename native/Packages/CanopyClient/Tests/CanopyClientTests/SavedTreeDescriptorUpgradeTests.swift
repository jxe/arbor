import ArborWire
import Foundation
import Testing
@testable import CanopyClient

struct SavedTreeDescriptorUpgradeTests {
    private var tree: [String: Any] { ["id":"tree", "kind":"account-configuration", "access":"write", "root":"sha256:" + String(repeating:"a",count:64), "update":"old-id", "canonical":NSNull()] }
    private func bytes(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject:value) }
    @Test func oldPlacementsAndVisits() throws {
        let record: [String: Any] = ["version":1,"origin":"https://example.test","tree":tree,"configurationTree":"config","locator":"arbor://example.test/~me","visitedAt":"2026-09-14T00:00:00Z"]
        for (key, version) in [("placements",2),("visits",1)] {
            let input=try bytes(["version":version,key:[record],"selectedTree":"tree"])
            let upgraded=try key == "placements" ? SavedTreeDescriptorUpgrade.placements(input) : SavedTreeDescriptorUpgrade.visits(input)
            let result=try #require(JSONSerialization.jsonObject(with:upgraded) as? [String:Any])
            let records=try #require(result[key] as? [[String:Any]])
            let descriptor=try #require(records[0]["tree"] as? [String:Any])
            #expect(try JSONDecoder().decode(WireTreeDescriptor.self,from:bytes(descriptor)).conflicted == false)
            #expect(records[0]["visitedAt"] as? String == record["visitedAt"] as? String)
            #expect(result["selectedTree"] as? String == "tree")
            #expect(throws:(any Error).self) { try JSONDecoder().decode(WireTreeDescriptor.self,from:bytes(tree)) }
        }
        _ = try SavedTreeDescriptorUpgrade.placements(bytes(record))
    }
    @Test func modernFlagsAndInvalidRecords() throws {
        var modern=tree; modern["conflicted"]=true
        let record: [String:Any] = ["version":1,"tree":modern]
        let upgraded=try SavedTreeDescriptorUpgrade.placements(bytes(record))
        let result=try #require(JSONSerialization.jsonObject(with:upgraded) as? [String:Any])
        #expect((result["tree"] as? [String:Any])?["conflicted"] as? Bool == true)
        for bad: Any in [NSNull(), "false", 0] {
            var invalid=modern; invalid["conflicted"]=bad
            #expect(throws:(any Error).self) { try SavedTreeDescriptorUpgrade.placements(bytes(["version":1,"tree":invalid])) }
        }
        #expect(throws:(any Error).self) { try SavedTreeDescriptorUpgrade.placements(bytes(["version":3,"placements":[record]])) }
    }
    @Test(.enabled(if: ProcessInfo.processInfo.environment["ARBOR_SAVED_DESCRIPTOR_REHEARSAL"] != nil))
    func preservedDeviceBackups() throws {
        let root=try #require(ProcessInfo.processInfo.environment["ARBOR_SAVED_DESCRIPTOR_REHEARSAL"])
        for name in ["dot-arbor.before", "phone.before"] {
            let url=URL(fileURLWithPath:root).appending(path:name).appending(path:"Native Placement.json")
            let original=try Data(contentsOf:url)
            let adapted=try SavedTreeDescriptorUpgrade.placements(original)
            let value=try #require(JSONSerialization.jsonObject(with:adapted) as? [String:Any])
            let records=(value["placements"] as? [[String:Any]]) ?? [value]
            #expect(!records.isEmpty)
            for record in records {
                _ = try JSONDecoder().decode(WireTreeDescriptor.self,from:bytes(#require(record["tree"]))).validated()
            }
            #expect(try Data(contentsOf:url)==original)
        }
    }

}
