import Foundation
@testable import PhotoboxKit

/// A real Photobox host on 127.0.0.1 with a temporary, synthetic library (scripts/android-test-host.js,
/// shared with the Kotlin client's tests): its native pairing payload and its local URL.
final class TestHost: @unchecked Sendable {
    let payload: PairingPayload
    /// The computer's own address of the host (no token needed): for deleting photos, say.
    let local: URL
    private let process: Process

    static let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()

    private init(payload: PairingPayload, local: URL, process: Process) {
        self.payload = payload
        self.local = local
        self.process = process
    }

    static func start() async throws -> TestHost {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["node", root.appendingPathComponent("scripts/android-test-host.js").path]
        process.currentDirectoryURL = root
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = (env["PATH"].map { $0 + ":" } ?? "") + "/opt/homebrew/bin:/usr/local/bin"
        // The host goes when this test process does, even if it crashes: it exits when its input ends.
        env["PHOTOBOX_TEST_HOST_STDIN"] = "1"
        process.environment = env
        let out = Pipe()
        process.standardOutput = out
        process.standardInput = Pipe()
        process.standardError = FileHandle.standardError
        try process.run()
        var lines = out.fileHandleForReading.bytes.lines.makeAsyncIterator()
        guard let first = try await lines.next(), let second = try await lines.next(), let local = URL(string: second) else {
            process.terminate()
            throw PhotoboxError("The Node test host didn't start")
        }
        return TestHost(payload: try PairingPayload.decode(first), local: local, process: process)
    }

    func stop() {
        process.terminate()
        // Not waitUntilExit(): from a test's task it can wait on after the host is gone.
        for _ in 0..<100 where process.isRunning { usleep(100_000) }
    }

    /// The server's port, as the pairing payload names it.
    var server: URL { URL(string: payload.server)! }

    /// Deletes the library's only photo on the computer, as you would in Photobox.
    func deleteOnlyPhoto() async throws {
        let (timeline, _) = try await URLSession.shared.data(from: local.appendingPathComponent("api/timeline"))
        let text = String(decoding: timeline, as: UTF8.self)
        guard let match = text.firstMatch(of: /"id":(\d+)/) else { throw PhotoboxError("No photo on the host") }
        var request = URLRequest(url: local.appendingPathComponent("api/media/\(match.1)"))
        request.httpMethod = "DELETE"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data("{}".utf8)
        let (_, response) = try await URLSession.shared.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw PhotoboxError("The host didn't delete it") }
    }

    /// Some valid certificate that isn't any host's: for tests that never connect.
    static func anyTrust() throws -> TrustAnchor {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/openssl")
        let key = try temporaryDirectory().appendingPathComponent("key.pem")
        process.arguments = ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key.path, "-subj", "/CN=Photobox test", "-days", "2", "-outform", "DER"]
        let out = Pipe()
        process.standardOutput = out
        process.standardError = Pipe()
        try process.run()
        let der = out.fileHandleForReading.readDataToEndOfFile()
        for _ in 0..<100 where process.isRunning { usleep(50_000) }
        try? FileManager.default.removeItem(at: key.deletingLastPathComponent())
        return TrustAnchor(kind: "ca", sha256: sha256Hex(der), certificate: der.base64EncodedString())
    }

    static func temporaryDirectory() throws -> URL {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("photoboxkit-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }
}

/// The server trust a host presents, caught before anything is sent.
final class TrustCatcher: NSObject, URLSessionDelegate, @unchecked Sendable {
    let caught = Locked<SecTrust?>(nil)
    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge) async -> (URLSession.AuthChallengeDisposition, URLCredential?) {
        caught.with { $0 = challenge.protectionSpace.serverTrust }
        return (.cancelAuthenticationChallenge, nil)
    }

    static func trust(of server: URL) async throws -> SecTrust {
        let catcher = TrustCatcher()
        let session = URLSession(configuration: .ephemeral, delegate: catcher, delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        _ = try? await session.data(from: server.appendingPathComponent("api/backup/capabilities"))
        guard let trust = catcher.caught.with({ $0 }) else { throw PhotoboxError("The host presented no certificate") }
        return trust
    }
}

/// Photos as files in a folder, standing in for the phone's library.
final class FileSource: MediaSource, @unchecked Sendable {
    let files = Locked<[String: (Original, URL)]>([:])
    let exported = Locked<[String]>([])

    func add(_ original: Original, bytes: Data, in dir: URL) throws {
        let file = dir.appendingPathComponent(UUID().uuidString)
        try bytes.write(to: file)
        files.with { $0[original.id] = (original, file) }
    }

    func remove(_ id: String) { files.with { $0[id] = nil } }

    func originals() async throws -> [Original] { files.with { $0.values.map(\.0) }.sorted { $0.id < $1.id } }
    func current(_ original: Original) async -> Original? { files.with { $0[original.id]?.0 } }
    func file(for original: Original) async throws -> URL {
        guard let file = files.with({ $0[original.id]?.1 }) else { throw SourceChanged(message: "gone") }
        exported.with { $0.append(original.id) }
        return file
    }
    func discard(_ original: Original) async {}
}

/// A tiny real PNG, padded so that it takes several chunks.
func photoBytes(_ seed: UInt8 = 0, padding: Int = 200_000) -> Data {
    var data = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")!
    data.append(contentsOf: (0..<padding).map { UInt8(($0 + Int(seed)) % 251) })
    return data
}

/// Polls `condition` until it holds or `seconds` pass.
func eventually(within seconds: Double = 20, _ condition: () async throws -> Bool) async throws -> Bool {
    let end = Date().addingTimeInterval(seconds)
    while Date() < end {
        if try await condition() { return true }
        try await Task.sleep(for: .milliseconds(200))
    }
    return try await condition()
}
