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
import android.util.Base64
import android.util.DisplayMetrics
import android.util.Log
import android.view.WindowManager
import java.io.ByteArrayOutputStream
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

    /** Newest frame as JPEG bytes, guarded by [frameLock]. */
    private var latestJpeg: ByteArray? = null
    private val frameLock = Any()

    /** Timestamp (ms) of the newest frame. */
    @Volatile var lastFrameTime = 0L
        private set

    @Volatile private var frameCounter = 0L

    /** Throttle: ignore frames arriving faster than this. */
    @Volatile private var minFrameIntervalMs = 120L
    private var lastAcceptedTime = 0L

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

            val jpeg = imageToJpeg(image, jpegQuality) ?: return
            synchronized(frameLock) {
                latestJpeg = jpeg
                lastFrameTime = now
                frameCounter++
            }
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

    private fun imageToJpeg(image: Image, quality: Int): ByteArray? {
        val plane = image.planes.firstOrNull() ?: return null
        val buffer: ByteBuffer = plane.buffer
        val pixelStride = plane.pixelStride
        val rowStride = plane.rowStride
        val rowPadding = rowStride - pixelStride * image.width

        val bitmap = Bitmap.createBitmap(
            image.width + rowPadding / pixelStride,
            image.height,
            Bitmap.Config.ARGB_8888
        )
        buffer.rewind()
        bitmap.copyPixelsFromBuffer(buffer)

        val cropped = if (rowPadding == 0) {
            bitmap
        } else {
            Bitmap.createBitmap(bitmap, 0, 0, image.width, image.height)
        }

        val out = ByteArrayOutputStream()
        cropped.compress(Bitmap.CompressFormat.JPEG, quality, out)

        if (cropped !== bitmap) {
            cropped.recycle()
        }
        bitmap.recycle()

        return out.toByteArray()
    }

    /* ------------------------------------------------------------------ */
    /* Public API used by the JS bridge                                    */
    /* ------------------------------------------------------------------ */

    /** Returns the newest frame as a base64 encoded JPEG, or null when none is ready. */
    fun captureFrameBase64(): String? {
        val jpeg = synchronized(frameLock) {
            latestJpeg?.copyOf()
        } ?: return null
        return Base64.encodeToString(jpeg, Base64.NO_WRAP)
    }

    /** Returns how many frames have been produced since the service started. */
    fun framesCaptured(): Long = frameCounter

    /** Sets the minimum interval between accepted frames. */
    fun setMinFrameInterval(intervalMs: Long) {
        minFrameIntervalMs = intervalMs.coerceIn(0L, 5000L)
    }

    fun stopCapture() {
        release(true)
    }

    private fun release(stopSelf: Boolean) {
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

        synchronized(frameLock) {
            latestJpeg = null
        }

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
