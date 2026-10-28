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
    dependencies: [
        // Pages read their frontmatter as YAML 1.2 (spec 02 §3).
        .package(url: "https://github.com/jpsim/Yams.git", from: "6.2.2")
    ],
    targets: [
        .target(name: "Overstory", dependencies: ["Yams"]),
        .testTarget(name: "OverstoryTests", dependencies: ["Overstory"])
    ],
    swiftLanguageModes: [.v6]
)
