package io.sillytavern.standalone

import java.io.Closeable
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.io.RandomAccessFile
import java.nio.channels.FileLock
import java.nio.channels.OverlappingFileLockException
import java.util.UUID
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.Callable
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Future
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

// Lock a byte beyond the largest allowed payload. This remains an exclusive
// kernel lock while allowing ordinary readers on Windows JVM regression runs.
private const val LEASE_OFFSET = 4L * 1024 * 1024 * 1024
private object TransferLocks {
    private val monitors = ConcurrentHashMap<String, Any>()
    private val owned = ConcurrentHashMap.newKeySet<String>()
    fun <T> directory(directory: File, action: () -> T): T {
        directory.mkdirs()
        return synchronized(monitors.computeIfAbsent(directory.canonicalPath) { Any() }) {
            RandomAccessFile(File(directory, ".transfer.guard"), "rw").use { guard ->
                guard.channel.lock().use { action() }
            }
        }
    }
    fun create(directory: File, name: String): FileLease = directory(directory) {
        val file = File(directory, name)
        if (!file.createNewFile()) throw IOException("无法创建临时文件")
        val handle = try { RandomAccessFile(file, "rw") } catch (error: Throwable) { file.delete(); throw error }
        try {
            val lease = FileLease(file, handle, handle.channel.lock(LEASE_OFFSET, 1, false))
            owned.add(file.canonicalPath)
            lease
        }
        catch (error: Throwable) { handle.close(); file.delete(); throw error }
    }
    fun cleanup(directory: File, matches: (File) -> Boolean) = directory(directory) {
        directory.listFiles()?.filter { it.isFile && matches(it) }?.forEach { file ->
            // Closing any descriptor can drop this process's POSIX file locks.
            // Do not even open a second descriptor for a lease owned in this JVM.
            if (file.canonicalPath in owned) return@forEach
            var available = false
            RandomAccessFile(file, "rw").use { handle ->
                try {
                    handle.channel.tryLock(LEASE_OFFSET, 1, false)?.use { available = true }
                } catch (_: OverlappingFileLockException) { /* Another owner in this JVM. */ }
            }
            if (available) file.delete()
        }
    }
    fun release(file: File) { owned.remove(file.canonicalPath) }
}

private class FileLease(val file: File, val handle: RandomAccessFile, private val lock: FileLock) : Closeable {
    private val closed = AtomicBoolean(false)
    override fun close() = TransferLocks.directory(file.parentFile!!) {
        if (closed.compareAndSet(false, true)) {
            try { lock.release() } finally {
                try { handle.close() } finally { file.delete(); TransferLocks.release(file) }
            }
        }
    }
    fun input(): InputStream {
        handle.seek(0)
        return object : InputStream() {
            override fun read() = handle.read()
            override fun read(buffer: ByteArray, offset: Int, length: Int) = handle.read(buffer, offset, length)
            // The lease owns this descriptor; closing a second descriptor could
            // release process-associated file locks on POSIX systems.
            override fun close() { }
        }
    }
}

class StagedImport(val id: String, val file: File, private val release: () -> Unit) : Closeable {
    override fun close() = release()
}

class ImportStager(
    private val directory: File,
    private val maxBytes: Long = 4L * 1024 * 1024 * 1024,
    private val reserveBytes: Long = 64L * 1024 * 1024,
    private val availableBytes: () -> Long = { directory.usableSpace },
) {
    fun stage(input: InputStream, cancelled: () -> Boolean = { false }): StagedImport {
        if (!directory.isDirectory && !directory.mkdirs()) throw IOException("无法创建导入目录")
        val id = UUID.randomUUID().toString().replace("-", "")
        val lease = TransferLocks.create(directory, "$id.zip")
        val staged = StagedImport(id, lease.file) { lease.close() }
        try {
            run {
                val buffer = ByteArray(64 * 1024)
                var total = 0L
                while (true) {
                    if (cancelled() || Thread.currentThread().isInterrupted) throw IOException("导入已取消")
                    val length = input.read(buffer)
                    if (length < 0) break
                    if (length == 0) continue
                    if (total + length > maxBytes) throw IOException("导入文件超过 4 GiB 上限")
                    if (availableBytes() < reserveBytes + length) throw IOException("存储空间不足，需保留至少 64 MiB 空间")
                    lease.handle.write(buffer, 0, length)
                    total += length
                }
            }
            return staged
        } catch (error: Throwable) { staged.close(); throw error }
    }

    // Call before starting Node, when no backend import can still own an archive.
    fun cleanupStale() {
        TransferLocks.cleanup(directory) { it.name == "incoming.zip" || it.name.matches(Regex("[a-f0-9]{32}\\.zip")) }
    }
}

class DownloadStore(private val directory: File, private val maxBytes: Long = 1024L * 1024 * 1024) {
    private data class Entry(val lease: FileLease, val name: String, val mime: String)
    private val entries = mutableMapOf<String, Entry>()
    init {
        TransferLocks.cleanup(directory) { it.name.matches(Regex("export-[a-f0-9-]{36}")) }
    }
    fun begin(name: String, mime: String): String {
        if (entries.size >= 4) throw IOException("同时导出的文件过多")
        directory.mkdirs()
        val id = UUID.randomUUID().toString()
        val lease = TransferLocks.create(directory, "export-$id")
        entries[id] = Entry(lease, name, mime)
        return id
    }
    fun chunk(id: String, bytes: ByteArray) {
        val entry = entries[id] ?: throw IOException("导出任务不存在")
        if (bytes.size > 65536 || entry.lease.handle.length() + bytes.size > maxBytes) throw IOException("导出文件或数据块过大")
        entry.lease.handle.write(bytes)
    }
    fun cancel(id: String) { entries.remove(id)?.lease?.close() }
    fun finish(id: String, consume: (InputStream, String, String) -> Unit) {
        val entry = entries.remove(id) ?: throw IOException("导出任务不存在")
        try { consume(entry.lease.input(), entry.name, entry.mime) } finally { entry.lease.close() }
    }
    fun cancelAll() { entries.values.forEach { it.lease.close() }; entries.clear() }
}

/** The worker owns every file operation; close only signals cancellation on the caller thread. */
class SerialDownloads(directory: File, capacity: Int = 32) : Closeable {
    private val closed = AtomicBoolean(false)
    private val store by lazy { DownloadStore(directory) }
    private val worker = ThreadPoolExecutor(1, 1, 0, TimeUnit.MILLISECONDS, ArrayBlockingQueue<Runnable>(capacity)) { runnable ->
        Thread(runnable, "SillyTavern-Downloads")
    }
    val cancelled get() = closed.get()
    @Synchronized fun <T> submit(action: (DownloadStore) -> T): Future<T> {
        if (closed.get()) throw RejectedExecutionException("下载处理已关闭")
        return worker.submit(Callable {
            if (closed.get()) throw IOException("导出已取消")
            action(store)
        })
    }
    @Synchronized override fun close() {
        if (!closed.compareAndSet(false, true)) return
        worker.queue.forEach { if (it is Future<*>) it.cancel(false) }
        worker.queue.clear()
        worker.execute { store.cancelAll() }
        worker.shutdown()
    }
    fun awaitTermination(timeout: Long, unit: TimeUnit) = worker.awaitTermination(timeout, unit)
}
