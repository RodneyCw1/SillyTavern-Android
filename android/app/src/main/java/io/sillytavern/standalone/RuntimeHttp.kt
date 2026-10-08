package io.sillytavern.standalone

import java.io.ByteArrayOutputStream
import java.io.EOFException
import java.io.IOException
import java.io.InputStream

internal object RuntimeHttp {
    data class Response(val status: Int, val body: ByteArray)
    fun read(raw: InputStream, maxBytes: Int = 2 * 1024 * 1024): Response {
        val input = raw.buffered()
        var headerBytes = 0
        fun line(): String {
            val bytes = ByteArrayOutputStream()
            while (true) {
                val next = input.read()
                if (next < 0) throw EOFException("本地服务响应不完整")
                if (++headerBytes > 65536) throw IOException("本地服务响应头过大")
                if (next == 10) break
                bytes.write(next)
            }
            return bytes.toString("US-ASCII").removeSuffix("\r")
        }
        val status = line().split(' ').getOrNull(1)?.toIntOrNull() ?: throw IOException("本地服务响应无效")
        val headers = mutableMapOf<String, String>()
        while (true) {
            val value = line()
            if (value.isEmpty()) break
            val colon = value.indexOf(':')
            if (colon <= 0) throw IOException("本地服务响应头无效")
            headers[value.substring(0, colon).lowercase()] = value.substring(colon + 1).trim()
        }
        val output = ByteArrayOutputStream()
        fun copy(length: Long) {
            if (length < 0 || length > maxBytes - output.size()) throw IOException("本地服务响应过大")
            var remaining = length
            val buffer = ByteArray(16384)
            while (remaining > 0) {
                val count = input.read(buffer, 0, minOf(buffer.size.toLong(), remaining).toInt())
                if (count < 0) throw EOFException("本地服务响应不完整")
                output.write(buffer, 0, count)
                remaining -= count
            }
        }
        if (headers["transfer-encoding"]?.lowercase() == "chunked") {
            while (true) {
                val length = line().substringBefore(';').trim().toLongOrNull(16) ?: throw IOException("本地服务分块无效")
                if (length == 0L) { while (line().isNotEmpty()) { }; break }
                copy(length)
                if (line().isNotEmpty()) throw IOException("本地服务分块无效")
            }
        } else if (headers.containsKey("content-length")) {
            copy(headers.getValue("content-length").toLongOrNull() ?: throw IOException("本地服务长度无效"))
        } else {
            val buffer = ByteArray(16384)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                if (output.size() + count > maxBytes) throw IOException("本地服务响应过大")
                output.write(buffer, 0, count)
            }
        }
        return Response(status, output.toByteArray())
    }
}

