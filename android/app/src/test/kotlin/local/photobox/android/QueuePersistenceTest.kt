package local.photobox.android

import android.app.Application
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import android.database.sqlite.SQLiteDatabase
import java.io.File
import java.util.UUID
import kotlinx.serialization.json.*
import kotlin.test.*
import kotlinx.coroutines.runBlocking
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class)
class QueuePersistenceTest {
    private fun asset(generation: Long = 1, folder: String = "DCIM/Camera/") = Asset(
        mediaKey = "external_primary/images/42", uri = "content://media/external_primary/images/media/42",
        filename = "PXL.MP.jpg", folder = folder, size = 1_000, modified = 100, generation = generation, takenAt = 100_000,
    )

    @Test fun `reopening the database retains the resumable URL offset and full identity`() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Application>()
        val name = "queue-${UUID.randomUUID()}.db"
        var db = Room.databaseBuilder(context, BackupDatabase::class.java, name).build()
        val item = db.assets().discover(asset())
        db.assets().activate("first")
        assertEquals(1, db.assets().progress(item.id, "first", AssetState.UPLOADING, "a".repeat(64), "/api/uploads/${"1".repeat(32)}", 200, null, null, false, false, false))
        db.close()
        db = Room.databaseBuilder(context, BackupDatabase::class.java, name).build()
        try {
            db.assets().activate("first")
            val resumed = db.assets().pending(listOf("DCIM/Camera/"), "first").single()
            assertEquals(200L, resumed.offset)
            assertEquals("a".repeat(64), resumed.sha256)
            assertTrue(resumed.uploadUrl!!.endsWith("1".repeat(32)))
        } finally { db.close(); context.deleteDatabase(name) }
    }

    @Test fun `a MediaStore edit is a new version and cannot inherit old upload proof`() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Application>()
        val db = Room.inMemoryDatabaseBuilder(context, BackupDatabase::class.java).build()
        try {
            val dao = db.assets()
            val old = dao.discover(asset())
            dao.activate("first")
            dao.progress(old.id, "first", AssetState.VERIFIED, "a".repeat(64), "/old", 1_000, null, 1, true, true, true)
            val edited = dao.discover(asset(generation = 2))
            assertNotEquals(old.id, edited.id)
            assertFalse(dao.get(old.id)!!.current)
            assertTrue(dao.get(old.id)!!.exported, "historical proof is retained for the old version")
            assertNull(edited.sha256)
            assertNull(edited.uploadUrl)
            assertFalse(edited.exported)
            assertEquals(edited.id, dao.pending(listOf("DCIM/Camera/"), "first").single().id)
        } finally { db.close() }
    }

    @Test fun `re-pairing clears old receipts and stale workers cannot restore them`() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Application>()
        val db = Room.inMemoryDatabaseBuilder(context, BackupDatabase::class.java).build()
        try {
            val dao = db.assets()
            val item = dao.discover(asset())
            dao.activate("first")
            dao.progress(item.id, "first", AssetState.VERIFIED, "a".repeat(64), "/old", 1_000, null, 1, true, true, true)
            dao.activate("replacement")
            assertEquals(0, dao.claim(item.id, "first"))
            assertEquals(0, dao.progress(item.id, "first", AssetState.VERIFIED, "a".repeat(64), "/old", 1_000, null, 1, true, true, true))
            val reset = dao.get(item.id)!!
            assertEquals("replacement", reset.connectionId)
            assertNull(reset.uploadUrl)
            assertFalse(reset.exported)
            assertNull(reset.verifiedAt)
            assertEquals(item.id, dao.pending(listOf("DCIM/Camera/"), "replacement").single().id)
        } finally { db.close() }
    }

    @Test fun `queue selection excludes folders the user has not selected`() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Application>()
        val db = Room.inMemoryDatabaseBuilder(context, BackupDatabase::class.java).build()
        try {
            val dao = db.assets()
            val camera = dao.discover(asset())
            dao.discover(asset(folder = "Pictures/Private/").copy(mediaKey = "external_primary/images/99"))
            dao.activate("first")
            assertEquals(listOf(camera.id), dao.pending(listOf("DCIM/Camera/"), "first").map { it.id })
            assertTrue(dao.pending(emptyList(), "first").isEmpty())
        } finally { db.close() }
    }

    @Test fun `awaiting host export cannot starve new uploads or other receipt checks`() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Application>()
        val db = Room.inMemoryDatabaseBuilder(context, BackupDatabase::class.java).build()
        try {
            val dao = db.assets()
            val first = dao.discover(asset())
            dao.activate("first")
            dao.progress(first.id, "first", AssetState.AWAITING_HOST, "a".repeat(64), "/old", 1_000, null, null, true, true, false, 100)
            val next = dao.discover(asset().copy(mediaKey = "external_primary/images/99"))
            assertEquals(next.id, dao.pending(listOf("DCIM/Camera/"), "first", 1).single().id)
            dao.claim(next.id, "first")
            dao.progress(next.id, "first", AssetState.AWAITING_HOST, "b".repeat(64), "/new", 1_000, null, null, true, true, false, 200)
            assertEquals(first.id, dao.pending(listOf("DCIM/Camera/"), "first", 1).single().id)
            dao.progress(first.id, "first", AssetState.AWAITING_HOST, "a".repeat(64), "/old", 1_000, null, null, true, true, false, 300)
            assertEquals(next.id, dao.pending(listOf("DCIM/Camera/"), "first", 1).single().id)
        } finally { db.close() }
    }

    @Test fun `a photo deleted in Photobox waits for the user, is never uploaded, and the decision is reported once`() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Application>()
        val db = Room.inMemoryDatabaseBuilder(context, BackupDatabase::class.java).build()
        try {
            val dao = db.assets()
            val item = dao.discover(asset())
            dao.activate("first")
            dao.progress(item.id, "first", AssetState.VERIFIED, "a".repeat(64), "/old", 1_000, null, 1, true, true, true)
            assertEquals(1, dao.requestDeletion("a".repeat(64)))
            assertEquals(0, dao.requestDeletion("a".repeat(64)), "asked about once")
            assertEquals(0, dao.requestDeletion("b".repeat(64)))
            assertTrue(dao.pending(listOf("DCIM/Camera/"), "first").isEmpty())
            assertEquals(0L, dao.unverified(listOf("DCIM/Camera/")), "a finished backup, not one waiting")
            assertEquals(listOf(item.id), dao.deletionRequests().map { it.id })
            assertTrue(dao.unreportedDeletions().isEmpty(), "nothing decided yet")
            assertEquals(1, dao.decideDeletion(listOf(item.id), AssetState.TRASHED))
            assertEquals(listOf(item.id), dao.unreportedDeletions().map { it.id })
            dao.deletionsReported(listOf(item.id))
            assertTrue(dao.unreportedDeletions().isEmpty())
            assertEquals(0, dao.cancelDeletion("a".repeat(64)), "a copy in the phone's trash stays there")
            dao.activate("replacement")
            assertEquals(AssetState.TRASHED, dao.get(item.id)!!.state, "pairing again doesn't bring it back")
            assertTrue(dao.pending(listOf("DCIM/Camera/"), "replacement").isEmpty())
            assertEquals(0, dao.claim(item.id, "replacement"))
        } finally { db.close() }
    }

    @Test fun `cleared from the host's Deleted list, a kept copy is backed up again from scratch`() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Application>()
        val db = Room.inMemoryDatabaseBuilder(context, BackupDatabase::class.java).build()
        try {
            val dao = db.assets()
            val item = dao.discover(asset())
            dao.activate("first")
            dao.progress(item.id, "first", AssetState.VERIFIED, "a".repeat(64), "/old", 1_000, null, 1, true, true, true)
            dao.requestDeletion("a".repeat(64))
            assertEquals(1, dao.decideDeletion(listOf(item.id), AssetState.KEPT))
            assertEquals(0, dao.decideDeletion(listOf(item.id), AssetState.TRASHED), "decided once")
            assertEquals(1, dao.cancelDeletion("a".repeat(64)))
            val again = dao.get(item.id)!!
            assertEquals(AssetState.NEW, again.state)
            assertFalse(again.exported)
            assertNull(again.uploadUrl)
            assertEquals(listOf(item.id), dao.pending(listOf("DCIM/Camera/"), "first").map { it.id })
        } finally { db.close() }
    }

    @Test fun `a version 1 queue opens as version 2 with its uploads intact`() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Application>()
        val name = "migration-${UUID.randomUUID()}.db"
        // A database as the first release made it, from its exported schema.
        val schema = Json.parseToJsonElement(File("schemas/local.photobox.android.BackupDatabase/1.json").readText()).jsonObject["database"]!!.jsonObject
        SQLiteDatabase.openOrCreateDatabase(context.getDatabasePath(name).apply { parentFile!!.mkdirs() }, null).apply {
            for (entity in schema["entities"]!!.jsonArray.map { it.jsonObject }) {
                execSQL(entity["createSql"]!!.jsonPrimitive.content.replace("\${TABLE_NAME}", entity["tableName"]!!.jsonPrimitive.content))
                for (index in entity["indices"]?.jsonArray.orEmpty()) execSQL(index.jsonObject["createSql"]!!.jsonPrimitive.content.replace("\${TABLE_NAME}", entity["tableName"]!!.jsonPrimitive.content))
            }
            for (query in schema["setupQueries"]!!.jsonArray) execSQL(query.jsonPrimitive.content)
            execSQL("""INSERT INTO Asset (id, mediaKey, uri, filename, folder, size, modified, generation, takenAt, current, connectionId, sha256, uploadUrl, offset,
                state, error, received, indexed, exported, attemptedAt, verifiedAt, discoveredAt)
                VALUES ('x', 'k', 'content://media/external_primary/images/media/1', 'PXL.jpg', 'DCIM/Camera/', 10, 1, 1, 1, 1, 'first', '${"a".repeat(64)}', NULL, 0,
                'VERIFIED', NULL, 1, 1, 1, 0, 5, 0)""")
            version = 1
            close()
        }
        val db = Room.databaseBuilder(context, BackupDatabase::class.java, name).build()
        try {
            val migrated = db.assets().get("x")!!
            assertEquals(AssetState.VERIFIED, migrated.state)
            assertEquals(5L, migrated.verifiedAt)
            assertFalse(migrated.deletionReported)
            assertEquals(1, db.assets().requestDeletion("a".repeat(64)))
        } finally { db.close(); context.deleteDatabase(name) }
    }
}
