package com.jieqibox.lineconnect

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.graphics.Path
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.accessibility.AccessibilityEvent

/**
 * Accessibility service used by the "line connect" (连线自动走棋) feature to
 * perform taps and drags on top of another chess app.
 *
 * Android offers no other supported way for a regular app to inject touches, so
 * the user has to enable this service manually in system settings.
 */
class AutoPlayAccessibilityService : AccessibilityService() {

    companion object {
        private const val TAG = "AutoPlayA11y"

        @Volatile
        var instance: AutoPlayAccessibilityService? = null
            private set

        fun isRunning(): Boolean = instance != null

        /** Last gesture failure reason, surfaced to the JS layer for diagnostics. */
        @Volatile
        var lastError: String = ""
    }

    private val mainHandler = Handler(Looper.getMainLooper())

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
        lastError = ""
        Log.i(TAG, "Accessibility service connected")
    }

    override fun onUnbind(intent: android.content.Intent?): Boolean {
        instance = null
        Log.i(TAG, "Accessibility service unbound")
        return super.onUnbind(intent)
    }

    override fun onDestroy() {
        instance = null
        super.onDestroy()
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        // Gesture-only service: nothing to observe.
    }

    override fun onInterrupt() {
        // Nothing to interrupt.
    }

    /**
     * Performs a single tap at the given screen coordinates.
     *
     * Called from the webview bridge, which runs on a background thread, so the
     * gesture is always posted to the main thread.
     *
     * @return true when the gesture was accepted for dispatch.
     */
    fun tap(x: Float, y: Float, durationMs: Long = 50L): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) {
            lastError = "Gesture dispatch requires Android 7.0+"
            return false
        }
        val path = Path().apply { moveTo(x, y) }
        return dispatchOnMain(path, durationMs)
    }

    /**
     * Performs a drag from one point to another.
     */
    fun swipe(
        fromX: Float,
        fromY: Float,
        toX: Float,
        toY: Float,
        durationMs: Long = 350L
    ): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) {
            lastError = "Gesture dispatch requires Android 7.0+"
            return false
        }
        val path = Path().apply {
            moveTo(fromX, fromY)
            lineTo(toX, toY)
        }
        return dispatchOnMain(path, durationMs)
    }

    /** Dispatches on the main thread, no matter which thread the caller is on. */
    private fun dispatchOnMain(path: Path, durationMs: Long): Boolean {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            return dispatchPath(path, durationMs)
        }
        mainHandler.post { dispatchPath(path, durationMs) }
        return true
    }

    private fun dispatchPath(path: Path, durationMs: Long): Boolean {
        val safeDuration = durationMs.coerceIn(20L, 4000L)
        return try {
            val stroke = GestureDescription.StrokeDescription(path, 0L, safeDuration)
            val gesture = GestureDescription.Builder().addStroke(stroke).build()
            val dispatched = dispatchGesture(gesture, null, mainHandler)
            if (!dispatched) {
                lastError = "dispatchGesture rejected the gesture"
                Log.w(TAG, lastError)
            }
            dispatched
        } catch (e: Exception) {
            lastError = "dispatchGesture failed: ${e.message}"
            Log.w(TAG, lastError, e)
            false
        }
    }
}
