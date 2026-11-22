import Photos
import PhotosUI
import PhotoboxKit
import SwiftUI

/// The paired phone: how far the backup is, what needs you, and the settings.
struct BackupView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openURL) private var openURL
    @State private var confirmForget = false
    @State private var problems: [BackupRecord] = []

    var body: some View {
        @Bindable var model = model
        List {
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    Text(headline).font(.headline).accessibilityIdentifier("headline")
                    if let progress = model.progress, progress.total > 0 {
                        ProgressView(value: Double(progress.done), total: Double(progress.total))
                        Text("\(progress.done) of \(progress.total)").font(.caption).foregroundStyle(.secondary)
                    }
                    if let problem = model.problem {
                        Text(problem).font(.callout).foregroundStyle(.red).accessibilityIdentifier("problem")
                    }
                    if let last = model.lastSuccess {
                        Text("Everything was backed up \(last.formatted(.relative(presentation: .named)))")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
                .padding(.vertical, 4)
                if model.running {
                    Button("Stop", role: .destructive) { model.stop() }
                } else {
                    Button("Back up now") { model.backUpNow() }
                        .disabled(model.paused || !PhotoLibrary.canRead)
                        .accessibilityIdentifier("back-up-now")
                }
            }

            if !PhotoLibrary.canRead {
                Section {
                    if model.access == .notDetermined {
                        Button("Allow access to your photos") { Task { await model.askForAccess() } }
                    } else {
                        Text("Photobox may not read your photos. Allow it in Settings › Photobox › Photos: **Full Access**.")
                        Button("Open Settings") { openURL(URL(string: UIApplication.openSettingsURLString)!) }
                    }
                } header: {
                    Text("Photos")
                }
            } else if model.access == .limited {
                Section {
                    Text("Photobox backs up only the photos you chose for it. Choose **Full Access** in Settings to back up all of them.")
                    Button("Open Settings") { openURL(URL(string: UIApplication.openSettingsURLString)!) }
                } header: {
                    Text("Photos")
                }
            }

            if !model.deletions.isEmpty {
                Section {
                    NavigationLink {
                        DeletedView()
                    } label: {
                        Label(model.deletions.count == 1 ? "1 photo was deleted in Photobox" : "\(model.deletions.count) photos were deleted in Photobox",
                              systemImage: "trash")
                    }
                    .accessibilityIdentifier("deleted-in-photobox")
                } footer: {
                    Text("They aren't backed up any more. Delete them from this iPhone too, or keep them.")
                }
            }

            Section {
                row("Backed up", model.backedUp, "checkmark.circle")
                row("Waiting for your computer", model.waitingForComputer, "hourglass")
                row("Still to back up", model.toBackUp, "arrow.up.circle")
                if model.notBackedUp > 0 {
                    NavigationLink {
                        ProblemsView(records: problems)
                    } label: {
                        row("Can't be backed up", model.notBackedUp, "exclamationmark.triangle")
                    }
                }
            } header: {
                Text("Your photos and videos")
            } footer: {
                Text("A photo counts as backed up once Photobox on your computer has filed it in your library's folder.")
            }

            Section {
                Toggle("Screenshots", isOn: $model.screenshots)
                Toggle("Pause backup", isOn: $model.paused)
            } header: {
                Text("Back up")
            } footer: {
                Text("Photobox backs up when you open it, and in the background when iPhone lets it: often at night, while charging.")
            }

            if let connection = model.connection {
                Section {
                    LabeledContent("Computer", value: URL(string: connection.server)?.host() ?? connection.server)
                    LabeledContent("This phone", value: connection.deviceName)
                    Button("Disconnect from this computer", role: .destructive) { confirmForget = true }
                } header: {
                    Text("Connected")
                } footer: {
                    Text("When your computer gets another address on the Wi-Fi, Photobox finds it again by itself.")
                }
            }
        }
        .navigationTitle("Photobox")
        .refreshable { model.backUpNow() }
        .task(id: model.counts) { problems = await model.problems() }
        .confirmationDialog("Disconnect from this computer?", isPresented: $confirmForget, titleVisibility: .visible) {
            Button("Disconnect", role: .destructive) { Task { await model.forget() } }
        } message: {
            Text("Backups stop. To back up again, connect again. Disconnect this phone on the computer too.")
        }
    }

    private var headline: String {
        if model.running { return model.status.isEmpty ? "Backing up…" : model.status }
        if model.paused { return "Backup is paused" }
        if !PhotoLibrary.canRead { return "Photobox needs access to your photos" }
        if model.toBackUp == 0 && model.waitingForComputer == 0 && model.backedUp > 0 { return "All your photos are backed up" }
        if model.toBackUp > 0 { return "\(model.toBackUp) to back up" }
        if model.waitingForComputer > 0 { return "Waiting for your computer to file \(model.waitingForComputer)" }
        return model.status.isEmpty ? "Ready" : model.status
    }

    private func row(_ title: String, _ count: Int, _ symbol: String) -> some View {
        LabeledContent {
            Text(count, format: .number).monospacedDigit()
        } label: {
            Label(title, systemImage: symbol)
        }
    }
}

/// Originals that won't go, and why.
struct ProblemsView: View {
    let records: [BackupRecord]

    var body: some View {
        List(records, id: \.original.id) { record in
            VStack(alignment: .leading) {
                Text(record.original.filename)
                Text(record.error ?? "Not backed up").font(.caption).foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Can't be backed up")
    }
}

/// Photos deleted in Photobox on the computer: delete them here too, or keep them.
struct DeletedView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        List {
            Section {
                ForEach(model.deletions) { request in
                    HStack(spacing: 12) {
                        Thumbnail(item: request.id)
                        VStack(alignment: .leading) {
                            Text(request.filenames.joined(separator: ", ")).lineLimit(2)
                            if let taken = request.takenAt {
                                Text(taken.formatted(date: .abbreviated, time: .shortened)).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                    .swipeActions {
                        Button("Delete", role: .destructive) { Task { await model.delete([request]) } }
                        Button("Keep") { Task { await model.keep([request]) } }
                    }
                }
            } footer: {
                Text("Deleting moves them to Recently Deleted in Photos. Photobox on your computer shows what you did.")
            }
            Section {
                Button("Delete \(model.deletions.count == 1 ? "it" : "all \(model.deletions.count)") from this iPhone", role: .destructive) {
                    Task { await model.delete(model.deletions) }
                }
                .accessibilityIdentifier("delete-all")
                Button("Keep \(model.deletions.count == 1 ? "it" : "them all")") {
                    Task { await model.keep(model.deletions) }
                }
            }
        }
        .navigationTitle("Deleted in Photobox")
        .onChange(of: model.deletions.isEmpty) { _, empty in if empty { dismiss() } }
    }
}

/// A library item's picture, small.
struct Thumbnail: View {
    let item: String
    @State private var image: UIImage?

    var body: some View {
        ZStack {
            Rectangle().fill(.quaternary)
            if let image { Image(uiImage: image).resizable().scaledToFill() }
        }
        .frame(width: 56, height: 56)
        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
        .task(id: item) {
            guard let asset = PHAsset.fetchAssets(withLocalIdentifiers: [item], options: nil).firstObject else { return }
            let options = PHImageRequestOptions()
            options.deliveryMode = .opportunistic
            options.isNetworkAccessAllowed = true
            PHImageManager.default().requestImage(for: asset, targetSize: CGSize(width: 168, height: 168), contentMode: .aspectFill, options: options) { picture, _ in
                if let picture { image = picture }
            }
        }
    }
}
