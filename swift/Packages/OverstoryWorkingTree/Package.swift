// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "OverstoryWorkingTree",
    platforms: [
        .iOS("27.0"),
        .macOS("27.0")
    ],
    products: [
        .library(name: "OverstoryWorkingTree", targets: ["OverstoryWorkingTree"])
    ],
    dependencies: [
        .package(path: "../StoryKit"),
        .package(path: "../OverstoryObjectStore"),
        .package(path: "../Overstory")
    ],
    targets: [
        .target(
            name: "OverstoryWorkingTree",
            dependencies: [
                .product(name: "StoryKit", package: "StoryKit"),
                .product(name: "OverstoryObjectStore", package: "OverstoryObjectStore"),
                .product(name: "Overstory", package: "Overstory")
            ]
        ),
        .testTarget(
            name: "OverstoryWorkingTreeTests",
            dependencies: [
                "OverstoryWorkingTree",
                .product(name: "StoryKit", package: "StoryKit"),
                .product(name: "OverstoryObjectStore", package: "OverstoryObjectStore"),
                .product(name: "Overstory", package: "Overstory")
            ]
        )
    ],
    swiftLanguageModes: [.v6]
)
