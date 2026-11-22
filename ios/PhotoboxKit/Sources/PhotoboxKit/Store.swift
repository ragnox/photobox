import Foundation
import SQLite3

/// One original on the phone: a photo's or video's file, or the video of a Live Photo.
public struct Original: Codable, Hashable, Sendable {
    /// Stable for this file of this library item.
    public let id: String
    /// The library item it belongs to; deleting from the phone deletes the whole item.
    public let item: String
    public let filename: String
    /// Changes when the file may have other bytes: a new version, backed up anew.
    public let signature: String
    public let takenAt: Date?

    public init(id: String, item: String, filename: String, signature: String, takenAt: Date?) {
        self.id = id
        self.item = item
        self.filename = filename
        self.signature = signature
        self.takenAt = takenAt
    }
}

public enum BackupState: String, Codable, Sendable {
    case pending, uploading
    /// Received; Photobox on the computer hasn't indexed and exported it yet.
    case awaitingHost
    case verified
    /// Won't go as it is (an unsupported format, too big): not tried again by itself.
    case blocked
    case failed
    /// Couldn't be read from the library (gone, or changing while read).
    case unavailable
    /// Deleted in Photobox: waits for you to delete it from this phone too, or keep it.
    case deleteRequested
    case trashed, kept
}

public struct BackupRecord: Codable, Equatable, Sendable {
    public var original: Original
    public var state: BackupState = .pending
    public var size: Int64?
    public var sha256: String?
    public var uploadURL: String?
    public var offset: Int64 = 0
    public var error: String?
    public var received = false
    public var indexed = false
    public var exported = false
    public var verifiedAt: Date?
    public var lastAttempt: Date?
    /// The pairing this progress belongs to: receipts are per paired phone.
    public var connection: String?
    /// What became of a photo deleted in Photobox was told to the host.
    public var reported = false

    public init(original: Original) { self.original = original }

    mutating func restart() {
        state = .pending
        uploadURL = nil
        offset = 0
        received = false
        indexed = false
        exported = false
        verifiedAt = nil
        error = nil
        reported = false
    }
}

/// The backup queue: every original seen, and how far its backup got. Kept in SQLite, one row a
/// record, so saving progress stays cheap with a big library.
public actor BackupStore {
    private let db: Database
    public private(set) var records: [String: BackupRecord] = [:]

    public init(file: URL) throws {
        db = try Database(path: file.path)
        try db.exec("CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, body BLOB NOT NULL)")
        try db.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        let decoder = JSONDecoder()
        for (id, body) in try db.rows("SELECT id, body FROM records") {
            if let record = try? decoder.decode(BackupRecord.self, from: body) { records[id] = record }
        }
    }

    func save(_ record: BackupRecord) throws {
        records[record.original.id] = record
        try db.run("INSERT INTO records (id, body) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body",
                   record.original.id, try JSONEncoder().encode(record))
    }

    public func record(_ id: String) -> BackupRecord? { records[id] }

    /// Adds originals not seen before; one with another signature is a new version and starts over.
    func discover(_ originals: [Original]) throws {
        try db.transaction {
            for original in originals {
                if var known = records[original.id] {
                    if known.original.signature != original.signature {
                        try save(BackupRecord(original: original))
                    } else if known.original != original || known.state == .unavailable {
                        known.original = original
                        if known.state == .unavailable { known.state = .pending; known.error = nil }
                        try save(known)
                    }
                } else {
                    try save(BackupRecord(original: original))
                }
            }
        }
    }

    /// Progress made for another pairing counts for nothing with this one.
    func activate(_ connection: String) throws {
        try db.transaction {
            for var record in records.values where record.connection != connection {
                switch record.state {
                case .trashed, .kept: continue
                default:
                    record.restart()
                    record.connection = connection
                    try save(record)
                }
            }
        }
    }

    /// Originals to back up now, least recently tried first.
    func pending(among ids: Set<String>) -> [BackupRecord] {
        records.values
            .filter { ids.contains($0.original.id) && [.pending, .uploading, .failed].contains($0.state) }
            .sorted { ($0.lastAttempt ?? .distantPast, $0.original.id) < ($1.lastAttempt ?? .distantPast, $1.original.id) }
    }

    func awaitingHost(among ids: Set<String>) -> [BackupRecord] {
        records.values.filter { ids.contains($0.original.id) && $0.state == .awaitingHost && $0.sha256 != nil }
    }

    /// A deletion in Photobox: copies with this content wait for you to delete them here. Returns how many newly do.
    func requestDeletion(_ sha256: String) throws -> Int {
        var count = 0
        for var record in records.values where record.sha256 == sha256 && ![.deleteRequested, .trashed, .kept].contains(record.state) {
            record.restart()
            record.state = .deleteRequested
            try save(record)
            count += 1
        }
        return count
    }

    /// Cleared from Photobox's Deleted list: a copy still here is backed up again.
    func cancelDeletion(_ sha256: String) throws {
        for var record in records.values where record.sha256 == sha256 && [.deleteRequested, .kept].contains(record.state) {
            record.restart()
            try save(record)
        }
    }

    public func deletionRequests() -> [BackupRecord] {
        records.values.filter { $0.state == .deleteRequested }.sorted { ($0.original.takenAt ?? .distantPast) > ($1.original.takenAt ?? .distantPast) }
    }

    /// What you did with these library items' copies: `trashed` or `kept`.
    public func decide(items: Set<String>, _ state: BackupState) throws {
        precondition(state == .trashed || state == .kept)
        for var record in records.values where items.contains(record.original.item) && record.state == .deleteRequested {
            record.state = state
            record.reported = false
            try save(record)
        }
    }

    func unreportedDeletions() -> [BackupRecord] {
        records.values.filter { [.trashed, .kept].contains($0.state) && !$0.reported && $0.sha256 != nil }
    }

    func markReported(_ ids: [String]) throws {
        for id in ids {
            guard var record = records[id] else { continue }
            record.reported = true
            try save(record)
        }
    }

    func deletionsSeen(_ connection: String) throws -> Int64 {
        try db.rows("SELECT value, value FROM settings WHERE key = ?", "deletions:\(connection)").first
            .flatMap { Int64(String(decoding: $0.1, as: UTF8.self)) } ?? 0
    }

    func sawDeletions(_ connection: String, upTo seq: Int64) throws {
        try db.run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                   "deletions:\(connection)", Data(String(seq).utf8))
    }

    /// Counts by state, among the originals chosen for backup.
    public func summary(among ids: Set<String>) -> [BackupState: Int] {
        var counts: [BackupState: Int] = [:]
        for record in records.values where ids.contains(record.original.id) { counts[record.state, default: 0] += 1 }
        return counts
    }

    /// Forgets everything, for a phone that was disconnected from its computer.
    public func clear() throws {
        try db.exec("DELETE FROM records; DELETE FROM settings")
        records = [:]
    }
}

