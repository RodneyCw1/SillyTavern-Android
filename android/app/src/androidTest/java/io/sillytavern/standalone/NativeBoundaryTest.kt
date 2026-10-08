package io.sillytavern.standalone

import android.content.ContextWrapper
import android.net.LocalServerSocket
import android.net.LocalSocket
import android.net.LocalSocketAddress
import android.os.Process
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** Device tests: no model calls, credentials, user data, or real runtime startup. */
class NativeBoundaryTest {
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private fun socketFile() = File(context.cacheDir, "t-${UUID.randomUUID().toString().take(8)}.sock")

    private fun unixServer(file: File, action: (LocalSocket) -> Unit): Pair<AutoCloseable, java.util.concurrent.Future<*>> {
        val bound = LocalSocket()
        bound.bind(LocalSocketAddress(file.absolutePath, LocalSocketAddress.Namespace.FILESYSTEM))
        val server = LocalServerSocket(bound.fileDescriptor)
        val executor = Executors.newSingleThreadExecutor()
        val future = executor.submit {
            server.accept().use { peer -> peer.soTimeout = 3000; action(peer) }
        }
        return Pair(AutoCloseable {
            runCatching { server.close() }; runCatching { bound.close() }
            executor.shutdownNow(); file.delete()
        }, future)
    }

    @Test fun wrongPeerUidIsRejectedBeforeSendingAnyBytes() {
        val file = socketFile()
        val (server, received) = unixServer(file) { peer -> assertEquals(-1, peer.inputStream.read()) }
        server.use {
            try {
                RuntimeConnection.connect(file, Process.myUid() + 1).close()
                fail("Peer UID must be verified")
            } catch (_: IOException) { }
            received.get(4, TimeUnit.SECONDS)
        }
    }

    @Test fun sameUidPrivateSocketCanExchangeData() {
        val file = socketFile()
        val (server, received) = unixServer(file) { peer -> assertEquals(42, peer.inputStream.read()) }
        server.use {
            RuntimeConnection.connect(file).use { it.outputStream.write(42) }
            received.get(4, TimeUnit.SECONDS)
        }
    }

    @Test fun occupiedLoopbackPortFailsClosed() {
        for (reuse in listOf(false, true)) {
            ServerSocket().use { squatter ->
                squatter.reuseAddress = reuse
                squatter.bind(InetSocketAddress(InetAddress.getByName("127.0.0.1"), 0))
                val gateway = LoopbackGateway(context, squatter.localPort)
                try { gateway.start(); fail("A second listener must not start") } catch (_: IOException) { }
                assertFalse(gateway.isRunning)
                gateway.close()
            }
        }
    }

    @Test fun gatewayCanRestartImmediatelyAfterServerClosesAConnection() {
        val file = socketFile()
        val (server, received) = unixServer(file) { peer ->
            assertEquals(42, peer.inputStream.read())
            peer.outputStream.write(7)
            peer.outputStream.flush()
            // Upstream closes first, making the gateway actively close TCP.
        }
        server.use {
            val gateway = LoopbackGateway(context, 0, file)
            gateway.use {
                gateway.start()
                val port = gateway.localPort
                Socket("127.0.0.1", port).use { client ->
                    client.soTimeout = 3000
                    client.getOutputStream().write(42)
                    assertEquals(7, client.getInputStream().read())
                    assertEquals(-1, client.getInputStream().read())
                }
                received.get(4, TimeUnit.SECONDS)
                gateway.close()
                LoopbackGateway(context, port, file).use { restarted ->
                    restarted.start()
                    assertTrue(restarted.isRunning)
                    // Reuse of a retired connection must not allow another listener.
                    LoopbackGateway(context, port, file).use { duplicate ->
                        try { duplicate.start(); fail("Live gateway must remain exclusive") } catch (_: IOException) { }
                        assertFalse(duplicate.isRunning)
                    }
                }
            }
        }
    }

    @Test fun gatewayForwardsBothDirectionsWithoutBufferingTheWholeRequest() {
        val file = socketFile()
        val (server, received) = unixServer(file) { peer ->
            assertEquals(1, peer.inputStream.read())
            peer.outputStream.write(7)
            peer.outputStream.flush()
            assertEquals(2, peer.inputStream.read())
            peer.outputStream.write(8)
            peer.outputStream.flush()
        }
        server.use {
            LoopbackGateway(context, 0, file).use { gateway ->
                gateway.start()
                Socket("127.0.0.1", gateway.localPort).use { client ->
                    client.soTimeout = 3000
                    client.getOutputStream().write(1)
                    client.getOutputStream().flush()
                    assertEquals(7, client.getInputStream().read())
                    client.getOutputStream().write(2)
                    client.getOutputStream().flush()
                    assertEquals(8, client.getInputStream().read())
                }
                received.get(4, TimeUnit.SECONDS)
            }
        }
    }

    @Test fun eachRuntimeStartRotatesThePersistedToken() {
        val fixture = File(context.cacheDir, "token-test-${UUID.randomUUID()}").apply { mkdirs() }
        val isolated = object : ContextWrapper(context) { override fun getFilesDir() = fixture }
        try {
            val first = RuntimeFiles.rotateToken(isolated)
            val second = RuntimeFiles.rotateToken(isolated)
            assertTrue(first.matches(Regex("[a-f0-9]{64}")))
            assertTrue(first != second)
            assertTrue(second == RuntimeFiles.token(isolated))
        } finally { fixture.deleteRecursively() }
    }
}
