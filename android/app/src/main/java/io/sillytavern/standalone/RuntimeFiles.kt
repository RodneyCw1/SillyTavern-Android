package io.sillytavern.standalone

import android.content.Context
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.zip.ZipInputStream

object RuntimeFiles {
    const val ORIGIN = "http://127.0.0.1:17614"
    fun home(context: Context) = File(context.filesDir, "tavern").apply { mkdirs() }
    fun socketFile(context: Context) = File(home(context), "runtime.sock")
    fun token(context: Context): String = File(home(context), "host-token").readText().trim().also {
        check(it.matches(Regex("[a-f0-9]{64}"))) { "Invalid runtime token" }
    }
    fun rotateToken(context: Context): String {
        val target = File(home(context), "host-token")
        val bytes = ByteArray(32).also { SecureRandom().nextBytes(it) }
        val token = bytes.joinToString("") { "%02x".format(it) }
        val temp = File(target.parentFile, "host-token.tmp")
        try {
            temp.writeText(token)
            check(temp.renameTo(target)) { "Unable to save host token" }
        } finally { temp.delete() }
        return token
    }
    fun deploy(context: Context): File {
        val metadata = JSONObject(context.assets.open("runtime.json").bufferedReader().use { it.readText() })
        val hash = metadata.getString("runtimeSha256")
        val base = File(home(context), "runtimes").apply { mkdirs() }
        val destination = File(base, hash)
        if (File(destination, ".complete").exists()) return destination
        val staging = File(base, "$hash.staging")
        if (staging.exists()) staging.deleteRecursively()
        check(staging.mkdirs()) { "Unable to create runtime directory" }
        val digest = MessageDigest.getInstance("SHA-256")
        context.assets.open("runtime.zip").use { input ->
            val buffer = ByteArray(256 * 1024)
            while (true) {
                val length = input.read(buffer)
                if (length < 0) break
                digest.update(buffer, 0, length)
            }
        }
        check(digest.digest().joinToString("") { "%02x".format(it) } == hash) { "Runtime checksum mismatch" }
        try {
            ZipInputStream(context.assets.open("runtime.zip").buffered()).use { zip ->
                while (true) {
                    val entry = zip.nextEntry ?: break
                    val output = File(staging, entry.name)
                    check(output.canonicalPath.startsWith(staging.canonicalPath + File.separator)) { "Invalid runtime archive path" }
                    if (entry.isDirectory) output.mkdirs() else {
                        output.parentFile?.mkdirs()
                        FileOutputStream(output).use { zip.copyTo(it) }
                    }
                    zip.closeEntry()
                }
            }
            File(staging, ".complete").writeText(hash)
            if (destination.exists()) check(destination.deleteRecursively())
            check(staging.renameTo(destination)) { "Unable to activate runtime" }
            base.listFiles()?.filter { it.isDirectory && it != destination && !it.name.endsWith(".staging") }
                ?.sortedByDescending { it.lastModified() }?.drop(1)?.forEach { it.deleteRecursively() }
            return destination
        } catch (error: Throwable) { staging.deleteRecursively(); throw error }
    }
}
