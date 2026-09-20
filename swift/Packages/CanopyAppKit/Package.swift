// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "CanopyAppKit",
    platforms: [
        .iOS("27.0"),
        .macOS("27.0")
    ],
    products: [
        .library(name: "CanopyAppKit", targets: ["CanopyAppKit"])
    ],
    targets: [
        .target(name: "CanopyAppKit"),
        .testTarget(name: "CanopyAppKitTests", dependencies: ["CanopyAppKit"])
    ],
    swiftLanguageModes: [.v6]
)
