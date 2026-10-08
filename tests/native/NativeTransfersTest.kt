package io.sillytavern.standalone

import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.TimeUnit

class NativeTransfersTest {
    private fun directory() = Files.createTempDirectory("st-native-test-").toFile()
    private fun rejected(action: () -> Unit) {
        try { action(); fail("Operation must fail") } catch (_: IOException) { }
    }

    @Test fun importIdsAreIndependentAndClosingOneDoesNotDeleteAnother() {
        val directory = directory()
        try {
            val stager = ImportStager(directory, availableBytes = { Long.MAX_VALUE })
            val first = stager.stage(ByteArrayInputStream(byteArrayOf(1)))
            val second = stager.stage(ByteArrayInputStream(byteArrayOf(2)))
            assertTrue(first.id.matches(Regex("[a-f0-9]{32}")))
            assertNotEquals(first.id, second.id)
            first.close()
            assertFalse(first.file.exists())
            assertArrayEquals(byteArrayOf(2), second.file.readBytes())
            second.close()
        } finally { directory.deleteRecursively() }
    }

    @Test fun importRejectsOversizeAndRemovesPartialFile() {
        val directory = directory()
        try {
            val stager = ImportStager(directory, maxBytes = 3, reserveBytes = 0, availableBytes = { 1000 })
            rejected { stager.stage(ByteArrayInputStream(ByteArray(4))) }
            assertEquals(0, directory.listFiles()!!.count { it.name != ".transfer.guard" })
        } finally { directory.deleteRecursively() }
    }

    @Test fun importPreservesDiskReserveBeforeWriting() {
        val directory = directory()
        try {
            val stager = ImportStager(directory, reserveBytes = 64, availableBytes = { 65 })
            rejected { stager.stage(ByteArrayInputStream(ByteArray(2))) }
            assertEquals(0, directory.listFiles()!!.count { it.name != ".transfer.guard" })
        } finally { directory.deleteRecursively() }
    }

    @Test fun interruptedCopyRemovesPartialFile() {
        val directory = directory()
        try {
            var checks = 0
            val stager = ImportStager(directory, availableBytes = { Long.MAX_VALUE })
            rejected { stager.stage(ByteArrayInputStream(ByteArray(100000)), cancelled = { ++checks > 1 }) }
            assertEquals(0, directory.listFiles()!!.count { it.name != ".transfer.guard" })
        } finally { directory.deleteRecursively() }
    }

    @Test fun providerReadFailureRemovesPartialFile() {
        val directory = directory()
        try {
            val input = object : java.io.InputStream() { override fun read(): Int = throw IOException("provider failed") }
            rejected { ImportStager(directory).stage(input) }
            assertEquals(0, directory.listFiles()!!.count { it.name != ".transfer.guard" })
        } finally { directory.deleteRecursively() }
    }

    @Test fun staleCleanupPreservesActiveAndUnrelatedFiles() {
        val directory = directory()
        try {
            val stager = ImportStager(directory, availableBytes = { Long.MAX_VALUE })
            val active = stager.stage(ByteArrayInputStream(byteArrayOf(1)))
            val stale = File(directory, "a".repeat(32) + ".zip").apply { writeText("old") }
            val unrelated = File(directory, "notes.txt").apply { writeText("keep") }
            stager.cleanupStale()
            assertFalse(stale.exists())
            assertTrue(active.file.exists())
            assertTrue(unrelated.exists())
            active.close()
        } finally { directory.deleteRecursively() }
    }

    @Test fun cleanupFromAnotherStagerPreservesAnArchiveStillOwnedByNative() {
        val directory = directory()
        try {
            val active = ImportStager(directory, availableBytes = { Long.MAX_VALUE }).stage(ByteArrayInputStream(byteArrayOf(1)))
            try {
                ImportStager(directory).cleanupStale()
                assertTrue("Another instance deleted an active import", active.file.exists())
            } finally { active.close() }
        } finally { directory.deleteRecursively() }
    }

    @Test fun cleanupPreservesAnotherProcessesArchiveUntilItsOwnerDies() {
        val directory = directory()
        val java = File(System.getProperty("java.home"), "bin/java.exe").takeIf { it.exists() }
            ?: File(System.getProperty("java.home"), "bin/java")
        val classes = File(NativeTransfersTest::class.java.protectionDomain.codeSource.location.toURI()).path
        val stdlib = File(kotlin.Unit::class.java.protectionDomain.codeSource.location.toURI()).path
        val child = ProcessBuilder(java.path, "-cp", classes + File.pathSeparator + stdlib, "io.sillytavern.standalone.ImportLockChild", directory.path).start()
        val reader = Executors.newSingleThreadExecutor()
        try {
            val id = reader.submit<String> { child.inputStream.bufferedReader().readLine() }.get(15, TimeUnit.SECONDS)
            assertTrue(id.matches(Regex("[a-f0-9]{32}")))
            val archive = File(directory, "$id.zip")
            ImportStager(directory).cleanupStale()
            assertTrue("A different process still owns the archive", archive.exists())
            child.destroyForcibly()
            assertTrue(child.waitFor(5, TimeUnit.SECONDS))
            child.inputStream.close()
            child.errorStream.close()
            child.outputStream.close()
            // Process termination and kernel handle teardown are asynchronous on
            // Windows. Cleanup must keep skipping the lock until it is released.
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(3)
            do {
                ImportStager(directory).cleanupStale()
                if (!archive.exists()) break
                Thread.sleep(25)
            } while (System.nanoTime() < deadline)
            assertFalse("Dead owner's archive must be reclaimable: ${archive.name}", archive.exists())
        } finally { child.destroyForcibly(); child.waitFor(5, TimeUnit.SECONDS); reader.shutdownNow(); directory.deleteRecursively() }
    }

