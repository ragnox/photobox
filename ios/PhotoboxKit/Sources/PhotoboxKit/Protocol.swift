import CryptoKit
import Foundation
import Security

/// What went wrong, worded for the person using the app.
public struct PhotoboxError: LocalizedError, Equatable, Sendable {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var errorDescription: String? { message }
}

/// The host answered, but not with what was asked: `status` is its HTTP status.
public struct HostError: LocalizedError, Equatable, Sendable {
    public let status: Int
    public let message: String
    public var errorDescription: String? { message }
    /// Worth trying again later; anything else needs something to change first.
    public var retryable: Bool { status >= 500 || status == 408 || status == 409 || status == 429 }
}

func ensure(_ condition: Bool, _ message: @autoclosure () -> String) throws {
    if !condition { throw PhotoboxError(message()) }
}

func sha256Hex(_ data: some DataProtocol) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

func isHash(_ value: String) -> Bool {
    value.count == 64 && value.allSatisfy { ("0"..."9").contains($0) || ("a"..."f").contains($0) }
}

/// The certificate a pairing QR code says to trust: Photobox's own CA (`ca`), or a server
/// certificate of your own that is pinned as it is (`certificate`).
public struct TrustAnchor: Codable, Equatable, Sendable {
    public let kind: String
    public let sha256: String
    public let certificate: String

    public init(kind: String, sha256: String, certificate: String) {
        self.kind = kind
        self.sha256 = sha256
        self.certificate = certificate
    }

    /// The certificate, once its fingerprint matches the QR code and it is valid now.
    public func secCertificate(at now: Date = Date()) throws -> SecCertificate {
        try ensure(kind == "ca" || kind == "certificate", "Unsupported host trust type")
        try ensure(isHash(sha256), "Invalid certificate fingerprint")
        try ensure(certificate.count <= 16_384, "Certificate is too large")
        guard let der = Data(base64Encoded: certificate) else { throw PhotoboxError("Invalid certificate encoding") }
        try ensure(sha256Hex(der) == sha256, "Certificate fingerprint does not match the QR code")
        guard let cert = SecCertificateCreateWithData(nil, der as CFData) else { throw PhotoboxError("Invalid certificate encoding") }
        try ensure(SecCertificateCopyData(cert) as Data == der, "Invalid certificate encoding")
        // Its own dates: evaluated as the only anchor, it is trusted unless it isn't valid now.
        var trust: SecTrust?
        try ensure(SecTrustCreateWithCertificates(cert, SecPolicyCreateBasicX509(), &trust) == errSecSuccess && trust != nil, "Invalid certificate")
        SecTrustSetAnchorCertificates(trust!, [cert] as CFArray)
        SecTrustSetAnchorCertificatesOnly(trust!, true)
        SecTrustSetVerifyDate(trust!, now as CFDate)
        try ensure(SecTrustEvaluateWithError(trust!, nil), "The host's certificate is not valid now; pair again")
        return cert
    }
}

/// A plain HTTPS host address, such as `https://192.0.2.20:4568/`.
public func serverURL(_ value: String) throws -> URL {
    guard var parts = URLComponents(string: value), parts.scheme?.lowercased() == "https", let host = parts.host, !host.isEmpty,
          parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
          parts.path == "/" || parts.path.isEmpty
    else { throw PhotoboxError("Pairing requires a plain HTTPS host address") }
    parts.scheme = "https"
    parts.path = "/"
    guard let url = parts.url else { throw PhotoboxError("Pairing requires a plain HTTPS host address") }
    return url
}

/// What the host's "Photobox for iPhone" QR code holds: versioned JSON.
public struct PairingPayload: Codable, Equatable, Sendable {
    public let type: String
    public let version: Int
    public let server: String
    public let code: String
    public let expiresAt: Int64
    public let trust: TrustAnchor

