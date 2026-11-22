// swift-tools-version:6.0
// The protocol, trust and backup engine of Photobox for iPhone, free of UIKit and PhotoKit so that
// `swift test` runs it on a Mac, against the real Node host too (see Tests/).
import PackageDescription

let package = Package(
    name: "PhotoboxKit",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [.library(name: "PhotoboxKit", targets: ["PhotoboxKit"])],
    targets: [
        .target(name: "PhotoboxKit"),
        .testTarget(name: "PhotoboxKitTests", dependencies: ["PhotoboxKit"]),
    ]
)
