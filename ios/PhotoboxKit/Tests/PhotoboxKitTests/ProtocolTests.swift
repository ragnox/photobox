import Foundation
import Testing
@testable import PhotoboxKit

// Rules that need no host: addresses, upload locations, timestamps, receipts.

@Test func onlyPlainHTTPSHostAddressesPair() throws {
    #expect(try serverURL("https://192.0.2.10:4568/").absoluteString == "https://192.0.2.10:4568/")
    #expect(try serverURL("https://192.0.2.10:4568").absoluteString == "https://192.0.2.10:4568/")
    for bad in ["http://192.0.2.10:4568/", "https://user:pw@192.0.2.10/", "https://192.0.2.10/photos", "https://192.0.2.10/?a=1", "https://192.0.2.10/#x", "nonsense"] {
        #expect(throws: PhotoboxError.self, "\(bad)") { try serverURL(bad) }
    }
}

@Test func uploadLocationsStayOnThePairedHostAndEndpoint() throws {
    let trust = try TestHost.anyTrust()
    let api = try HostAPI(base: serverURL("https://192.0.2.10:4568/"), trust: trust, token: "t")
    let id = String(repeating: "a", count: 32)
    #expect(try api.uploadURL("/api/uploads/\(id)").absoluteString == "https://192.0.2.10:4568/api/uploads/\(id)")
    for bad in ["https://198.51.100.7:4568/api/uploads/\(id)", "https://192.0.2.10:4569/api/uploads/\(id)",
                "http://192.0.2.10:4568/api/uploads/\(id)", "/api/uploads/\(id)?x=1", "/api/uploads/\(id)#x",
                "/api/media/1", "/api/uploads/ABC", "/api/uploads/\(id)/../../pair", "https://u@192.0.2.10:4568/api/uploads/\(id)"] {
        #expect(throws: PhotoboxError.self, "\(bad)") { try api.uploadURL(bad) }
    }
}

@Test func anUploadBegunAtTheHostsEarlierAddressGoesOnAtItsNewOne() {
    let id = String(repeating: "b", count: 32)
    #expect(movedUpload("https://192.0.2.10:4568/api/uploads/\(id)", to: "https://198.51.100.7:4568/") == "https://198.51.100.7:4568/api/uploads/\(id)")
    // Anything else stays as it was, for uploadURL to refuse.
    for other in ["https://192.0.2.10:4568/api/pair", "https://192.0.2.10:4568/api/uploads/\(id)?x=1", "not a url"] {
        #expect(movedUpload(other, to: "https://198.51.100.7:4568/") == other)
    }
}

@Test func announcedHostsAreTriedAtTheirIPv4Addresses() {
    #expect(hostURLs(["192.0.2.10", "192.0.2.11%en0", "fe80::1", "host.local"], port: 4568) == ["https://192.0.2.10:4568/", "https://192.0.2.11:4568/"])
    #expect(hostURLs(["192.0.2.10"], port: 0).isEmpty)
}

@Test func captureTimesHaveMillisecondsAndAnOffsetTheHostAccepts() throws {
    let date = Date(timeIntervalSince1970: 1_717_243_387.25)
    #expect(capturedAt(date, in: TimeZone(identifier: "Europe/Vienna")!) == "2024-06-01T14:03:07.250+02:00")
    #expect(capturedAt(date, in: TimeZone(identifier: "UTC")!) == "2024-06-01T12:03:07.250Z")
}

@Test func receiptsFromAHostBeforeDeletingCountAsNotDeleted() throws {
    let old = try JSONDecoder().decode(Receipt.self, from: Data(#"{"sha256":"\#(String(repeating: "c", count: 64))","received":true,"indexed":true,"exported":true}"#.utf8))
    #expect(old.verified && !old.deleted)
    #expect(!Receipt(sha256: old.sha256, received: true, indexed: true, exported: false).verified)
    #expect(!Receipt(sha256: old.sha256, received: true, indexed: true, exported: true, deleted: true).verified)
}

@Test func theQueueSurvivesAndTreatsNewVersionsAsNewPhotos() async throws {
    let dir = try TestHost.temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: dir) }
    let file = dir.appendingPathComponent("queue.sqlite")
    let photo = Original(id: "A/photo", item: "A", filename: "IMG_1.HEIC", signature: "v1", takenAt: Date(timeIntervalSince1970: 1))
    do {
        let store = try BackupStore(file: file)
        try await store.discover([photo])
        var record = try #require(await store.record(photo.id))
        record.sha256 = String(repeating: "d", count: 64)
        record.state = .verified
        record.connection = "pairing-1"
        try await store.save(record)
        try await store.sawDeletions("pairing-1", upTo: 7)
    }
    let store = try BackupStore(file: file)
    #expect(await store.record(photo.id)?.state == .verified)
    #expect(try await store.deletionsSeen("pairing-1") == 7)
    #expect(try await store.deletionsSeen("pairing-2") == 0)
    // The same signature changes nothing; another one is a photo of its own.
    try await store.discover([photo])
    #expect(await store.record(photo.id)?.state == .verified)
    try await store.discover([Original(id: photo.id, item: "A", filename: "IMG_1.HEIC", signature: "v2", takenAt: photo.takenAt)])
    #expect(await store.record(photo.id)?.state == .pending)
    #expect(await store.record(photo.id)?.sha256 == nil)
    // Progress made for another pairing counts for nothing with a new one.
    var again = try #require(await store.record(photo.id))
    again.state = .verified
    again.connection = "pairing-1"
    try await store.save(again)
    try await store.activate("pairing-2")
    #expect(await store.record(photo.id)?.state == .pending)
    #expect(await store.record(photo.id)?.connection == "pairing-2")
}
