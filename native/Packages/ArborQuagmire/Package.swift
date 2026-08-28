// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "ArborQuagmire",
    platforms: [.iOS("27.0"), .macOS("27.0")],
    products: [.library(name: "ArborQuagmire", targets: ["ArborQuagmire"])],
    dependencies: [
        .package(path: "../ArborClient"),
        .package(path: "../ArborKit"),
        .package(path: "../ArborProviders"),
        .package(url: "https://github.com/jxe/quagmire.git", exact: "0.4.0")
    ],
    targets: [
        .target(
            name: "ArborQuagmire",
            dependencies: [
                "ArborKit",
                .product(name: "Quagmire", package: "quagmire"),
                .product(name: "QuagmireExtras", package: "quagmire")
            ]
        ),
        .testTarget(
            name: "ArborQuagmireTests",
            dependencies: [
                "ArborQuagmire",
                "ArborClient",
                "ArborKit",
                "ArborProviders",
                .product(name: "Quagmire", package: "quagmire"),
                .product(name: "QuagmireExtras", package: "quagmire")
            ]
        )
    ],
    swiftLanguageModes: [.v6]
)
