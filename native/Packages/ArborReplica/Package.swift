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
        .package(path: "../ArborKit"),
        .package(path: "../ArborClient")
    ],
    targets: [
        .target(
            name: "ArborReplica",
            dependencies: [
                .product(name: "ArborKit", package: "ArborKit"),
                .product(name: "ArborClient", package: "ArborClient")
            ]
        ),
        .testTarget(
            name: "ArborReplicaTests",
            dependencies: [
                "ArborReplica",
                .product(name: "ArborKit", package: "ArborKit"),
                .product(name: "ArborClient", package: "ArborClient")
            ]
        )
    ],
    swiftLanguageModes: [.v6]
)
