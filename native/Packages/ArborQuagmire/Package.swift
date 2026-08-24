// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "ArborQuagmire",
    platforms: [.iOS("27.0"), .macOS("27.0")],
    products: [.library(name: "ArborQuagmire", targets: ["ArborQuagmire"])],
    dependencies: [
        .package(path: "../ArborKit"),
        .package(url: "https://github.com/jxe/quagmire.git", exact: "0.1.0")
    ],
    targets: [
        .target(
            name: "ArborQuagmire",
            dependencies: ["ArborKit", .product(name: "Quagmire", package: "quagmire")]
        ),
        .testTarget(
            name: "ArborQuagmireTests",
            dependencies: ["ArborQuagmire", "ArborKit", .product(name: "Quagmire", package: "quagmire")]
        )
    ],
    swiftLanguageModes: [.v6]
)
