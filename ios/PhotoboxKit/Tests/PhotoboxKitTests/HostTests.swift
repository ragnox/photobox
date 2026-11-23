import Foundation
import Testing
@testable import PhotoboxKit

// Against the real Node host: pairing, trust, resumable uploads, receipts and deletions.

@Suite(.serialized) struct HostTests {
    @Test func pairingChecksTheCertificateInTheQRCodeBeforeSendingTheCode() async throws {
        let host = try await TestHost.start()
        defer { host.stop() }
        let p = host.payload
        let wrong = PairingPayload(type: p.type, version: p.version, server: p.server, code: p.code, expiresAt: p.expiresAt,
                                   trust: TrustAnchor(kind: "ca", sha256: String(repeating: "0", count: 64), certificate: p.trust.certificate))
        await #expect(throws: PhotoboxError.self) { try await HostAPI.pair(wrong, name: "iPhone") }
        let expired = PairingPayload(type: p.type, version: p.version, server: p.server, code: p.code, expiresAt: 1, trust: p.trust)
        #expect(throws: PhotoboxError.self) { try expired.validate() }
        #expect(throws: PhotoboxError.self) { try PairingPayload.decode("https://example.com") }
        // The code still works: nothing was sent with the wrong certificate.
        let connection = try await HostAPI.pair(p, name: "iPhone test")
        #expect(connection.deviceName == "iPhone test")
        #expect(try await HostAPI(connection).capabilities().version == 1)
        // A code works once.
        await #expect(throws: HostError.self) { try await HostAPI.pair(p, name: "Again") }
    }

    @Test func trustNeedsThePairedAnchorAndTheRightHostName() async throws {
        let host = try await TestHost.start()
        defer { host.stop() }
        let trust = try await TrustCatcher.trust(of: host.server)
        let pinned = try PinnedTrust(host.payload.trust)
        #expect(pinned.accepts(trust, host: "127.0.0.1"))
        #expect(!pinned.accepts(trust, host: "192.0.2.1"), "host-name checking stays on")
        // A valid certificate of another authority is no reason to trust this host.
        #expect(!(try PinnedTrust(TestHost.anyTrust())).accepts(trust, host: "127.0.0.1"))
        // A certificate of your own is trusted only as exactly that server certificate.
        let leaf = try #require((SecTrustCopyCertificateChain(trust) as? [SecCertificate])?.first)
        let der = SecCertificateCopyData(leaf) as Data
        #expect(try PinnedTrust(TrustAnchor(kind: "certificate", sha256: sha256Hex(der), certificate: der.base64EncodedString())).accepts(trust, host: "127.0.0.1"))
        let other = try TestHost.anyTrust()
        #expect(!(try PinnedTrust(TrustAnchor(kind: "certificate", sha256: other.sha256, certificate: other.certificate))).accepts(trust, host: "127.0.0.1"))
    }

    @Test func uploadsResumeAtTheHostsOffsetAndCountOnlyOnceExported() async throws {
        let host = try await TestHost.start()
        defer { host.stop() }
        let connection = try await HostAPI.pair(host.payload, name: "iPhone test")
        let api = try HostAPI(connection)
        #expect(try await api.capabilities().extensions.contains(".heic"))
        // Busy for a while (hashing a video, say): the host closed the idle connection meanwhile.
        try await Task.sleep(for: .seconds(6))
        #expect(try await api.capabilities().version == 1)

        let bytes = photoBytes()
        let hash = sha256Hex(bytes)
        let location = try await api.create(filename: "IMG_0001.PNG", size: Int64(bytes.count), sha256: hash, capturedAt: "2024-01-01T12:00:00.000+01:00", mediaID: "A/photo")
        #expect(try await api.chunk(location, offset: 0, bytes: bytes.prefix(50_000)) == 50_000)
        await #expect(throws: HostError.self) { try await api.chunk(location, offset: 0, bytes: bytes.prefix(10)) }
        // A new client has nothing in memory: it goes on from the saved location and the host's offset.
        let resumed = try HostAPI(connection)
        let offset = try #require(try await resumed.offset(location, expectedSize: Int64(bytes.count)))
        #expect(offset == 50_000)
        _ = try await resumed.chunk(location, offset: offset, bytes: bytes.suffix(from: Int(offset)))
        #expect(try await eventually { try await resumed.check([hash])[0].verified })
        try await resumed.cancelPartial(location)
        #expect(try await resumed.check([hash])[0].verified, "cancelling can't delete a received original")
        #expect(try await resumed.deletions(after: 0).deletions.isEmpty)
    }

