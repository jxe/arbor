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
        .package(path: "../CanopyAppKit"),
        .package(path: "../CanopyWorkingTree"),
        .package(path: "../OverstoryObjectStore"),
        .package(path: "../Overstory")
    ],
    targets: [
        .target(
            name: "ArborSyncClient",
            dependencies: [
                .product(name: "CanopyAppKit", package: "CanopyAppKit"),
                .product(name: "OverstoryObjectStore", package: "OverstoryObjectStore"),
                .product(name: "Overstory", package: "Overstory")
            ]
        ),
        .testTarget(
            name: "ArborSyncClientTests",
            dependencies: [
                "ArborSyncClient",
                .product(name: "CanopyAppKit", package: "CanopyAppKit"),
                .product(name: "OverstoryObjectStore", package: "OverstoryObjectStore"),
                .product(name: "Overstory", package: "Overstory"),
                .product(name: "CanopyWorkingTree", package: "CanopyWorkingTree")
            ]
        )
    ],
    swiftLanguageModes: [.v6]
)
