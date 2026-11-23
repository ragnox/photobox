import XCTest

/// The app in the simulator against a throwaway Photobox host (see ios/test-ui.sh, which starts
/// one and passes its pairing data and local address): pairing, a backup, and a photo deleted in
/// Photobox that you then delete from the phone. It deletes a photo from the simulator's library.
final class BackupUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    func testPairBackUpAndDeleteWhatWasDeletedInPhotobox() throws {
        let env = ProcessInfo.processInfo.environment
        let pairing = try XCTUnwrap(env["PHOTOBOX_PAIRING"], "run through ios/test-ui.sh")
        let host = try XCTUnwrap(env["PHOTOBOX_LOCAL"].flatMap(URL.init(string:)))
        let app = XCUIApplication()
        app.launchArguments = ["-PhotoboxReset", "YES"]
        app.launch()

        // Pair by pasting the pairing data, as without a camera.
        XCTAssert(app.staticTexts["Back up your photos to your computer"].waitForExistence(timeout: 10))
        keep(app, "1-pair")
        UIPasteboard.general.string = pairing
        let paste = app.buttons.matching(NSPredicate(format: "identifier == 'paste-pairing' OR label == 'Paste'")).firstMatch
        if !paste.waitForExistence(timeout: 3) { app.swipeUp() }
        XCTAssert(paste.waitForExistence(timeout: 5), app.debugDescription)
        paste.tap()

        // Photos access, if the simulator didn't have it granted already.
        let allow = app.buttons["Allow access to your photos"]
        if allow.waitForExistence(timeout: 5) {
            allow.tap()
            let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
            let full = springboard.alerts.buttons["Allow Full Access"]
            if full.waitForExistence(timeout: 10) { full.tap() }
        }

        // Everything is backed up once the computer has filed it.
        XCTAssert(app.staticTexts["All your photos are backed up"].waitForExistence(timeout: 90), app.debugDescription)
        keep(app, "2-backed-up")
        let photos = try timeline(host)
        XCTAssertGreaterThanOrEqual(photos.count, 4, "the 3 test photos and the video, and the simulator's own")

        // Deleted in Photobox on the computer: the phone learns of it and offers to delete it too.
        try delete(photos[0], on: host)
        app.buttons["back-up-now"].tap()
        let deleted = app.buttons["deleted-in-photobox"]
        XCTAssert(deleted.waitForExistence(timeout: 30), app.debugDescription)
        keep(app, "3-deleted-in-photobox")
        deleted.tap()
        XCTAssert(app.buttons["delete-all"].waitForExistence(timeout: 5))
        keep(app, "4-delete-from-iphone")
        app.buttons["delete-all"].tap()
        // iPhone asks first.
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let confirm = [app.alerts.buttons["Delete"], springboard.alerts.buttons["Delete"]]
        let deadline = Date().addingTimeInterval(15)
        while Date() < deadline, !confirm.contains(where: \.exists) { Thread.sleep(forTimeInterval: 0.3) }
        try XCTUnwrap(confirm.first(where: \.exists), "iPhone's delete confirmation").tap()

        // The phone tells the computer, which shows it on its Deleted list.
        XCTAssert(app.staticTexts["All your photos are backed up"].waitForExistence(timeout: 30), app.debugDescription)
        let end = Date().addingTimeInterval(30)
        var states: [String] = []
        while Date() < end {
            states = try deletedOnPhones(host)
            if states.contains("trashed") { break }
            Thread.sleep(forTimeInterval: 1)
        }
        XCTAssertEqual(states, ["trashed"])
    }

    /// A screenshot kept with the test results, to look at.
    private func keep(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }

    // MARK: The host's local API (no token needed on the computer itself)

    private func get(_ url: URL, method: String = "GET") throws -> Data {
        var request = URLRequest(url: url)
        request.httpMethod = method
        if method == "DELETE" {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = Data("{}".utf8)
        }
        var result: Result<Data, Error> = .failure(URLError(.timedOut))
        let done = expectation(description: url.path)
        URLSession.shared.dataTask(with: request) { data, response, error in
            if let error { result = .failure(error) }
            else if let code = (response as? HTTPURLResponse)?.statusCode, code != 200 { result = .failure(URLError(.badServerResponse, userInfo: ["status": code])) }
            else { result = .success(data ?? Data()) }
            done.fulfill()
        }.resume()
        wait(for: [done], timeout: 20)
        return try result.get()
    }

    /// The ids of the photos in the host's timeline.
    private func timeline(_ host: URL) throws -> [Int] {
        let text = String(decoding: try get(host.appendingPathComponent("api/timeline")), as: UTF8.self)
        return text.matches(of: /"id":(\d+)/).compactMap { Int($0.1) }
    }

    private func delete(_ id: Int, on host: URL) throws {
        _ = try get(host.appendingPathComponent("api/media/\(id)"), method: "DELETE")
    }

    /// What phones did with the photos on the host's Deleted list.
    private func deletedOnPhones(_ host: URL) throws -> [String] {
        let list = try JSONSerialization.jsonObject(with: get(host.appendingPathComponent("api/deletions"))) as? [[String: Any]] ?? []
        return list.flatMap { photo in
            (photo["contents"] as? [[String: Any]] ?? [photo]).flatMap { ($0["devices"] as? [[String: Any]] ?? []).compactMap { $0["state"] as? String } }
        }
    }
}