    public init(type: String, version: Int, server: String, code: String, expiresAt: Int64, trust: TrustAnchor) {
        self.type = type
        self.version = version
        self.server = server
        self.code = code
        self.expiresAt = expiresAt
        self.trust = trust
    }

    @discardableResult
    public func validate(at now: Date = Date()) throws -> PairingPayload {
        try ensure(type == "photobox-pair" && version == 1, "Unsupported Photobox pairing code")
        _ = try serverURL(server)
        try ensure(code.count == 22 && code.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_" || $0 == "-") }, "Invalid pairing code")
        let ms = Int64(now.timeIntervalSince1970 * 1000)
        try ensure(expiresAt > ms && expiresAt - ms <= 11 * 60_000, "Pairing code expired; make a new one on the computer")
        _ = try trust.secCertificate(at: now)
        return self
    }

    public static func decode(_ value: String, at now: Date = Date()) throws -> PairingPayload {
        try ensure(value.utf8.count <= 24_000, "Pairing data is too large")
        guard let data = value.trimmingCharacters(in: .whitespacesAndNewlines).data(using: .utf8),
              let payload = try? JSONDecoder().decode(PairingPayload.self, from: data)
        else { throw PhotoboxError("This isn't a Photobox pairing code") }
        return try payload.validate(at: now)
    }
}

/// A paired host: where it was last reached, the device token and the trust anchor.
public struct Connection: Codable, Equatable, Sendable {
    public let id: String
    public var server: String
    public let token: String
    public let trust: TrustAnchor
    public let deviceName: String

    public init(id: String, server: String, token: String, trust: TrustAnchor, deviceName: String) {
        self.id = id
        self.server = server
        self.token = token
        self.trust = trust
        self.deviceName = deviceName
    }

    func moved(to server: String) -> Connection {
        var copy = self
        copy.server = server
        return copy
    }
}

public struct Capabilities: Codable, Equatable, Sendable {
    public let version: Int
    public let tusVersion: String
    public let maxFileBytes: Int64
    public let extensions: [String]
}

/// The host's evidence for one original. `deleted`: it was deleted in Photobox, so this phone
/// deletes its copy instead of backing it up again.
public struct Receipt: Codable, Equatable, Sendable {
    public let sha256: String
    public let received: Bool
    public let indexed: Bool
    public let exported: Bool
    public let deleted: Bool

    public init(sha256: String, received: Bool, indexed: Bool, exported: Bool, deleted: Bool = false) {
        self.sha256 = sha256
        self.received = received
        self.indexed = indexed
        self.exported = exported
        self.deleted = deleted
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sha256 = try c.decode(String.self, forKey: .sha256)
        received = try c.decode(Bool.self, forKey: .received)
        indexed = try c.decode(Bool.self, forKey: .indexed)
        exported = try c.decode(Bool.self, forKey: .exported)
        deleted = try c.decodeIfPresent(Bool.self, forKey: .deleted) ?? false
    }

    public var verified: Bool { received && indexed && exported && !deleted }
}

/// One change on the host's Deleted list; `deleted: false` means it was cleared there.
public struct Deletion: Codable, Equatable, Sendable {
    public let seq: Int64
    public let sha256: String
    public let deleted: Bool
}

public struct Deletions: Codable, Equatable, Sendable {
    public let deletions: [Deletion]
    public let more: Bool
}

/// What this phone did with its copy of a photo deleted in Photobox: `trashed` or `kept`.
public struct DeletionOutcome: Codable, Equatable, Sendable {
    public let sha256: String
    public let state: String
    public init(sha256: String, state: String) {
        self.sha256 = sha256
        self.state = state
    }
}

struct Receipts: Codable { let assets: [Receipt] }
struct PairRequest: Codable { let code: String; let name: String }
struct PairResponse: Codable { let token: String }
struct CheckRequest: Codable { let sha256: [String] }
struct DeletionReport: Codable { let items: [DeletionOutcome] }
