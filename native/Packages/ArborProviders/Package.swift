// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "ArborProviders",
    platforms: [.iOS("27.0"), .macOS("27.0")],
    products: [.library(name: "ArborProviders", targets: ["ArborProviders"])],
    dependencies: [
        .package(path: "../ArborKit"),
        .package(path: "../ArborClient"),
        .package(path: "../ArborReplica")
    ],
    targets: [
        .target(
            name: "ArborProviders",
            dependencies: ["ArborKit", "ArborClient"]
        ),
        .testTarget(
            name: "ArborProvidersTests",
            dependencies: ["ArborProviders", "ArborKit", "ArborReplica"]
        )
    ],
    swiftLanguageModes: [.v6]
)
