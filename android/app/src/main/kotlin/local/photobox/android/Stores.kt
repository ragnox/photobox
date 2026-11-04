package local.photobox.android

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.encodeToString
import local.photobox.api.Connection
import local.photobox.api.protocolJson

/** Only ciphertext is persisted. The AES key remains in Android Keystore. */
class ConnectionStore(context: Context) {
    private val prefs = context.getSharedPreferences("host", Context.MODE_PRIVATE)
    private val alias = "photobox.connection.v1"
    private val mutable = MutableStateFlow(load())
    val connection = mutable.asStateFlow()

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true).build())
        }.generateKey()
    }

    private fun load(): Connection? = try {
        prefs.getString("sealed", null)?.let {
            val bytes = Base64.getDecoder().decode(it)
            require(bytes.size > 12 + 16)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
            protocolJson.decodeFromString<Connection>(cipher.doFinal(bytes.copyOfRange(12, bytes.size)).toString(Charsets.UTF_8))
        }
    } catch (_: Exception) { null }

    @Synchronized fun save(connection: Connection) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val encrypted = cipher.doFinal(protocolJson.encodeToString(connection).toByteArray())
        check(prefs.edit().putString("sealed", Base64.getEncoder().encodeToString(cipher.iv + encrypted)).commit()) { "Could not save the paired host" }
        mutable.value = connection
    }

    @Synchronized fun clear() {
        check(prefs.edit().clear().commit())
        mutable.value = null
    }
}

data class BackupSettings(
    val paused: Boolean = false, val unmetered: Boolean = true, val charging: Boolean = false,
    val folders: Set<String> = setOf("DCIM/Camera/"), val knownFolders: Set<String> = emptySet(),
    val lastRun: Long = 0, val lastSuccess: Long = 0, val error: String? = null,
)

class SettingsStore(context: Context) {
    private val prefs = context.getSharedPreferences("backup-settings", Context.MODE_PRIVATE)
    private val mutable = MutableStateFlow(BackupSettings(
        prefs.getBoolean("paused", false), prefs.getBoolean("unmetered", true), prefs.getBoolean("charging", false),
        prefs.getStringSet("folders", setOf("DCIM/Camera/"))!!.toSet(), prefs.getStringSet("known", emptySet())!!.toSet(),
        prefs.getLong("run", 0), prefs.getLong("success", 0), prefs.getString("error", null),
    ))
    val settings = mutable.asStateFlow()
    @Synchronized fun update(change: (BackupSettings) -> BackupSettings) {
        val next = change(mutable.value)
        prefs.edit().putBoolean("paused", next.paused).putBoolean("unmetered", next.unmetered).putBoolean("charging", next.charging)
            .putStringSet("folders", next.folders).putStringSet("known", next.knownFolders).putLong("run", next.lastRun)
            .putLong("success", next.lastSuccess).putString("error", next.error).apply()
        mutable.value = next
    }

    /** The last change on the paired host's Deleted list this phone has seen, per pairing. */
    fun deletionsSeen(connection: String): Long = prefs.getLong("deletions:$connection", 0)
    fun sawDeletions(connection: String, seq: Long) { check(prefs.edit().putLong("deletions:$connection", seq).commit()) }
}
