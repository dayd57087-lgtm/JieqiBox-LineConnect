package com.jieqibox.lineconnect

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.Image
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.Looper
import android.util.Base64
import android.util.DisplayMetrics
import android.util.Log
import android.view.WindowManager
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.ByteBuffer

/**
 * Foreground service that owns the MediaProjection session.
 *
 * A MediaProjection can only keep capturing while the owning app is in the
 * foreground, so the session has to live in a foreground service of type
 * "mediaProjection" (Android 10+). The service keeps the newest frame cached so
 * the JS side can pull frames on demand without blocking the capture thread.
 */
class ScreenCaptureService : Service() {

    companion object {
        private const val TAG = "ScreenCapture"
        private const val CHANNEL_ID = "jieqibox_line_connect"
        private const val NOTIFICATION_ID = 0x7A31

        const val EXTRA_RESULT_CODE = "resultCode"
        const val EXTRA_DATA = "data"
        const val EXTRA_SCALE = "scale"
        const val EXTRA_QUALITY = "quality"
        const val EXTRA_INTERVAL_MS = "intervalMs"

        /** Side of the luminance fingerprint grid used for change detection. */
        private const val SIGNATURE_GRID = 16

        /** Per-cell luma delta that counts as "this cell changed". */
        private const val SIGNATURE_TOLERANCE = 10

        /** Public collection visible to file managers, used for sample export. */
        private const val PUBLIC_SAMPLE_DIR = "/storage/emulated/0/Pictures/JieqiBoxLine"

        /** Longest edge allowed when transferring a full frame to the webview. */
        private const val MAX_TRANSFER_EDGE = 1280

        /**
         * Longest edge of a saved training sample.
         *
         * Deliberately identical to [MAX_TRANSFER_EDGE]: the sample then has the
         * exact pixel dimensions of the frame the JS side analysed, so the boxes
         * it reports can be stored verbatim.
         */
        private const val SAMPLE_MAX_EDGE = MAX_TRANSFER_EDGE

        /** JPEG quality for saved training samples. */
        private const val SAMPLE_QUALITY = 92

        /** Minimum delay between two saved samples. */
        private const val SAMPLE_MIN_INTERVAL_MS = 1500L

        /** Minimum fraction of changed cells required to save a sample. */
        private const val SAMPLE_MIN_CHANGE = 0.01

        /** Latest service instance while capture is running. */
        @Volatile
        var instance: ScreenCaptureService? = null
            private set

        fun isRunning(): Boolean = instance != null
    }

    private var mediaProjection: MediaProjection? = null
    private var virtualDisplay: VirtualDisplay? = null
    private var imageReader: ImageReader? = null
    private var handlerThread: HandlerThread? = null
    private var handler: Handler? = null

    /** Scale applied to the physical screen resolution before capture. */
    @Volatile private var captureScale = 0.5f

    /** JPEG quality used when encoding a frame. */
    @Volatile private var jpegQuality = 70

    /** Size of the captured (already scaled) frame. */
    @Volatile var frameWidth = 0
        private set
    @Volatile var frameHeight = 0
        private set

    /** Size of the physical screen the projection is mirroring. */
    @Volatile var screenWidth = 0
        private set
    @Volatile var screenHeight = 0
        private set

    /**
     * Newest frame as a bitmap. Kept around so cropped captures (and repeated
     * requests for the same frame) do not have to re-decode a JPEG.
     */
    private var latestBitmap: Bitmap? = null
    private val frameLock = Any()

    /** Coarse luminance fingerprint of the newest frame, used for change detection. */
    @Volatile private var latestSignature: IntArray? = null

    /** How much of the frame changed compared to the previous accepted frame (0..1). */
    @Volatile var lastChangeRatio: Double = 1.0
        private set

    /** Cached JPEG of the full frame, invalidated whenever a new frame arrives. */
    private var cachedFullJpeg: ByteArray? = null
    private var cachedFullSignature: IntArray? = null

    /** Cached JPEG of the last crop request; avoids re-encoding on every tick. */
    private var cachedCropJpeg: ByteArray? = null
    private var cachedCropKey: String = ""

