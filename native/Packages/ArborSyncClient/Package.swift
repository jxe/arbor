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
        .package(path: "../ArborWorkingTree"),
        .package(path: "../ArborObjectStore"),
        .package(path: "../ArborWire")
    ],
    targets: [
        .target(
            name: "ArborSyncClient",
            dependencies: [
                .product(name: "ArborKit", package: "ArborKit"),
                .product(name: "ArborObjectStore", package: "ArborObjectStore"),
                .product(name: "ArborWire", package: "ArborWire")
            ]
        ),
        .testTarget(
            name: "ArborSyncClientTests",
            dependencies: [
                "ArborSyncClient",
                .product(name: "ArborKit", package: "ArborKit"),
                .product(name: "ArborObjectStore", package: "ArborObjectStore"),
                .product(name: "ArborWire", package: "ArborWire"),
                .product(name: "ArborWorkingTree", package: "ArborWorkingTree")
            ]
        )
    ],
    swiftLanguageModes: [.v6]
)
