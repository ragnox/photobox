import SwiftUI

@main
struct PhotoboxApp: App {
    @State private var model = AppModel.shared
    @Environment(\.scenePhase) private var phase

    init() {
        Background.register()
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environment(model)
                .tint(Color.accentColor)
        }
        .onChange(of: phase) { _, phase in
            switch phase {
            case .active:
                model.noteAccess()
                model.backUpNow()
            case .background:
                Background.schedule()
            default:
                break
            }
        }
    }
}

struct ContentView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        NavigationStack {
            if model.connection == nil {
                PairView()
            } else {
                BackupView()
            }
        }
    }
}
