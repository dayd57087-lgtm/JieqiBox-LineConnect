package com.jieqibox.lineconnect

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.PixelFormat
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.LinearLayout
import android.widget.TextView

/**
 * Draggable control/status bar drawn on top of other apps.
 *
 * Layout (mirrors the reference design):
 *
 *   [新局][扫描][自动][变招][棋盘]                        [✕]
 *   轮到红方 · 识别中        评估 +0.35        等待 3s
 *
 * The whole bar is draggable by its status row; the buttons keep their own
 * click handling.
 */
class LineConnectOverlay(
    private val context: Context,
    private val onAction: (String) -> Unit
) {

    companion object {
        private const val TAG = "LineConnectOverlay"

        const val ACTION_NEW_GAME = "newGame"
        const val ACTION_SCAN = "scan"
        const val ACTION_AUTO = "auto"
        const val ACTION_VARIATION = "variation"
        const val ACTION_BOARD = "board"
        const val ACTION_APP = "app"
        const val ACTION_COLLAPSE = "collapse"
        const val ACTION_CLOSE = "close"

        private const val COLOR_BAR_BG = 0xE8171717.toInt()
        private const val COLOR_BTN = 0xFF3A3A3A.toInt()
        private const val COLOR_BTN_GREEN = 0xFF2E7D32.toInt()
        private const val COLOR_BTN_RED = 0xFFC62828.toInt()
        private const val COLOR_BTN_AMBER = 0xFFB8860B.toInt()
        private const val COLOR_TEXT = 0xFFFFFFFF.toInt()
        private const val COLOR_TEXT_DIM = 0xFFB4B4B4.toInt()
        private const val COLOR_DIVIDER = 0x33FFFFFF
    }

    private val mainHandler = Handler(Looper.getMainLooper())
    private var root: View? = null
    private var bar: LinearLayout? = null
    private var params: WindowManager.LayoutParams? = null
    private var windowManager: WindowManager? = null

    private var turnView: TextView? = null
    private var statusView: TextView? = null
    private var evalView: TextView? = null
    private var waitView: TextView? = null
    private var autoButton: TextView? = null
    private val actionButtons = mutableMapOf<String, TextView>()

    /** Collapsed mode keeps only the status row, to get out of the way. */
    private var collapsed = false

    val isVisible: Boolean
        get() = root != null

    val isCollapsed: Boolean
        get() = collapsed

    /* ------------------------------------------------------------------ */
    /* Lifecycle                                                           */
    /* ------------------------------------------------------------------ */

    /** Adds the bar to the screen. Safe to call repeatedly. */
    fun show(): Boolean {
        if (root != null) return true

        var added = false
        runOnMain {
            try {
                val wm = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
                windowManager = wm
                val view = buildBar()
                val lp = WindowManager.LayoutParams(
                    WindowManager.LayoutParams.WRAP_CONTENT,
                    WindowManager.LayoutParams.WRAP_CONTENT,
                    overlayType(),
                    WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                        WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
                    PixelFormat.TRANSLUCENT
                ).apply {
                    gravity = Gravity.TOP or Gravity.START
                    x = dp(10)
                    y = dp(90)
                }
                wm.addView(view, lp)
                root = view
                params = lp
                added = true
                Log.i(TAG, "Overlay shown")
            } catch (e: Exception) {
                Log.e(TAG, "Failed to add overlay view", e)
            }
        }
        return added
    }

    /** Removes the bar from the screen. */
    fun hide() {
        runOnMain {
            val view = root ?: return@runOnMain
            try {
                windowManager?.removeView(view)
            } catch (e: Exception) {
                Log.w(TAG, "Failed to remove overlay view", e)
            }
            root = null
            params = null
            bar = null
            turnView = null
            statusView = null
            evalView = null
            waitView = null
            autoButton = null
            actionButtons.clear()
            Log.i(TAG, "Overlay hidden")
        }
    }

    /** Collapses the bar to a single compact row. */
    fun setCollapsed(value: Boolean) {
        runOnMain {
            collapsed = value
            bar?.let { b ->
                // Row 0 = buttons, row 1 = status. In collapsed mode the status
                // row becomes the drag handle for the whole bar.
                b.getChildAt(0)?.visibility = if (value) View.GONE else View.VISIBLE
                b.requestLayout()
            }
        }
    }

    /* ------------------------------------------------------------------ */
    /* Content updates                                                     */
    /* ------------------------------------------------------------------ */

    /**
     * Refreshes the visible state. Every argument is optional so the caller can
     * push just the fields that changed.
     */
    fun update(
        turn: String? = null,
        status: String? = null,
        evaluation: String? = null,
        waiting: String? = null,
        autoRunning: Boolean? = null,
        autoEnabled: Boolean? = null,
        scanEnabled: Boolean? = null
    ) {
        runOnMain {
            turn?.let { turnView?.text = it }
            status?.let { statusView?.text = it }
            evaluation?.let { evalView?.text = it }
            waiting?.let { waitView?.text = it }

            autoRunning?.let { running ->
                autoButton?.let { btn ->
                    btn.text = context.getString(
                        if (running) R.string.line_connect_overlay_auto_stop
                        else R.string.line_connect_overlay_auto_start
                    )
                    btn.background = buttonBackground(
                        if (running) COLOR_BTN_RED else COLOR_BTN_AMBER
                    )
                }
            }
            autoEnabled?.let { enabled ->
                autoButton?.alpha = if (enabled) 1f else 0.4f
            }
            scanEnabled?.let { enabled ->
                actionButtons[ACTION_SCAN]?.alpha = if (enabled) 1f else 0.4f
            }
        }
    }

    /* ------------------------------------------------------------------ */
    /* View construction                                                   */
    /* ------------------------------------------------------------------ */

    private fun buildBar(): View {
        val column = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            background = GradientDrawable().apply {
                setColor(COLOR_BAR_BG)
                cornerRadius = dpF(12f)
            }
            // Padding inside the rounded background
            val p = dp(6)
            setPadding(p, dp(5), p, dp(5))
            elevation = dpF(8f)
        }

        /* --- row 0: action buttons --- */
        val buttonRow = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }

        buttonRow.addView(
            makeButton(
                context.getString(R.string.line_connect_overlay_new_game),
                ACTION_NEW_GAME,
                COLOR_BTN_GREEN
            )
        )
        buttonRow.addView(
            makeButton(
                context.getString(R.string.line_connect_overlay_scan),
                ACTION_SCAN,
                COLOR_BTN
            )
        )
        buttonRow.addView(
            makeButton(
                context.getString(R.string.line_connect_overlay_auto_start),
                ACTION_AUTO,
                COLOR_BTN_AMBER
            ).also { autoButton = it }
        )
        buttonRow.addView(
            makeButton(
                context.getString(R.string.line_connect_overlay_variation),
                ACTION_VARIATION,
                COLOR_BTN
            )
        )
        buttonRow.addView(
            makeButton(
                context.getString(R.string.line_connect_overlay_board),
                ACTION_BOARD,
                COLOR_BTN
            )
        )

        val spacer = View(context).apply {
            layoutParams = LinearLayout.LayoutParams(0, 1, 1f)
        }
        buttonRow.addView(spacer)

        buttonRow.addView(
            makeButton(
                context.getString(R.string.line_connect_overlay_app),
                ACTION_APP,
                COLOR_BTN
            )
        )
        buttonRow.addView(
            makeButton("\u2715", ACTION_CLOSE, COLOR_BTN, compact = true)
        )

        column.addView(buttonRow)

        /* --- row 1: status (also the drag handle) --- */
        val statusRow = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            val p = dp(6)
            setPadding(p, dp(4), p, dp(2))
        }

        turnView = makeStatusText(context.getString(R.string.line_connect_overlay_idle), COLOR_TEXT)
        statusView = makeStatusText("", COLOR_TEXT_DIM)
        evalView = makeStatusText("", COLOR_TEXT_DIM)
        waitView = makeStatusText("", COLOR_TEXT_DIM)

        statusRow.addView(turnView)
        statusRow.addView(makeDivider())
        statusRow.addView(statusView)

        val statusSpacer = View(context).apply {
            layoutParams = LinearLayout.LayoutParams(0, 1, 1f)
        }
        statusRow.addView(statusSpacer)

        statusRow.addView(evalView)
        statusRow.addView(makeDivider())
        statusRow.addView(waitView)

        // The status row doubles as the drag handle.
        attachDrag(statusRow)

        column.addView(statusRow)

        return column
    }

    private fun makeStatusText(initial: String, color: Int): TextView {
        return TextView(context).apply {
            text = initial
            setTextColor(color)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
            maxLines = 1
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            )
        }
    }

    private fun makeDivider(): View {
        return View(context).apply {
            setBackgroundColor(COLOR_DIVIDER)
            layoutParams = LinearLayout.LayoutParams(dp(1), dp(11)).apply {
                marginStart = dp(6)
                marginEnd = dp(6)
            }
        }
    }

    private fun makeButton(
        label: String,
        action: String,
        color: Int,
        compact: Boolean = false
    ): TextView {
        val btn = TextView(context).apply {
            text = label
            setTextColor(COLOR_TEXT)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, if (compact) 12f else 12f)
            gravity = Gravity.CENTER
            isClickable = true
            isFocusable = false
            background = buttonBackground(color)
            val hPad = if (compact) dp(8) else dp(9)
            setPadding(hPad, dp(7), hPad, dp(7))
            minWidth = dp(34)
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply {
                marginEnd = dp(4)
            }
        }
        btn.setOnClickListener {
            if (action == ACTION_COLLAPSE) {
                setCollapsed(!collapsed)
            } else if (action == ACTION_CLOSE) {
                onAction(ACTION_CLOSE)
            } else {
                onAction(action)
            }
        }
        actionButtons[action] = btn
        return btn
    }

    private fun buttonBackground(color: Int): Drawable {
        val shape = GradientDrawable().apply {
            setColor(color)
            cornerRadius = dpF(7f)
        }
        return RippleDrawable(ColorStateList.valueOf(0x55FFFFFF), shape, null)
    }

    /* ------------------------------------------------------------------ */
    /* Dragging                                                            */
    /* ------------------------------------------------------------------ */

    private fun attachDrag(handle: View) {
        var startX = 0
        var startY = 0
        var touchX = 0f
        var touchY = 0f
        var dragging = false

        handle.setOnTouchListener { _, event ->
            val lp = params ?: return@setOnTouchListener false
            when (event.action) {
                MotionEvent.ACTION_DOWN -> {
                    startX = lp.x
                    startY = lp.y
                    touchX = event.rawX
                    touchY = event.rawY
                    dragging = false
                    true
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = (event.rawX - touchX).toInt()
                    val dy = (event.rawY - touchY).toInt()
                    if (!dragging && (Math.abs(dx) > dp(4) || Math.abs(dy) > dp(4))) {
                        dragging = true
                    }
                    if (dragging) {
                        lp.x = startX + dx
                        lp.y = (startY + dy).coerceAtLeast(0)
                        try {
                            root?.let { windowManager?.updateViewLayout(it, lp) }
                        } catch (e: Exception) {
                            Log.w(TAG, "Failed to move overlay", e)
                        }
                    }
                    true
                }
                MotionEvent.ACTION_UP -> {
                    if (!dragging) {
                        // Tapping the status row toggles the collapsed state.
                        setCollapsed(!collapsed)
                    }
                    true
                }
                else -> false
            }
        }
    }

    /* ------------------------------------------------------------------ */
    /* Helpers                                                             */
    /* ------------------------------------------------------------------ */

    private fun overlayType(): Int {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        } else {
            @Suppress("DEPRECATION")
            WindowManager.LayoutParams.TYPE_PHONE
        }
    }

    private fun dp(value: Int): Int = dpF(value.toFloat()).toInt()

    private fun dpF(value: Float): Float {
        return value * context.resources.displayMetrics.density
    }

    private fun runOnMain(block: () -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            block()
        } else {
            mainHandler.post(block)
        }
    }
}