    @Test fun downloadFailureRemovesTempFile() {
        val directory = directory()
        try {
            val store = DownloadStore(directory)
            val id = store.begin("fixture.txt", "text/plain")
            store.chunk(id, byteArrayOf(1, 2))
            rejected { store.finish(id) { _, _, _ -> throw IOException("destination failed") } }
            assertEquals(0, directory.listFiles()!!.count { it.name != ".transfer.guard" })
        } finally { directory.deleteRecursively() }
    }

    @Test fun downloadLimitIncludesIncomingChunk() {
        val directory = directory()
        try {
            val store = DownloadStore(directory, maxBytes = 3)
            val id = store.begin("fixture", "text/plain")
            store.chunk(id, byteArrayOf(1, 2))
            rejected { store.chunk(id, byteArrayOf(3, 4)) }
            store.finish(id) { input, _, _ -> assertArrayEquals(byteArrayOf(1, 2), input.readBytes()) }
        } finally { directory.deleteRecursively() }
    }

    @Test fun aNewDownloadStoreReclaimsOnlyUnownedExports() {
        val directory = directory()
        try {
            val first = DownloadStore(directory)
            val id = first.begin("active", "text/plain")
            val active = File(directory, "export-$id")
            val stale = File(directory, "export-" + java.util.UUID.randomUUID()).apply { writeText("abandoned") }
            val unrelated = File(directory, "notes.txt").apply { writeText("keep") }
            DownloadStore(directory)
            assertTrue("Another Activity still owns this export", active.exists())
            assertFalse("Abandoned export must be reclaimed", stale.exists())
            assertTrue(unrelated.exists())
            first.cancelAll()
        } finally { directory.deleteRecursively() }
    }

    @Test fun teardownDoesNotDeleteFileWhileFinishUsesItAndRunsOffCallerThread() {
        val directory = directory()
        val queue = SerialDownloads(directory)
        val started = CountDownLatch(1)
        val release = CountDownLatch(1)
        val caller = Thread.currentThread()
        try {
            val id = queue.submit { it.begin("fixture", "text/plain") }.get(2, TimeUnit.SECONDS)
            val finish = queue.submit { store ->
                store.finish(id) { _, _, _ ->
                    assertNotSame(caller, Thread.currentThread())
                    started.countDown()
                    assertTrue(release.await(2, TimeUnit.SECONDS))
                    assertTrue(File(directory, "export-$id").exists())
                }
            }
            assertTrue(started.await(2, TimeUnit.SECONDS))
            queue.close()
            assertTrue(queue.cancelled)
            release.countDown()
            finish.get(2, TimeUnit.SECONDS)
            assertTrue(queue.awaitTermination(2, TimeUnit.SECONDS))
            assertEquals(0, directory.listFiles()!!.count { it.name != ".transfer.guard" })
        } finally { release.countDown(); queue.close(); directory.deleteRecursively() }
    }

    @Test fun downloadQueueIsBounded() {
        val directory = directory()
        val queue = SerialDownloads(directory, capacity = 1)
        val started = CountDownLatch(1)
        val release = CountDownLatch(1)
        try {
            queue.submit { started.countDown(); release.await(2, TimeUnit.SECONDS) }
            assertTrue(started.await(2, TimeUnit.SECONDS))
            queue.submit { true }
            try { queue.submit { true }; fail("Unbounded queue") } catch (_: RejectedExecutionException) { }
        } finally { release.countDown(); queue.close(); queue.awaitTermination(2, TimeUnit.SECONDS); directory.deleteRecursively() }
    }

    @Test fun privateHttpReadsContentLengthWithoutWaitingForSocketClose() {
        val reply = RuntimeHttp.read(ByteArrayInputStream("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}ignored".toByteArray()))
        assertEquals(200, reply.status)
        assertEquals("{}", reply.body.toString(Charsets.UTF_8))
    }

    @Test fun privateHttpDecodesChunkedResponseAndTrailers() {
        val reply = RuntimeHttp.read(ByteArrayInputStream("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\n{\r\n1\r\n}\r\n0\r\nX-Test: fixture\r\n\r\n".toByteArray()))
        assertEquals("{}", reply.body.toString(Charsets.UTF_8))
    }

    @Test fun privateHttpRejectsOversizeBeforeAllocatingTheBody() {
        rejected { RuntimeHttp.read(ByteArrayInputStream("HTTP/1.1 200 OK\r\nContent-Length: 999999999\r\n\r\n".toByteArray())) }
    }

    @Test fun privateHttpRejectsTruncatedBody() {
        rejected { RuntimeHttp.read(ByteArrayInputStream("HTTP/1.1 200 OK\r\nContent-Length: 9\r\n\r\n{}".toByteArray())) }
    }
}

object ImportLockChild {
    @JvmStatic fun main(args: Array<String>) {
        val staged = ImportStager(File(args[0]), availableBytes = { Long.MAX_VALUE }).stage(ByteArrayInputStream(byteArrayOf(1)))
        println(staged.id)
        System.out.flush()
        System.`in`.read()
        staged.close()
    }
}

