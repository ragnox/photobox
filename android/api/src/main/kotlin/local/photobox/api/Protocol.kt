package local.photobox.api

import java.io.ByteArrayInputStream
import java.security.KeyStore
import java.security.MessageDigest
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.security.cert.CertificateException
import java.util.Base64
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.ConnectionPool
import okhttp3.OkHttpClient

val protocolJson = Json { ignoreUnknownKeys = true; encodeDefaults = true }

fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256")
    .digest(bytes).joinToString("") { "%02x".format(it.toInt() and 255) }

@Serializable
data class TrustAnchor(val kind: String, val sha256: String, val certificate: String) {
    fun certificate(): X509Certificate {
        require(kind == "ca" || kind == "certificate") { "Unsupported host trust type" }
        require(sha256.matches(Regex("[a-f0-9]{64}"))) { "Invalid certificate fingerprint" }
        require(certificate.length <= 16_384) { "Certificate is too large" }
        val bytes = Base64.getDecoder().decode(certificate)
        require(local.photobox.api.sha256(bytes) == sha256) { "Certificate fingerprint does not match the QR code" }
        val cert = CertificateFactory.getInstance("X.509").generateCertificate(ByteArrayInputStream(bytes)) as X509Certificate
        require(cert.encoded.contentEquals(bytes)) { "Invalid certificate encoding" }
        cert.checkValidity()
        require(kind != "ca" || cert.basicConstraints >= 0) { "The QR trust anchor is not a certificate authority" }
        return cert
    }

    fun client(): OkHttpClient {
        val cert = certificate()
        val store = KeyStore.getInstance(KeyStore.getDefaultType()).apply {
            load(null); setCertificateEntry("photobox", cert)
        }
        val delegate = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply { init(store) }
            .trustManagers.filterIsInstance<X509TrustManager>().single()
        val manager = object : X509TrustManager {
            override fun getAcceptedIssuers(): Array<X509Certificate> = delegate.acceptedIssuers
            override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) = delegate.checkClientTrusted(chain, authType)
            override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
                if (kind == "certificate" && (chain.isEmpty() || local.photobox.api.sha256(chain[0].encoded) != sha256)) {
                    throw CertificateException("The host certificate changed; pair again")
                }
                delegate.checkServerTrusted(chain, authType)
            }
        }
        val ssl = SSLContext.getInstance("TLS").apply { init(null, arrayOf(manager), null) }
        return OkHttpClient.Builder()
            .sslSocketFactory(ssl.socketFactory, manager)
            // Keep OkHttp's hostname verification. Never use a trust-all verifier.
            .followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false)
            // The host closes a connection that was idle for 5 s, and with retries off (an upload is
            // never sent twice) reusing one it closed fails the request: idle ones go after 4 s.
            .connectionPool(ConnectionPool(5, 4, java.util.concurrent.TimeUnit.SECONDS))
            .connectTimeout(15, java.util.concurrent.TimeUnit.SECONDS)
            .readTimeout(60, java.util.concurrent.TimeUnit.SECONDS)
            .writeTimeout(90, java.util.concurrent.TimeUnit.SECONDS)
            .callTimeout(120, java.util.concurrent.TimeUnit.SECONDS)
            .build()
    }
}

fun serverUrl(value: String): HttpUrl {
    val url = value.toHttpUrl()
    require(url.isHttps && url.username.isEmpty() && url.password.isEmpty() && url.query == null &&
        url.fragment == null && url.encodedPath == "/") { "Pairing requires a plain HTTPS host address" }
    return url
}

@Serializable
data class PairingPayload(
    val type: String, val version: Int, val server: String, val code: String,
    val expiresAt: Long, val trust: TrustAnchor,
) {
    fun validate(now: Long = System.currentTimeMillis()): PairingPayload {
        require(type == "photobox-pair" && version == 1) { "Unsupported Photobox pairing code" }
        serverUrl(server)
        require(code.matches(Regex("[A-Za-z0-9_-]{22}"))) { "Invalid pairing code" }
        require(expiresAt > now && expiresAt - now <= 11 * 60_000) { "Pairing code expired; make a new one on the host" }
        trust.certificate()
        return this
    }

    companion object {
        fun decode(value: String): PairingPayload {
            require(value.length <= 24_000) { "Pairing data is too large" }
            return protocolJson.decodeFromString<PairingPayload>(value.trim()).validate()
        }
    }
}

@Serializable
data class Connection(val id: String, val server: String, val token: String, val trust: TrustAnchor, val deviceName: String)

@Serializable data class Capabilities(val version: Int, val tusVersion: String, val maxFileBytes: Long, val extensions: List<String>)
/** `deleted`: the photo was deleted in Photobox, so this phone deletes its copy instead of backing it up. */
@Serializable data class Receipt(val sha256: String, val received: Boolean, val indexed: Boolean, val exported: Boolean, val deleted: Boolean = false) {
    val verified: Boolean get() = received && indexed && exported && !deleted
}
/** One change on the host's Deleted list; `deleted: false` means it was cleared there, so the copy stays. */
@Serializable data class Deletion(val seq: Long, val sha256: String, val deleted: Boolean)
@Serializable data class Deletions(val deletions: List<Deletion>, val more: Boolean)
/** What this phone did with its copy of a deleted photo: `trashed` or `kept`. */
@Serializable data class DeletionOutcome(val sha256: String, val state: String)
@Serializable internal data class DeletionReport(val items: List<DeletionOutcome>)
@Serializable internal data class Receipts(val assets: List<Receipt>)
@Serializable internal data class PairRequest(val code: String, val name: String)
@Serializable internal data class PairResponse(val token: String)
@Serializable internal data class CheckRequest(val sha256: List<String>)

class HostException(val status: Int, message: String) : java.io.IOException(message) {
    val retryable: Boolean get() = status >= 500 || status == 408 || status == 409 || status == 429
}
