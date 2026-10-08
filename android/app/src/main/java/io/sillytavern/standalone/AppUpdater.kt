package io.sillytavern.standalone

import android.app.AlertDialog
import android.app.DownloadManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

class AppUpdater(private val activity: MainActivity, private val prepareInstall: (() -> Unit) -> Unit) {
    private val manager = activity.getSystemService(DownloadManager::class.java)
    private val prefs = activity.getSharedPreferences("app-updates", Context.MODE_PRIVATE)
    private val handler = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor()
    private val closed = AtomicBoolean(false)
    private val verifying = AtomicBoolean(false)
    private var dialog: AlertDialog? = null
    private val installedCode get() = activity.packageManager.getPackageInfo(activity.packageName, 0).longVersionCode
    private val downloadId get() = prefs.getLong("downloadId", -1)
    private fun notice(message: String) {
        if (!closed.get()) AlertDialog.Builder(activity).setTitle("应用更新").setMessage(message).setPositiveButton("确定", null).show()
    }
    private fun post(action: () -> Unit) { handler.post { if (!closed.get()) action() } }
    private fun infoJson(info: UpdateInfo) = JSONObject().put("schemaVersion", 1)
        .put("versionName", info.versionName).put("versionCode", info.versionCode)
        .put("packageName", info.packageName).put("minSdk", info.minSdk)
        .put("apkUrl", info.apkUrl).put("size", info.size).put("sha256", info.sha256)
        .put("signingSha256", info.signingSha256).put("commit", info.commit).put("notes", info.notes)
    private fun parse(text: String): UpdateInfo {
        val json = JSONObject(text)
        require(json.getInt("schemaVersion") == 1) { "更新清单格式不支持" }
        return UpdateInfo(json.getString("versionName"), json.getLong("versionCode"), json.getString("packageName"),
            json.getInt("minSdk"), json.getString("apkUrl"), json.getLong("size"), json.getString("sha256"),
            json.getString("signingSha256"), json.getString("commit"), json.optString("notes").take(12000))
    }
    private fun storedInfo() = prefs.getString("manifest", null)?.let { parse(it) }
    fun check() {
        if (BuildConfig.DEBUG) { notice("调试包请使用正式签名版本进行更新。"); return }
        if (verifying.get()) { notice("正在验证更新文件，请稍候。"); return }
        if (downloadId > 0) {
            runCatching { storedInfo() }.getOrNull()?.let { showDownload(it); return }
            cancel()
        }
        dialog?.dismiss()
        val loading = AlertDialog.Builder(activity).setTitle("检查更新").setMessage("正在读取最新版本…")
            .setNegativeButton("关闭", null).create()
        dialog = loading; loading.show()
        worker.execute {
            val result = runCatching { parse(fetchManifest()).also { UpdatePolicy.validate(it, Build.VERSION.SDK_INT) } }
            post {
                if (!loading.isShowing) return@post
                loading.dismiss()
                result.fold({ info ->
                    if (info.versionCode <= installedCode) notice("当前版本 ${BuildConfig.VERSION_NAME} 已是最新版本。")
                    else AlertDialog.Builder(activity).setTitle("发现新版本 ${info.versionName}")
                        .setMessage("当前版本：${BuildConfig.VERSION_NAME}\n下载大小：${info.size / 1024 / 1024} MB\n\n${info.notes.take(3000)}")
                        .setNegativeButton("稍后", null).setPositiveButton("下载") { _, _ -> startDownload(info) }.show()
                }, { notice("检查更新失败：${it.message}\n请检查网络后重试。") })
            }
        }
    }
    private fun fetchManifest(): String {
        var url = URL(UpdatePolicy.MANIFEST)
        repeat(6) {
            val uri = url.toURI()
            require(uri.scheme == "https" && (uri.host == "github.com" || uri.host?.endsWith(".githubusercontent.com") == true)) { "更新服务重定向地址无效" }
            val connection = url.openConnection() as HttpURLConnection
            try {
                connection.instanceFollowRedirects = false
                connection.connectTimeout = 15000; connection.readTimeout = 15000
                connection.setRequestProperty("Accept", "application/json")
                connection.setRequestProperty("User-Agent", "SillyTavern-Android/" + BuildConfig.VERSION_NAME)
                val code = connection.responseCode
                if (code in listOf(301, 302, 303, 307, 308)) {
                    url = URL(url, connection.getHeaderField("Location") ?: error("更新服务重定向失败"))
                } else {
                    require(code == 200) { "更新服务返回 HTTP $code" }
                    val output = ByteArrayOutputStream()
                    connection.inputStream.use { input ->
                        val buffer = ByteArray(8192)
                        while (true) {
                            val count = input.read(buffer); if (count < 0) break
                            require(output.size() + count <= 65536) { "更新清单过大" }
                            output.write(buffer, 0, count)
                        }
                    }
                    return output.toString("UTF-8")
                }
            } finally { connection.disconnect() }
        }
        error("更新服务重定向次数过多")
    }
    private fun externalFile(info: UpdateInfo) = File(activity.getExternalFilesDir("updates") ?: error("下载目录不可用"), "update-${info.versionCode}.apk")
    private fun verifiedFile(info: UpdateInfo) = File(File(activity.cacheDir, "updates"), "${info.versionCode}-${info.sha256.take(12)}.apk")
    private fun startDownload(info: UpdateInfo) {
        runCatching {
            UpdatePolicy.validate(info, Build.VERSION.SDK_INT); UpdatePolicy.requireUpgrade(info, installedCode)
            val file = externalFile(info); file.parentFile?.mkdirs(); if (file.exists()) check(file.delete())
            val request = DownloadManager.Request(Uri.parse(info.apkUrl))
                .setTitle("SillyTavern ${info.versionName}").setDescription("应用更新")
                .setMimeType("application/vnd.android.package-archive").setAllowedOverMetered(true)
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                .setDestinationInExternalFilesDir(activity, "updates", file.name)
            val id = manager.enqueue(request)
            if (!prefs.edit().putString("manifest", infoJson(info).toString()).putLong("downloadId", id).commit()) {
                manager.remove(id); error("无法保存下载状态")
            }
            showDownload(info)
        }.onFailure { notice("无法开始下载：${it.message}") }
    }
    private fun showDownload(info: UpdateInfo) {
        dialog?.dismiss()
        val layout = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL; setPadding(40, 20, 40, 20) }
        val label = TextView(activity).apply { text = "正在读取下载状态…" }
        val progress = ProgressBar(activity, null, android.R.attr.progressBarStyleHorizontal).apply { max = 100 }
        layout.addView(label); layout.addView(progress)
        val current = AlertDialog.Builder(activity).setTitle("更新 ${info.versionName}").setView(layout)
            .setNegativeButton("取消下载") { _, _ -> cancel() }.setNeutralButton("后台下载", null).create()
        dialog = current; current.show()
        fun tick() {
            if (closed.get() || !current.isShowing || downloadId < 0) return
            runCatching {
                manager.query(DownloadManager.Query().setFilterById(downloadId)).use { cursor ->
                    require(cursor.moveToFirst()) { "下载记录不存在，请重新下载" }
                    val state = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))
                    val bytes = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR))
                    val total = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES))
                    progress.isIndeterminate = total <= 0
                    if (total > 0) progress.progress = ((bytes * 100 / total).coerceIn(0, 100)).toInt()
                    label.text = when (state) {
                        DownloadManager.STATUS_PAUSED -> "等待网络或系统恢复下载…"
                        DownloadManager.STATUS_PENDING -> "等待开始下载…"
                        else -> "${bytes / 1024 / 1024} / ${info.size / 1024 / 1024} MB"
                    }
                    if (state == DownloadManager.STATUS_FAILED) error("系统下载失败（${cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON))}），请重试")
                    if (state == DownloadManager.STATUS_SUCCESSFUL) {
                        current.dismiss(); verifyDownload(info); return
                    }
                }
            }.onFailure { current.dismiss(); cancel(); notice("下载失败：${it.message}") }
            if (current.isShowing) handler.postDelayed({ tick() }, 500)
        }
        tick()
    }
    private fun verifyApk(file: File, info: UpdateInfo) {
        UpdatePolicy.validate(info, Build.VERSION.SDK_INT); UpdatePolicy.requireUpgrade(info, installedCode)
        UpdatePolicy.verifyFile(file, info)
        val archive = activity.packageManager.getPackageArchiveInfo(file.absolutePath, PackageManager.GET_SIGNING_CERTIFICATES)
            ?: error("更新文件不是有效 APK")
        require(archive.packageName == UpdatePolicy.PACKAGE && archive.longVersionCode == info.versionCode
            && archive.versionName == info.versionName && archive.applicationInfo!!.minSdkVersion == info.minSdk) { "APK 版本信息与更新清单不一致" }
        fun signers(signing: android.content.pm.SigningInfo?) = signing?.apkContentsSigners?.map {
            UpdatePolicy.hex(MessageDigest.getInstance("SHA-256").digest(it.toByteArray()))
        }?.toSet() ?: emptySet()
        val expected = setOf(UpdatePolicy.CERTIFICATE)
        val installed = activity.packageManager.getPackageInfo(activity.packageName, PackageManager.GET_SIGNING_CERTIFICATES)
        require(signers(archive.signingInfo) == expected && signers(installed.signingInfo) == expected) { "APK 签名与已安装版本不一致" }
    }
    private fun verifyDownload(info: UpdateInfo) {
        if (!verifying.compareAndSet(false, true)) return
        val id = downloadId
        val checking = AlertDialog.Builder(activity).setTitle("验证更新").setMessage("正在验证文件完整性与原版签名…").create()
        dialog = checking; checking.show()
        worker.execute {
            val result = runCatching {
                val source = externalFile(info); val target = verifiedFile(info)
                target.parentFile?.mkdirs()
                val temp = File(target.parentFile, target.name + ".pending")
                try {
                    require(source.length() == info.size) { "下载文件大小不匹配" }
                    source.inputStream().buffered().use { input ->
                        java.io.FileOutputStream(temp).use { output ->
                            val buffer = ByteArray(256 * 1024); var bytes = 0L
                            while (true) {
                                val n = input.read(buffer); if (n < 0) break
                                bytes += n; require(bytes <= info.size) { "下载文件大小不匹配" }
                                output.write(buffer, 0, n)
                            }
                            output.fd.sync()
                        }
                    }
                    verifyApk(temp, info)
                    require(downloadId == id) { "下载已取消" }
                    if (target.exists()) require(target.delete())
                    require(temp.renameTo(target)) { "无法保存已验证更新" }
                    target
                } finally { temp.delete() }
            }
            verifying.set(false)
            post {
                checking.dismiss()
                result.fold({ showReady(info) }, { cancel(); notice("更新验证失败：${it.message}") })
            }
        }
    }
    private fun showReady(info: UpdateInfo) {
        AlertDialog.Builder(activity).setTitle("更新已准备好")
            .setMessage("${info.versionName}\n安装前会保存当前内容，随后打开 Android 安装确认界面。")
            .setNegativeButton("稍后", null).setPositiveButton("安装") { _, _ -> requestInstall(info) }.show()
    }
    private fun requestInstall(info: UpdateInfo) {
        if (!activity.packageManager.canRequestPackageInstalls()) {
            prefs.edit().putBoolean("permissionPending", true).commit()
            runCatching {
                activity.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + activity.packageName)))
            }.onFailure { prefs.edit().remove("permissionPending").apply(); notice("无法打开安装授权设置：${it.message}") }
            return
        }
        val wait = AlertDialog.Builder(activity).setTitle("准备安装").setMessage("正在再次核对更新包…").create()
        dialog = wait; wait.show()
        worker.execute {
            val result = runCatching { val file = verifiedFile(info); verifyApk(file, info); file }
            post {
                wait.dismiss()
                result.fold({ file ->
                    prepareInstall {
                        runCatching {
                            val uri = FileProvider.getUriForFile(activity, activity.packageName + ".updates", file)
                            activity.startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
                                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION))
                        }.onFailure { notice("无法启动系统安装：${it.message}") }
                    }
                }, { notice("安装前验证失败：${it.message}") })
            }
        }
    }
    fun onResume() {
        val info = runCatching { storedInfo() }.getOrNull()
        if (info != null && installedCode >= info.versionCode) { cancel(); return }
        if (prefs.getBoolean("permissionPending", false)) {
            prefs.edit().remove("permissionPending").commit()
            if (info != null && activity.packageManager.canRequestPackageInstalls()) requestInstall(info)
            else Toast.makeText(activity, "未授权安装，更新文件已保留，可稍后重试。", Toast.LENGTH_LONG).show()
        }
    }
    private fun cancel() {
        val info = runCatching { storedInfo() }.getOrNull()
        val id = downloadId
        prefs.edit().clear().commit()
        if (id > 0) runCatching { manager.remove(id) }
        if (info != null) runCatching { verifiedFile(info).delete() }
    }
    fun close() {
        closed.set(true); handler.removeCallbacksAndMessages(null); dialog?.dismiss(); worker.shutdownNow()
    }
}
