import CryptoKit
import Foundation

/// The phone's photos and videos, as the backup engine reads them. On iPhone that is PhotoKit
/// (see the app's PhotoLibrary.swift); tests give it files.
public protocol MediaSource: Sendable {
    /// The originals chosen for backup, as they are now.
    func originals() async throws -> [Original]
    /// This original as it is now; nil when it's gone from the library.
    func current(_ original: Original) async -> Original?
    /// The original's bytes as a file to read. It stays until `discard`.
    func file(for original: Original) async throws -> URL
    func discard(_ original: Original) async
}

/// What one backup run did.
public struct RunReport: Sendable {
    /// Where the paired host answered: save it when it moved.
    public var connection: Connection
    public var uploaded = 0
    public var verified = 0
    /// Newly deleted in Photobox: waiting for you to delete them from this phone too.
    public var deletionRequests = 0
    /// Something is left for the next run (time ran out, or something can be retried).
    public var more = false
    /// The last thing that went wrong with an original, if any.
    public var problem: String?
    /// The originals chosen for backup when the run looked, by id: what the counts are about.
    public var chosen: Set<String> = []
}

/// What a run is doing now, for the app to show.
public struct RunProgress: Sendable {
    public let text: String
    public let done: Int
    public let total: Int
}

struct SourceChanged: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

/// Backs up originals over the paired host's tus API, the way Photobox for Android does: hash
/// the original, ask the host whether it has it already, upload what's missing in resumable
/// chunks (the location saved before the first byte), then keep the host's receipt. An original
/// counts as backed up only once the host received, indexed and exported it.
public final class BackupEngine: Sendable {
    public let store: BackupStore
    let source: MediaSource
    let finder: @Sendable () async -> [String]
    let chunkSize: Int

    public init(store: BackupStore, source: MediaSource, chunkSize: Int = 4 * 1024 * 1024,
                finder: @escaping @Sendable () async -> [String] = { await HostFinder.find() }) {
        self.store = store
        self.source = source
        self.chunkSize = chunkSize
        self.finder = finder
    }

    /// One backup run, until everything is done or `deadline`. Cancelling the task stops it
    /// between chunks; whatever was sent is found again with the host's offset next time.
    public func run(_ paired: Connection, until deadline: Date = .distantFuture,
                    progress: @escaping @Sendable (RunProgress) -> Void = { _ in }) async throws -> RunReport {
        progress(RunProgress(text: "Looking for Photobox on your computer", done: 0, total: 0))
        let reached = try await reach(paired, elsewhere: finder)
        let connection = reached.connection
        let api = reached.api
        var report = RunReport(connection: connection)
        try await store.activate(connection.id)

        progress(RunProgress(text: "Looking through your photos", done: 0, total: 0))
        let originals = try await source.originals()
        try await store.discover(originals)
        let chosen = Set(originals.map(\.id))
        report.chosen = chosen

        // Before anything is uploaded: a photo deleted in Photobox is deleted here, not backed up again.
        report.deletionRequests = try await syncDeletions(api, connection: connection.id)
        report.verified += try await refreshReceipts(api, among: chosen)

        let queue = await store.pending(among: chosen)
        for (index, initial) in queue.enumerated() {
            try Task.checkCancellation()
            if Date() >= deadline { report.more = true; break }
            guard var record = await store.record(initial.original.id), [.pending, .uploading, .failed].contains(record.state) else { continue }
            record.lastAttempt = Date()
            record.connection = connection.id
            try await store.save(record)
            progress(RunProgress(text: "Backing up \(record.original.filename)", done: index, total: queue.count))
            do {
                let ext = "." + (record.original.filename.split(separator: ".").last.map { $0.lowercased() } ?? "")
                guard reached.capabilities.extensions.contains(ext) else {
                    record.state = .blocked
                    record.error = "Photobox on your computer doesn't take \(ext) files"
                    try await store.save(record)
                    continue
                }
                switch try await backUp(record, api: api, capabilities: reached.capabilities, connection: connection, deadline: deadline) {
                case .verified: report.uploaded += 1; report.verified += 1
                case .received: report.uploaded += 1
                case .unfinished: report.more = true
                case .deletionRequested: report.deletionRequests += 1
                case .done: break
                }
            } catch is CancellationError {
                throw CancellationError()
            } catch let changed as SourceChanged {
                if let current = await store.record(record.original.id) { await cancelPartial(api, current) }
                if let latest = await source.current(record.original), latest.signature != record.original.signature {
                    try await store.discover([latest])
                    report.more = true
                } else {
                    var latest = await store.record(record.original.id) ?? record
                    latest.state = .unavailable
                    latest.error = changed.message
                    try await store.save(latest)
                }
            } catch let error as HostError {
                var latest = await store.record(record.original.id) ?? record
                latest.state = error.retryable ? .failed : .blocked
                latest.error = error.message
                try await store.save(latest)
                report.problem = error.message
                if error.status == 401 { throw error }
                report.more = report.more || error.retryable
            } catch let error as URLError {
                // The host went away mid-run (off the Wi-Fi, say): the next run goes on.
                var latest = await store.record(record.original.id) ?? record
                latest.state = .failed
                latest.error = error.localizedDescription
                try await store.save(latest)
                throw error
            } catch {
                var latest = await store.record(record.original.id) ?? record
                latest.state = .failed
                latest.error = error.localizedDescription
                try await store.save(latest)
                report.problem = error.localizedDescription
                report.more = true
            }
        }
        progress(RunProgress(text: "Backed up", done: queue.count, total: queue.count))
        return report
    }

