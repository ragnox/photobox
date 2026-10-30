package local.photobox.android

import android.app.Application
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import java.util.UUID
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
}
