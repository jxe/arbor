// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "ArborObjectStore",
    platforms: [
        .iOS("27.0"),
        .macOS("27.0")
    ],
    products: [
        .library(name: "ArborObjectStore", targets: ["ArborObjectStore"])
    ],
    dependencies: [
        .package(path: "../ArborWire")
    ],
    targets: [
        .target(
            name: "ArborObjectStore",
            dependencies: [
                .product(name: "ArborWire", package: "ArborWire")
            ]
        ),
        .testTarget(
            name: "ArborObjectStoreTests",
            dependencies: [
                "ArborObjectStore",
                .product(name: "ArborWire", package: "ArborWire")
            ]
        )
    ],
    swiftLanguageModes: [.v6]
)
