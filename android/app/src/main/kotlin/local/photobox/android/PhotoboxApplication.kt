package local.photobox.android

import android.app.Application
import android.content.Context
import android.database.ContentObserver
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import androidx.room.Room
import androidx.work.*
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.sync.Mutex

class AppGraph(context: Context) {
    val database = Room.databaseBuilder(context, BackupDatabase::class.java, "backup.db").build()
    val connections = ConnectionStore(context)
    val settings = SettingsStore(context)
    val catalog = MediaCatalog(context)
    val finder = HostFinder(context)
    val backupMutex = Mutex()
    val scheduler = BackupScheduler(context, connections, settings)
}

class PhotoboxApplication : Application() {
    val graph by lazy { AppGraph(this) }
    private val handler = Handler(Looper.getMainLooper())
    private val reconcile = Runnable { graph.scheduler.now() }
    private var observingImages = false
    private var observingVideos = false
    private val observer = object : ContentObserver(handler) {
        override fun onChange(selfChange: Boolean) {
            handler.removeCallbacks(reconcile)
            handler.postDelayed(reconcile, 3_000)
        }
    }
    override fun onCreate() {
        super.onCreate()
        graph.scheduler.configure()
        observeMedia()
    }

    fun observeMedia() {
        val access = graph.catalog.access()
        // Observers only exist while this process is alive. Periodic reconciliation
        // handles changes made while the process was absent and after reboot.
        if (!observingImages && (access.images || access.limited)) {
            try {
                contentResolver.registerContentObserver(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, true, observer)
                observingImages = true
            } catch (_: SecurityException) { /* Periodic reconciliation remains available. */ }
        }
        if (!observingVideos && (access.videos || access.limited)) {
            try {
                contentResolver.registerContentObserver(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, true, observer)
                observingVideos = true
            } catch (_: SecurityException) { /* Permission may have changed before registration. */ }
        }
    }
}

class BackupScheduler(private val context: Context, private val connections: ConnectionStore, private val settings: SettingsStore) {
    private val work get() = WorkManager.getInstance(context)
    private fun constraints(): Constraints {
        val config = settings.settings.value
        return Constraints.Builder().setRequiredNetworkType(if (config.unmetered) NetworkType.UNMETERED else NetworkType.CONNECTED)
            .setRequiresBatteryNotLow(true).setRequiresCharging(config.charging).build()
    }
    fun stop() { work.cancelUniqueWork(PERIODIC); work.cancelUniqueWork(NOW) }
    fun configure(restart: Boolean = false) {
        if (settings.settings.value.paused || connections.connection.value == null) {
            stop()
            return
        }
        if (restart) work.cancelUniqueWork(NOW)
        work.enqueueUniquePeriodicWork(PERIODIC, if (restart) ExistingPeriodicWorkPolicy.CANCEL_AND_REENQUEUE else ExistingPeriodicWorkPolicy.UPDATE,
            PeriodicWorkRequestBuilder<BackupWorker>(15, TimeUnit.MINUTES).setConstraints(constraints())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build())
    }
    /** Opening the app: back up now. A run that is going on goes on; one waiting after failures waits no longer. */
    suspend fun soon() {
        val waiting = work.getWorkInfosForUniqueWorkFlow(NOW).first().any { it.state == WorkInfo.State.ENQUEUED && it.runAttemptCount > 0 }
        now(replace = waiting)
    }
    fun now(replace: Boolean = false) {
        if (settings.settings.value.paused || connections.connection.value == null) return
        work.enqueueUniqueWork(NOW, if (replace) ExistingWorkPolicy.REPLACE else ExistingWorkPolicy.KEEP,
            OneTimeWorkRequestBuilder<BackupWorker>().setConstraints(constraints())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build())
    }
    companion object { const val PERIODIC = "photobox.periodic"; const val NOW = "photobox.now" }
}
