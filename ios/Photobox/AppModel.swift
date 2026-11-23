import Foundation
import Observation
import Photos
import PhotoboxKit
import UIKit
import UserNotifications

/// Photos deleted in Photobox, as one library item each (a Live Photo's still and video together).
struct DeletionRequest: Identifiable, Hashable {
    let id: String // the library item
    let filenames: [String]
    let takenAt: Date?
}

/// What the app shows and does: the paired computer, backup runs and their state.
@MainActor @Observable
final class AppModel {
    static let shared = AppModel()

    private(set) var connection: Connection?
    private(set) var running = false
    private(set) var status = ""
    private(set) var progress: (done: Int, total: Int)?
    private(set) var problem: String?
    private(set) var counts: [BackupState: Int] = [:]
    private(set) var deletions: [DeletionRequest] = []
    private(set) var access = PhotoLibrary.access
    private(set) var lastSuccess: Date? = UserDefaults.standard.object(forKey: "lastSuccess") as? Date

    var paused: Bool = UserDefaults.standard.bool(forKey: "paused") {
        didSet {
            UserDefaults.standard.set(paused, forKey: "paused")
            if paused { stop() } else { backUpNow() }
        }
    }

    var screenshots: Bool = UserDefaults.standard.object(forKey: "screenshots") as? Bool ?? true {
        didSet {
            UserDefaults.standard.set(screenshots, forKey: "screenshots")
            library = PhotoLibrary(screenshots: screenshots)
            Task { await refresh() }
        }
    }

    private var library: PhotoLibrary
    private let store: BackupStore
    private var run: Task<Bool, Never>?
    private var chosen: Set<String> = []
    private var rechecks = 0

