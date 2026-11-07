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
    dependencies: [
        .package(path: "../OverstoryWorkspace")
    ],
    targets: [
        .target(name: "StoryKit", dependencies: [
            .product(name: "OverstoryWorkspace", package: "OverstoryWorkspace")
        ]),
        .testTarget(name: "StoryKitTests", dependencies: [
            "StoryKit",
            .product(name: "OverstoryWorkspace", package: "OverstoryWorkspace")
        ])
    ],
    swiftLanguageModes: [.v6]
)
