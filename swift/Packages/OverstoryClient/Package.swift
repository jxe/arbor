// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "OverstoryClient",
    platforms: [.iOS("27.0"), .macOS("27.0")],
    products: [.library(name: "OverstoryClient", targets: ["OverstoryClient"])],
    dependencies: [
        .package(path: "../CanopyAppKit"),
        .package(path: "../CanopyWorkingTree"),
        .package(path: "../OverstoryObjectStore"),
        .package(path: "../Overstory"),
        .package(url: "https://github.com/jpsim/Yams.git", from: "6.2.2")
    ],
    targets: [
        .target(
            name: "OverstoryClient",
            dependencies: ["CanopyAppKit", "CanopyWorkingTree", "OverstoryObjectStore", "Overstory", "Yams"],
            linkerSettings: [.linkedFramework("Security")]
        ),
        .testTarget(
            name: "OverstoryClientTests",
            dependencies: ["OverstoryClient", "CanopyAppKit", "CanopyWorkingTree", "OverstoryObjectStore", "Overstory"]
        )
    ],
    swiftLanguageModes: [.v6]
)
