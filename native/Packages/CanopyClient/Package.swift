// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "CanopyClient",
    platforms: [.iOS("27.0"), .macOS("27.0")],
    products: [.library(name: "CanopyClient", targets: ["CanopyClient"])],
    dependencies: [
        .package(path: "../ArborKit"),
        .package(path: "../ArborReplica"),
        .package(path: "../ArborWire"),
        .package(url: "https://github.com/jpsim/Yams.git", from: "6.2.2")
    ],
    targets: [
        .target(
            name: "CanopyClient",
            dependencies: ["ArborKit", "ArborReplica", "ArborWire", "Yams"],
            linkerSettings: [.linkedFramework("Security")]
        ),
        .testTarget(
            name: "CanopyClientTests",
            dependencies: ["CanopyClient", "ArborKit", "ArborReplica", "ArborWire"]
        )
    ],
    swiftLanguageModes: [.v6]
)
