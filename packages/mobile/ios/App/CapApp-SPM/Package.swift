// swift-tools-version: 5.9
import PackageDescription

// DO NOT MODIFY THIS FILE - managed by Capacitor CLI commands
let package = Package(
    name: "CapApp-SPM",
    platforms: [.iOS(.v14)],
    products: [
        .library(
            name: "CapApp-SPM",
            targets: ["CapApp-SPM"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "7.6.9"),
        .package(name: "CapacitorBarcodeScanner", path: "../../../../../node_modules/.bun/@capacitor+barcode-scanner@2.2.0+22269fde31107d14/node_modules/@capacitor/barcode-scanner"),
        .package(name: "CapacitorSecureStoragePlugin", path: "../../../../../node_modules/.bun/capacitor-secure-storage-plugin@0.12.0+22269fde31107d14/node_modules/capacitor-secure-storage-plugin")
    ],
    targets: [
        .target(
            name: "CapApp-SPM",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
                .product(name: "CapacitorBarcodeScanner", package: "CapacitorBarcodeScanner"),
                .product(name: "CapacitorSecureStoragePlugin", package: "CapacitorSecureStoragePlugin")
            ]
        )
    ]
)
