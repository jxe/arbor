// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "StoryKit",
    platforms: [
        .iOS("27.0"),
        .macOS("27.0")
    ],
    products: [
        .library(name: "StoryKit", targets: ["StoryKit"])
    ],
    targets: [
        .target(name: "StoryKit"),
        .testTarget(name: "StoryKitTests", dependencies: ["StoryKit"])
    ],
    swiftLanguageModes: [.v6]
)
