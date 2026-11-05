package local.photobox.api

import java.io.IOException
import kotlinx.coroutines.CancellationException
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/** The paired host as it answered: the connection that reached it, and what it accepts. */
data class Reached(val connection: Connection, val api: HostApi, val capabilities: Capabilities)

/**
 * The paired host at the address it paired from or, when nothing answers there, at one of
 * `elsewhere`: where hosts on the local network say they are now (a computer gets another
 * address when the Wi-Fi router hands one out). Wherever it answers, only the paired host
 * passes TLS with this connection's trust anchor, so a stranger's is never used.
 */
suspend fun reach(connection: Connection, elsewhere: suspend () -> List<String>): Reached {
    val api = HostApi(connection)
    try {
        return Reached(connection, api, api.capabilities())
    } catch (e: HostException) {
        throw e // It answered: it's there.
    } catch (e: IOException) {
        for (server in elsewhere().distinct()) {
            val moved = try { connection.copy(server = serverUrl(server).toString()) } catch (_: IllegalArgumentException) { continue }
            if (moved.server == connection.server) continue
            try {
                val other = HostApi(moved)
                return Reached(moved, other, other.capabilities())
            } catch (c: CancellationException) { throw c }
            catch (_: Exception) { /* Another host, or not reachable either. */ }
        }
        throw e
    }
}

/**
 * An upload begun when the host had another address, at the address it has now (`server`): the
 * same unfinished upload on the same paired host. Anything that isn't an upload location stays
 * as it was, for [HostApi.uploadUrl] to refuse.
 */
fun movedUpload(location: String, server: String): String {
    val url = location.toHttpUrlOrNull() ?: return location
    if (url.query != null || url.fragment != null || !url.encodedPath.matches(Regex("/api/uploads/[a-f0-9]{32}"))) return location
    return serverUrl(server).newBuilder().encodedPath(url.encodedPath).build().toString()
}
