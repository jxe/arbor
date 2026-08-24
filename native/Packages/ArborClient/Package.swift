// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "ArborClient",
    platforms: [
        .iOS("27.0"),
        .macOS("27.0")
    ],
    products: [
        .library(name: "ArborClient", targets: ["ArborClient"])
    ],
    dependencies: [
        .package(path: "../ArborWire")
    ],
    targets: [
        .target(
            name: "ArborClient",
            dependencies: [.product(name: "ArborWire", package: "ArborWire")]
        ),
        .testTarget(name: "ArborClientTests", dependencies: ["ArborClient"])
    ],
    swiftLanguageModes: [.v6]
)
