// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "OverstoryObjectStore",
    platforms: [
        .iOS("27.0"),
        .macOS("27.0")
    ],
    products: [
        .library(name: "OverstoryObjectStore", targets: ["OverstoryObjectStore"])
    ],
    dependencies: [
        .package(path: "../Overstory")
    ],
    targets: [
        .target(
            name: "OverstoryObjectStore",
            dependencies: [
                .product(name: "Overstory", package: "Overstory")
            ]
        ),
        .testTarget(
            name: "OverstoryObjectStoreTests",
            dependencies: [
                "OverstoryObjectStore",
                .product(name: "Overstory", package: "Overstory")
            ]
        )
    ],
    swiftLanguageModes: [.v6]
)
