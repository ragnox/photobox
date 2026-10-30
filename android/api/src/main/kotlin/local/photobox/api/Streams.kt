package local.photobox.api

import java.io.EOFException
import java.io.InputStream

fun readChunk(input: InputStream, maximum: Int): ByteArray {
    require(maximum > 0)
    val buffer = ByteArray(maximum)
    var count = 0
    while (count < buffer.size) {
        val read = input.read(buffer, count, buffer.size - count)
        if (read < 0) break
        if (read == 0) {
            val byte = input.read()
            if (byte < 0) break
            buffer[count++] = byte.toByte()
        } else count += read
    }
    return if (count == buffer.size) buffer else buffer.copyOf(count)
}

fun skipFully(input: InputStream, count: Long) {
    require(count >= 0)
    var remaining = count
    while (remaining > 0) {
        val skipped = input.skip(remaining)
        if (skipped > 0) remaining -= skipped
        else if (input.read() < 0) throw EOFException("Original ended before the resumable offset")
        else remaining--
    }
}