    /** Floating chessboard mirroring the recognised position. */
    private var chessboard: ChessboardOverlay? = null

    /* --- sample recording (for building a fine-tuning dataset) --- */

    @Volatile private var sampleDir: File? = null
    @Volatile private var sampleCount = 0
    private var lastSampleTime = 0L
    private var lastSampleSignature: IntArray? = null

    @Volatile private var sampleRecording = false

    /** Timestamp (ms) of the newest frame. */
    @Volatile var lastFrameTime = 0L
        private set

    @Volatile private var frameCounter = 0L

    /** Throttle: ignore frames arriving faster than this. */
    @Volatile private var minFrameIntervalMs = 120L
    private var lastAcceptedTime = 0L

    /**
     * Floating control bar shown on top of other apps.
     *
     * It lives here rather than in the activity because the bar has to survive
     * the user switching to the game app.
     */
    private var overlay: LineConnectOverlay? = null

    /**
     * Drives the JS recognition loop from the native side.
     *
     * A webview that is not visible gets its `setTimeout` callbacks throttled
     * (or suspended outright), so a JS-only polling loop stops as soon as the
     * user switches away. `evaluateJavascript` keeps working in the background,
     * so the native timer is what actually keeps the loop alive.
     */
    private var tickHandler: Handler? = null
    private var tickRunnable: Runnable? = null

    @Volatile private var tickCount = 0L

    private val projectionCallback = object : MediaProjection.Callback() {
        override fun onStop() {
            Log.i(TAG, "MediaProjection stopped by the system")
            release(false)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent == null) {
            stopSelf()
            return START_NOT_STICKY
        }

        val resultCode = intent.getIntExtra(EXTRA_RESULT_CODE, 0)
        val data: Intent? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent.getParcelableExtra(EXTRA_DATA, Intent::class.java)
        } else {
            @Suppress("DEPRECATION")
            intent.getParcelableExtra(EXTRA_DATA) as? Intent
        }
        captureScale = intent.getFloatExtra(EXTRA_SCALE, 0.5f).coerceIn(0.15f, 1.0f)
        jpegQuality = intent.getIntExtra(EXTRA_QUALITY, 70).coerceIn(30, 100)
        minFrameIntervalMs = intent.getLongExtra(EXTRA_INTERVAL_MS, 120L).coerceIn(0L, 5000L)

        if (data == null) {
            Log.e(TAG, "No projection data provided, aborting")
            stopSelf()
            return START_NOT_STICKY
        }

        startForegroundCompat()
        instance = this

        if (!startProjection(resultCode, data)) {
            Log.e(TAG, "Failed to start projection")
            release(true)
            return START_NOT_STICKY
        }

        // Surface the floating control bar when the user allows overlays. A
        // missing permission is not fatal: the in-app panel still works.
        ensureOverlay()

