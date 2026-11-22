import CryptoKit
import Foundation
import Photos
import PhotoboxKit

/// The phone's Photos library as the backup engine reads it: each item's original still or video,
/// as it was taken (edits in Photos are kept apart from it), and a Live Photo's video too.
final class PhotoLibrary: MediaSource, @unchecked Sendable {
    let screenshots: Bool
    private let exports: URL
    private let catalogFile: URL
    private let catalog = Catalog()

    init(screenshots: Bool) {
        self.screenshots = screenshots
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        exports = caches.appendingPathComponent("Originals", isDirectory: true)
        catalogFile = caches.appendingPathComponent("library-catalog.json")
        try? FileManager.default.createDirectory(at: exports, withIntermediateDirectories: true)
    }

    static var access: PHAuthorizationStatus { PHPhotoLibrary.authorizationStatus(for: .readWrite) }
    static var canRead: Bool { access == .authorized || access == .limited }

    func originals() async throws -> [Original] {
        guard Self.canRead else { throw PhotoboxError("Allow Photobox to read your photos first") }
        let options = PHFetchOptions()
        options.includeHiddenAssets = true
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)] // newest first
        let assets = PHAsset.fetchAssets(with: options)
        // Reading an item's files takes a while, so what was read is kept until the item changes.
        await catalog.load(from: catalogFile)
        var originals: [Original] = []
        var seen = Set<String>()
        for index in 0..<assets.count {
            let asset = assets.object(at: index)
            if !screenshots && asset.mediaSubtypes.contains(.photoScreenshot) { continue }
            seen.insert(asset.localIdentifier)
            if let known = await catalog.originals(of: asset) {
                originals += known
            } else {
                let read = Self.originals(of: asset)
                await catalog.set(read, for: asset)
                originals += read
            }
            if index % 500 == 499 { try Task.checkCancellation() }
        }
        await catalog.keep(only: seen)
        await catalog.save(to: catalogFile)
        return originals
    }

    func current(_ original: Original) async -> Original? {
        guard let asset = PHAsset.fetchAssets(withLocalIdentifiers: [original.item], options: nil).firstObject else { return nil }
        return Self.originals(of: asset).first { $0.id == original.id }
    }

    func file(for original: Original) async throws -> URL {
        guard let asset = PHAsset.fetchAssets(withLocalIdentifiers: [original.item], options: nil).firstObject,
              let resource = Self.resource(original.id, of: asset)
        else { throw PhotoboxError("It's gone from your Photos library") }
        let file = exportFile(original)
        if FileManager.default.fileExists(atPath: file.path) { return file } // from an earlier run
        let partial = file.appendingPathExtension("partial")
        try? FileManager.default.removeItem(at: partial)
        let options = PHAssetResourceRequestOptions()
        options.isNetworkAccessAllowed = true // the original may be in iCloud only
        try await PHAssetResourceManager.default().writeData(for: resource, toFile: partial, options: options)
        try FileManager.default.moveItem(at: partial, to: file)
        return file
    }

    func discard(_ original: Original) async {
        try? FileManager.default.removeItem(at: exportFile(original))
    }

    /// Exports left behind by runs that stopped, a week on.
    func tidy() {
        let old = Date().addingTimeInterval(-7 * 86_400)
        let files = (try? FileManager.default.contentsOfDirectory(at: exports, includingPropertiesForKeys: [.contentModificationDateKey])) ?? []
        for file in files where ((try? file.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast) < old {
            try? FileManager.default.removeItem(at: file)
        }
    }

    /// One file per version of an original, so an export of an older version is never reused.
    private func exportFile(_ original: Original) -> URL {
        let name = SHA256.hash(data: Data("\(original.id)\n\(original.signature)".utf8)).prefix(16).map { String(format: "%02x", $0) }.joined()
        let ext = (original.filename as NSString).pathExtension
        return exports.appendingPathComponent(ext.isEmpty ? name : "\(name).\(ext)")
    }

    // MARK: PhotoKit

    /// The original still or video and, for a Live Photo, its original video.
    static func originals(of asset: PHAsset) -> [Original] {
        let resources = PHAssetResource.assetResources(for: asset)
        return [("original", main(resources)), ("live", resources.first { $0.type == .pairedVideo })].compactMap { role, resource in
            guard let resource else { return nil }
            return Original(id: "\(asset.localIdentifier)#\(role)", item: asset.localIdentifier, filename: resource.originalFilename,
                            signature: "\(resource.originalFilename)|\(resource.uniformTypeIdentifier)|\(asset.creationDate?.timeIntervalSince1970 ?? 0)",
                            takenAt: asset.creationDate)
        }
    }

    static func resource(_ id: String, of asset: PHAsset) -> PHAssetResource? {
        let resources = PHAssetResource.assetResources(for: asset)
        return id.hasSuffix("#live") ? resources.first { $0.type == .pairedVideo } : main(resources)
    }

    private static func main(_ resources: [PHAssetResource]) -> PHAssetResource? {
        resources.first { $0.type == .photo } ?? resources.first { $0.type == .video }
            ?? resources.first { $0.type == .alternatePhoto } ?? resources.first { $0.type == .audio }
    }

    /// Deletes these items from the phone; iPhone asks you first, and they go to Recently Deleted.
    /// False when you said no.
    static func delete(_ items: Set<String>) async throws -> Bool {
        let assets = PHAsset.fetchAssets(withLocalIdentifiers: Array(items), options: nil)
        guard assets.count > 0 else { return true } // gone already
        do {
            try await PHPhotoLibrary.shared().performChanges { PHAssetChangeRequest.deleteAssets(assets) }
            return true
        } catch let error as PHPhotosError where error.code == .userCancelled {
            return false
        } catch let error as NSError where error.domain == "PHPhotosErrorDomain" && error.code == 3072 {
            return false
        }
    }
}

/// What each library item's files were, while the item is unchanged.
private actor Catalog {
    struct Entry: Codable {
        let modified: Date?
        let originals: [Original]
    }

    private var entries: [String: Entry] = [:]
    private var loaded = false
    private var changed = false

    func load(from file: URL) {
        guard !loaded else { return }
        loaded = true
        if let data = try? Data(contentsOf: file), let saved = try? JSONDecoder().decode([String: Entry].self, from: data) { entries = saved }
    }

    func originals(of asset: PHAsset) -> [Original]? {
        guard let entry = entries[asset.localIdentifier], entry.modified == asset.modificationDate else { return nil }
        return entry.originals
    }

    func set(_ originals: [Original], for asset: PHAsset) {
        entries[asset.localIdentifier] = Entry(modified: asset.modificationDate, originals: originals)
        changed = true
    }

    func keep(only items: Set<String>) {
        let before = entries.count
        entries = entries.filter { items.contains($0.key) }
        changed = changed || entries.count != before
    }

    func save(to file: URL) {
        guard changed, let data = try? JSONEncoder().encode(entries) else { return }
        try? data.write(to: file, options: .atomic)
        changed = false
    }
}
