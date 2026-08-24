// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "ArborWire",
    platforms: [
        .iOS("27.0"),
        .macOS("27.0")
    ],
    products: [
        .library(name: "ArborWire", targets: ["ArborWire"])
    ],
    targets: [
        .target(name: "ArborWire"),
        .testTarget(name: "ArborWireTests", dependencies: ["ArborWire"])
    ],
    swiftLanguageModes: [.v6]
)
