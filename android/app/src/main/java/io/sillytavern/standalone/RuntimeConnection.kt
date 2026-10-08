package io.sillytavern.standalone

import android.content.Context
import android.net.LocalSocket
import android.net.LocalSocketAddress
import android.os.Process
import org.json.JSONObject
import java.io.File
import java.io.IOException

object RuntimeConnection {
    /** Check the kernel-reported UID before obtaining an output stream or sending any credentials. */
    internal fun connect(socketFile: File, expectedUid: Int = Process.myUid()): LocalSocket {
        val socket = LocalSocket()
        try {
            // Android's connect(address, timeout) overload is unimplemented.
            socket.connect(LocalSocketAddress(socketFile.absolutePath, LocalSocketAddress.Namespace.FILESYSTEM))
            if (socket.peerCredentials.uid != expectedUid) throw IOException("本地服务身份不匹配")
            return socket
        } catch (error: Throwable) { socket.close(); throw error }
    }

    fun request(context: Context, endpoint: String, body: JSONObject? = null, timeoutMs: Int = 2000): JSONObject {
        require(endpoint.matches(Regex("/[a-z-]+")))
        connect(RuntimeFiles.socketFile(context)).use { socket ->
            socket.soTimeout = timeoutMs
            val data = body?.toString()?.toByteArray(Charsets.UTF_8) ?: byteArrayOf()
            val token = RuntimeFiles.token(context)
            val headers = buildString {
                append(if (body == null) "GET" else "POST")
                append(" /api/android/native$endpoint HTTP/1.1\r\nHost: 127.0.0.1:17614\r\n")
                append("X-Android-Host: $token\r\nConnection: close\r\n")
                if (body != null) append("Content-Type: application/json\r\nContent-Length: ${data.size}\r\n")
                append("\r\n")
            }
            socket.outputStream.write(headers.toByteArray(Charsets.US_ASCII))
            if (data.isNotEmpty()) socket.outputStream.write(data)
            socket.outputStream.flush()
            val response = RuntimeHttp.read(socket.inputStream)
            val json = JSONObject(response.body.toString(Charsets.UTF_8))
            if (response.status !in 200..299) throw IOException(json.optString("error", "操作失败（${response.status}）"))
            return json
        }
    }
}


