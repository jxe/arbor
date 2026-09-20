// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "CanopyWorkingTree",
    platforms: [
        .iOS("27.0"),
        .macOS("27.0")
    ],
    products: [
        .library(name: "CanopyWorkingTree", targets: ["CanopyWorkingTree"])
    ],
    dependencies: [
        .package(path: "../CanopyAppKit"),
        .package(path: "../OverstoryObjectStore"),
        .package(path: "../Overstory")
    ],
    targets: [
        .target(
            name: "CanopyWorkingTree",
            dependencies: [
                .product(name: "CanopyAppKit", package: "CanopyAppKit"),
                .product(name: "OverstoryObjectStore", package: "OverstoryObjectStore"),
                .product(name: "Overstory", package: "Overstory")
            ]
        ),
        .testTarget(
            name: "CanopyWorkingTreeTests",
            dependencies: [
                "CanopyWorkingTree",
                .product(name: "CanopyAppKit", package: "CanopyAppKit"),
                .product(name: "OverstoryObjectStore", package: "OverstoryObjectStore"),
                .product(name: "Overstory", package: "Overstory")
            ]
        )
    ],
    swiftLanguageModes: [.v6]
)
