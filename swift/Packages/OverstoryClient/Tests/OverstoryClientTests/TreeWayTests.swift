import Testing
@testable import OverstoryClient

@Suite("Choosing the way to hold a tree")
struct TreeWayTests {
    private let gigabyte: Int64 = 1 << 30

    @Test("A tree placed here with Story Sync running is held alongside it")
    func placed() {
        #expect(TreeWay.choose(.init(placedWithStorySync: true, canWrite: true)) == .alongsideStorySync)
        #expect(TreeWay.choose(.init(placedWithStorySync: true, canWrite: false)) == .alongsideStorySync)
    }

    @Test("A tree the person can change is a replica when it fits, and browsed when it does not")
    func writable() {
        #expect(TreeWay.choose(.init(placedWithStorySync: false, canWrite: true)) == .replica)
        #expect(TreeWay.choose(.init(placedWithStorySync: false, canWrite: true, freeDiskBytes: 10 * gigabyte, treeBytes: gigabyte)) == .replica)
        #expect(TreeWay.choose(.init(placedWithStorySync: false, canWrite: true, freeDiskBytes: 2 * gigabyte, treeBytes: gigabyte)) == .browse)
        #expect(TreeWay.choose(.init(placedWithStorySync: false, canWrite: true, freeDiskBytes: gigabyte / 2)) == .browse)
    }

    @Test("A tree the person can only read is browsed")
    func readOnly() {
        #expect(TreeWay.choose(.init(placedWithStorySync: false, canWrite: false)) == .browse)
    }

    @Test("An override is honored only when it can work")
    func override() {
        #expect(TreeWay.choose(.init(placedWithStorySync: true, canWrite: true, override: .browse)) == .browse)
        #expect(TreeWay.choose(.init(placedWithStorySync: false, canWrite: false, override: .replica)) == .replica)
        #expect(TreeWay.choose(.init(placedWithStorySync: false, canWrite: true, override: .alongsideStorySync)) == .replica)
        #expect(TreeWay.choose(.init(placedWithStorySync: false, canWrite: true, freeDiskBytes: 0, override: .replica)) == .browse)
    }
}
