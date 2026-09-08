// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "ArborSyncClient",
    platforms: [
        .iOS("27.0"),
        .macOS("27.0")
    ],
    products: [
        .library(name: "ArborSyncClient", targets: ["ArborSyncClient"])
    ],
    dependencies: [
        .package(path: "../ArborKit"),
        .package(path: "../ArborReplica"),
        .package(path: "../ArborWire")
    ],
    targets: [
        .target(
            name: "ArborSyncClient",
            dependencies: [
                .product(name: "ArborKit", package: "ArborKit"),
                .product(name: "ArborWire", package: "ArborWire")
            ]
        ),
        .testTarget(
            name: "ArborSyncClientTests",
            dependencies: [
                "ArborSyncClient",
                .product(name: "ArborKit", package: "ArborKit"),
                .product(name: "ArborReplica", package: "ArborReplica")
            ]
        )
    ],
    swiftLanguageModes: [.v6]
)
