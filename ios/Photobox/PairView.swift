import SwiftUI

/// Connecting to Photobox on the computer: scan its code, or paste the pairing data.
struct PairView: View {
    @Environment(AppModel.self) private var model
    @State private var name = "iPhone"
    @State private var scanning = false
    @State private var pairing = false
    @State private var problem: String?

    var body: some View {
        Form {
            Section {
                VStack(alignment: .leading, spacing: 12) {
                    Image("Mark")
                        .resizable()
                        .frame(width: 64, height: 64)
                        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                        .accessibilityHidden(true)
                    Text("Back up your photos to your computer")
                        .font(.title2.bold())
                    Text("Photobox copies the original files of your photos and videos to Photobox on your computer, over your Wi-Fi.")
                        .foregroundStyle(.secondary)
                }
                .padding(.vertical, 8)
            }

            Section {
                Label("On your computer, open Photobox and choose **Connect a phone**.", systemImage: "1.circle")
                Label("Choose **Photobox for iPhone**.", systemImage: "2.circle")
                Label("Scan the code with this iPhone.", systemImage: "3.circle")
            } header: {
                Text("Connect")
            }

            Section {
                TextField("This phone's name", text: $name)
                    .textInputAutocapitalization(.words)
                    .accessibilityIdentifier("phone-name")
            } header: {
                Text("Name")
            } footer: {
                Text("Photobox on your computer shows this phone by this name.")
            }

            Section {
                Button {
                    scanning = true
                } label: {
                    Label("Scan the code", systemImage: "qrcode.viewfinder")
                }
                .disabled(pairing)
                PasteButton(payloadType: String.self) { strings in
                    guard let text = strings.first else { return }
                    Task { await pair(text) }
                }
                .disabled(pairing)
                .accessibilityIdentifier("paste-pairing")
            } footer: {
                Text("No camera at hand? On the computer, open **Copy pairing data**, copy it, and paste it here.")
            }

            if pairing {
                Section { ProgressView("Connecting…") }
            }
            if let problem {
                Section {
                    Text(problem).foregroundStyle(.red)
                }
            }
        }
        .navigationTitle("Photobox")
        .sheet(isPresented: $scanning) {
            ScannerView { text in
                scanning = false
                Task { await pair(text) }
            }
            .ignoresSafeArea()
        }
    }

    private func pair(_ text: String) async {
        pairing = true
        problem = nil
        defer { pairing = false }
        do {
            try await model.pair(text, name: name)
        } catch {
            problem = error.localizedDescription
        }
    }
}
