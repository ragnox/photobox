package local.photobox.android

import androidx.room.*
import java.util.UUID
import kotlinx.coroutines.flow.Flow

object AssetState {
    const val NEW = "NEW"
    const val UPLOADING = "UPLOADING"
    const val AWAITING_HOST = "AWAITING_HOST"
    const val VERIFIED = "VERIFIED"
    const val ERROR = "ERROR"
    const val BLOCKED = "BLOCKED"
    const val UNAVAILABLE = "UNAVAILABLE"
    // Deleted in Photobox: waiting for the user to confirm deleting it here, then moved to the phone's trash or kept.
    const val DELETE_REQUESTED = "DELETE_REQUESTED"
    const val TRASHED = "TRASHED"
    const val KEPT = "KEPT"
}

@Entity(indices = [Index("mediaKey"), Index(value = ["current", "state"])] )
data class Asset(
    @PrimaryKey val id: String = UUID.randomUUID().toString(),
    val mediaKey: String, val uri: String, val filename: String, val folder: String,
    val size: Long, val modified: Long, val generation: Long, val takenAt: Long,
    val current: Boolean = true,
    val connectionId: String? = null, val sha256: String? = null,
    val uploadUrl: String? = null, val offset: Long = 0,
    val state: String = AssetState.NEW, val error: String? = null,
    val received: Boolean = false, val indexed: Boolean = false, val exported: Boolean = false,
    val attemptedAt: Long = 0,
    val verifiedAt: Long? = null, val discoveredAt: Long = System.currentTimeMillis(),
    // The host has been told what became of this copy of a photo deleted there.
    @ColumnInfo(defaultValue = "0") val deletionReported: Boolean = false,
) {
    @get:Ignore val signature: String get() = listOf(uri, filename, folder, size, modified, generation, takenAt).joinToString("\u0000")
}

@Entity data class HostSession(@PrimaryKey val singleton: Int = 1, val connectionId: String)
data class StateCount(val state: String, val count: Long)

@Dao
abstract class AssetDao {
    @Query("SELECT * FROM Asset WHERE mediaKey = :key AND current = 1 ORDER BY discoveredAt DESC LIMIT 1")
    abstract suspend fun current(key: String): Asset?

    @Query("SELECT * FROM Asset WHERE id = :id") abstract suspend fun get(id: String): Asset?
    @Insert abstract suspend fun insert(asset: Asset)
    @Query("UPDATE Asset SET current = 0 WHERE mediaKey = :key") abstract suspend fun retire(key: String)

    @Transaction
    open suspend fun discover(asset: Asset): Asset {
        val old = current(asset.mediaKey)
        if (old?.signature == asset.signature) {
            if (old.state == AssetState.UNAVAILABLE) retryUnavailable(old.id)
            return get(old.id)!!
        }
        retire(asset.mediaKey)
        insert(asset)
        return asset
    }

    @Query("UPDATE Asset SET state = 'NEW', error = NULL, attemptedAt = 0 WHERE id = :id AND state = 'UNAVAILABLE'")
    abstract suspend fun retryUnavailable(id: String)

    @Query("SELECT connectionId FROM HostSession WHERE singleton = 1") abstract suspend fun session(): String?
    @Insert(onConflict = OnConflictStrategy.REPLACE) abstract suspend fun putSession(value: HostSession)
    // A copy already moved to the phone's trash stays that way.
    @Query("UPDATE Asset SET connectionId = :connection, state = 'NEW', uploadUrl = NULL, offset = 0, verifiedAt = NULL, error = NULL, received = 0, indexed = 0, exported = 0, attemptedAt = 0 WHERE current = 1 AND state != 'TRASHED'")
    abstract suspend fun resetRows(connection: String)

    @Transaction
    open suspend fun activate(connection: String) {
        if (session() != connection) { putSession(HostSession(connectionId = connection)); resetRows(connection) }
    }

    @Query("""UPDATE Asset SET connectionId = :connection, state = 'NEW', uploadUrl = NULL, offset = 0, verifiedAt = NULL, error = NULL, received = 0, indexed = 0, exported = 0
        WHERE id = :id AND current = 1 AND state != 'TRASHED' AND (connectionId IS NULL OR connectionId != :connection)
        AND :connection = (SELECT connectionId FROM HostSession WHERE singleton = 1)""")
    abstract suspend fun claim(id: String, connection: String): Int

