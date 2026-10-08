package io.sillytavern.standalone

/** Executes restart actions in order; the caller owns Android lifecycle objects. */
internal fun executeRuntimeRestart(
    importing: Boolean,
    forceRuntimeRestart: Boolean,
    rendererGone: () -> Boolean,
    prepareAndStop: (clearWebView: Boolean) -> Unit,
    schedule: (() -> Unit) -> Unit,
    recreate: () -> Unit,
    start: () -> Unit,
): Boolean {
    if (importing) return false
    if (rendererGone() && !forceRuntimeRestart) { recreate(); return true }
    prepareAndStop(!rendererGone())
    schedule { if (rendererGone()) recreate() else start() }
    return true
}
