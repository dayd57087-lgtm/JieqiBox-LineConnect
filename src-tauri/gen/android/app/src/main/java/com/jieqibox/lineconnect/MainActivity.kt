package com.jieqibox.lineconnect

import android.app.Activity
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.DocumentsContract
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.documentfile.provider.DocumentFile
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream

class MainActivity : TauriActivity() {

    companion object {
        private const val TAG = "MainActivity"

        /**
         * Weak handle on the live webview so background components (the capture
         * service, the floating bar) can push events into the running app.
         */
        @Volatile
        private var webViewRef: java.lang.ref.WeakReference<WebView>? = null

        /** Evaluates [script] in the app webview, if one is alive. */
        fun dispatchJs(script: String) {
            val view = webViewRef?.get() ?: return
            view.post {
                try {
                    view.evaluateJavascript(script, null)
                } catch (e: Exception) {
                    Log.w(TAG, "Failed to evaluate JS", e)
                }
            }
        }
    }

    private var webView: WebView? = null
    
    // Store the current SAF request data
    private var currentSafRequest: Map<String, String>? = null

    // Screen capture token granted by the user for the line-connect feature.
    // Android only allows a single use per grant, so it is cleared once consumed.
    private var pendingProjectionResultCode: Int = 0
    private var pendingProjectionData: Intent? = null

    private val lineConnectBridge by lazy { LineConnectBridge(this) }

