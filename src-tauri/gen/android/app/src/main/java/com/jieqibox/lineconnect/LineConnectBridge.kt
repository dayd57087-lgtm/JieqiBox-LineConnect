package com.jieqibox.lineconnect

import android.content.Intent
import android.provider.Settings
import android.util.Log
import android.webkit.JavascriptInterface
import org.json.JSONObject

/**
 * Bridge exposed to the webview as `window.LineConnect`.
 *
 * The "连线自动走棋" feature needs two Android capabilities that plain web
 * code cannot reach:
 *   1. reading the screen (MediaProjection, owned by [ScreenCaptureService])
 *   2. injecting taps into another app (see [AutoPlayAccessibilityService])
 *
 * All methods are synchronous and cheap except [captureFrame], which copies the
 * newest cached JPEG. Nothing here blocks the UI thread.
 */
class LineConnectBridge(private val activity: MainActivity) {

    companion object {
        private const val TAG = "LineConnect"
    }

    /* ------------------------------------------------------------------ */
    /* Screen capture                                                      */
    /* ------------------------------------------------------------------ */

    /** Returns true when the app already holds a live projection permission. */
    @JavascriptInterface
    fun hasCapturePermission(): Boolean {
        return activity.hasPendingProjection()
    }

    /** Asks the system for a screen capture token. The result arrives asynchronously. */
    @JavascriptInterface
    fun requestCapturePermission() {
        activity.requestProjectionPermission()
    }

    /** Drops a previously granted token (used when the user cancels or restarts). */
    @JavascriptInterface
    fun clearCapturePermission() {
        activity.clearProjectionPermission()
    }

    /**
     * Starts the foreground capture service using the previously granted token.
     *
     * @param scale      resolution factor applied to the screen (0.15 - 1.0)
     * @param quality    JPEG quality (30 - 100)
     * @param intervalMs minimum delay between two accepted frames
     * @return true when the service was started successfully
     */
    @JavascriptInterface
    fun startCapture(scale: Double, quality: Int, intervalMs: Int): Boolean {
        return activity.startProjectionService(scale.toFloat(), quality, intervalMs.toLong())
    }

    /** Stops the capture service. */
    @JavascriptInterface
    fun stopCapture() {
        activity.stopProjectionService()
    }

    /** True while the foreground service is mirroring the screen. */
    @JavascriptInterface
    fun isCapturing(): Boolean = ScreenCaptureService.isRunning()

    /**
     * Returns the newest frame as a base64 encoded JPEG, or an empty string when
     * no frame is available yet. Callers should poll [captureStatus] first.
     */
    @JavascriptInterface
    fun captureFrame(): String {
        val service = ScreenCaptureService.instance ?: return ""
        return try {
            service.captureFrameBase64() ?: ""
        } catch (e: Exception) {
            Log.w(TAG, "captureFrame failed", e)
            ""
        }
    }

    /** JSON describing the capture session. */
    @JavascriptInterface
    fun captureStatus(): String {
        val service = ScreenCaptureService.instance
        val json = JSONObject()
        json.put("running", service != null)
        json.put("screenWidth", service?.screenWidth ?: 0)
        json.put("screenHeight", service?.screenHeight ?: 0)
        json.put("frameWidth", service?.frameWidth ?: 0)
        json.put("frameHeight", service?.frameHeight ?: 0)
        json.put("lastFrameTime", service?.lastFrameTime ?: 0L)
        json.put("frames", service?.framesCaptured() ?: 0L)
        json.put("hasPermission", activity.hasPendingProjection())
        return json.toString()
    }

    /* ------------------------------------------------------------------ */
    /* Gesture injection                                                   */
    /* ------------------------------------------------------------------ */

    /** True when the accessibility service is connected and can dispatch gestures. */
    @JavascriptInterface
    fun hasAccessibility(): Boolean = AutoPlayAccessibilityService.isRunning()

    /** Opens the system accessibility settings page so the user can enable the service. */
    @JavascriptInterface
    fun openAccessibilitySettings() {
        try {
            val intent = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            activity.startActivity(intent)
        } catch (e: Exception) {
            Log.w(TAG, "Failed to open accessibility settings", e)
        }
    }

    /** Performs a tap on the screen. */
    @JavascriptInterface
    fun tap(x: Double, y: Double, durationMs: Int): Boolean {
        val service = AutoPlayAccessibilityService.instance
        if (service == null) {
            AutoPlayAccessibilityService.lastError = "无障碍服务未开启"
            return false
        }
        return service.tap(x.toFloat(), y.toFloat(), durationMs.toLong())
    }

    /** Performs a drag between two screen points. */
    @JavascriptInterface
    fun swipe(
        fromX: Double,
        fromY: Double,
        toX: Double,
        toY: Double,
        durationMs: Int
    ): Boolean {
        val service = AutoPlayAccessibilityService.instance
        if (service == null) {
            AutoPlayAccessibilityService.lastError = "无障碍服务未开启"
            return false
        }
        return service.swipe(
            fromX.toFloat(),
            fromY.toFloat(),
            toX.toFloat(),
            toY.toFloat(),
            durationMs.toLong()
        )
    }

    /** Last gesture error message (empty when the last gesture succeeded). */
    @JavascriptInterface
    fun lastGestureError(): String = AutoPlayAccessibilityService.lastError

    /* ------------------------------------------------------------------ */
    /* Misc                                                                */
    /* ------------------------------------------------------------------ */

    /** Package name of the app that is currently in the foreground, if resolvable. */
    @JavascriptInterface
    fun currentForegroundPackage(): String {
        return activity.currentForegroundPackage()
    }

    /** Opens the "display over other apps" settings page. */
    @JavascriptInterface
    fun openOverlaySettings() {
        try {
            val intent = Intent(
                Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                android.net.Uri.parse("package:" + activity.packageName)
            )
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            activity.startActivity(intent)
        } catch (e: Exception) {
            Log.w(TAG, "Failed to open overlay settings", e)
        }
    }
}
