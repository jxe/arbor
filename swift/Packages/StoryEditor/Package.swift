// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "StoryEditor",
    platforms: [.iOS("27.0"), .macOS("27.0")],
    products: [.library(name: "StoryEditor", targets: ["StoryEditor"])],
    dependencies: [
        .package(path: "../StoryKit"),
        .package(path: "../OverstoryWorkingTree"),
        .package(path: "../Overstory"),
        .package(url: "https://github.com/jxe/quagmire.git", exact: "0.8.0")
    ],
    targets: [
        .target(
            name: "StoryEditor",
            dependencies: [
                "StoryKit",
                .product(name: "Quagmire", package: "quagmire"),
                .product(name: "QuagmireExtras", package: "quagmire")
            ]
        ),
        .testTarget(
            name: "StoryEditorTests",
            dependencies: [
                "StoryEditor",
                "StoryKit",
                "OverstoryWorkingTree",
                "Overstory",
                .product(name: "Quagmire", package: "quagmire"),
                .product(name: "QuagmireExtras", package: "quagmire")
            ]
        )
    ],
    swiftLanguageModes: [.v6]
)
