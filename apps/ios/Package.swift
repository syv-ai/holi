// swift-tools-version: 6.2
import PackageDescription

let package = Package(
  name: "HoliVaultFormat",
  platforms: [.iOS(.v26), .macOS(.v15)],
  products: [.library(name: "HoliVaultFormat", targets: ["HoliVaultFormat"])],
  targets: [
    .target(name: "HoliVaultFormat"),
    .testTarget(
      name: "HoliVaultFormatTests",
      dependencies: ["HoliVaultFormat"],
      resources: [.process("Fixtures")]
    ),
  ]
)
