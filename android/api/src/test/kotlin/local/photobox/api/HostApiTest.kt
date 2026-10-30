package local.photobox.api

import java.io.File
import java.util.Base64
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLException
import kotlin.test.*
import kotlinx.coroutines.*
import kotlinx.serialization.encodeToString
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.Test

class HostApiTest {
    private val token = "a".repeat(43)
    private val uploadId = "1".repeat(32)

    private class Host(hostname: String = "localhost") : AutoCloseable {
        val ca = HeldCertificate.Builder().certificateAuthority(1).commonName("Photobox test CA").build()
        val leaf = HeldCertificate.Builder().commonName(hostname).addSubjectAlternativeName(hostname).signedBy(ca).build()
        val trust = TrustAnchor("ca", sha256(ca.certificate.encoded), Base64.getEncoder().encodeToString(ca.certificate.encoded))
        val server = MockWebServer().apply {
            useHttps(HandshakeCertificates.Builder().heldCertificate(leaf, ca.certificate).build().sslSocketFactory(), false)
            start()
        }
        fun connection(trust: TrustAnchor = this.trust) = Connection("test-session", server.url("/").toString(), "a".repeat(43), trust, "Test")
        fun payload() = PairingPayload("photobox-pair", 1, server.url("/").toString(), "b".repeat(22), System.currentTimeMillis() + 300_000, trust)
        override fun close() = server.close()
    }

    @Test fun `pairing validates the embedded certificate before exchanging any code`() = runBlocking<Unit> {
        Host().use { host ->
            val wrong = host.payload().copy(trust = host.trust.copy(sha256 = "0".repeat(64)))
            assertFailsWith<IllegalArgumentException> { HostApi.pair(wrong, "Phone") }
            assertEquals(0, host.server.requestCount)
            host.server.enqueue(MockResponse().setBody("""{"token":"$token"}"""))
            val connection = HostApi.pair(PairingPayload.decode(protocolJson.encodeToString(host.payload())), "Phone")
            assertEquals(token, connection.token)
            val request = host.server.takeRequest()
            assertEquals("/api/pair", request.path)
            assertNull(request.getHeader("Authorization"))
            assertTrue(request.body.readUtf8().contains("b".repeat(22)))
            assertFailsWith<IllegalArgumentException> { host.payload().copy(expiresAt = 1).validate() }
            assertFailsWith<IllegalArgumentException> { host.payload().copy(server = "http://localhost/").validate() }
        }
    }

    @Test fun `a valid fingerprint is not enough to trust a different signing authority`() = runBlocking<Unit> {
        Host().use { first -> Host().use { second ->
            assertFailsWith<SSLException> { HostApi(first.connection(second.trust)).capabilities() }
            assertEquals(0, first.server.requestCount)
        } }
    }

    @Test fun `hostname verification remains enabled for the QR trust anchor`() = runBlocking<Unit> {
        Host("wrong.example").use { host ->
            assertFailsWith<SSLException> { HostApi(host.connection()).capabilities() }
            assertEquals(0, host.server.requestCount)
        }
    }

    @Test fun `a user supplied certificate is trusted only as the pinned server leaf`() = runBlocking<Unit> {
        Host().use { host ->
            val leaf = host.leaf.certificate.encoded
            val trust = TrustAnchor("certificate", sha256(leaf), Base64.getEncoder().encodeToString(leaf))
            host.server.enqueue(MockResponse().setBody("""{"version":1,"tusVersion":"1.0.0","maxFileBytes":100,"extensions":[".jpg"]}"""))
            assertEquals(1, HostApi(host.connection(trust)).capabilities().version)
            assertFailsWith<IllegalArgumentException> { trust.copy(kind = "ca").certificate() }
        }
    }

    @Test fun `resume locations cannot redirect device credentials to another host or endpoint`() {
        Host().use { host ->
            val api = HostApi(host.connection())
            for (location in listOf("https://elsewhere.example/api/uploads/$uploadId", "http://localhost/api/uploads/$uploadId", "/api/pair", "/api/uploads/$uploadId?token=secret", "/api/uploads/../../api/status")) {
                assertFailsWith<IllegalArgumentException>(location) { api.uploadUrl(location) }
            }
            assertTrue(api.uploadUrl("/api/uploads/$uploadId").endsWith(uploadId))
            assertEquals(0, host.server.requestCount)
        }
    }