        Log.i(TAG, "Screen capture started at ${frameWidth}x${frameHeight} (screen ${screenWidth}x$screenHeight)")
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        release(true)
        super.onDestroy()
    }

    /* ------------------------------------------------------------------ */
    /* Capture plumbing                                                    */
    /* ------------------------------------------------------------------ */

    private fun startProjection(resultCode: Int, data: Intent): Boolean {
        val manager = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as? MediaProjectionManager
        if (manager == null) {
            Log.e(TAG, "MediaProjectionManager unavailable")
            return false
        }

        val metrics = DisplayMetrics()
        val wm = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        @Suppress("DEPRECATION")
        wm.defaultDisplay.getRealMetrics(metrics)
        screenWidth = metrics.widthPixels
        screenHeight = metrics.heightPixels
        val densityDpi = if (metrics.densityDpi > 0) metrics.densityDpi else 320

        val projection = try {
            manager.getMediaProjection(resultCode, data)
        } catch (e: Exception) {
            Log.e(TAG, "getMediaProjection failed", e)
            return false
        }
        if (projection == null) {
            Log.e(TAG, "getMediaProjection returned null")
            return false
        }
        mediaProjection = projection

        frameWidth = (screenWidth * captureScale).toInt().coerceAtLeast(180)
        frameHeight = (screenHeight * captureScale).toInt().coerceAtLeast(180)

        val thread = HandlerThread("jieqibox-capture")
        thread.start()
        handlerThread = thread
        val h = Handler(thread.looper)
        handler = h

        val reader = ImageReader.newInstance(
            frameWidth,
            frameHeight,
            PixelFormat.RGBA_8888,
            2
        )
        imageReader = reader

        reader.setOnImageAvailableListener({ r -> onImageAvailable(r) }, h)

        projection.registerCallback(projectionCallback, h)

        virtualDisplay = projection.createVirtualDisplay(
            "jieqibox-capture",
            frameWidth,
            frameHeight,
            densityDpi,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
            reader.surface,
            null,
            h
        )

        return virtualDisplay != null
    }

    private fun onImageAvailable(reader: ImageReader) {
        var image: Image? = null
        try {
            image = reader.acquireLatestImage() ?: return
            val now = System.currentTimeMillis()
            if (now - lastAcceptedTime < minFrameIntervalMs) {
                return
            }
            lastAcceptedTime = now

            val bitmap = imageToBitmap(image) ?: return
            val signature = luminanceSignature(bitmap)

            // Change ratio vs. the previous accepted frame. Comparing the
            // fingerprints is far cheaper than diffing pixels, and it lets the
            // JS loop skip inference entirely while nothing is happening.
            val previous = latestSignature
            lastChangeRatio = if (previous == null) {
                1.0
            } else {
                var changed = 0
                for (i in signature.indices) {
                    if (Math.abs(signature[i] - previous[i]) > SIGNATURE_TOLERANCE) {
                        changed++
                    }
                }
                changed.toDouble() / signature.size
            }

            synchronized(frameLock) {
                latestBitmap?.recycle()
                latestBitmap = bitmap
                latestSignature = signature
                cachedFullJpeg = null
                cachedFullSignature = null
                cachedCropJpeg = null
                cachedCropKey = ""
                lastFrameTime = now
                frameCounter++
            }

            maybeRecordSample(bitmap, signature)
        } catch (e: Exception) {
            Log.w(TAG, "Frame conversion failed: ${e.message}")
        } finally {
            try {
                image?.close()
            } catch (_: Exception) {
                // ignore
            }
        }
    }

    /** Converts a captured [Image] into a plain ARGB bitmap (row padding removed). */
    private fun imageToBitmap(image: Image): Bitmap? {
        val plane = image.planes.firstOrNull() ?: return null
        val buffer: ByteBuffer = plane.buffer
        val pixelStride = plane.pixelStride
        val rowStride = plane.rowStride
        val rowPadding = rowStride - pixelStride * image.width

        val padded = Bitmap.createBitmap(
            image.width + rowPadding / pixelStride,
            image.height,
            Bitmap.Config.ARGB_8888
        )
        buffer.rewind()
        padded.copyPixelsFromBuffer(buffer)

        if (rowPadding == 0) return padded

        val trimmed = Bitmap.createBitmap(padded, 0, 0, image.width, image.height)
        padded.recycle()
        return trimmed
    }

    private fun encodeJpeg(bitmap: Bitmap, quality: Int, maxEdge: Int = 0): ByteArray? {
        var target = bitmap
        if (maxEdge > 0) {
            val longest = Math.max(bitmap.width, bitmap.height)
            if (longest > maxEdge) {
                val ratio = maxEdge.toFloat() / longest
                val w = Math.max(1, (bitmap.width * ratio).toInt())
                val h = Math.max(1, (bitmap.height * ratio).toInt())
                target = Bitmap.createScaledBitmap(bitmap, w, h, true)
            }
        }
        return try {
            val out = ByteArrayOutputStream()
            target.compress(Bitmap.CompressFormat.JPEG, quality, out)
            out.toByteArray()
        } catch (e: Exception) {
            Log.w(TAG, "JPEG encoding failed", e)
            null
        } finally {
            if (target !== bitmap) target.recycle()
        }
    }

    /**
     * Coarse luminance fingerprint: a 16x16 grid of average brightness.
     *
     * Cheap enough to run on every accepted frame and sensitive enough to catch
     * a piece being moved on the board.
     */
    private fun luminanceSignature(bitmap: Bitmap): IntArray {
        val grid = SIGNATURE_GRID
        val out = IntArray(grid * grid)
        val stepX = Math.max(1, bitmap.width / grid)
        val stepY = Math.max(1, bitmap.height / grid)
        val pixel = IntArray(stepX * stepY)

        for (gy in 0 until grid) {
            for (gx in 0 until grid) {
                val x0 = Math.min(gx * stepX, bitmap.width - 1)
                val y0 = Math.min(gy * stepY, bitmap.height - 1)
                val w = Math.min(stepX, bitmap.width - x0)
                val h = Math.min(stepY, bitmap.height - y0)
                if (w <= 0 || h <= 0) continue
                try {
                    bitmap.getPixels(pixel, 0, w, x0, y0, w, h)
                } catch (e: Exception) {
                    continue
                }
                var sum = 0L
                val n = w * h
                for (i in 0 until n) {
                    val c = pixel[i]
                    // Rec. 601 luma, integer approximation
                    sum += (((c shr 16) and 0xFF) * 77 +
                        ((c shr 8) and 0xFF) * 151 +
                        (c and 0xFF) * 28) shr 8
                }
                out[gy * grid + gx] = (sum / Math.max(1, n)).toInt()
            }
        }
        return out
    }

    /* ------------------------------------------------------------------ */
    /* Public API used by the JS bridge                                    */
    /* ------------------------------------------------------------------ */

    /** Returns the newest frame as a base64 encoded JPEG, or null when none is ready. */
    fun captureFrameBase64(): String? {
        // The lock is held across the encode on purpose: the capture thread
        // recycles the previous bitmap when a new frame arrives, so a reference
        // taken under the lock must not be used after releasing it.
        synchronized(frameLock) {
            val bitmap = latestBitmap ?: return null
            val signature = latestSignature
            val cached = cachedFullJpeg
            if (cached != null && cachedFullSignature === signature) {
                return Base64.encodeToString(cached, Base64.NO_WRAP)
            }
            val jpeg = encodeJpeg(bitmap, jpegQuality, MAX_TRANSFER_EDGE) ?: return null
            cachedFullJpeg = jpeg
            cachedFullSignature = signature
            return Base64.encodeToString(jpeg, Base64.NO_WRAP)
        }
    }

    /**
     * Returns a cropped region of the newest frame as a base64 JPEG.
     *
     * The line-connect loop uses this once the board has been located: sending
     * only the board means far less data over the JS bridge, and the board fills
     * the model input instead of being shrunk into a corner of it, which makes
     * both recognition and inference noticeably better.
     *
     * Coordinates are in captured-frame pixels (the same space the JS side sees).
     */
    fun captureFrameCropBase64(
        left: Int,
        top: Int,
        width: Int,
        height: Int,
        maxEdge: Int
    ): String? {
        // Held across the crop + encode: the capture thread recycles the
        // previous bitmap when a new frame arrives.
        synchronized(frameLock) {
            val bitmap = latestBitmap ?: return null
            val l = left.coerceIn(0, Math.max(0, bitmap.width - 1))
            val t = top.coerceIn(0, Math.max(0, bitmap.height - 1))
            val w = width.coerceIn(1, bitmap.width - l)
            val h = height.coerceIn(1, bitmap.height - t)
            val key = "$l,$t,$w,$h,$maxEdge,${bitmap.width}x${bitmap.height}"

            if (cachedCropKey == key && cachedCropJpeg != null) {
                return Base64.encodeToString(cachedCropJpeg, Base64.NO_WRAP)
            }

            val crop = try {
                Bitmap.createBitmap(bitmap, l, t, w, h)
            } catch (e: Exception) {
                Log.w(TAG, "Crop failed: ${e.message}")
                return null
            }
            val jpeg = encodeJpeg(crop, jpegQuality, maxEdge)
            crop.recycle()
            if (jpeg == null) return null
            cachedCropJpeg = jpeg
            cachedCropKey = key
            return Base64.encodeToString(jpeg, Base64.NO_WRAP)
        }
    }

    /** Fraction of the frame that changed since the previous accepted frame. */
    fun frameChangeRatio(): Double = lastChangeRatio

    /** Returns how many frames have been produced since the service started. */
    fun framesCaptured(): Long = frameCounter

    /* ------------------------------------------------------------------ */
    /* Floating control bar                                                */
    /* ------------------------------------------------------------------ */

    /** True when the app is allowed to draw over other apps. */
    fun canDrawOverlays(): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            android.provider.Settings.canDrawOverlays(this)
        } else {
            true
        }
    }

    /**
     * Creates and shows the floating bar when the overlay permission is held.
     *
     * @return true when the bar is visible afterwards.
     */
    fun ensureOverlay(): Boolean {
        if (!canDrawOverlays()) {
            Log.i(TAG, "Overlay permission not granted; skipping floating bar")
            return false
        }
        val existing = overlay
        if (existing != null && existing.isVisible) return true

        val created = existing ?: LineConnectOverlay(this) { action ->
            MainActivity.dispatchJs(
                "window.dispatchEvent(new CustomEvent('line-connect-overlay', " +
                    "{ detail: { action: '${action.replace("'", "\\'")}' } }));"
            )
        }
        overlay = created
        return created.show()
    }

    /** Removes the floating bar. */
    fun hideOverlay() {
        overlay?.hide()
    }

    /** Tears the bar down entirely, e.g. when capture stops. */
    fun destroyOverlay() {
        overlay?.hide()
        overlay = null
    }

    /** True while the bar is on screen. */
    fun isOverlayVisible(): Boolean = overlay?.isVisible == true

    /* ------------------------------------------------------------------ */
    /* Floating chessboard                                                 */
    /* ------------------------------------------------------------------ */

    /** Shows (or creates) the floating chessboard. Requires overlay permission. */
    fun ensureChessboard(): Boolean {
        if (!canDrawOverlays()) {
            Log.i(TAG, "Overlay permission not granted; skipping chessboard")
            return false
        }
        val existing = chessboard
        if (existing != null && existing.isVisible) return true
        val created = existing ?: ChessboardOverlay(this)
        chessboard = created
        return created.show()
    }

    fun hideChessboard() {
        chessboard?.hide()
    }

    fun destroyChessboard() {
        chessboard?.hide()
        chessboard = null
    }

    fun isChessboardVisible(): Boolean = chessboard?.isVisible == true

    /** Updates the position rendered by the floating chessboard. */
    fun setChessboardFen(fen: String) {
        chessboard?.setFen(fen)
    }

    /* ------------------------------------------------------------------ */
    /* Sample recording                                                    */
    /* ------------------------------------------------------------------ */

    /**
     * Starts collecting screenshots (plus the recognition result) so they can be
     * corrected by hand and used to fine-tune the detector.
     */
    fun startSampleRecording(): Boolean {
        val dir = resolveSampleDir() ?: return false
        sampleDir = dir
        sampleCount = countExistingSamples(dir)
        lastSampleTime = 0L
        lastSampleSignature = null
        sampleRecording = true
        Log.i(TAG, "Sample recording started in ${dir.absolutePath}")
        return true
    }

    fun stopSampleRecording() {
        sampleRecording = false
        sampleDir = null
        Log.i(TAG, "Sample recording stopped")
    }

    fun isSampleRecording(): Boolean = sampleRecording

    fun sampleCount(): Int = sampleCount

    fun samplePath(): String = sampleDirRef()?.absolutePath ?: ""

    /**
     * Writes the newest frame plus [annotationJson] as a sample pair.
     *
     * Called from JS, which passes the recognised boxes so the labelling tool can
     * pre-fill them (correcting existing boxes is much faster than drawing from
     * scratch).
     */
    fun saveSample(annotationJson: String): Boolean {
        if (!sampleRecording) return false
        val now = System.currentTimeMillis()
        if (now - lastSampleTime < SAMPLE_MIN_INTERVAL_MS) return false
        val dir = sampleDirRef() ?: return false

        // Everything runs under the frame lock: the capture thread recycles the
        // previous bitmap as soon as a new frame arrives.
        synchronized(frameLock) {
            val bitmap = latestBitmap ?: return false
            val signature = latestSignature

            // Skip frames that look the same as the last saved one; duplicates
            // add nothing to a training set.
            val previous = lastSampleSignature
            if (previous != null && signature != null) {
                var changed = 0
                for (i in signature.indices) {
                    if (Math.abs(signature[i] - previous[i]) > SIGNATURE_TOLERANCE) changed++
                }
                if (changed.toDouble() / signature.size < SAMPLE_MIN_CHANGE) return false
            }

            return try {
                val jpeg = encodeJpeg(bitmap, SAMPLE_QUALITY, SAMPLE_MAX_EDGE) ?: return false
                File(dir, "sample_$now.jpg").writeBytes(jpeg)
                File(dir, "sample_$now.json").writeText(annotationJson)
                lastSampleTime = now
                lastSampleSignature = signature
                sampleCount++
                true
            } catch (e: Exception) {
                Log.w(TAG, "Failed to save sample", e)
                false
            }
        }
    }

    /**
     * Prefers a user-visible folder (so the samples can be opened in any file
     * picker / the labelling page) and falls back to app-private storage.
     */
    private fun resolveSampleDir(): File? {
        try {
            val public = File(PUBLIC_SAMPLE_DIR)
            if (public.exists() || public.mkdirs()) {
                if (public.canWrite()) return public
            }
        } catch (e: Exception) {
            Log.i(TAG, "Public sample dir unavailable: ${e.message}")
        }
        return try {
            val dir = File(getExternalFilesDir(null), "line_samples")
            if (dir.exists() || dir.mkdirs()) dir else null
        } catch (e: Exception) {
            Log.w(TAG, "Failed to resolve sample dir", e)
            null
        }
    }

    private fun countExistingSamples(dir: File): Int {
        return try {
            dir.listFiles { f -> f.name.endsWith(".jpg") }?.size ?: 0
        } catch (e: Exception) {
            0
        }
    }

    /**
     * Opportunistic sample capture driven by new frames.
     *
     * Shares [frameLock] with [saveSample] so the "last saved" bookkeeping is
     * never written by two threads at once.
     */
    private fun maybeRecordSample(bitmap: Bitmap, signature: IntArray) {
        if (!sampleRecording) return
        val now = System.currentTimeMillis()
        if (now - lastSampleTime < SAMPLE_MIN_INTERVAL_MS) return

        synchronized(frameLock) {
            val previous = lastSampleSignature
            if (previous != null) {
                var changed = 0
                for (i in signature.indices) {
                    if (Math.abs(signature[i] - previous[i]) > SIGNATURE_TOLERANCE) changed++
                }
                if (changed.toDouble() / signature.size < SAMPLE_MIN_CHANGE) return
            }

            val dir = sampleDir ?: return
            try {
                val jpeg = encodeJpeg(bitmap, SAMPLE_QUALITY, SAMPLE_MAX_EDGE) ?: return
                File(dir, "sample_$now.jpg").writeBytes(jpeg)
                lastSampleTime = now
                lastSampleSignature = signature
                sampleCount++
            } catch (e: Exception) {
                Log.w(TAG, "Failed to save sample frame", e)
            }
        }
    }

    /** Reads the sample directory under the lock (it is written from another thread). */
    private fun sampleDirRef(): File? = synchronized(frameLock) { sampleDir }

    /**
     * Pushes new content into the floating bar. Each parameter is optional.
     */
    fun updateOverlay(
        turn: String?,
        status: String?,
        evaluation: String?,
        waiting: String?,
        autoRunning: Boolean?,
        autoEnabled: Boolean?,
        scanEnabled: Boolean?
    ) {
        overlay?.update(
            turn = turn,
            status = status,
            evaluation = evaluation,
            waiting = waiting,
            autoRunning = autoRunning,
            autoEnabled = autoEnabled,
            scanEnabled = scanEnabled
        )
    }

    /* ------------------------------------------------------------------ */
    /* JS loop driver                                                      */
    /* ------------------------------------------------------------------ */

    /**
     * Starts calling `window.__lineConnectTick__()` every [intervalMs].
     *
     * The webview throttles its own timers once the activity is not visible, so
     * the polling loop is driven from here instead.
     */
    fun startJsTick(intervalMs: Long) {
        val interval = intervalMs.coerceIn(200L, 10000L)
        val handler = tickHandler ?: Handler(Looper.getMainLooper()).also { tickHandler = it }
        tickRunnable?.let { handler.removeCallbacks(it) }

        val runnable = object : Runnable {
            override fun run() {
                tickCount++
                MainActivity.dispatchJs(
                    "if (window.__lineConnectTick__) { window.__lineConnectTick__(); }"
                )
                tickHandler?.postDelayed(this, interval)
            }
        }
        tickRunnable = runnable
        handler.postDelayed(runnable, interval)
        Log.i(TAG, "JS tick started with interval ${interval}ms")
    }

    /** Stops the JS loop driver. */
    fun stopJsTick() {
        tickRunnable?.let { tickHandler?.removeCallbacks(it) }
        tickRunnable = null
        Log.i(TAG, "JS tick stopped (ticks so far: $tickCount)")
    }

    /** Number of ticks emitted since the service started. */
    fun ticksSent(): Long = tickCount

    /** Sets the minimum interval between accepted frames. */
    fun setMinFrameInterval(intervalMs: Long) {
        minFrameIntervalMs = intervalMs.coerceIn(0L, 5000L)
    }

    fun stopCapture() {
        release(true)
    }

    private fun release(stopSelf: Boolean) {
        stopJsTick()
        destroyOverlay()
        stopSampleRecording()
        destroyChessboard()

        synchronized(frameLock) {
            latestBitmap?.recycle()
            latestBitmap = null
            latestSignature = null
            cachedFullJpeg = null
            cachedFullSignature = null
            cachedCropJpeg = null
            cachedCropKey = ""
        }

        try {
            imageReader?.setOnImageAvailableListener(null, null)
            imageReader?.close()
        } catch (_: Exception) {
            // ignore
        }
        imageReader = null

        try {
            virtualDisplay?.release()
        } catch (_: Exception) {
            // ignore
        }
        virtualDisplay = null

        try {
            mediaProjection?.unregisterCallback(projectionCallback)
            mediaProjection?.stop()
        } catch (_: Exception) {
            // ignore
        }
        mediaProjection = null

        handlerThread?.quitSafely()
        handlerThread = null
        handler = null

        if (instance === this) {
            instance = null
        }

        if (stopSelf) {
            try {
                stopForeground(true)
                stopSelf()
            } catch (_: Exception) {
                // ignore
            }
        }
    }

    /* ------------------------------------------------------------------ */
    /* Notification                                                        */
    /* ------------------------------------------------------------------ */

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.line_connect_channel_name),
            NotificationManager.IMPORTANCE_LOW
        )
        channel.description = getString(R.string.line_connect_channel_description)
        channel.setShowBadge(false)
        manager.createNotificationChannel(channel)
    }

    private fun startForegroundCompat() {
        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
        val pendingFlags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        } else {
            PendingIntent.FLAG_UPDATE_CURRENT
        }
        val pendingIntent = if (launchIntent != null) {
            PendingIntent.getActivity(this, 0, launchIntent, pendingFlags)
        } else {
            null
        }

        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }

        val notification = builder
            .setContentTitle(getString(R.string.line_connect_notification_title))
            .setContentText(getString(R.string.line_connect_notification_text))
            .setSmallIcon(android.R.drawable.ic_menu_view)
            .setOngoing(true)
            .apply { if (pendingIntent != null) setContentIntent(pendingIntent) }
            .build()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }
}