/// Just enough SQLite.
final class Database: @unchecked Sendable {
    private var handle: OpaquePointer?
    private static let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

    init(path: String) throws {
        guard sqlite3_open_v2(path, &handle, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK else {
            defer { sqlite3_close(handle) }
            throw PhotoboxError("Couldn't open the backup queue: \(String(cString: sqlite3_errmsg(handle)))")
        }
        try exec("PRAGMA journal_mode = WAL")
    }

    deinit { sqlite3_close(handle) }

    private func failure() -> PhotoboxError { PhotoboxError("Backup queue: \(String(cString: sqlite3_errmsg(handle)))") }

    func exec(_ sql: String) throws {
        guard sqlite3_exec(handle, sql, nil, nil, nil) == SQLITE_OK else { throw failure() }
    }

    func transaction(_ body: () throws -> Void) throws {
        try exec("BEGIN")
        do {
            try body()
            try exec("COMMIT")
        } catch {
            try? exec("ROLLBACK")
            throw error
        }
    }

    private func prepare(_ sql: String, _ values: [Any]) throws -> OpaquePointer? {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(handle, sql, -1, &statement, nil) == SQLITE_OK else { throw failure() }
        for (i, value) in values.enumerated() {
            let index = Int32(i + 1)
            switch value {
            case let text as String: sqlite3_bind_text(statement, index, text, -1, Self.transient)
            case let data as Data: _ = data.withUnsafeBytes { sqlite3_bind_blob(statement, index, $0.baseAddress, Int32(data.count), Self.transient) }
            default: preconditionFailure("Unsupported SQLite value")
            }
        }
        return statement
    }

    func run(_ sql: String, _ values: Any...) throws {
        let statement = try prepare(sql, values)
        defer { sqlite3_finalize(statement) }
        guard sqlite3_step(statement) == SQLITE_DONE else { throw failure() }
    }

    /// Rows of two columns: text, then blob.
    func rows(_ sql: String, _ values: Any...) throws -> [(String, Data)] {
        let statement = try prepare(sql, values)
        defer { sqlite3_finalize(statement) }
        var rows: [(String, Data)] = []
        while true {
            let step = sqlite3_step(statement)
            if step == SQLITE_DONE { break }
            guard step == SQLITE_ROW else { throw failure() }
            let key = sqlite3_column_text(statement, 0).map { String(cString: $0) } ?? ""
            let count = Int(sqlite3_column_bytes(statement, 1))
            let body = sqlite3_column_blob(statement, 1).map { Data(bytes: $0, count: count) } ?? Data()
            rows.append((key, body))
        }
        return rows
    }
}
