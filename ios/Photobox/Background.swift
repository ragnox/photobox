import BackgroundTasks
import Foundation

/// Backups when Photobox isn't open. iPhone decides when: a processing task gets minutes, often at
/// night while charging; an app refresh gets about half a minute, more often. Both pick up where
/// the last run stopped.
enum Background {
    static let backup = "local.photobox.ios.backup"
    static let refresh = "local.photobox.ios.refresh"

    /// Before the app finishes launching.
    static func register() {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: backup, using: nil) { task in
            run(task, for: 15 * 60)
        }
        BGTaskScheduler.shared.register(forTaskWithIdentifier: refresh, using: nil) { task in
            run(task, for: 20)
        }
    }

    private static func run(_ task: BGTask, for seconds: TimeInterval) {
        schedule()
        let work = Task { @MainActor in
            let done = await AppModel.shared.runInBackground(until: Date().addingTimeInterval(seconds))
            task.setTaskCompleted(success: done)
        }
        task.expirationHandler = { work.cancel() }
    }

    static func schedule() {
        let processing = BGProcessingTaskRequest(identifier: backup)
        processing.requiresNetworkConnectivity = true
        processing.requiresExternalPower = false
        processing.earliestBeginDate = Date().addingTimeInterval(15 * 60)
        try? BGTaskScheduler.shared.submit(processing)
        let quick = BGAppRefreshTaskRequest(identifier: refresh)
        quick.earliestBeginDate = Date().addingTimeInterval(30 * 60)
        try? BGTaskScheduler.shared.submit(quick)
    }

    static func cancel() {
        BGTaskScheduler.shared.cancelAllTaskRequests()
    }
}