    // A disconnected/replaced worker cannot overwrite a new connection's state.
    @Query("""UPDATE Asset SET state = :state, sha256 = :hash, uploadUrl = :url, offset = :offset, error = :error, verifiedAt = :verifiedAt, received = :received, indexed = :indexed, exported = :exported, attemptedAt = :attemptedAt
        WHERE id = :id AND current = 1 AND connectionId = :connection
        AND :connection = (SELECT connectionId FROM HostSession WHERE singleton = 1)""")
    abstract suspend fun progress(id: String, connection: String, state: String, hash: String?, url: String?, offset: Long, error: String?, verifiedAt: Long?, received: Boolean, indexed: Boolean, exported: Boolean, attemptedAt: Long = System.currentTimeMillis()): Int

    @Query("""SELECT * FROM Asset WHERE current = 1 AND folder IN (:folders) AND state != 'TRASHED'
        AND (connectionId IS NULL OR connectionId != :connection OR state IN ('NEW', 'UPLOADING', 'AWAITING_HOST', 'ERROR'))
        ORDER BY attemptedAt, discoveredAt, id LIMIT :limit""")
    abstract suspend fun pending(folders: List<String>, connection: String, limit: Int = 100): List<Asset>

    @Query("SELECT count(*) FROM Asset WHERE current = 1 AND folder IN (:folders) AND state NOT IN ('VERIFIED', 'DELETE_REQUESTED', 'TRASHED', 'KEPT')")
    abstract suspend fun unverified(folders: List<String>): Long

    @Query("SELECT * FROM Asset WHERE current = 1 ORDER BY discoveredAt DESC LIMIT 200") abstract fun observe(): Flow<List<Asset>>
    @Query("SELECT state, count(*) AS count FROM Asset WHERE current = 1 GROUP BY state") abstract fun counts(): Flow<List<StateCount>>
    @Query("UPDATE Asset SET state = 'NEW', error = NULL, attemptedAt = 0 WHERE current = 1 AND state IN ('ERROR', 'BLOCKED')") abstract suspend fun retryErrors()

    // --- photos deleted in Photobox ---------------------------------------

    /** The host deleted this content: its copies here wait for the user to delete them too. Returns how many. */
    @Query("""UPDATE Asset SET state = 'DELETE_REQUESTED', error = NULL, deletionReported = 0
        WHERE current = 1 AND sha256 = :hash AND state NOT IN ('DELETE_REQUESTED', 'TRASHED', 'KEPT')""")
    abstract suspend fun requestDeletion(hash: String): Int

    /** Cleared from the host's Deleted list: a copy still here is backed up again, from scratch. */
    @Query("""UPDATE Asset SET state = 'NEW', uploadUrl = NULL, offset = 0, verifiedAt = NULL, error = NULL, received = 0, indexed = 0, exported = 0,
        attemptedAt = 0, deletionReported = 0 WHERE current = 1 AND sha256 = :hash AND state IN ('DELETE_REQUESTED', 'KEPT')""")
    abstract suspend fun cancelDeletion(hash: String): Int

    @Query("SELECT * FROM Asset WHERE current = 1 AND state = 'DELETE_REQUESTED' ORDER BY takenAt DESC")
    abstract suspend fun deletionRequests(): List<Asset>
    @Query("SELECT * FROM Asset WHERE current = 1 AND state = 'DELETE_REQUESTED' ORDER BY takenAt DESC")
    abstract fun observeDeletionRequests(): Flow<List<Asset>>

    /** The user deleted these here (TRASHED) or chose to keep them (KEPT). */
    @Query("UPDATE Asset SET state = :state, deletionReported = 0 WHERE id IN (:ids) AND state = 'DELETE_REQUESTED'")
    abstract suspend fun decideDeletion(ids: List<String>, state: String): Int

    @Query("SELECT * FROM Asset WHERE current = 1 AND state IN ('TRASHED', 'KEPT') AND deletionReported = 0 AND sha256 IS NOT NULL LIMIT 500")
    abstract suspend fun unreportedDeletions(): List<Asset>
    @Query("UPDATE Asset SET deletionReported = 1 WHERE id IN (:ids)") abstract suspend fun deletionsReported(ids: List<String>)
}

@Database(entities = [Asset::class, HostSession::class], version = 2, exportSchema = true, autoMigrations = [AutoMigration(from = 1, to = 2)])
abstract class BackupDatabase : RoomDatabase() { abstract fun assets(): AssetDao }