    // Activity result launcher for SAF file selection
    private val safFileSelectionLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (result.resultCode == Activity.RESULT_OK) {
            val data = result.data
            if (data != null) {
                val uri = data.data
                if (uri != null) {
                    handleSafFileSelection(uri)
                } else {
                    Log.e(TAG, "No URI returned from SAF file selection")
                    sendSafFileResult("", "", "No URI returned")
                }
            } else {
                Log.e(TAG, "No data returned from SAF file selection")
                sendSafFileResult("", "", "No data returned")
            }
        } else {
            Log.e(TAG, "SAF file selection cancelled or failed")
            sendSafFileResult("", "", "File selection cancelled")
        }
        // Clear the current request after handling
        currentSafRequest = null
    }

    // Activity result launcher for the MediaProjection permission dialog
    private val projectionPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val data = result.data
        if (result.resultCode == Activity.RESULT_OK && data != null) {
            pendingProjectionResultCode = result.resultCode
            pendingProjectionData = data
            Log.i(TAG, "Screen capture permission granted")
            dispatchProjectionPermissionResult(true, "granted")
        } else {
            pendingProjectionResultCode = 0
            pendingProjectionData = null
            Log.w(TAG, "Screen capture permission denied")
            dispatchProjectionPermissionResult(false, "denied")
        }
    }
    
    override fun onWebViewCreate(webView: WebView) {
        super.onWebViewCreate(webView)
        this.webView = webView
        webViewRef = java.lang.ref.WeakReference(webView)
        webView.addJavascriptInterface(SafFileInterface(), "SafFileInterface")
        
        // Listen for external URL opening events from Tauri
        webView.addJavascriptInterface(ExternalUrlInterface(), "ExternalUrlInterface")

        // Line connect (连线自动走棋) bridge
        webView.addJavascriptInterface(lineConnectBridge, "LineConnect")
        
        // Listen for Tauri events
        setupTauriEventListeners()
    }
    
    private fun setupTauriEventListeners() {
        // Listen for SAF file selection requests from Tauri
        webView?.addJavascriptInterface(object {
            @JavascriptInterface
            fun onTauriEvent(eventName: String, eventData: String) {
                Log.d(TAG, "Received Tauri event: $eventName with data: $eventData")
                when (eventName) {
                    "request-saf-file-selection" -> {
                        try {
                            // Parse the JSON data
                            val jsonData = org.json.JSONObject(eventData)
                            val name = jsonData.getString("name")
                            val args = jsonData.getString("args")
                            
                            currentSafRequest = mapOf("name" to name, "args" to args)
                            
                            runOnUiThread {
                                requestSafFileSelection()
                            }
                        } catch (e: Exception) {
                            Log.e(TAG, "Error parsing SAF request data", e)
                        }
                    }
                }
            }
        }, "TauriEventHandler")
    }
    
    // JavaScript interface for SAF file selection (legacy support)
    inner class SafFileInterface {
        @JavascriptInterface
        fun startFileSelection() {
            Log.d(TAG, "Received SAF file selection request from JavaScript")
            runOnUiThread {
                this@MainActivity.requestSafFileSelection()
            }
        }
    }
    
    // JavaScript interface for external URL opening
    inner class ExternalUrlInterface {
        @JavascriptInterface
        fun openExternalUrl(url: String) {
            Log.d(TAG, "Received external URL opening request: $url")
            runOnUiThread {
                this@MainActivity.openExternalUrl(url)
            }
        }
    }
    
    private fun requestSafFileSelection() {
        try {
            val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = "*/*" // Allow all file types for engine files
                putExtra(Intent.EXTRA_TITLE, "Select Engine File")
            }
            
            safFileSelectionLauncher.launch(intent)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to launch SAF file selection", e)
            sendSafFileResult("", "", "Failed to launch file selector: ${e.message}")
        }
    }
    
    private fun handleSafFileSelection(uri: Uri) {
        try {
            Log.d(TAG, "Handling SAF file selection: $uri")
            
            // Get file information
            val documentFile = DocumentFile.fromSingleUri(this, uri)
            if (documentFile == null) {
                Log.e(TAG, "Failed to create DocumentFile from URI")
                sendSafFileResult("", "", "Failed to access selected file")
                return
            }
            
            val filename = documentFile.name ?: "unknown_engine"
            Log.d(TAG, "Selected file: $filename")
            
            // Copy file to internal storage
            val internalPath = copyFileToInternalStorage(uri, filename)
            if (internalPath.isNotEmpty()) {
                Log.d(TAG, "Successfully copied file to: $internalPath")
                
                // If we have current SAF request data, send it to the Rust backend
                if (currentSafRequest != null) {
                    val name = currentSafRequest!!["name"] ?: ""
                    val args = currentSafRequest!!["args"] ?: ""
                    
                    // Escape special characters in the parameters to prevent JavaScript errors
                    val escapedInternalPath = internalPath.replace("\\", "\\\\").replace("'", "\\'")
                    val escapedFilename = filename.replace("'", "\\'")
                    val escapedName = name.replace("'", "\\'")
                    val escapedArgs = args.replace("'", "\\'")
                    
                    // Call the Rust backend to handle the SAF file result
                    val jsCode = "window.__TAURI__.invoke('handle_saf_file_result', { " +
                        "tempFilePath: '$escapedInternalPath', " +
                        "filename: '$escapedFilename', " +
                        "name: '$escapedName', " +
                        "args: '$escapedArgs' " +
                        "}).catch(function(error) { " +
                        "console.error('SAF file result handling failed:', error); " +
                        "window.dispatchEvent(new CustomEvent('saf-file-result', { " +
                        "detail: { uri: '', filename: '', result: 'Failed to process engine: ' + error } " +
                        "})); " +
                        "});"
                    
                    Log.d(TAG, "Executing JavaScript: $jsCode")
                    webView?.evaluateJavascript(jsCode, null)
                } else {
                    // Fallback: send result via custom event
                    sendSafFileResult(uri.toString(), filename, internalPath)
                }
            } else {
                Log.e(TAG, "Failed to copy file to internal storage")
                sendSafFileResult("", "", "Failed to copy file to internal storage")
            }
            
        } catch (e: Exception) {
            Log.e(TAG, "Error handling SAF file selection", e)
            sendSafFileResult("", "", "Error processing file: ${e.message}")
        }
    }
    
    private fun copyFileToInternalStorage(uri: Uri, filename: String): String {
        try {
            // Get internal storage directory
            val internalDir = File(filesDir, "engines")
            if (!internalDir.exists()) {
                internalDir.mkdirs()
            }
            
            val destFile = File(internalDir, filename)
            Log.d(TAG, "Copying file to: ${destFile.absolutePath}")
            
            // Copy file content
            contentResolver.openInputStream(uri)?.use { inputStream ->
                FileOutputStream(destFile).use { outputStream ->
                    inputStream.copyTo(outputStream)
                }
            }
            
            // Set executable permissions
            destFile.setExecutable(true)
            
            return destFile.absolutePath
            
        } catch (e: Exception) {
            Log.e(TAG, "Error copying file to internal storage", e)
            return ""
        }
    }
    
    private fun sendSafFileResult(uri: String, filename: String, result: String) {
        try {
            // Send result back to JavaScript
            val jsCode = "window.dispatchEvent(new CustomEvent('saf-file-result', { detail: { uri: '$uri', filename: '$filename', result: '$result' } }));"
            runOnUiThread {
                webView?.evaluateJavascript(jsCode, null)
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error sending SAF file result to JavaScript", e)
        }
    }
    
    // Open external URL in default browser
    private fun openExternalUrl(url: String) {
        try {
            Log.d(TAG, "Opening external URL: $url")
            
            // Create intent to open URL in external browser
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url))
            
            // Check if there's an app that can handle this intent
            if (intent.resolveActivity(packageManager) != null) {
                startActivity(intent)
                Log.d(TAG, "Successfully opened URL in external browser")
            } else {
                Log.e(TAG, "No app found to handle URL: $url")
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error opening external URL: $url", e)
        }
    }

    /* ------------------------------------------------------------------ */
    /* Line connect: screen capture plumbing                               */
    /* ------------------------------------------------------------------ */

    /** True when a screen capture token is available for the capture service. */
    fun hasPendingProjection(): Boolean = pendingProjectionData != null

    /** Discards the stored screen capture token. */
    fun clearProjectionPermission() {
        pendingProjectionData = null
        pendingProjectionResultCode = 0
    }

    /** Shows the system screen capture consent dialog. */
    fun requestProjectionPermission() {
        runOnUiThread {
            try {
                val manager = getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
                projectionPermissionLauncher.launch(manager.createScreenCaptureIntent())
            } catch (e: Exception) {
                Log.e(TAG, "Failed to request screen capture permission", e)
                dispatchProjectionPermissionResult(false, "error: ${e.message}")
            }
        }
    }

    /**
     * Starts the foreground capture service with the stored token.
     *
     * @return true when the service was launched.
     */
    fun startProjectionService(scale: Float, quality: Int, intervalMs: Long): Boolean {
        val data = pendingProjectionData
        if (data == null) {
            Log.w(TAG, "startProjectionService called without a valid token")
            return false
        }
        return try {
            val intent = Intent(this, ScreenCaptureService::class.java).apply {
                putExtra(ScreenCaptureService.EXTRA_RESULT_CODE, pendingProjectionResultCode)
                putExtra(ScreenCaptureService.EXTRA_DATA, data)
                putExtra(ScreenCaptureService.EXTRA_SCALE, scale)
                putExtra(ScreenCaptureService.EXTRA_QUALITY, quality)
                putExtra(ScreenCaptureService.EXTRA_INTERVAL_MS, intervalMs)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(intent)
            } else {
                startService(intent)
            }
            // A projection token can only be consumed once.
            clearProjectionPermission()
            true
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start capture service", e)
            false
        }
    }

    /** Stops the capture service if it is running. */
    fun stopProjectionService() {
        try {
            ScreenCaptureService.instance?.stopCapture()
        } catch (e: Exception) {
            Log.w(TAG, "Failed to stop capture service", e)
        }
    }

    private fun dispatchProjectionPermissionResult(granted: Boolean, reason: String) {
        val jsCode = "window.dispatchEvent(new CustomEvent('line-connect-projection', " +
            "{ detail: { granted: $granted, reason: '${reason.replace("'", "\\'")}' } }));"
        runOnUiThread {
            webView?.evaluateJavascript(jsCode, null)
        }
    }

    /**
     * Brings this task back to the foreground.
     *
     * Named `moveToFront` because `bringToFront()` already exists on Activity.
     * Used by the floating bar's "棋盘" action.
     */
    fun moveToFront() {
        try {
            val intent = Intent(this, MainActivity::class.java).apply {
                addFlags(
                    Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or
                        Intent.FLAG_ACTIVITY_NEW_TASK
                )
            }
            startActivity(intent)
        } catch (e: Exception) {
            Log.w(TAG, "Failed to bring the app to front", e)
        }
    }

    /** True when the app is allowed to draw over other apps. */
    fun canDrawOverlaysNow(): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            android.provider.Settings.canDrawOverlays(this)
        } else {
            true
        }
    }

    /** Best-effort foreground package lookup, preferring the accessibility service. */
    fun currentForegroundPackage(): String {
        val service = AutoPlayAccessibilityService.instance
        try {
            val pkg = service?.rootInActiveWindow?.packageName?.toString()
            if (!pkg.isNullOrEmpty()) return pkg
        } catch (_: Exception) {
            // fall through
        }
        return ""
    }

    /**
     * A webview that is considered hidden throttles its own timers, which would
     * stall the line-connect loop as soon as the user switches to the game app.
     * Tauri may pause the timers in `super.onPause()`, so they are resumed again
     * afterwards; the loop itself is driven natively by ScreenCaptureService.
     */
    override fun onPause() {
        super.onPause()
        try {
            webView?.resumeTimers()
        } catch (e: Exception) {
            Log.w(TAG, "Failed to resume webview timers", e)
        }
    }

    override fun onDestroy() {
        stopProjectionService()
        webViewRef = null
        super.onDestroy()
    }
}
