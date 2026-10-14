// swift-tools-version:5.9
import PackageDescription

// The Mac app's core: the Home Assistant client, the device hub and the plan store.
let package = Package(
    name: "HouseCore",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "HouseCore", targets: ["HouseCore"])
    ],
    targets: [
        .target(name: "HouseCore", path: "Sources/HouseCore"),
        .testTarget(name: "HouseCoreTests", dependencies: ["HouseCore"], path: "Tests/HouseCoreTests"),
    ]
)