    private static var queueFile: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("backup-queue.sqlite")
    }

    private init() {
        #if DEBUG
        // UI tests start unpaired, with an empty queue (launch argument `-PhotoboxReset YES`).
        if UserDefaults.standard.bool(forKey: "PhotoboxReset") {
            Keychain.delete()
            for suffix in ["", "-wal", "-shm"] { try? FileManager.default.removeItem(atPath: Self.queueFile.path + suffix) }
            for key in ["paused", "screenshots", "lastSuccess"] { UserDefaults.standard.removeObject(forKey: key) }
            paused = false
            screenshots = true
            lastSuccess = nil
        }
        #endif
        connection = Keychain.load()
        library = PhotoLibrary(screenshots: UserDefaults.standard.object(forKey: "screenshots") as? Bool ?? true)
        try? FileManager.default.createDirectory(at: Self.queueFile.deletingLastPathComponent(), withIntermediateDirectories: true)
        do {
            store = try BackupStore(file: Self.queueFile)
        } catch {
            fatalError("Photobox couldn't open its backup queue: \(error.localizedDescription)")
        }
        library.tidy()
        Task { await refresh() }
    }

    // MARK: Pairing

    func pair(_ text: String, name: String) async throws {
        let payload = try PairingPayload.decode(text)
        let paired = try await HostAPI.pair(payload, name: name)
        try Keychain.save(paired)
        connection = paired
        problem = nil
        // Quietly, without asking: notifications about photos deleted in Photobox.
        _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.provisional, .alert, .badge])
        backUpNow()
    }

    /// Forgets the computer here. Disconnect the phone on the computer too, to revoke its token.
    func forget() async {
        stop()
        Keychain.delete()
        Background.cancel()
        try? await store.clear()
        connection = nil
        problem = nil
        status = ""
        lastSuccess = nil
        UserDefaults.standard.removeObject(forKey: "lastSuccess")
        await refresh()
    }

    // MARK: Photo access

    func askForAccess() async {
        access = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
        backUpNow()
    }

    func noteAccess() {
        access = PhotoLibrary.access
    }

    // MARK: Backup runs

    func backUpNow() {
        guard run == nil, connection != nil, !paused, PhotoLibrary.canRead else { return }
        run = Task { await backUp(until: .distantFuture) }
        Background.schedule()
    }

    func stop() {
        run?.cancel()
    }

    /// A run iPhone gave time for in the background. True when nothing was left over.
    func runInBackground(until deadline: Date) async -> Bool {
        if let run { return await run.value } // already running, since the app was opened
        guard connection != nil, !paused, PhotoLibrary.canRead else { return true }
        let task = Task { await backUp(until: deadline) }
        run = task
        return await withTaskCancellationHandler { await task.value } onCancel: { task.cancel() }
    }

    private func backUp(until deadline: Date) async -> Bool {
        guard let paired = connection else { return true }
        running = true
        problem = nil
        // Finish the chunk under way if you leave the app meanwhile.
        let background = UIApplication.shared.beginBackgroundTask(withName: "Photobox backup") { [weak self] in self?.stop() }
        defer {
            running = false
            progress = nil
            run = nil
            UIApplication.shared.endBackgroundTask(background)
        }
        let engine = BackupEngine(store: store, source: library)
        do {
            let report = try await engine.run(paired, until: deadline) { update in
                Task { @MainActor in
                    self.status = update.text
                    self.progress = update.total > 0 ? (update.done, update.total) : nil
                }
            }
            if report.connection != paired, report.connection.id == connection?.id {
                try? Keychain.save(report.connection) // the computer has another address now
                connection = report.connection
            }
            problem = report.problem
            chosen = report.chosen
            await refresh()
            // Everything is backed up once the computer filed it all, not when it was sent.
            if !report.more && report.problem == nil && toBackUp == 0 && waitingForComputer == 0 {
                lastSuccess = Date()
                UserDefaults.standard.set(lastSuccess, forKey: "lastSuccess")
            }
            if report.deletionRequests > 0 { notifyDeletions() }
            recheckSoon()
            return !report.more
        } catch is CancellationError {
            status = "Stopped"
        } catch let error as HostError {
            problem = error.message
        } catch let error as URLError where error.code == .cancelled && Task.isCancelled {
            status = "Stopped"
        } catch let error as URLError {
            problem = "Can't reach Photobox on your computer (\(error.localizedDescription))"
        } catch {
            problem = error.localizedDescription
        }
        await refresh()
        return false
    }

    /// The computer files new photos within moments of receiving them: while the app is open, look
    /// again shortly, a few times.
    private func recheckSoon() {
        guard waitingForComputer > 0, rechecks < 6, UIApplication.shared.applicationState == .active else {
            rechecks = 0
            return
        }
        rechecks += 1
        Task {
            try? await Task.sleep(for: .seconds(5))
            backUpNow()
        }
    }

    /// The counts and the deletions waiting for you, from the queue.
    func refresh() async {
        access = PhotoLibrary.access
        if PhotoLibrary.canRead, !running, let originals = try? await library.originals() { chosen = Set(originals.map(\.id)) }
        counts = await store.summary(among: chosen)
        let waiting = await store.deletionRequests()
        deletions = Dictionary(grouping: waiting, by: \.original.item).map { item, records in
            DeletionRequest(id: item, filenames: records.map(\.original.filename).sorted(), takenAt: records.first?.original.takenAt)
        }.sorted { ($0.takenAt ?? .distantPast) > ($1.takenAt ?? .distantPast) }
        try? await UNUserNotificationCenter.current().setBadgeCount(deletions.count)
    }

    // MARK: Photos deleted in Photobox

    /// Deletes them from this phone after iPhone asks you; they go to Recently Deleted.
    func delete(_ requests: [DeletionRequest]) async {
        do {
            let items = Set(requests.map(\.id))
            guard try await PhotoLibrary.delete(items) else { return } // you said no: they keep waiting
            try await store.decide(items: items, .trashed)
            await refresh()
            backUpNow() // tells the computer
        } catch {
            problem = "Couldn't delete: \(error.localizedDescription)"
        }
    }

    func keep(_ requests: [DeletionRequest]) async {
        try? await store.decide(items: Set(requests.map(\.id)), .kept)
        await refresh()
        backUpNow()
    }

    private func notifyDeletions() {
        let content = UNMutableNotificationContent()
        let count = deletions.count
        content.title = count == 1 ? "A photo was deleted in Photobox" : "\(count) photos were deleted in Photobox"
        content.body = "Open Photobox to delete \(count == 1 ? "it" : "them") from this iPhone too."
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "deletions", content: content, trigger: nil))
    }

    // MARK: Showing it

    var backedUp: Int { counts[.verified] ?? 0 }
    var waitingForComputer: Int { counts[.awaitingHost] ?? 0 }
    var toBackUp: Int { (counts[.pending] ?? 0) + (counts[.uploading] ?? 0) + (counts[.failed] ?? 0) }
    var notBackedUp: Int { (counts[.blocked] ?? 0) + (counts[.unavailable] ?? 0) }

    func problems() async -> [BackupRecord] {
        await store.records.values.filter { [.blocked, .unavailable, .failed].contains($0.state) && chosen.contains($0.original.id) }
            .sorted { $0.original.filename < $1.original.filename }
    }
}
