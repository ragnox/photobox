package local.photobox.android

import android.Manifest
import android.content.ContentUris
import android.content.Context
import android.content.IntentSender
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.MediaStore
import androidx.core.content.ContextCompat
import java.io.InputStream
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext

data class MediaAccess(val images: Boolean, val videos: Boolean, val limited: Boolean, val location: Boolean) {
    val any: Boolean get() = images || videos || limited
}

class MediaCatalog(private val context: Context) {
    private fun granted(permission: String) = ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED
    fun access(): MediaAccess {
        val legacy = Build.VERSION.SDK_INT < 33 && granted(Manifest.permission.READ_EXTERNAL_STORAGE)
        val images = legacy || (Build.VERSION.SDK_INT >= 33 && granted(Manifest.permission.READ_MEDIA_IMAGES))
        val videos = legacy || (Build.VERSION.SDK_INT >= 33 && granted(Manifest.permission.READ_MEDIA_VIDEO))
        return MediaAccess(
            images, videos,
            Build.VERSION.SDK_INT >= 34 && granted(Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED) && (!images || !videos),
            granted(Manifest.permission.ACCESS_MEDIA_LOCATION),
        )
    }

    suspend fun scan(accept: suspend (Asset) -> Unit): Set<String> = withContext(Dispatchers.IO) {
        val access = access()
        require(access.any) { "Grant photo/video access before backing up" }
        val folders = mutableSetOf<String>()
        for (volume in MediaStore.getExternalVolumeNames(context)) {
            val collections = buildList {
                if (access.images || access.limited) add(MediaStore.Images.Media.getContentUri(volume))
                if (access.videos || access.limited) add(MediaStore.Video.Media.getContentUri(volume))
            }
            for (collection in collections) {
                context.contentResolver.query(collection, projection(), selection(), null, "${MediaStore.MediaColumns._ID} ASC")?.use { cursor ->
                    while (cursor.moveToNext()) {
                        currentCoroutineContext().ensureActive()
                        val id = cursor.getLong(cursor.getColumnIndexOrThrow(MediaStore.MediaColumns._ID))
                        val uri = ContentUris.withAppendedId(collection, id)
                        val asset = fromCursor(cursor, uri, "$volume/${collection.pathSegments[1]}/$id")
                        folders += asset.folder
                        accept(asset)
                    }
                }
            }
        }
        folders
    }

    fun find(asset: Asset): Asset? = context.contentResolver.query(Uri.parse(asset.uri), projection(), selection(), null, null)?.use {
        if (it.moveToFirst()) fromCursor(it, Uri.parse(asset.uri), asset.mediaKey) else null
    }

    /**
     * Android's own confirmation for moving these photos to the phone's trash (Android 11+), for
     * the ones that are still the version that was deleted: an edit since is a photo of its own.
     */
    fun trashRequest(assets: List<Asset>): IntentSender? {
        if (Build.VERSION.SDK_INT < 30) return null
        val unchanged = assets.filter { find(it)?.signature == it.signature }
        if (unchanged.isEmpty()) return null
        return MediaStore.createTrashRequest(context.contentResolver, unchanged.map { Uri.parse(it.uri) }, true).intentSender
    }

    fun openOriginal(asset: Asset): InputStream {
        // setRequireOriginal prevents Android's EXIF/GPS redaction. No transcoding or re-encoding.
        if (!access().location) throw SecurityException("Allow photo location access to back up unredacted originals")
        val original = MediaStore.setRequireOriginal(Uri.parse(asset.uri))
        if (Build.VERSION.SDK_INT >= 31) {
            val options = Bundle().apply { putBoolean(MediaStore.EXTRA_ACCEPT_ORIGINAL_MEDIA_FORMAT, true) }
            val descriptor = context.contentResolver.openTypedAssetFileDescriptor(original, "*/*", options)
                ?: error("Original is unavailable")
            try { return descriptor.createInputStream() } catch (e: Exception) { descriptor.close(); throw e }
        }
        return context.contentResolver.openInputStream(original) ?: error("Original is unavailable")
    }

    private fun projection() = buildList {
        addAll(listOf(MediaStore.MediaColumns._ID, MediaStore.MediaColumns.DISPLAY_NAME, MediaStore.MediaColumns.SIZE,
            MediaStore.MediaColumns.RELATIVE_PATH, MediaStore.MediaColumns.DATE_MODIFIED, MediaStore.Images.ImageColumns.DATE_TAKEN))
        if (Build.VERSION.SDK_INT >= 30) add(MediaStore.MediaColumns.GENERATION_MODIFIED)
    }.toTypedArray()

    private fun selection() = "${MediaStore.MediaColumns.SIZE} > 0 AND ${MediaStore.MediaColumns.IS_PENDING} = 0" +
        if (Build.VERSION.SDK_INT >= 30) " AND ${MediaStore.MediaColumns.IS_TRASHED} = 0" else ""

    private fun fromCursor(cursor: android.database.Cursor, uri: Uri, key: String): Asset {
        fun text(column: String) = cursor.getString(cursor.getColumnIndexOrThrow(column)) ?: ""
        fun number(column: String) = cursor.getLong(cursor.getColumnIndexOrThrow(column))
        return Asset(mediaKey = key, uri = uri.toString(), filename = text(MediaStore.MediaColumns.DISPLAY_NAME),
            folder = text(MediaStore.MediaColumns.RELATIVE_PATH), size = number(MediaStore.MediaColumns.SIZE),
            modified = number(MediaStore.MediaColumns.DATE_MODIFIED),
            generation = if (Build.VERSION.SDK_INT >= 30) number(MediaStore.MediaColumns.GENERATION_MODIFIED) else 0,
            takenAt = number(MediaStore.Images.ImageColumns.DATE_TAKEN))
    }
}
