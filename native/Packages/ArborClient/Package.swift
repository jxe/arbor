// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "ArborClient",
    platforms: [
        .iOS(.v26),
        .macOS(.v26)
    ],
    products: [
        .library(name: "ArborClient", targets: ["ArborClient"])
    ],
    targets: [
        .target(name: "ArborClient"),
        .testTarget(name: "ArborClientTests", dependencies: ["ArborClient"])
    ],
    swiftLanguageModes: [.v6]
)