    enum Outcome { case verified, received, unfinished, deletionRequested, done }

    private func backUp(_ initial: BackupRecord, api: HostAPI, capabilities: Capabilities, connection: Connection, deadline: Date) async throws -> Outcome {
        var record = initial
        // Begun when the computer had another address: go on with it where the computer is now.
        if let url = record.uploadURL { record.uploadURL = movedUpload(url, to: connection.server) }
        // A lost final response is reconciled before another upload is created.
        if let hash = record.sha256 {
            let receipt = try await api.check([hash])[0]
            try await requireCurrent(record)
            if receipt.deleted { return try await requestDeletion(api, record) }
            if receipt.received { return try await keep(receipt, for: record) }
        }
        let file = try await source.file(for: record.original)
        let (size, hash) = try digest(file)
        try await requireCurrent(record)
        guard size > 0 else { throw SourceChanged(message: "The original is empty") }
        if size > capabilities.maxFileBytes {
            record.state = .blocked
            record.error = "This file is bigger than Photobox on your computer takes"
            try await store.save(record)
            await source.discard(record.original)
            return .done
        }
        if record.sha256 != hash || record.size != size {
            await cancelPartial(api, record)
            record.sha256 = hash
            record.size = size
            record.uploadURL = nil
            record.offset = 0
        }
        try await store.save(record)
        let existing = try await api.check([hash])[0]
        if existing.deleted { try await requireCurrent(record); return try await requestDeletion(api, record) }
        if existing.received { try await requireCurrent(record); return try await keep(existing, for: record) }

        var offset = try await record.uploadURL.asyncMap { try await api.offset($0, expectedSize: size) } ?? nil
        // A complete offset without a receipt can mean lost or damaged bytes on the host. A received
        // original can't be changed, so repair it with a new upload.
        if offset == nil || offset == size {
            if let receipt = await cancelPartial(api, record) { return try await keep(receipt, for: record) }
            let location: String
            do {
                location = try await api.create(filename: record.original.filename, size: size, sha256: hash,
                                                capturedAt: record.original.takenAt.map { capturedAt($0) }, mediaID: record.original.id)
            } catch let error as HostError where error.status == 410 {
                return try await requestDeletion(api, record)
            }
            record.uploadURL = location
            record.offset = 0
            record.state = .uploading
            record.error = nil
            try await store.save(record) // the location, before the first byte
            offset = 0
        }
        guard let location = record.uploadURL, var sent = offset else { throw PhotoboxError("No upload to go on with") }

        let handle = try FileHandle(forReadingFrom: file)
        defer { try? handle.close() }
        var repairs = 0
        while sent < size {
            try Task.checkCancellation()
            if Date() >= deadline {
                record.offset = sent
                try await store.save(record)
                return .unfinished
            }
            try handle.seek(toOffset: UInt64(sent))
            let bytes = try handle.read(upToCount: min(chunkSize, Int(size - sent))) ?? Data()
            if bytes.isEmpty { throw SourceChanged(message: "The original ended during the upload") }
            do {
                sent = try await api.chunk(location, offset: sent, bytes: bytes)
            } catch let error where repairs < 3 && Self.lostAcknowledgement(error) {
                // The chunk may or may not have arrived: go on from where the host is.
                repairs += 1
                guard let now = try await api.offset(location, expectedSize: size) else { throw error }
                sent = now
                continue
            }
            record.offset = sent
            record.state = .uploading
            try await store.save(record)
        }
        try await requireCurrent(record)
        let receipt = try await api.check([hash])[0]
        return try await keep(receipt, for: record)
    }

    static func lostAcknowledgement(_ error: Error) -> Bool {
        if let error = error as? URLError { return [.networkConnectionLost, .timedOut].contains(error.code) }
        if let error = error as? HostError { return error.status == 409 }
        return false
    }

    /// Batches of receipt checks for originals the host has but hadn't exported yet.
    private func refreshReceipts(_ api: HostAPI, among chosen: Set<String>) async throws -> Int {
        let waiting = await store.awaitingHost(among: chosen)
        var verified = 0
        for start in stride(from: 0, to: waiting.count, by: 100) {
            let batch = Array(waiting[start..<min(start + 100, waiting.count)])
            let receipts = try await api.check(batch.compactMap(\.sha256))
            for (record, receipt) in zip(batch, receipts) {
                if receipt.deleted { _ = try await store.requestDeletion(receipt.sha256); continue }
                var latest = await store.record(record.original.id) ?? record
                if !receipt.received { latest.restart() } // gone from the host: back it up again
                else { apply(receipt, to: &latest) }
                if latest.state == .verified { verified += 1 }
                try await store.save(latest)
            }
        }
        return verified
    }