    @Test func aHostWithAnotherAddressIsFoundAndAStrangerNeverSeesTheToken() async throws {
        let host = try await TestHost.start()
        let stranger = try await TestHost.start()
        defer { host.stop(); stranger.stop() }
        var connection = try await HostAPI.pair(host.payload, name: "iPhone test")
        let real = connection.server
        connection.server = "https://127.0.0.1:9/" // nothing answers there any more
        // The stranger's certificate isn't from the paired authority: TLS stops before any request.
        do {
            _ = try await HostAPI(connection.moved(to: stranger.payload.server)).capabilities()
            Issue.record("A stranger's host was trusted")
        } catch is HostError {
            Issue.record("The token went to a stranger's host")
        } catch {}
        let reached = try await reach(connection) { [stranger.payload.server, real] }
        #expect(reached.connection.server == real)
        // A host that answers at its address isn't looked for elsewhere.
        let direct = try await reach(reached.connection) { Issue.record("looked elsewhere"); return [] }
        #expect(direct.connection == reached.connection)
    }

    @Test func theEngineBacksUpLearnsOfDeletionsAndReportsWhatYouDid() async throws {
        let host = try await TestHost.start()
        defer { host.stop() }
        let dir = try TestHost.temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let connection = try await HostAPI.pair(host.payload, name: "iPhone test")
        let source = FileSource()
        let photo = Original(id: "A/photo", item: "A", filename: "IMG_0001.PNG", signature: "v1", takenAt: Date(timeIntervalSince1970: 1_704_106_800))
        try source.add(photo, bytes: photoBytes(), in: dir)
        let store = try BackupStore(file: dir.appendingPathComponent("queue.sqlite"))
        let engine = BackupEngine(store: store, source: source, chunkSize: 64 * 1024, finder: { [] })

        let first = try await engine.run(connection)
        #expect(first.uploaded == 1)
        #expect(try await eventually {
            _ = try await engine.run(connection)
            return await store.record(photo.id)?.state == .verified
        })
        // Backed up: another run doesn't read it again.
        let reads = source.exported.with { $0.count }
        _ = try await engine.run(connection)
        #expect(source.exported.with { $0.count } == reads)

        // Deleted in Photobox: the phone is asked to delete its copy, and doesn't upload it again.
        try await host.deleteOnlyPhoto()
        let after = try await engine.run(connection)
        #expect(after.deletionRequests == 1)
        #expect(await store.deletionRequests().map(\.original.id) == [photo.id])
        // You delete it on the phone; the next run tells the host.
        try await store.decide(items: ["A"], .trashed)
        source.remove(photo.id)
        _ = try await engine.run(connection)
        #expect(await store.record(photo.id)?.reported == true)
        #expect(await store.deletionRequests().isEmpty)
    }

    @Test func aRunThatIsStoppedGoesOnWhereItStopped() async throws {
        let host = try await TestHost.start()
        defer { host.stop() }
        let dir = try TestHost.temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let connection = try await HostAPI.pair(host.payload, name: "iPhone test")
        let source = FileSource()
        let video = Original(id: "B/video", item: "B", filename: "IMG_0002.MOV", signature: "v1", takenAt: nil)
        let size = 8_000_000
        try source.add(video, bytes: photoBytes(7, padding: size), in: dir)
        let store = try BackupStore(file: dir.appendingPathComponent("queue.sqlite"))
        // Small chunks, and stopped partway, as iPhone ends a background task: the location and
        // how far it got are saved.
        let engine = BackupEngine(store: store, source: source, chunkSize: 16 * 1024, finder: { [] })
        let run = Task { try await engine.run(connection) }
        #expect(try await eventually { (await store.record(video.id)?.offset ?? 0) > 0 })
        run.cancel()
        _ = await run.result
        let partway = try #require(await store.record(video.id))
        #expect(partway.state == .uploading)
        let location = try #require(partway.uploadURL)
        let total = try #require(partway.size)
        #expect(partway.offset > 0 && partway.offset < total)
        // The next run goes on from the host's offset, and the host gets it all.
        let api = try HostAPI(connection)
        let there = try #require(try await api.offset(location, expectedSize: total))
        #expect(there >= partway.offset)
        let bigger = BackupEngine(store: store, source: source, chunkSize: 1024 * 1024, finder: { [] })
        _ = try await bigger.run(connection)
        let done = try #require(await store.record(video.id))
        #expect(done.received)
        #expect(done.uploadURL == nil)
    }

    @Test func aRunPastItsDeadlineLeavesTheRestForLater() async throws {
        let host = try await TestHost.start()
        defer { host.stop() }
        let dir = try TestHost.temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let connection = try await HostAPI.pair(host.payload, name: "iPhone test")
        let source = FileSource()
        let photo = Original(id: "C/photo", item: "C", filename: "IMG_0003.PNG", signature: "v1", takenAt: nil)
        try source.add(photo, bytes: photoBytes(9), in: dir)
        let store = try BackupStore(file: dir.appendingPathComponent("queue.sqlite"))
        let engine = BackupEngine(store: store, source: source, finder: { [] })
        let late = try await engine.run(connection, until: .distantPast)
        #expect(late.more)
        #expect(await store.record(photo.id)?.state == .pending)
        _ = try await engine.run(connection)
        #expect(await store.record(photo.id)?.received == true)
    }
}
