// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "CanopyEditor",
    platforms: [.iOS("27.0"), .macOS("27.0")],
    products: [.library(name: "CanopyEditor", targets: ["CanopyEditor"])],
    dependencies: [
        .package(path: "../ArborSyncClient"),
        .package(path: "../CanopyAppKit"),
        .package(path: "../CanopyWorkingTree"),
        .package(path: "../Overstory"),
        .package(url: "https://github.com/jxe/quagmire.git", exact: "0.8.0")
    ],
    targets: [
        .target(
            name: "CanopyEditor",
            dependencies: [
                "ArborSyncClient",
                "CanopyAppKit",
                .product(name: "Quagmire", package: "quagmire"),
                .product(name: "QuagmireExtras", package: "quagmire")
            ]
        ),
        .testTarget(
            name: "CanopyEditorTests",
            dependencies: [
                "CanopyEditor",
                "ArborSyncClient",
                "CanopyAppKit",
                "CanopyWorkingTree",
                "Overstory",
                .product(name: "Quagmire", package: "quagmire"),
                .product(name: "QuagmireExtras", package: "quagmire")
            ]
        )
    ],
    swiftLanguageModes: [.v6]
)
