// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "ArborWorkingTree",
    platforms: [
        .iOS("27.0"),
        .macOS("27.0")
    ],
    products: [
        .library(name: "ArborWorkingTree", targets: ["ArborWorkingTree"])
    ],
    dependencies: [
        .package(path: "../ArborKit"),
        .package(path: "../ArborObjectStore"),
        .package(path: "../ArborWire")
    ],
    targets: [
        .target(
            name: "ArborWorkingTree",
            dependencies: [
                .product(name: "ArborKit", package: "ArborKit"),
                .product(name: "ArborObjectStore", package: "ArborObjectStore"),
                .product(name: "ArborWire", package: "ArborWire")
            ]
        ),
        .testTarget(
            name: "ArborWorkingTreeTests",
            dependencies: [
                "ArborWorkingTree",
                .product(name: "ArborKit", package: "ArborKit"),
                .product(name: "ArborObjectStore", package: "ArborObjectStore"),
                .product(name: "ArborWire", package: "ArborWire")
            ]
        )
    ],
    swiftLanguageModes: [.v6]
)
