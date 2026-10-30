package local.photobox.android

import android.app.ForegroundServiceStartNotAllowedException
import android.os.Build

/** Background reconciliation is already bounded below WorkManager's run limit. */
internal suspend fun promoteWhenVisible(visible: Boolean, promote: suspend () -> Unit): Boolean {
    if (!visible) return false
    try {
        promote()
        return true
    } catch (e: Exception) {
        // Visibility/quota can change after checking. Continue as a bounded job,
        // but never swallow cancellation or unrelated foreground setup failures.
        if (Build.VERSION.SDK_INT >= 31 && e is ForegroundServiceStartNotAllowedException) return false
        throw e
    }
}