    /// Learns what was deleted in Photobox since the last run, and tells the host what became of
    /// this phone's copies. Returns how many copies here newly wait for you to delete them.
    private func syncDeletions(_ api: HostAPI, connection: String) async throws -> Int {
        var requested = 0
        do {
            var seen = try await store.deletionsSeen(connection)
            while true {
                let page = try await api.deletions(after: seen)
                for change in page.deletions {
                    if change.deleted { requested += try await store.requestDeletion(change.sha256) }
                    else { try await store.cancelDeletion(change.sha256) }
                    seen = change.seq
                }
                try await store.sawDeletions(connection, upTo: seen)
                if !page.more || page.deletions.isEmpty { break }
            }
        } catch let error as HostError where error.status == 404 {
            return 0 // A host from before deleting: there's nothing to learn.
        }
        // Gone from this phone another way (deleted in Photos): nothing left to ask about.
        var gone = Set<String>()
        for record in await store.deletionRequests() where await source.current(record.original) == nil { gone.insert(record.original.item) }
        if !gone.isEmpty { try await store.decide(items: gone, .trashed) }
        let decided = await store.unreportedDeletions()
        for start in stride(from: 0, to: decided.count, by: 500) {
            let batch = Array(decided[start..<min(start + 500, decided.count)])
            try await api.reportDeletions(batch.map { DeletionOutcome(sha256: $0.sha256!, state: $0.state == .trashed ? "trashed" : "kept") })
            try await store.markReported(batch.map(\.original.id))
        }
        return requested
    }

    /// Deleted in Photobox: not backed up, but waiting for you to delete it here too.
    private func requestDeletion(_ api: HostAPI, _ record: BackupRecord) async throws -> Outcome {
        await cancelPartial(api, record)
        var latest = record
        latest.restart()
        latest.state = .deleteRequested
        try await store.save(latest)
        await source.discard(record.original)
        return .deletionRequested
    }

    private func keep(_ receipt: Receipt, for record: BackupRecord) async throws -> Outcome {
        var latest = record
        apply(receipt, to: &latest)
        try await store.save(latest)
        if receipt.received { await source.discard(record.original) }
        return receipt.verified ? .verified : receipt.received ? .received : .unfinished
    }

    private func apply(_ receipt: Receipt, to record: inout BackupRecord) {
        record.received = receipt.received
        record.indexed = receipt.indexed
        record.exported = receipt.exported
        record.error = nil
        record.state = receipt.verified ? .verified : receipt.received ? .awaitingHost : .pending
        record.verifiedAt = receipt.verified ? Date() : nil
        if receipt.received { record.uploadURL = nil }
    }

    /// Drops an unfinished upload, unless the host verifies it has the bytes after all.
    @discardableResult
    private func cancelPartial(_ api: HostAPI, _ record: BackupRecord) async -> Receipt? {
        guard let location = record.uploadURL, let hash = record.sha256 else { return nil }
        do {
            let receipt = try await api.check([hash])[0]
            if receipt.received { return receipt }
            try await api.cancelPartial(location)
        } catch {
            // Offline cleanup of an orphan must not hold up a new version.
        }
        return nil
    }

    private func requireCurrent(_ record: BackupRecord) async throws {
        try Task.checkCancellation()
        guard await source.current(record.original)?.signature == record.original.signature else {
            throw SourceChanged(message: "The original changed or is gone from the library")
        }
    }
}

/// The file's size and SHA-256, read in pieces.
func digest(_ file: URL) throws -> (Int64, String) {
    let handle = try FileHandle(forReadingFrom: file)
    defer { try? handle.close() }
    var hasher = SHA256()
    var size: Int64 = 0
    while let piece = try handle.read(upToCount: 4 * 1024 * 1024), !piece.isEmpty {
        hasher.update(data: piece)
        size += Int64(piece.count)
    }
    return (size, hasher.finalize().map { String(format: "%02x", $0) }.joined())
}

/// When it was taken, in this phone's time zone, as the host wants it: milliseconds and an
/// offset with a colon, such as `2024-06-01T14:03:07.250+02:00`.
func capturedAt(_ date: Date, in zone: TimeZone = .current) -> String {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.calendar = Calendar(identifier: .gregorian)
    formatter.timeZone = zone
    formatter.dateFormat = "yyyy-MM-dd'T'HH:mm:ss.SSSXXXXX"
    return formatter.string(from: date)
}

extension Optional {
    func asyncMap<T>(_ transform: (Wrapped) async throws -> T) async rethrows -> T? {
        switch self {
        case .some(let value): try await transform(value)
        case .none: nil
        }
    }
}
