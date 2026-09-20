import Foundation

/// The working tree's own overlay in front of a platform store: local objects
/// win, everything else is fetched through. Nothing fetched is written back
/// into the overlay; the platform is the authority for accepted bytes.
public struct LayeredObjectStore: ObjectStore {
    public let overlay: any ObjectOverlay
    public let platform: any ObjectStore

    public init(overlay: any ObjectOverlay, platform: any ObjectStore) {
        self.overlay = overlay
        self.platform = platform
    }

    public func bytes(_ hash: String) async throws -> Data {
        if let local = try overlay.storedBytes(hash) { return local }
        return try verifyObject(try await platform.bytes(hash), hash: hash)
    }
}