    @Test fun `HTTP redirects are rejected without forwarding the bearer token`() = runBlocking<Unit> {
        Host().use { host -> Host().use { other ->
            host.server.enqueue(MockResponse().setResponseCode(302).addHeader("Location", other.server.url("/stolen")))
            val error = assertFailsWith<HostException> { HostApi(host.connection()).capabilities() }
            assertEquals(302, error.status)
            assertEquals("Bearer $token", host.server.takeRequest().getHeader("Authorization"))
            assertEquals(0, other.server.requestCount)
        } }
    }

    @Test fun `resumption uses the server offset and rejects mismatched acknowledgement`() = runBlocking<Unit> {
        Host().use { host ->
            val api = HostApi(host.connection())
            host.server.enqueue(MockResponse().setResponseCode(201).addHeader("Location", "/api/uploads/$uploadId"))
            val url = api.create("PXL.MP.jpg", 10, "f".repeat(64), "2024-01-01T12:00:00Z", "images/42")
            assertEquals("10", host.server.takeRequest().getHeader("Upload-Length"))
            host.server.enqueue(MockResponse().addHeader("Upload-Length", 10).addHeader("Upload-Offset", 4))
            assertEquals(4L, api.offset(url, 10))
            host.server.takeRequest()
            host.server.enqueue(MockResponse().setResponseCode(204).addHeader("Upload-Offset", 7))
            assertEquals(7L, api.chunk(url, 4, byteArrayOf(1, 2, 3)))
            assertEquals("4", host.server.takeRequest().getHeader("Upload-Offset"))
            host.server.enqueue(MockResponse().setResponseCode(204).addHeader("Upload-Offset", 99))
            assertFailsWith<IllegalArgumentException> { api.chunk(url, 7, byteArrayOf(4)) }
        }
    }

    @Test fun `receipt order and content identity cannot be silently substituted`() = runBlocking<Unit> {
        Host().use { host ->
            host.server.enqueue(MockResponse().setBody("""{"assets":[{"sha256":"${"0".repeat(64)}","received":true,"indexed":true,"exported":true}]}"""))
            assertFailsWith<IllegalArgumentException> { HostApi(host.connection()).check(listOf("f".repeat(64))) }
        }
    }

    @Test fun `cancelling work cancels an in-flight HTTP request`() = runBlocking<Unit> {
        Host().use { host ->
            host.server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
            val job = launch { HostApi(host.connection()).capabilities() }
            withContext(Dispatchers.IO) { assertNotNull(host.server.takeRequest(5, TimeUnit.SECONDS)) }
            withTimeout(2_000) { job.cancelAndJoin() }
        }
    }

    @Test fun `the Kotlin transport pairs resumes and verifies export against the real Node host`() = runBlocking<Unit> {
        val root = File(System.getProperty("photobox.root"))
        val process = ProcessBuilder("node", File(root, "scripts/android-test-host.js").absolutePath)
            .directory(root).redirectError(ProcessBuilder.Redirect.INHERIT).start()
        try {
            val line = withContext(Dispatchers.IO) { process.inputStream.bufferedReader().readLine() }
            assertNotNull(line, "Node host did not start")
            val payload = PairingPayload.decode(line)
            val connection = HostApi.pair(payload, "Kotlin integration test")
            val api = HostApi(connection)
            assertEquals(1, api.capabilities().version)
            val bytes = Base64.getDecoder().decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=") + ByteArray(200_000) { (it % 251).toByte() }
            val hash = sha256(bytes)
            val location = api.create("original.png", bytes.size.toLong(), hash, "2024-01-01T12:00:00Z", "images/1")
            assertEquals(50_000L, api.chunk(location, 0, bytes.copyOfRange(0, 50_000)))
            // A fresh client has no in-memory session state; it resumes using persisted URL/HEAD.
            val resumed = HostApi(connection)
            val offset = resumed.offset(location, bytes.size.toLong())!!
            assertEquals(50_000L, offset)
            resumed.chunk(location, offset, bytes.copyOfRange(offset.toInt(), bytes.size))
            withTimeout(20_000) {
                while (!resumed.check(listOf(hash)).single().verified) delay(200)
            }
            resumed.cancelPartial(location)
            assertTrue(resumed.check(listOf(hash)).single().verified, "Host termination cannot delete a received original")
        } finally {
            process.destroy()
            withContext(Dispatchers.IO) { if (!process.waitFor(10, TimeUnit.SECONDS)) process.destroyForcibly() }
        }
    }
}
