import Foundation

/// The paired host's backup API (see docs/backup-api.md): capabilities, receipts, the Deleted
/// list and tus 1.0.0 uploads. Every request carries the device token; nothing else does.
public final class HostAPI: Sendable {
    public let base: URL
    private let token: String?
    private let session: URLSession

    public convenience init(_ connection: Connection) throws {
        try self.init(base: serverURL(connection.server), trust: connection.trust, token: connection.token)
    }

    init(base: URL, trust: TrustAnchor, token: String?) throws {
        self.base = base
        self.token = token
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 60
        config.timeoutIntervalForResource = 120
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.urlCache = nil
        config.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        config.waitsForConnectivity = false
        config.httpMaximumConnectionsPerHost = 2
        session = URLSession(configuration: config, delegate: try PinnedTrust(trust), delegateQueue: nil)
    }

    deinit { session.invalidateAndCancel() }

    struct Reply {
        let status: Int
        let response: HTTPURLResponse
        let body: Data
        func header(_ name: String) -> String? { response.value(forHTTPHeaderField: name) }
    }

    /// `again`: the request may be sent a second time when the host had closed the connection it
    /// went out on (it closes idle ones after 5 s), because sending it twice does no harm.
    private func send(_ method: String, _ path: String, headers: [String: String] = [:], body: Data? = nil, again: Bool = false) async throws -> Reply {
        guard let url = URL(string: path, relativeTo: base)?.absoluteURL else { throw PhotoboxError("Invalid host address") }
        var request = URLRequest(url: url)
        request.httpMethod = method
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
        do {
            let (data, response): (Data, URLResponse)
            if let body { (data, response) = try await session.upload(for: request, from: body) }
            else { (data, response) = try await session.data(for: request) }
            guard let http = response as? HTTPURLResponse else { throw PhotoboxError("The host's answer wasn't HTTP") }
            // Only protocol answers come this way, never photos.
            try ensure(data.count <= 1_048_576, "Host response is too large")
            return Reply(status: http.statusCode, response: http, body: data)
        } catch let error as URLError where again && error.code == .networkConnectionLost {
            return try await send(method, path, headers: headers, body: body, again: false)
        } catch let error as URLError where error.code == .cancelled && Task.isCancelled {
            throw CancellationError()
        }
    }

    @discardableResult
    private func expect(_ reply: Reply, _ codes: Int...) throws -> Reply {
        guard codes.contains(reply.status) else {
            let message = switch reply.status {
            case 401: "Photobox on your computer disconnected this phone; pair again"
            case 410: "Deleted in Photobox"
            case 413: "Photobox on your computer doesn't take a file this big, or this phone's share of its space is used up"
            case 422: "Photobox on your computer got different bytes than this phone sent; it tries again"
            case 507: "Your computer doesn't have enough free space"
            case 300...399: "Host redirects are not permitted"
            default: "Host request failed (HTTP \(reply.status))"
            }
            throw HostError(status: reply.status, message: message)
        }
        return reply
    }

    private func decode<T: Decodable>(_ type: T.Type, _ reply: Reply) throws -> T {
        do { return try JSONDecoder().decode(type, from: reply.body) }
        catch { throw PhotoboxError("The host's answer couldn't be read") }
    }

    private func json(_ value: some Encodable) throws -> Data { try JSONEncoder().encode(value) }

    public func capabilities() async throws -> Capabilities {
        let reply = try expect(await send("GET", "/api/backup/capabilities", again: true), 200)
        let caps = try decode(Capabilities.self, reply)
        try ensure(caps.version == 1 && caps.tusVersion == "1.0.0" && caps.maxFileBytes > 0, "Photobox on your computer speaks another backup protocol; update both")
        return caps
    }

    /// The host's receipts for these originals, in the same order: at most 100 at a time.
    public func check(_ hashes: [String]) async throws -> [Receipt] {
        try ensure(hashes.count <= 100 && hashes.allSatisfy(isHash), "Invalid receipt request")
        let reply = try expect(await send("POST", "/api/assets/check", headers: ["Content-Type": "application/json"],
                                          body: json(CheckRequest(sha256: hashes)), again: true), 200)
        let receipts = try decode(Receipts.self, reply).assets
        try ensure(receipts.map(\.sha256) == hashes, "Host returned mismatched backup receipts")
        return receipts
    }

    /// Changes on the host's Deleted list after `after` (the last `seq` seen), oldest first.
    public func deletions(after: Int64) async throws -> Deletions {
        try ensure(after >= 0, "Invalid deletion position")
        let reply = try expect(await send("GET", "/api/backup/deletions?after=\(after)", again: true), 200)
        let page = try decode(Deletions.self, reply)
        try ensure(page.deletions.allSatisfy { $0.seq > after && isHash($0.sha256) }, "Host returned invalid deletions")
        return page
    }

