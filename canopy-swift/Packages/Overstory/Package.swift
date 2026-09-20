// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "Overstory",
    platforms: [
        .iOS("27.0"),
        .macOS("27.0")
    ],
    products: [
        .library(name: "Overstory", targets: ["Overstory"])
    ],
    targets: [
        .target(name: "Overstory"),
        .testTarget(name: "OverstoryTests", dependencies: ["Overstory"])
    ],
    swiftLanguageModes: [.v6]
)
