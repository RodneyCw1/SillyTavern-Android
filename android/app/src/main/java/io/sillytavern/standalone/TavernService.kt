package io.sillytavern.standalone

import android.app.*
import android.content.Intent
import android.os.*
import androidx.core.app.NotificationCompat
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

object NodeRuntime {
    init { System.loadLibrary("node"); System.loadLibrary("tavern_node") }
    external fun start(arguments: Array<String>, logPath: String): Int
}
class TavernService : Service() {
    private val worker = Executors.newScheduledThreadPool(2)
    private lateinit var manager: NotificationManager
    private lateinit var wakeLock: PowerManager.WakeLock
    private var started = false
    private var lastTitle = ""
    private val seen = mutableSetOf<String>()
    override fun onBind(intent: Intent?) = null
    override fun onCreate() {
        super.onCreate()
        manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel("runtime", "酒馆运行状态", NotificationManager.IMPORTANCE_LOW))
        manager.createNotificationChannel(NotificationChannel("generation", "回复完成", NotificationManager.IMPORTANCE_DEFAULT))
        wakeLock = getSystemService(PowerManager::class.java).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, packageName + ":generation")
        wakeLock.setReferenceCounted(false)
        seen.addAll(getSharedPreferences("notifications", MODE_PRIVATE).getStringSet("seen", emptySet()) ?: emptySet())
        startForeground(1001, notification("正在启动酒馆…", "runtime"))
    }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == "stop") { stopSelf(); return START_NOT_STICKY }
        if (!started) {
            started = true
            worker.execute {
                try {
                    val home = RuntimeFiles.home(this)
                    val token = RuntimeFiles.rotateToken(this)
                    val runtime = RuntimeFiles.deploy(this)
                    ImportStager(File(home, "imports")).cleanupStale()
                    DownloadStore(cacheDir).cancelAll() // Reclaim exports left by older app versions.
                    DownloadStore(File(cacheDir, "exports")).cancelAll()
                    File(home, "startup-error.txt").delete()
                    Thread({
                        try {
                            val exit = NodeRuntime.start(arrayOf("node", File(runtime, "run-android.js").absolutePath, home.absolutePath, token), File(home, "runtime.log").absolutePath)
                            if (!File(home, "startup-error.txt").exists()) File(home, "startup-error.txt").writeText("运行服务已退出，退出码 $exit")
                        } catch (error: Throwable) {
                            File(home, "startup-error.txt").writeText(error.toString())
                        }
                    }, "SillyTavern-Node").start()
                    worker.scheduleWithFixedDelay({ poll() }, 1, 2, TimeUnit.SECONDS)
                } catch (error: Throwable) {
                    File(RuntimeFiles.home(this), "startup-error.txt").writeText(error.toString())
                    manager.notify(1001, notification("启动失败，请打开应用查看", "runtime"))
                }
            }
        }
        return START_NOT_STICKY
    }
    private fun notification(title: String, channel: String): Notification {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        return NotificationCompat.Builder(this, channel).setSmallIcon(R.drawable.ic_tavern)
            .setContentTitle(title).setContentText("SillyTavern 独立版")
            .setContentIntent(open).setOngoing(channel == "runtime").setOnlyAlertOnce(channel == "runtime").setAutoCancel(channel != "runtime").build()
    }
    private fun poll() {
        try {
            val status = RuntimeConnection.request(this, "/status", timeoutMs = 1500)
            val active = status.optInt("active")
            if (active > 0 && !wakeLock.isHeld) wakeLock.acquire(10 * 60 * 1000L)
            if (active == 0 && wakeLock.isHeld) wakeLock.release()
            val title = if (active > 0) "正在生成回复…" else "酒馆已就绪"
            if (lastTitle != title) { manager.notify(1001, notification(title, "runtime")); lastTitle = title }
            val results = status.optJSONArray("results") ?: return
            for (i in 0 until results.length()) {
                val result = results.getJSONObject(i)
                val id = result.getString("id")
                if (seen.add(id)) {
                    while (seen.size > 200) seen.remove(seen.first())
                    val text = if (result.getString("state") == "complete") "回复已保存，点击查看" else "生成已结束，点击查看结果"
                    manager.notify(1002, notification(text, "generation"))
                    getSharedPreferences("notifications", MODE_PRIVATE).edit().putStringSet("seen", seen.toList().takeLast(200).toSet()).apply()
                }
            }
        } catch (_: Exception) { /* Startup or a transient network transition; the next poll retries. */ }
    }
    override fun onDestroy() {
        worker.shutdownNow()
        if (::wakeLock.isInitialized && wakeLock.isHeld) wakeLock.release()
        stopForeground(STOP_FOREGROUND_REMOVE)
        super.onDestroy()
        Process.killProcess(Process.myPid())
    }
}
