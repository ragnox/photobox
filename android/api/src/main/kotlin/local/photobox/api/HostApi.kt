package local.photobox.api

import java.io.IOException
import java.util.Base64
import java.util.UUID
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.encodeToString
import okhttp3.Call
import okhttp3.Callback
import okhttp3.Headers
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response

private data class Reply(val code: Int, val headers: Headers, val body: String)

class HostApi private constructor(private val base: HttpUrl, private val client: OkHttpClient, private val token: String?) {
    constructor(connection: Connection) : this(serverUrl(connection.server), connection.trust.client(), connection.token)

    private suspend fun send(request: Request): Reply = suspendCancellableCoroutine { continuation ->
        val call = client.newCall(request)
        continuation.invokeOnCancellation { call.cancel() }
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) { if (continuation.isActive) continuation.resumeWithException(e) }
            override fun onResponse(call: Call, response: Response) {
                try {
                    response.use {
                        val body = it.body?.byteStream()?.use { stream ->
                            // Only JSON/protocol responses, never original media, use this path.
                            val bytes = readChunk(stream, 1_048_577)
                            if (bytes.size > 1_048_576) throw IOException("Host response is too large")
                            bytes.toString(Charsets.UTF_8)
                        } ?: ""
                        if (continuation.isActive) continuation.resume(Reply(it.code, it.headers, body))
                    }
                } catch (e: Exception) { if (continuation.isActive) continuation.resumeWithException(e) }
            }
        })
    }

    private fun request(path: String): Request.Builder = Request.Builder().url(base.resolve(path)!!).apply {
        token?.let { header("Authorization", "Bearer $it") }
    }

    private fun Reply.expect(vararg codes: Int): Reply {
        if (code !in codes) {
            val message = when (code) {
                401 -> "Host disconnected this phone; pair again"
                413 -> "Host file-size limit or device quota exceeded"
                422 -> "Host rejected the file's SHA-256; retry the original"
                507 -> "Host does not have enough free space"
                in 300..399 -> "Host redirects are not permitted"
                else -> "Host request failed (HTTP $code)"
            }
            throw HostException(code, message)
        }
        return this
    }

    suspend fun capabilities(): Capabilities {
        val reply = send(request("/api/backup/capabilities").get().build()).expect(200)
        return protocolJson.decodeFromString<Capabilities>(reply.body).also {
            require(it.version == 1 && it.tusVersion == "1.0.0" && it.maxFileBytes > 0) { "Host backup protocol is not supported" }
        }
    }

    suspend fun check(hashes: List<String>): List<Receipt> {
        require(hashes.size <= 100 && hashes.all { it.matches(Regex("[a-f0-9]{64}")) })
        val body = protocolJson.encodeToString(CheckRequest(hashes)).toRequestBody(JSON)
        val reply = send(request("/api/assets/check").post(body).build()).expect(200)
        return protocolJson.decodeFromString<Receipts>(reply.body).assets.also {
            require(it.map(Receipt::sha256) == hashes) { "Host returned mismatched backup receipts" }
        }
    }

    /** Resumed locations are validated before a bearer token is ever attached. */
    fun uploadUrl(value: String): String {
        val url = base.resolve(value) ?: throw IOException("Invalid upload URL")
        require(url.scheme == base.scheme && url.host == base.host && url.port == base.port &&
            url.username.isEmpty() && url.password.isEmpty() && url.query == null && url.fragment == null &&
            url.encodedPath.matches(Regex("/api/uploads/[a-f0-9]{32}"))) { "Upload URL belongs to a different host or endpoint" }
        return url.toString()
    }

    suspend fun create(filename: String, size: Long, hash: String, capturedAt: String?, mediaStoreId: String): String {
        require(size > 0 && hash.matches(Regex("[a-f0-9]{64}")))
        val metadata = linkedMapOf("filename" to filename, "sha256" to hash, "mediaStoreId" to mediaStoreId)
        capturedAt?.let { metadata["capturedAt"] = it }
        val encoded = metadata.entries.joinToString(",") { (key, value) -> "$key ${Base64.getEncoder().encodeToString(value.toByteArray(Charsets.UTF_8))}" }
        val result = send(request("/api/uploads").header("Tus-Resumable", "1.0.0")
            .header("Upload-Length", size.toString()).header("Upload-Metadata", encoded)
            .post(ByteArray(0).toRequestBody(null)).build()).expect(201)
        return uploadUrl(result.headers["Location"] ?: throw IOException("Host omitted the upload location"))
    }

    suspend fun offset(location: String, expectedSize: Long): Long? {
        val safe = uploadUrl(location).toHttpUrl()
        val result = send(request(safe.encodedPath).header("Tus-Resumable", "1.0.0").head().build())
        if (result.code == 404 || result.code == 410 || result.code == 422) return null
        result.expect(200, 204)
        val size = result.headers["Upload-Length"]?.toLongOrNull()
        val offset = result.headers["Upload-Offset"]?.toLongOrNull()
        require(size == expectedSize && offset != null && offset in 0..expectedSize) { "Host returned an invalid resumable offset" }
        return offset
    }

    suspend fun chunk(location: String, offset: Long, bytes: ByteArray): Long {
        val safe = uploadUrl(location).toHttpUrl()
        val result = send(request(safe.encodedPath).header("Tus-Resumable", "1.0.0")
            .header("Upload-Offset", offset.toString()).patch(bytes.toRequestBody(BINARY)).build()).expect(204)
        val next = result.headers["Upload-Offset"]?.toLongOrNull()
        require(next == offset + bytes.size) { "Host acknowledged an unexpected upload offset" }
        return next
    }

    suspend fun cancelPartial(location: String) {
        val safe = uploadUrl(location).toHttpUrl()
        // 409 means the host already received it: immutable originals are retained.
        send(request(safe.encodedPath).header("Tus-Resumable", "1.0.0").delete().build()).expect(204, 404, 409, 410)
    }

    companion object {
        private val JSON = "application/json".toMediaType()
        private val BINARY = "application/offset+octet-stream".toMediaType()
        suspend fun pair(payload: PairingPayload, name: String): Connection {
            payload.validate()
            val api = HostApi(serverUrl(payload.server), payload.trust.client(), null)
            val response = api.send(api.request("/api/pair")
                .post(protocolJson.encodeToString(PairRequest(payload.code, name.take(60))).toRequestBody(JSON)).build())
            with(api) { response.expect(200) }
            val token = protocolJson.decodeFromString<PairResponse>(response.body).token
            require(token.matches(Regex("[A-Za-z0-9_-]{43}"))) { "Host returned an invalid device token" }
            return Connection(UUID.randomUUID().toString(), serverUrl(payload.server).toString(), token, payload.trust, name.take(60))
        }
    }
}
