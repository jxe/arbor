// swift-tools-version: 6.2
import PackageDescription

// The client library's workspace module (Clients 003, module 7): what an
// editor or UI uses to read and edit a tree, with its models, locators and
// collection views. The engine (OverstoryWorkingTree) and the accounts module
// (OverstoryClient) build on it; app code reaches it through StoryKit.
let package = Package(
    name: "OverstoryWorkspace",
    platforms: [
        .iOS("27.0"),
        .macOS("27.0")
    ],
    products: [
        .library(name: "OverstoryWorkspace", targets: ["OverstoryWorkspace"])
    ],
    targets: [
        .target(name: "OverstoryWorkspace"),
        .testTarget(name: "OverstoryWorkspaceTests", dependencies: ["OverstoryWorkspace"])
    ],
    swiftLanguageModes: [.v6]
)
