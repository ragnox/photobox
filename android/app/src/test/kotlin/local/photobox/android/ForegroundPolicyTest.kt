package local.photobox.android

import android.app.Application
import android.app.ForegroundServiceStartNotAllowedException
import kotlin.test.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class)
class ForegroundPolicyTest {
    @Test fun `background work does not request a foreground-service start`() = runBlocking<Unit> {
        var requested = false
        assertFalse(promoteWhenVisible(false) { requested = true })
        assertFalse(requested)
    }

    @Test fun `a foreground-start denial falls back to bounded background work`() = runBlocking<Unit> {
        assertFalse(promoteWhenVisible(true) { throw ForegroundServiceStartNotAllowedException("background start denied") })
    }

    @Test fun `cancellation and unrelated setup failures still stop the worker`() = runBlocking<Unit> {
        assertFailsWith<CancellationException> { promoteWhenVisible(true) { throw CancellationException("paused") } }
        assertFailsWith<IllegalStateException> { promoteWhenVisible(true) { throw IllegalStateException("broken setup") } }
    }

    @Test fun `visible work can use a foreground notification`() = runBlocking<Unit> {
        var requested = false
        assertTrue(promoteWhenVisible(true) { requested = true })
        assertTrue(requested)
    }
}
