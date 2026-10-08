package io.sillytavern.standalone

import org.junit.Assert.*
import org.junit.Test

class RuntimeRestartTest {
    private class Fixture(var rendererGone: Boolean) {
        val calls = mutableListOf<String>()
        var delayed: (() -> Unit)? = null
        fun restart(importing: Boolean = false, force: Boolean = false) = executeRuntimeRestart(
            importing, force, { rendererGone },
            prepareAndStop = { clearWebView -> if (clearWebView) calls.add("clear-webview"); calls.add("stop-service") },
            schedule = { action -> calls.add("schedule"); delayed = action },
            recreate = { calls.add("recreate") },
            start = { calls.add("start-runtime") },
        )
    }

    @Test fun ongoingImportIsBlockedBeforeRendererRecovery() {
        for (gone in listOf(false, true)) for (force in listOf(false, true)) {
            val f = Fixture(gone)
            assertFalse(f.restart(importing = true, force = force))
            assertEquals(emptyList<String>(), f.calls)
            assertNull(f.delayed)
        }
    }

    @Test fun ordinaryRendererRecoveryDoesNotStopBackgroundGeneration() {
        val f = Fixture(true)
        assertTrue(f.restart())
        assertEquals(listOf("recreate"), f.calls)
        assertNull(f.delayed)
    }

    @Test fun completedImportStopsRuntimeEvenWhenRendererWasDestroyed() {
        val f = Fixture(true)
        assertTrue(f.restart(force = true))
        assertEquals(listOf("stop-service", "schedule"), f.calls)
        assertNotNull(f.delayed)
        f.delayed!!.invoke()
        assertEquals(listOf("stop-service", "schedule", "recreate"), f.calls)
    }

    @Test fun healthyRendererRestartsOnlyAfterTheScheduledDelay() {
        val f = Fixture(false)
        assertTrue(f.restart())
        assertEquals(listOf("clear-webview", "stop-service", "schedule"), f.calls)
        f.delayed!!.invoke()
        assertEquals(listOf("clear-webview", "stop-service", "schedule", "start-runtime"), f.calls)
    }

    @Test fun rendererLossDuringTheDelayChoosesRecreationAtExecutionTime() {
        val f = Fixture(false)
        f.restart(force = true)
        f.rendererGone = true
        f.delayed!!.invoke()
        assertEquals(listOf("clear-webview", "stop-service", "schedule", "recreate"), f.calls)
    }
}
