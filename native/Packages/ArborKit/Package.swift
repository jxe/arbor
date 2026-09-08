// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "ArborKit",
    platforms: [
        .iOS("27.0"),
        .macOS("27.0")
    ],
    products: [
        .library(name: "ArborKit", targets: ["ArborKit"])
    ],
    targets: [
        .target(name: "ArborKit"),
        .testTarget(name: "ArborKitTests", dependencies: ["ArborKit"])
    ],
    swiftLanguageModes: [.v6]
)
