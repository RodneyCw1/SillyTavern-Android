package io.sillytavern.standalone

import android.Manifest
import android.app.AlertDialog
import android.content.*
import android.graphics.Color
import android.net.Uri
import android.os.*
import android.provider.MediaStore
import android.view.View
import android.webkit.*
import android.widget.*
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import java.io.File
import java.io.InputStream
import java.io.IOException
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import java.util.concurrent.Executors

class MainActivity : ComponentActivity() {
    private lateinit var web: WebView
    private lateinit var status: TextView
    private val handler = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()
    private var startedAt = 0L
    private var runtimeEpoch = 0
    private var importing = false
    private val closing = AtomicBoolean(false)
    private val importInput = AtomicReference<InputStream?>(null)
    private var loaded = false
    private var rendererGone = false
    private var webViewReady = true
    private var choosing: ValueCallback<Array<Uri>>? = null
    private val updater by lazy { AppUpdater(this, ::prepareUpdateInstall) }
    private var updateInstall: (() -> Unit)? = null
    private var updateNonce: String? = null
    private val downloads by lazy { SerialDownloads(File(cacheDir, "exports")) }
    private val filePicker = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        choosing?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data)); choosing = null
    }
    private val migrationPicker = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) AlertDialog.Builder(this).setTitle("导入个人数据")
            .setMessage("这会替换当前角色、聊天和设置。现有数据会先备份，已安装插件和手机上的密钥会保留。")
            .setNegativeButton("取消", null).setPositiveButton("导入") { _, _ -> importMigration(uri) }.show()
    }
    private val permissionPicker = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        val root = FrameLayout(this).apply { setBackgroundColor(Color.rgb(24, 26, 32)) }
        val content = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        root.addView(content, FrameLayout.LayoutParams(-1, -1))
        status = TextView(this).apply { setTextColor(Color.WHITE); text = "正在准备独立运行环境，首次启动需要解压资源…"; setPadding(16, 12, 16, 12) }
        content.addView(status)
        web = WebView(this)
        content.addView(web, LinearLayout.LayoutParams(-1, 0, 1f))
        val controls = AppControls(this, root) { action ->
            if (action == "update") updater.check() else requestLifecycle(action)
        }
        setContentView(root)
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val keyboard = insets.getInsets(WindowInsetsCompat.Type.ime())
            view.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, keyboard.bottom))
            view.post { controls.reposition() }
            insets
        }
        web.setBackgroundColor(Color.rgb(24, 26, 32))
        with(web.settings) {
            javaScriptEnabled = true; domStorageEnabled = true; databaseEnabled = true
            allowFileAccess = false; allowContentAccess = true
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            mediaPlaybackRequiresUserGesture = true
            setSupportMultipleWindows(false)
        }
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        CookieManager.getInstance().setAcceptCookie(true)
        web.webViewClient = object : WebViewClient() {
            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                rendererGone = true; loaded = true
                (view.parent as? android.view.ViewGroup)?.removeView(view)
                choosing = null
                downloads.close()
                view.destroy()
                status.visibility = View.VISIBLE
                status.text = "页面进程已停止（内存回收或浏览器异常）。后台服务仍独立运行，已接收的生成结果会保留。点击这里重新打开页面。"
                status.setOnClickListener { recreate() }
                return true
            }
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url
                if (isLocal(url)) return false
                if (request.isForMainFrame) {
                    if (url.scheme == "https" || url.scheme == "http") runCatching { startActivity(Intent(Intent.ACTION_VIEW, url)) }
                    return true
                }
                return false
            }
            override fun onReceivedSslError(view: WebView?, handle: SslErrorHandler?, error: android.net.http.SslError?) { handle?.cancel() }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                choosing?.onReceiveValue(null); choosing = callback
                return try { filePicker.launch(params.createIntent()); true } catch (_: Exception) { choosing?.onReceiveValue(null); choosing = null; false }
            }
            override fun onConsoleMessage(message: ConsoleMessage): Boolean {
                if (message.messageLevel() == ConsoleMessage.MessageLevel.ERROR) android.util.Log.e("ST-WebView", message.message())
                return true
            }
        }
        val browserVersion = WebViewCompat.getCurrentWebViewPackage(this)?.versionName.orEmpty()
        val browserMajor = browserVersion.substringBefore(".").toIntOrNull() ?: 0
        webViewReady = browserMajor >= 120 && WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)
        if (webViewReady) {
            WebViewCompat.addWebMessageListener(web, "AndroidHost", setOf(RuntimeFiles.ORIGIN)) { _, message, origin, mainFrame, reply ->
                if (!mainFrame || !isLocal(origin)) return@addWebMessageListener
                var id = ""
                try {
                    val input = JSONObject(message.data ?: "")
                    id = input.getString("id")
                    if (input.getString("method").startsWith("download.")) {
                        val messageId = id
                        downloads.submit { store ->
                            val result = runCatching { handleDownloadMessage(store, input) }
                            handler.post {
                                if (!closing.get() && !rendererGone) runCatching { reply.postMessage(hostReply(messageId, result)) }
                            }
                        }
                    } else {
                        reply.postMessage(hostReply(id, runCatching { handleHostMessage(input) }))
                    }
                } catch (error: Exception) {
                    reply.postMessage(JSONObject().put("id", id).put("ok", false).put("error", error.message).toString())
                }
            }
        } else {
            status.text = "当前 WebView " + browserVersion + " 版本过旧。请点击这里更新 Android System WebView（需要 120 或更新版本），更新后重新打开应用。"
            status.setOnClickListener {
                val address = Uri.parse("https://play.google.com/store/apps/details?id=com.google.android.webview")
                runCatching { startActivity(Intent(Intent.ACTION_VIEW, address)) }
            }
        }
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (rendererGone) { moveTaskToBack(true); return }
                web.evaluateJavascript("window.STAndroid?.back?.() || false") { consumed ->
                    if (consumed != "true") moveTaskToBack(true)
                }
            }
        })
        if (Build.VERSION.SDK_INT >= 33) permissionPicker.launch(Manifest.permission.POST_NOTIFICATIONS)
        startRuntime()
    }
    private fun isLocal(uri: Uri) = uri.scheme == "http" && uri.host == "127.0.0.1" && uri.port == 17614
    private fun startRuntime() {
        loaded = false; startedAt = System.currentTimeMillis(); runtimeEpoch++
        status.visibility = View.VISIBLE
        try { (application as TavernApplication).ensureGateway() }
        catch (_: Exception) { status.text = "本机 17614 端口被占用，已停止启动以保护本地数据。关闭占用端口的应用后点击重启。"; return }
        ContextCompat.startForegroundService(this, Intent(this, TavernService::class.java))
        pollReady()
    }
    private fun pollReady() {
        if (isFinishing || isDestroyed || loaded) return
        val epoch = runtimeEpoch
        io.execute {
            val result = runCatching { nativeRequest("/status") }
            handler.post {
                if (isFinishing || isDestroyed || epoch != runtimeEpoch) return@post
                if (result.getOrNull()?.optBoolean("ready") == true) {
                    loaded = true
                    if (webViewReady) {
                        try {
                            (application as TavernApplication).ensureGateway()
                            val token = RuntimeFiles.token(this)
                            CookieManager.getInstance().setCookie(RuntimeFiles.ORIGIN, "st_android_auth=$token; Path=/; HttpOnly; SameSite=Strict") { accepted ->
                                if (epoch == runtimeEpoch && !closing.get() && accepted) {
                                    CookieManager.getInstance().flush()
                                    status.visibility = View.GONE
                                    web.loadUrl(RuntimeFiles.ORIGIN + "/")
                                }
                            }
                        } catch (error: Exception) { status.text = "无法安全连接本地服务：" + error.message }
                    }
                } else {
                    val error = File(RuntimeFiles.home(this), "startup-error.txt")
                    if (!webViewReady) { /* Keep the browser update instruction visible. */ }
                    else if (error.exists()) status.text = "启动失败：\n" + error.readText().take(3000)
                    else if (System.currentTimeMillis() - startedAt > 120000) status.text = "启动时间较长，请稍候；可点击重启重试。"
                    handler.postDelayed({ pollReady() }, 1000)
                }
            }
        }
    }
    private fun nativeRequest(endpoint: String, body: JSONObject? = null): JSONObject =
        RuntimeConnection.request(this, endpoint, body, if (body != null) 10 * 60 * 1000 else 2000)

    private fun importMigration(uri: Uri) {
        if (!loaded || importing) { status.text = "请等待运行环境就绪或当前导入完成。"; return }
        importing = true
        status.visibility = View.VISIBLE; status.text = "正在校验并导入数据，请勿退出应用…"
        io.execute {
            val result = runCatching {
                val input = contentResolver.openInputStream(uri) ?: error("无法读取导入文件")
                importInput.set(input)
                val staged = try {
                    input.use { ImportStager(File(RuntimeFiles.home(this), "imports")).stage(it) { closing.get() } }
                } finally { importInput.compareAndSet(input, null) }
                staged.use {
                    if (closing.get()) throw IOException("导入已取消")
                    nativeRequest("/import", JSONObject().put("id", it.id))
                }
            }
            handler.post {
                if (closing.get()) return@post
                importing = false
                result.onSuccess { status.text = "导入完成，正在重启…"; restart(forceRuntimeRestart = true) }
                    .onFailure { status.text = "导入未完成：" + it.message }
            }
        }
    }
    private fun restart(forceRuntimeRestart: Boolean = false) {
        val accepted = executeRuntimeRestart(
            importing = importing,
            forceRuntimeRestart = forceRuntimeRestart,
            rendererGone = { rendererGone },
            prepareAndStop = { clearWebView ->
                runtimeEpoch++
                if (clearWebView) web.loadUrl("about:blank")
                stopService(Intent(this, TavernService::class.java))
                loaded = true
                status.visibility = View.VISIBLE; status.text = "正在重启…"
            },
            schedule = { action -> handler.postDelayed({ action() }, 1200) },
            recreate = { recreate() },
            start = { startRuntime() },
        )
        if (!accepted) status.text = "导入进行中，请等待完成后重启。"
    }
    private fun checkUpdateRuntime(nonce: String, beforeSave: Boolean = false, ready: () -> Unit) {
        io.execute {
            val result = runCatching {
                val state = nativeRequest("/status")
                UpdatePolicy.requireIdle(state.optBoolean("ready"), state.optBoolean("migrating"),
                    state.optInt("active", -1), if (beforeSave) 0 else state.optInt("pendingSaves", -1),
                    if (beforeSave) 0 else state.optJSONObject("memory")?.optInt("pendingWrites", -1) ?: -1)
            }
            handler.post {
                if (closing.get() || updateNonce != nonce) return@post
                if (importing || rendererGone || !webViewReady || result.isFailure) {
                    updateInstall = null; updateNonce = null
                    status.visibility = View.VISIBLE
                    status.text = result.exceptionOrNull()?.message ?: "页面或导入状态已变化，已取消安装更新。"
                } else ready()
            }
        }
    }
    private fun prepareUpdateInstall(install: () -> Unit) {
        if (importing || updateInstall != null || !loaded || rendererGone || !webViewReady) {
            AlertDialog.Builder(this).setTitle("暂时无法安装").setMessage("请等待页面、聊天及数据导入完成后再安装更新。").setPositiveButton("确定", null).show()
            return
        }
        val nonce = java.util.UUID.randomUUID().toString()
        updateInstall = install; updateNonce = nonce
        status.visibility = View.VISIBLE; status.text = "正在保存内容，准备安装更新…"
        handler.postDelayed({
            if (updateNonce == nonce) {
                updateInstall = null; updateNonce = null
                status.text = "保存确认超时，已取消安装；请稍后重试。"
            }
        }, 30000)
        checkUpdateRuntime(nonce, beforeSave = true) {
            web.evaluateJavascript("window.STAndroid?.prepareUpdateInstall(" + JSONObject.quote(nonce) + ") || false") { accepted ->
                if (accepted != "true" && updateNonce == nonce) {
                    updateInstall = null; updateNonce = null
                    status.text = "页面未能确认保存，已取消安装更新。"
                }
            }
        }
    }
    private fun requestLifecycle(action: String) {
        if (importing) { status.text = "导入进行中，请等待完成。"; return }
        fun proceed() {
            if (action == "restart") restart()
            else { stopService(Intent(this, TavernService::class.java)); finish() }
        }
        if (!loaded || rendererGone || !webViewReady) { proceed(); return }
        status.visibility = View.VISIBLE; status.text = "正在保存设置，请稍候…"
        web.evaluateJavascript("window.STAndroid?.prepareLifecycle('$action') || false") { accepted ->
            if (accepted != "true") proceed()
        }
    }
    private fun hostReply(id: String, result: Result<Any>): String = result.fold(
        { JSONObject().put("id", id).put("ok", true).put("result", it).toString() },
        { JSONObject().put("id", id).put("ok", false).put("error", it.message).toString() }
    )
    private fun handleHostMessage(input: JSONObject): Any {
        when (input.getString("method")) {
            "runtime.update-ready" -> {
                check(!importing && !rendererGone && webViewReady) { "页面或导入状态已变化，请稍后重试" }
                check(updateNonce != null && input.optJSONObject("data")?.optString("nonce") == updateNonce) { "无有效的安装请求" }
                val nonce = updateNonce ?: error("安装请求已取消")
                checkUpdateRuntime(nonce) {
                    val install = updateInstall ?: return@checkUpdateRuntime
                    updateInstall = null; updateNonce = null
                    status.visibility = View.GONE; install()
                }
                return true
            }
            "runtime.restart" -> { handler.post { restart() }; return true }
            "runtime.exit" -> { handler.post { stopService(Intent(this, TavernService::class.java)); finish() }; return true }
            "runtime.save-failed" -> { updateInstall = null; updateNonce = null; status.text = "保存失败，已取消退出、重启或安装更新。请重试保存后再操作。"; return true }
        }
        check(input.getString("method") == "clipboard.write") { "不支持的原生操作" }
        val data = input.optJSONObject("data") ?: JSONObject()
        getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("SillyTavern", data.getString("text")))
        return true
    }
    private fun handleDownloadMessage(store: DownloadStore, input: JSONObject): Any {
        val data = input.optJSONObject("data") ?: JSONObject()
        return when (input.getString("method")) {
            "download.begin" -> store.begin(data.optString("name", "sillytavern-export"), data.optString("mime", "application/octet-stream"))
            "download.chunk" -> {
                val encoded = data.getString("base64")
                check(encoded.length <= 90000) { "导出数据块过大" }
                store.chunk(data.getString("downloadId"), android.util.Base64.decode(encoded, android.util.Base64.DEFAULT))
                true
            }
            "download.cancel" -> { store.cancel(data.getString("downloadId")); true }
            "download.finish" -> {
                store.finish(data.getString("downloadId")) { source, requestedName, mime ->
                    val name = File(requestedName).name.map { if (it in "\\/:*?\"<>|" || it.code < 32) '_' else it }.joinToString("").take(180).ifBlank { "sillytavern-export" }
                    val values = ContentValues().apply {
                        put(MediaStore.Downloads.DISPLAY_NAME, name)
                        put(MediaStore.Downloads.MIME_TYPE, mime)
                        put(MediaStore.Downloads.RELATIVE_PATH, "Download/SillyTavern")
                        put(MediaStore.Downloads.IS_PENDING, 1)
                    }
                    val uri = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: error("无法创建下载文件")
                    try {
                        (contentResolver.openOutputStream(uri) ?: error("无法写入下载文件")).use { output ->
                            source.use { input ->
                                val buffer = ByteArray(65536)
                                while (true) {
                                    if (downloads.cancelled) throw IOException("导出已取消")
                                    val count = input.read(buffer)
                                    if (count < 0) break
                                    output.write(buffer, 0, count)
                                }
                            }
                        }
                        if (downloads.cancelled) throw IOException("导出已取消")
                        values.clear(); values.put(MediaStore.Downloads.IS_PENDING, 0)
                        check(contentResolver.update(uri, values, null, null) > 0) { "无法完成下载文件" }
                    } catch (error: Throwable) { runCatching { contentResolver.delete(uri, null, null) }; throw error }
                }
                handler.post { if (!closing.get() && !rendererGone) Toast.makeText(this, "已保存到 Download/SillyTavern", Toast.LENGTH_LONG).show() }
                true
            }
            else -> error("不支持的原生操作")
        }
    }
    override fun onResume() {
        super.onResume()
        updater.onResume()
        getSystemService(android.app.NotificationManager::class.java).cancel(1002)
        if (::web.isInitialized && !rendererGone) web.onResume()
    }
    override fun onDestroy() {
        closing.set(true)
        updateInstall = null; updateNonce = null
        updater.close()
        handler.removeCallbacksAndMessages(null)
        io.shutdownNow()
        importInput.getAndSet(null)?.let { input -> Thread({ runCatching { input.close() } }, "SillyTavern-ImportCancel").start() }
        choosing?.onReceiveValue(null)
        downloads.close()
        if (::web.isInitialized && !rendererGone) web.destroy()
        super.onDestroy()
    }
}
