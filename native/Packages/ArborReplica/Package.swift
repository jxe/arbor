// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "ArborReplica",
    platforms: [
        .iOS("27.0"),
        .macOS("27.0")
    ],
    products: [
        .library(name: "ArborReplica", targets: ["ArborReplica"])
    ],
    dependencies: [
        .package(path: "../ArborKit")
    ],
    targets: [
        .target(
            name: "ArborReplica",
            dependencies: [.product(name: "ArborKit", package: "ArborKit")]
        ),
        .testTarget(
            name: "ArborReplicaTests",
            dependencies: ["ArborReplica", .product(name: "ArborKit", package: "ArborKit")]
        )
    ],
    swiftLanguageModes: [.v6]
)