    public func reportDeletions(_ items: [DeletionOutcome]) async throws {
        try ensure(items.count <= 500 && items.allSatisfy { isHash($0.sha256) && ($0.state == "trashed" || $0.state == "kept") }, "Invalid deletion report")
        try expect(await send("POST", "/api/backup/deletions/report", headers: ["Content-Type": "application/json"],
                              body: json(DeletionReport(items: items)), again: true), 200)
    }

    /// An upload location, checked to be on this host and an upload before the token goes there.
    public func uploadURL(_ value: String) throws -> URL {
        guard let url = URL(string: value, relativeTo: base)?.absoluteURL,
              let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              parts.scheme == base.scheme, parts.host == base.host, url.port == base.port,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              isUploadPath(parts.percentEncodedPath)
        else { throw PhotoboxError("Upload URL belongs to a different host or endpoint") }
        return url
    }

    /// Starts an upload; returns its location, to be saved before any bytes are sent.
    public func create(filename: String, size: Int64, sha256: String, capturedAt: String?, mediaID: String) async throws -> String {
        try ensure(size > 0 && isHash(sha256), "Invalid upload")
        var metadata = [("filename", filename), ("sha256", sha256), ("mediaStoreId", String(mediaID.prefix(128)))]
        if let capturedAt { metadata.append(("capturedAt", capturedAt)) }
        let encoded = metadata.map { "\($0.0) \(Data($0.1.utf8).base64EncodedString())" }.joined(separator: ",")
        let reply = try expect(await send("POST", "/api/uploads", headers: [
            "Tus-Resumable": "1.0.0", "Upload-Length": String(size), "Upload-Metadata": encoded,
        ], body: Data()), 201)
        guard let location = reply.header("Location") else { throw PhotoboxError("Host omitted the upload location") }
        return try uploadURL(location).absoluteString
    }

    /// How much of an upload the host has; nil when it has no such upload (anymore).
    public func offset(_ location: String, expectedSize: Int64) async throws -> Int64? {
        let url = try uploadURL(location)
        let reply = try await send("HEAD", url.path, headers: ["Tus-Resumable": "1.0.0"], again: true)
        if [404, 410, 422].contains(reply.status) { return nil }
        try expect(reply, 200, 204)
        guard let size = reply.header("Upload-Length").flatMap(Int64.init), let offset = reply.header("Upload-Offset").flatMap(Int64.init),
              size == expectedSize, (0...expectedSize).contains(offset)
        else { throw PhotoboxError("Host returned an invalid resumable offset") }
        return offset
    }

    /// Sends `bytes` at `offset`; returns the host's new offset.
    public func chunk(_ location: String, offset: Int64, bytes: Data) async throws -> Int64 {
        let url = try uploadURL(location)
        let reply = try expect(await send("PATCH", url.path, headers: [
            "Tus-Resumable": "1.0.0", "Upload-Offset": String(offset), "Content-Type": "application/offset+octet-stream",
        ], body: bytes), 204)
        guard let next = reply.header("Upload-Offset").flatMap(Int64.init), next == offset + Int64(bytes.count)
        else { throw PhotoboxError("Host acknowledged an unexpected upload offset") }
        return next
    }

    /// Drops an unfinished upload. One the host already received stays there (409).
    public func cancelPartial(_ location: String) async throws {
        let url = try uploadURL(location)
        try expect(await send("DELETE", url.path, headers: ["Tus-Resumable": "1.0.0"], again: true), 204, 404, 409, 410)
    }

    /// Redeems a pairing code: the host's trust anchor was checked first, so only it sees the code.
    public static func pair(_ payload: PairingPayload, name: String) async throws -> Connection {
        try payload.validate()
        let base = try serverURL(payload.server)
        let api = try HostAPI(base: base, trust: payload.trust, token: nil)
        let deviceName = String(name.trimmingCharacters(in: .whitespacesAndNewlines).prefix(60))
        try ensure(!deviceName.isEmpty, "Name this phone first")
        let reply = try api.expect(await api.send("POST", "/api/pair", headers: ["Content-Type": "application/json"],
                                                  body: api.json(PairRequest(code: payload.code, name: deviceName))), 200)
        let token = try api.decode(PairResponse.self, reply).token
        try ensure(token.count == 43 && token.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_" || $0 == "-") },
                              "Host returned an invalid device token")
        return Connection(id: UUID().uuidString.lowercased(), server: base.absoluteString, token: token, trust: payload.trust, deviceName: deviceName)
    }
}

func isUploadPath(_ path: String) -> Bool {
    let prefix = "/api/uploads/"
    guard path.hasPrefix(prefix) else { return false }
    let id = path.dropFirst(prefix.count)
    return id.count == 32 && id.allSatisfy { ("0"..."9").contains($0) || ("a"..."f").contains($0) }
}
