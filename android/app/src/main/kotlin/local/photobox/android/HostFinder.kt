package local.photobox.android

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build
import java.net.Inet4Address
import java.net.InetAddress
import kotlin.coroutines.resume
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Where Photobox hosts on this network say they are (DNS-SD `_photobox._tcp`, announced by the
 * computer), as addresses to try when the paired one doesn't answer. Which of them is the paired
 * host only TLS can tell.
 */
class HostFinder(context: Context) {
    private val nsd = context.getSystemService(NsdManager::class.java)

    suspend fun find(): List<String> = discover().flatMap { resolve(it) }.distinct()

    /** The hosts announced within a few seconds; a moment longer after the first, for any others. */
    private suspend fun discover(): List<NsdServiceInfo> {
        val found = mutableListOf<NsdServiceInfo>()
        val first = CompletableDeferred<Unit>()
        val listener = object : NsdManager.DiscoveryListener {
            override fun onServiceFound(service: NsdServiceInfo) { synchronized(found) { found += service }; first.complete(Unit) }
            override fun onStartDiscoveryFailed(type: String, code: Int) { first.complete(Unit) }
            override fun onServiceLost(service: NsdServiceInfo) {}
            override fun onDiscoveryStarted(type: String) {}
            override fun onDiscoveryStopped(type: String) {}
            override fun onStopDiscoveryFailed(type: String, code: Int) {}
        }
        nsd.discoverServices(SERVICE, NsdManager.PROTOCOL_DNS_SD, listener)
        try {
            withTimeoutOrNull(DISCOVER_MS) { first.await(); delay(MORE_MS) }
        } finally {
            try { nsd.stopServiceDiscovery(listener) } catch (_: IllegalArgumentException) { /* Discovery never started. */ }
        }
        return synchronized(found) { found.toList() }
    }

    private suspend fun resolve(service: NsdServiceInfo): List<String> = withTimeoutOrNull(RESOLVE_MS) {
        suspendCancellableCoroutine { done ->
            if (Build.VERSION.SDK_INT >= 34) {
                val callback = object : NsdManager.ServiceInfoCallback {
                    override fun onServiceUpdated(info: NsdServiceInfo) {
                        stop(this) // The first answer is all it takes.
                        if (done.isActive) done.resume(hostUrls(info.hostAddresses, info.port))
                    }
                    override fun onServiceInfoCallbackRegistrationFailed(code: Int) { if (done.isActive) done.resume(emptyList()) }
                    override fun onServiceLost() {}
                    override fun onServiceInfoCallbackUnregistered() {}
                }
                nsd.registerServiceInfoCallback(service, Runnable::run, callback)
                done.invokeOnCancellation { stop(callback) }
            } else {
                @Suppress("DEPRECATION")
                nsd.resolveService(service, object : NsdManager.ResolveListener {
                    override fun onServiceResolved(info: NsdServiceInfo) {
                        @Suppress("DEPRECATION") val host = info.host
                        if (done.isActive) done.resume(hostUrls(listOfNotNull(host), info.port))
                    }
                    override fun onResolveFailed(info: NsdServiceInfo, code: Int) { if (done.isActive) done.resume(emptyList()) }
                })
            }
        }
    } ?: emptyList()

    private fun stop(callback: NsdManager.ServiceInfoCallback) {
        if (Build.VERSION.SDK_INT >= 34) try { nsd.unregisterServiceInfoCallback(callback) } catch (_: IllegalArgumentException) { /* Already. */ }
    }

    companion object {
        const val SERVICE = "_photobox._tcp"
        private const val DISCOVER_MS = 5_000L
        private const val MORE_MS = 500L
        private const val RESOLVE_MS = 3_000L
    }
}

/** The host's addresses as server URLs. Photobox's certificate names its IPv4 addresses. */
internal fun hostUrls(addresses: List<InetAddress>, port: Int): List<String> =
    if (port !in 1..65535) emptyList()
    else addresses.filterIsInstance<Inet4Address>().mapNotNull { it.hostAddress }.map { "https://$it:$port/" }
