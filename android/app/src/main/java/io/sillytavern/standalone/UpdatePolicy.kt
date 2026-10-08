package io.sillytavern.standalone

import java.io.File
import java.net.URI
import java.security.MessageDigest

data class UpdateInfo(
    val versionName: String, val versionCode: Long, val packageName: String,
    val minSdk: Int, val apkUrl: String, val size: Long, val sha256: String,
    val signingSha256: String, val commit: String, val notes: String,
)

object UpdatePolicy {
    const val PACKAGE = "io.sillytavern.standalone"
    const val CERTIFICATE = "c1b898bcbe03fc7991fe77a0fbe559f0da86667036850a917c2e45839070799f"
    const val MANIFEST = "https://github.com/RodneyCw1/SillyTavern-Android/releases/latest/download/update.json"
    fun validate(info: UpdateInfo, sdk: Int) {
        require(info.packageName == PACKAGE) { "更新包的应用标识不匹配" }
        require(info.versionCode in 8..2100000000L) { "更新版本编号无效" }
        require(info.versionName.matches(Regex("[\\w.+-]{1,100}"))) { "更新版本名无效" }
        require(info.minSdk in 29..sdk) { "当前 Android 版本不支持该更新" }
        require(info.size in 1..2147483648L) { "更新文件大小无效" }
        require(info.sha256.matches(Regex("[a-f0-9]{64}"))) { "更新校验值无效" }
        require(info.signingSha256 == CERTIFICATE) { "更新签名与原版不匹配" }
        require(info.commit.matches(Regex("[a-f0-9]{40}"))) { "更新提交标识无效" }
        val uri = URI(info.apkUrl)
        require(uri.scheme == "https" && uri.host == "github.com" && uri.port == -1
            && uri.userInfo == null && uri.rawQuery == null && uri.fragment == null
            && uri.path.startsWith("/RodneyCw1/SillyTavern-Android/releases/download/")
            && uri.path.endsWith(".apk") && uri.path.split('/').none { it == "." || it == ".." }) { "更新下载地址无效" }
    }
    fun requireIdle(ready: Boolean, importing: Boolean, activeJobs: Int, pendingSaves: Int, pendingJobWrites: Int) {
        require(ready && !importing && activeJobs == 0 && pendingSaves == 0 && pendingJobWrites == 0) {
            "后台聊天、保存或导入尚未结束，请稍后安装更新"
        }
    }
    fun requireUpgrade(info: UpdateInfo, installedCode: Long) {
        require(info.versionCode > installedCode) { "该版本不是更新版本" }
    }
    fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().buffered().use { input ->
            val buffer = ByteArray(256 * 1024)
            while (true) { val n = input.read(buffer); if (n < 0) break; digest.update(buffer, 0, n) }
        }
        return hex(digest.digest())
    }
    fun verifyFile(file: File, info: UpdateInfo) {
        require(file.length() == info.size) { "更新文件不完整，请重新下载" }
        require(sha256(file) == info.sha256) { "更新文件校验失败，请重新下载" }
    }
    fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it) }
}
