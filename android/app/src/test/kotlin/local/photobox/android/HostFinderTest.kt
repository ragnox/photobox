package local.photobox.android

import java.net.InetAddress
import kotlin.test.*
import org.junit.Test

class HostFinderTest {
    @Test fun `an announced host's IPv4 addresses become addresses to try`() {
        val wifi = InetAddress.getByName("192.0.2.20")
        val vpn = InetAddress.getByName("198.51.100.7")
        val local = InetAddress.getByName("fe80::1")
        assertEquals(listOf("https://192.0.2.20:4568/", "https://198.51.100.7:4568/"), hostUrls(listOf(local, wifi, vpn), 4568))
        assertEquals(emptyList(), hostUrls(listOf(wifi), 0), "no port announced")
    }
}
