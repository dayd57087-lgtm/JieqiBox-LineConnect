package com.jieqibox.lineconnect

import android.content.Intent
import android.os.Build
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

    /** Brings the app back to the foreground (floating bar "棋盘" action). */
    @JavascriptInterface
    fun bringToFront() {
        activity.moveToFront()
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

    /* ------------------------------------------------------------------ */
    /* Floating control bar                                                */
    /* ------------------------------------------------------------------ */

    /**
     * True when the app may draw over other apps.
     *
     * On Android M+ this needs the user to flip a system switch; the app cannot
     * request it with a runtime dialog like a normal permission.
     */
    @JavascriptInterface
    fun canDrawOverlays(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true
        return activity.canDrawOverlaysNow()
    }

    /** Shows the floating bar. Requires the overlay permission. */
    @JavascriptInterface
    fun showOverlay(): Boolean {
        val service = ScreenCaptureService.instance ?: return false
        return service.ensureOverlay()
    }

    /** Hides the floating bar. */
    @JavascriptInterface
    fun hideOverlay() {
        ScreenCaptureService.instance?.hideOverlay()
    }

    /** True while the bar is on screen. */
    @JavascriptInterface
    fun isOverlayVisible(): Boolean {
        return ScreenCaptureService.instance?.isOverlayVisible() == true
    }

    /**
     * Pushes new content into the floating bar.
     *
     * @param json object with any of: turn, status, evaluation, waiting,
     *             autoRunning, autoEnabled, scanEnabled
     * @return true when the payload was applied
     */
    @JavascriptInterface
    fun updateOverlay(json: String): Boolean {
        val service = ScreenCaptureService.instance ?: return false
        return try {
            val obj = JSONObject(json)
            service.updateOverlay(
                turn = obj.optStringOrNull("turn"),
                status = obj.optStringOrNull("status"),
                evaluation = obj.optStringOrNull("evaluation"),
                waiting = obj.optStringOrNull("waiting"),
                autoRunning = obj.optBooleanOrNull("autoRunning"),
                autoEnabled = obj.optBooleanOrNull("autoEnabled"),
                scanEnabled = obj.optBooleanOrNull("scanEnabled")
            )
            true
        } catch (e: Exception) {
            Log.w(TAG, "updateOverlay failed", e)
            false
        }
    }

    /* ------------------------------------------------------------------ */
    /* Background JS loop driver                                           */
    /* ------------------------------------------------------------------ */

    /**
     * Starts driving `window.__lineConnectTick__()` from native code.
     *
     * A hidden webview throttles its own timers, so the loop would stall once
     * the user switches to the game app. Ticks are emitted from the capture
     * service instead, which keeps running in the foreground.
     */
    @JavascriptInterface
    fun startTick(intervalMs: Int): Boolean {
        val service = ScreenCaptureService.instance ?: return false
        service.startJsTick(intervalMs.toLong())
        return true
    }

    /** Stops the native loop driver. */
    @JavascriptInterface
    fun stopTick() {
        ScreenCaptureService.instance?.stopJsTick()
    }
}

/** Returns the string value or null when the key is absent. */
private fun JSONObject.optStringOrNull(key: String): String? {
    if (!has(key) || isNull(key)) return null
    return optString(key)
}

/** Returns the boolean value or null when the key is absent. */
private fun JSONObject.optBooleanOrNull(key: String): Boolean? {
    if (!has(key) || isNull(key)) return null
    return optBoolean(key)
}
