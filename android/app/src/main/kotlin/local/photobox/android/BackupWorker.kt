package local.photobox.android

import android.app.NotificationChannel
import android.app.ActivityManager
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.SystemClock
import androidx.core.app.NotificationCompat
import androidx.work.CoroutineWorker
import androidx.work.ForegroundInfo
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import java.io.IOException
import java.security.MessageDigest
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import local.photobox.api.*

class BackupWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    private val graph get() = (applicationContext as PhotoboxApplication).graph
    private val dao get() = graph.database.assets()
    private var name = "Preparing backup"
    private var deadline = Long.MAX_VALUE
    private var foregroundActive = false

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        graph.backupMutex.withLock {
            val connection = graph.connections.connection.value ?: return@withLock Result.success()
            if (graph.settings.settings.value.paused) return@withLock Result.success()
            deadline = SystemClock.elapsedRealtime() + 9 * 60_000
            graph.settings.update { it.copy(lastRun = System.currentTimeMillis(), error = null) }
            try {
                require(graph.catalog.access().any) { "Grant photo/video access before backing up" }
                val process = ActivityManager.RunningAppProcessInfo()
                ActivityManager.getMyMemoryState(process)
                foregroundActive = promoteWhenVisible(process.importance <= ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND) {
                    setForeground(foreground())
                }
                dao.activate(connection.id)
                val api = HostApi(connection)
                val capabilities = api.capabilities()
                val folders = graph.catalog.scan { found ->
                    ensureAllowed(connection.id)
                    if (found.folder in graph.settings.settings.value.folders) dao.discover(found)
                }
                graph.settings.update { it.copy(knownFolders = folders) }
                var retry = false
                val assets = dao.pending(graph.settings.settings.value.folders.toList(), connection.id)
                for (stored in assets) {
                    ensureAllowed(connection.id, stored.folder)
                    if (SystemClock.elapsedRealtime() >= deadline) { retry = true; break }
                    dao.claim(stored.id, connection.id)
                    val asset = dao.get(stored.id) ?: continue
                    name = "Backing up ${asset.filename}"
                    if (foregroundActive) setForeground(foreground())
                    try {
                        requireCurrent(asset)
                        val extension = ".${asset.filename.substringAfterLast('.', "").lowercase()}"
                        if (extension !in capabilities.extensions || asset.size > capabilities.maxFileBytes) {
                            save(asset.copy(state = AssetState.BLOCKED, error = "Host does not support this format or file size"), connection.id)
                            continue
                        }
                        val result = backUp(asset, connection, api)
                        if (!result.verified) retry = true
                    } catch (e: CancellationException) { throw e }
                    catch (e: SourceChanged) {
                        dao.get(asset.id)?.let { cancelPartial(api, it) }
                        val latest = graph.catalog.find(asset)
                        if (latest != null && latest.signature != asset.signature) dao.discover(latest)
                        else save(asset.copy(state = AssetState.UNAVAILABLE, error = e.message), connection.id)
                        retry = retry || latest != null
                    } catch (e: SecurityException) {
                        save(asset.copy(state = AssetState.BLOCKED, error = "Grant photo/video and photo-location permissions to read the original bytes"), connection.id)
                        graph.settings.update { it.copy(error = "Photo access changed; grant permissions and tap Back up now") }
                        return@withLock Result.success()
                    } catch (e: Exception) {
                        val latest = dao.get(asset.id) ?: asset
                        val blocked = e is HostException && !e.retryable
                        save(latest.copy(state = if (blocked) AssetState.BLOCKED else AssetState.ERROR, error = e.message ?: "Backup interrupted"), connection.id)
                        graph.settings.update { it.copy(error = e.message ?: "Backup interrupted") }
                        if (e is HostException && e.status == 401) return@withLock Result.success()
                        retry = retry || !blocked
                    }
                }
                retry = retry || dao.pending(graph.settings.settings.value.folders.toList(), connection.id, 1).isNotEmpty()
                if (!retry && dao.unverified(graph.settings.settings.value.folders.toList()) == 0L) {
                    graph.settings.update { it.copy(lastSuccess = System.currentTimeMillis()) }
                }
                if (retry) Result.retry() else Result.success()
            } catch (e: CancellationException) { throw e }
            catch (e: Exception) {
                graph.settings.update { it.copy(error = e.message ?: "Backup could not run") }
                if (e is SecurityException || e is IllegalArgumentException || (e is HostException && !e.retryable)) Result.success()
                else Result.retry()
            }
        }
    }

    private suspend fun backUp(initial: Asset, connection: Connection, api: HostApi): Receipt {
        var asset = initial
        // A lost final response is reconciled before another upload is created.
        if (asset.sha256 != null) {
            val receipt = api.check(listOf(asset.sha256!!)).single()
            ensureAllowed(connection.id, asset.folder)
            requireCurrent(asset)
            if (receipt.received) { saveReceipt(asset, connection.id, receipt); return receipt }
        }
        val digest = MessageDigest.getInstance("SHA-256")
        var size = 0L
        graph.catalog.openOriginal(asset).use { input ->
            while (true) {
                ensureAllowed(connection.id, asset.folder)
                val chunk = readChunk(input, CHUNK_SIZE)
                if (chunk.isEmpty()) break
                digest.update(chunk); size += chunk.size
            }
        }
        requireCurrent(asset)
        if (size != asset.size) throw SourceChanged("Original size changed; waiting for MediaStore to settle")
        val hash = digest.digest().joinToString("") { "%02x".format(it.toInt() and 255) }
        if (asset.sha256 != hash) {
            cancelPartial(api, asset)
            asset = asset.copy(sha256 = hash, uploadUrl = null, offset = 0)
        }
        save(asset, connection.id)
        val existing = api.check(listOf(hash)).single()
        if (existing.received) { requireCurrent(asset); saveReceipt(asset, connection.id, existing); return existing }
        var offset = asset.uploadUrl?.let { api.offset(it, asset.size) }
        // A complete tus offset without reception proof can represent lost/corrupt
        // host bytes. Received originals are immutable, so repair via a new session.
        if (offset == null || offset == asset.size) {
            cancelPartial(api, asset)?.let { receipt ->
                requireCurrent(asset)
                saveReceipt(asset, connection.id, receipt)
                return receipt
            }
            val capturedAt = asset.takenAt.takeIf { it > 0 }?.let {
                DateTimeFormatter.ofPattern("uuuu-MM-dd'T'HH:mm:ss.SSSXXX")
                    .format(Instant.ofEpochMilli(it).atZone(ZoneId.systemDefault()))
            }
            val location = api.create(asset.filename, asset.size, hash, capturedAt, asset.mediaKey.take(128))
            asset = asset.copy(uploadUrl = location, offset = 0, state = AssetState.UPLOADING, error = null)
            save(asset, connection.id) // Persist URL before the first PATCH.
            offset = 0
        }
        graph.catalog.openOriginal(asset).use { input ->
            skipFully(input, offset!!)
            while (offset!! < asset.size) {
                ensureAllowed(connection.id, asset.folder)
                if (SystemClock.elapsedRealtime() >= deadline) {
                    save(asset.copy(state = AssetState.UPLOADING, offset = offset!!), connection.id)
                    return Receipt(hash, false, false, false)
                }
                val bytes = readChunk(input, minOf(CHUNK_SIZE.toLong(), asset.size - offset!!).toInt())
                if (bytes.isEmpty()) throw SourceChanged("Original ended during upload")
                offset = api.chunk(asset.uploadUrl!!, offset!!, bytes)
                asset = asset.copy(offset = offset!!, state = AssetState.UPLOADING, error = null)
                save(asset, connection.id)
            }
        }
        ensureAllowed(connection.id, asset.folder)
        requireCurrent(asset)
        val receipt = api.check(listOf(hash)).single()
        saveReceipt(asset, connection.id, receipt)
        return receipt
    }

    private suspend fun cancelPartial(api: HostApi, asset: Asset): Receipt? {
        val location = asset.uploadUrl ?: return null
        val hash = asset.sha256 ?: return null
        try {
            // A lost final response can leave complete original bytes in staging.
            // Let the host verify/publish those before considering termination.
            val receipt = api.check(listOf(hash)).single()
            if (receipt.received) return receipt
            api.cancelPartial(location)
        }
        catch (e: CancellationException) { throw e }
        catch (_: Exception) { /* Offline orphan cleanup must not block a new content version. */ }
        return null
    }

    private suspend fun requireCurrent(asset: Asset) {
        currentCoroutineContext().ensureActive()
        if (graph.catalog.find(asset)?.signature != asset.signature) throw SourceChanged("Original changed or became unavailable")
    }

    private suspend fun ensureAllowed(connection: String, folder: String? = null) {
        currentCoroutineContext().ensureActive()
        val settings = graph.settings.settings.value
        if (isStopped || settings.paused || graph.connections.connection.value?.id != connection ||
            (folder != null && folder !in settings.folders)) throw CancellationException("Backup paused or connection changed")
    }

    private suspend fun save(asset: Asset, connection: String) {
        if (dao.progress(asset.id, connection, asset.state, asset.sha256, asset.uploadUrl, asset.offset, asset.error, asset.verifiedAt, asset.received, asset.indexed, asset.exported) != 1) {
            throw CancellationException("The asset version or paired host changed")
        }
    }

    private suspend fun saveReceipt(asset: Asset, connection: String, receipt: Receipt) {
        ensureAllowed(connection, asset.folder)
        save(asset.copy(state = if (receipt.verified) AssetState.VERIFIED else AssetState.AWAITING_HOST,
            received = receipt.received, indexed = receipt.indexed, exported = receipt.exported,
            error = null, verifiedAt = if (receipt.verified) System.currentTimeMillis() else null), connection)
    }

    override suspend fun getForegroundInfo(): ForegroundInfo = foreground()
    private fun foreground(): ForegroundInfo {
        val manager = applicationContext.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(CHANNEL, "Photo backup", NotificationManager.IMPORTANCE_LOW))
        val open = PendingIntent.getActivity(applicationContext, 0, Intent(applicationContext, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val notification = NotificationCompat.Builder(applicationContext, CHANNEL).setSmallIcon(R.drawable.ic_photobox)
            .setContentTitle("Photobox backup").setContentText(name).setContentIntent(open).setOngoing(true)
            .addAction(0, "Stop this run", WorkManager.getInstance(applicationContext).createCancelPendingIntent(id)).build()
        return ForegroundInfo(1001, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    }
    private class SourceChanged(message: String) : IOException(message)
    companion object { private const val CHANNEL = "backup"; private const val CHUNK_SIZE = 2 * 1024 * 1024 }
}
