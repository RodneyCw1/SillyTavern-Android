package io.sillytavern.standalone

import android.app.Application
import android.content.Context
import android.net.LocalSocket
import java.io.Closeable
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.Executors
import java.util.concurrent.Semaphore
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

class TavernApplication : Application() {
    private var gateway: LoopbackGateway? = null
    override fun onCreate() {
        super.onCreate()
        if (Application.getProcessName() == packageName) runCatching { ensureGateway() }
    }
    @Synchronized fun ensureGateway() {
        check(Application.getProcessName() == packageName) { "浏览器网关仅在主进程运行" }
        if (gateway?.isRunning == true) return
        gateway?.close()
        gateway = LoopbackGateway(this).also { it.start() }
    }
}

/** Own the browser origin before loading WebView; Node itself never listens on TCP. */
class LoopbackGateway(context: Context, private val port: Int = 17614, private val socketFile: File = RuntimeFiles.socketFile(context)) : Closeable {
    private val listener = ServerSocket()
    private val slots = Semaphore(24)
    private val workers = ThreadPoolExecutor(48, 48, 0, TimeUnit.MILLISECONDS, ArrayBlockingQueue<Runnable>(48))
    private val watchdog = Executors.newSingleThreadScheduledExecutor()
    private val sessions = ConcurrentHashMap.newKeySet<Session>()
    private val closed = AtomicBoolean(false)
    @Volatile private var acceptThread: Thread? = null
    val isRunning get() = listener.isBound && !listener.isClosed && !closed.get()
    internal val localPort get() = listener.localPort

    fun start() {
        try {
            // Allow immediate restart while retired connections are in TIME_WAIT.
            // SO_REUSEPORT remains disabled: an existing listener still wins bind.
            listener.reuseAddress = true
            listener.bind(InetSocketAddress(InetAddress.getByName("127.0.0.1"), port), 24)
        } catch (error: Throwable) { close(); throw error }
        watchdog.scheduleWithFixedDelay({
            val now = System.nanoTime()
            sessions.filter { now - it.lastActivity > TimeUnit.MINUTES.toNanos(15) }.forEach { it.close() }
        }, 30, 30, TimeUnit.SECONDS)
        val thread = Thread({
            while (!closed.get()) {
                try {
                    val client = listener.accept()
                    if (!slots.tryAcquire()) { client.close(); continue }
                    val session = Session(client)
                    sessions.add(session)
                    try { workers.execute { forward(session) } } catch (_: Exception) { session.close() }
                } catch (_: Exception) { if (!closed.get()) close(); break }
            }
        }, "SillyTavern-Loopback")
        acceptThread = thread
        thread.start()
    }

    private inner class Session(val client: Socket) : Closeable {
        @Volatile var upstream: LocalSocket? = null
        @Volatile var lastActivity = System.nanoTime()
        private val done = AtomicBoolean(false)
        override fun close() {
            if (!done.compareAndSet(false, true)) return
            runCatching { client.close() }
            runCatching { upstream?.close() }
            sessions.remove(this)
            slots.release()
        }
        fun attach(socket: LocalSocket) {
            upstream = socket
            if (done.get()) socket.close()
        }
        fun copy(input: InputStream, output: OutputStream) {
            val buffer = ByteArray(65536)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) return
                output.write(buffer, 0, count)
                lastActivity = System.nanoTime()
            }
        }
    }

    private fun forward(session: Session) {
        try {
            val client = session.client
            client.tcpNoDelay = true
            client.soTimeout = 10000
            val first = client.getInputStream().read()
            if (first < 0) { session.close(); return }
            val local = RuntimeConnection.connect(socketFile)
            session.attach(local)
            client.soTimeout = 0
            local.outputStream.write(first)
            workers.execute {
                try { session.copy(local.inputStream, client.getOutputStream()) }
                catch (_: Exception) { }
                finally { session.close() }
            }
            session.copy(client.getInputStream(), local.outputStream)
            runCatching { local.shutdownOutput() }
        } catch (_: Exception) { session.close() }
    }

    override fun close() {
        if (closed.compareAndSet(false, true)) {
            runCatching { listener.close() }
            sessions.toList().forEach { it.close() }
            watchdog.shutdownNow()
            workers.shutdownNow()
        }
        // A blocked accept can retain the listening descriptor until it unwinds.
        // Wait for that release before a caller immediately binds a replacement.
        acceptThread?.takeIf { it !== Thread.currentThread() }?.let {
            try { it.join(1000) } catch (_: InterruptedException) { Thread.currentThread().interrupt() }
        }
    }
}
