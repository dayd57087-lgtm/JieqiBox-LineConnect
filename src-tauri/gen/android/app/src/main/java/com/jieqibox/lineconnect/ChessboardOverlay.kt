package com.jieqibox.lineconnect

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.PixelFormat
import android.graphics.RectF
import android.graphics.Typeface
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
import android.widget.FrameLayout
import android.widget.TextView

/**
 * Floating chessboard that mirrors the recognised position.
 *
 * Meant to be used while another chess app is in the foreground, so the board
 * has to be movable and resizable by the user:
 *
 *  - drag anywhere on the board    -> move the window
 *  - drag the grip in the corner   -> resize (aspect ratio is preserved)
 *  - tap the ✕ at the top right    -> hide it
 */
class ChessboardOverlay(private val context: Context) {

    companion object {
        private const val TAG = "ChessboardOverlay"

        private const val MIN_SIZE_DP = 150
        private const val MOVE_SLOP_DP = 4
    }

    private val mainHandler = Handler(Looper.getMainLooper())

    private var root: FrameLayout? = null
    private var board: XiangqiBoardView? = null
    private var params: WindowManager.LayoutParams? = null
    private var windowManager: WindowManager? = null

    /** Last FEN pushed from the webview. */
    @Volatile
    private var pendingFen: String = ""

    val isVisible: Boolean
        get() = root != null

    /* ------------------------------------------------------------------ */
    /* Lifecycle                                                           */
    /* ------------------------------------------------------------------ */

    fun show(): Boolean {
        if (root != null) return true

        var added = false
        runOnMain {
            try {
                val wm = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
                windowManager = wm
                val view = buildView()
                val lp = WindowManager.LayoutParams(
                    dp(defaultSize()),
                    dp(defaultSize()),
                    overlayType(),
                    WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                        WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
                    PixelFormat.TRANSLUCENT
                ).apply {
                    gravity = Gravity.TOP or Gravity.START
                    x = dp(20)
                    y = dp(180)
                }
                wm.addView(view, lp)
                root = view
                params = lp
                attachMove(view)
                board?.fen = pendingFen
                added = true
                Log.i(TAG, "Chessboard shown")
            } catch (e: Exception) {
                Log.e(TAG, "Failed to add chessboard view", e)
            }
        }
        return added
    }

    fun hide() {
        runOnMain {
            val view = root ?: return@runOnMain
            try {
                windowManager?.removeView(view)
            } catch (e: Exception) {
                Log.w(TAG, "Failed to remove chessboard view", e)
            }
            root = null
            params = null
            board = null
            Log.i(TAG, "Chessboard hidden")
        }
    }

    /** Updates the rendered position. Also works before the board is shown. */
    fun setFen(fen: String) {
        pendingFen = fen
        runOnMain { board?.fen = fen }
    }

    fun currentFen(): String = pendingFen

    /* ------------------------------------------------------------------ */
    /* View construction                                                   */
    /* ------------------------------------------------------------------ */

    private fun buildView(): FrameLayout {
        val container = FrameLayout(context)

        val boardView = XiangqiBoardView(context).apply {
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
        }
        board = boardView
        container.addView(boardView)

        // Close button, top-right
        val close = TextView(context).apply {
            text = "\u2715"
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
            gravity = Gravity.CENTER
            background = RippleDrawable(
                ColorStateList.valueOf(0x55FFFFFF),
                GradientDrawable().apply {
                    setColor(0x99000000.toInt())
                    cornerRadius = dpF(11f)
                },
                null
            )
            isClickable = true
            layoutParams = FrameLayout.LayoutParams(dp(22), dp(22)).apply {
                gravity = Gravity.TOP or Gravity.END
                topMargin = dp(4)
                marginEnd = dp(4)
            }
            setOnClickListener { hide() }
        }
        container.addView(close)

        // Resize grip, bottom-right
        val grip = TextView(context).apply {
            text = "\u25E2"
            setTextColor(0xCCFFFFFF.toInt())
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
            gravity = Gravity.CENTER
            isClickable = true
            layoutParams = FrameLayout.LayoutParams(dp(26), dp(26)).apply {
                gravity = Gravity.BOTTOM or Gravity.END
            }
        }
        container.addView(grip)
        attachResize(grip)

        return container
    }

    /* ------------------------------------------------------------------ */
    /* Gestures                                                            */
    /* ------------------------------------------------------------------ */

    private fun attachMove(container: View) {
        var startX = 0
        var startY = 0
        var touchX = 0f
        var touchY = 0f
        var dragging = false

        container.setOnTouchListener { _, event ->
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
                    if (!dragging &&
                        (Math.abs(dx) > dp(MOVE_SLOP_DP) || Math.abs(dy) > dp(MOVE_SLOP_DP))
                    ) {
                        dragging = true
                    }
                    if (dragging) {
                        lp.x = startX + dx
                        lp.y = (startY + dy).coerceAtLeast(0)
                        applyLayout()
                    }
                    true
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> true
                else -> false
            }
        }
    }

    private fun attachResize(grip: View) {
        var startW = 0
        var startH = 0
        var touchX = 0f
        var touchY = 0f

        grip.setOnTouchListener { _, event ->
            val lp = params ?: return@setOnTouchListener false
            when (event.action) {
                MotionEvent.ACTION_DOWN -> {
                    startW = lp.width
                    startH = lp.height
                    touchX = event.rawX
                    touchY = event.rawY
                    true
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = (event.rawX - touchX).toInt()
                    val dy = (event.rawY - touchY).toInt()
                    // Use the dominant axis so the gesture feels natural in both
                    // directions while keeping the board's 9:10 aspect ratio.
                    val delta = if (Math.abs(dx) >= Math.abs(dy)) dx else dy
                    val maxSize = maxSizePx()
                    val newW = (startW + delta).coerceIn(dp(MIN_SIZE_DP), maxSize)
                    lp.width = newW
                    lp.height = newW * 10 / 9
                    applyLayout()
                    true
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> true
                else -> false
            }
        }
    }

    private fun applyLayout() {
        try {
            val view = root ?: return
            val lp = params ?: return
            windowManager?.updateViewLayout(view, lp)
        } catch (e: Exception) {
            Log.w(TAG, "Failed to update chessboard layout", e)
        }
    }

    /* ------------------------------------------------------------------ */
    /* Helpers                                                             */
    /* ------------------------------------------------------------------ */

    private fun defaultSize(): Int {
        val widthDp = (context.resources.displayMetrics.widthPixels /
            context.resources.displayMetrics.density).toInt()
        // Roughly 60% of the screen width, clamped to a comfortable range.
        return (widthDp * 0.6f).toInt().coerceIn(MIN_SIZE_DP, 420)
    }

    private fun maxSizePx(): Int {
        val dm = context.resources.displayMetrics
        return Math.min(dm.widthPixels, dm.heightPixels)
    }

    private fun overlayType(): Int {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        } else {
            @Suppress("DEPRECATION")
            WindowManager.LayoutParams.TYPE_PHONE
        }
    }

    private fun dp(value: Int): Int = dpF(value.toFloat()).toInt()

    private fun dpF(value: Float): Float = value * context.resources.displayMetrics.density

    private fun runOnMain(block: () -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) block()
        else mainHandler.post(block)
    }
}

/**
 * Draws a xiangqi board plus the pieces described by a Jieqi FEN.
 *
 * Uppercase letters are red (bottom half), lowercase are black (top half), and
 * `X` / `x` are hidden (unrevealed) pieces of either side.
 */
class XiangqiBoardView(context: Context) : View(context) {

    companion object {
        private const val BG_COLOR = 0xFFD9B382.toInt()
        private const val BG_EDGE = 0xFF8B5A2B.toInt()
        private const val LINE_COLOR = 0xFF4A3728.toInt()
        private const val RIVER_TEXT = 0xFF4A3728.toInt()

        /** Piece glyphs, colour independent: index 0..6 = K A B N R C P. */
        private val RED_GLYPHS = arrayOf(
            "\u5E05", "\u4ED5", "\u76F8", "\u9A6C", "\u8F66", "\u70AE", "\u5175"
        )
        private val BLACK_GLYPHS = arrayOf(
            "\u5C06", "\u58EB", "\u8C61", "\u9A6C", "\u8F66", "\u70AE", "\u5352"
        )
        private const val RIVER_LEFT = "\u695A\u6CB3"
        private const val RIVER_RIGHT = "\u6C49\u754C"

        /** FEN letter -> index into the glyph arrays. */
        private val LETTER_INDEX = mapOf(
            'K' to 0, 'A' to 1, 'B' to 2, 'N' to 3, 'R' to 4, 'C' to 5, 'P' to 6
        )
    }

    private val linePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = LINE_COLOR
        style = Paint.Style.STROKE
        strokeWidth = 1.5f
    }
    private val bgPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = BG_COLOR }
    private val edgePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = BG_EDGE
        style = Paint.Style.STROKE
        strokeWidth = 3f
    }
    private val pieceFillPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = 0xFFF3E2C7.toInt()
    }
    private val hiddenFillPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = 0xFF3A3A3A.toInt()
    }
    private val hiddenRingPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = 0xFFCFCFCF.toInt()
        style = Paint.Style.STROKE
        strokeWidth = 2f
    }
    private val redPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xFFC62828.toInt() }
    private val blackPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xFF1A1A1A.toInt() }
    private val pieceBorderPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = 2f
    }
    private val riverPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = RIVER_TEXT
        textAlign = Paint.Align.CENTER
    }

    /** Cells[row][col] holds the FEN letter, or '\u0000' when empty. */
    private var cells: Array<CharArray> =
        Array(10) { CharArray(9) { '\u0000' } }

    var fen: String = ""
        set(value) {
            if (field == value) return
            field = value
            parseFen(value)
            invalidate()
        }

    init {
        setLayerType(LAYER_TYPE_SOFTWARE, null)
    }

    private fun parseFen(value: String) {
        val fresh = Array(10) { CharArray(9) { '\u0000' } }
        val board = value.trim().split(' ').firstOrNull().orEmpty()
        val rows = board.split('/')
        for (row in 0 until 10) {
            if (row >= rows.size) break
            var col = 0
            for (ch in rows[row]) {
                if (ch.isDigit()) {
                    col += ch - '0'
                } else {
                    if (col in 0..8) fresh[row][col] = ch
                    col++
                }
                if (col > 8) break
            }
        }
        cells = fresh
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)

        val pad = Math.min(width, height) * 0.045f
        val left = pad
        val top = pad
        val boardW = width - pad * 2
        val boardH = height - pad * 2
        if (boardW <= 0 || boardH <= 0) return

        val cellW = boardW / 8f
        val cellH = boardH / 9f

        // Background
        val frame = RectF(left - pad * 0.5f, top - pad * 0.5f, left + boardW + pad * 0.5f, top + boardH + pad * 0.5f)
        canvas.drawRoundRect(frame, pad * 0.4f, pad * 0.4f, bgPaint)
        canvas.drawRoundRect(frame, pad * 0.4f, pad * 0.4f, edgePaint)

        // Horizontal lines (10)
        for (row in 0..9) {
            val y = top + row * cellH
            canvas.drawLine(left, y, left + boardW, y, linePaint)
        }

        // Vertical lines (9); inner ones are broken at the river
        for (col in 0..8) {
            val x = left + col * cellW
            if (col == 0 || col == 8) {
                canvas.drawLine(x, top, x, top + boardH, linePaint)
            } else {
                val riverTop = top + 4 * cellH
                val riverBottom = top + 5 * cellH
                canvas.drawLine(x, top, x, riverTop, linePaint)
                canvas.drawLine(x, riverBottom, x, top + boardH, linePaint)
            }
        }

        // Palace diagonals (top and bottom)
        val x3 = left + 3 * cellW
        val x5 = left + 5 * cellW
        val y0 = top
        val y2 = top + 2 * cellH
        val y7 = top + 7 * cellH
        val y9 = top + 9 * cellH
        canvas.drawLine(x3, y0, x5, y2, linePaint)
        canvas.drawLine(x5, y0, x3, y2, linePaint)
        canvas.drawLine(x3, y7, x5, y9, linePaint)
        canvas.drawLine(x5, y7, x3, y9, linePaint)

        // Position markers on the soldier and cannon points
        drawMarkers(canvas, left, top, cellW, cellH)

        // River text
        riverPaint.textSize = cellH * 0.55f
        val riverY = top + 4.5f * cellH + riverPaint.textSize * 0.35f
        canvas.drawText(RIVER_LEFT, left + 2f * cellW, riverY, riverPaint)
        canvas.drawText(RIVER_RIGHT, left + 6f * cellW, riverY, riverPaint)

        // Pieces
        val radius = Math.min(cellW, cellH) * 0.42f
        val glyphPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            textAlign = Paint.Align.CENTER
            typeface = Typeface.DEFAULT_BOLD
            textSize = radius * 1.15f
        }
        for (row in 0..9) {
            for (col in 0..8) {
                val letter = cells[row][col]
                if (letter == '\u0000') continue
                val cx = left + col * cellW
                val cy = top + row * cellH
                drawPiece(canvas, cx, cy, radius, letter, glyphPaint)
            }
        }
    }

    private fun drawPiece(
        canvas: Canvas,
        cx: Float,
        cy: Float,
        radius: Float,
        letter: Char,
        glyphPaint: Paint
    ) {
        val hidden = letter == 'X' || letter == 'x'
        val isRed = letter.isUpperCase()

        if (hidden) {
            canvas.drawCircle(cx, cy, radius, hiddenFillPaint)
            canvas.drawCircle(cx, cy, radius * 0.72f, hiddenRingPaint)
            return
        }

        canvas.drawCircle(cx, cy, radius, pieceFillPaint)
        pieceBorderPaint.color = if (isRed) 0xFFC62828.toInt() else 0xFF1A1A1A.toInt()
        canvas.drawCircle(cx, cy, radius, pieceBorderPaint)

        val index = LETTER_INDEX[letter.uppercaseChar()]
        val glyphs = if (isRed) RED_GLYPHS else BLACK_GLYPHS
        val glyph = if (index != null && index < glyphs.size) glyphs[index] else "?"
        glyphPaint.color = if (isRed) redPaint.color else blackPaint.color

        // Vertically centre using the font metrics so glyphs sit on the point.
        val metrics = glyphPaint.fontMetrics
        val baseline = cy - (metrics.ascent + metrics.descent) / 2f
        canvas.drawText(glyph, cx, baseline, glyphPaint)
    }

    private fun drawMarkers(
        canvas: Canvas,
        left: Float,
        top: Float,
        cellW: Float,
        cellH: Float
    ) {
        val gap = Math.min(cellW, cellH) * 0.12f
        val len = Math.min(cellW, cellH) * 0.16f
        val rows = intArrayOf(3, 6)
        val cols = intArrayOf(0, 2, 4, 6, 8)

        for (row in rows) {
            for (col in cols) {
                drawBracket(canvas, left + col * cellW, top + row * cellH, gap, len, col == 0, col == 8)
            }
        }
        for (row in intArrayOf(2, 7)) {
            for (col in intArrayOf(1, 7)) {
                drawBracket(canvas, left + col * cellW, top + row * cellH, gap, len, false, false)
            }
        }
    }

    private fun drawBracket(
        canvas: Canvas,
        x: Float,
        y: Float,
        gap: Float,
        len: Float,
        skipLeft: Boolean,
        skipRight: Boolean
    ) {
        val paint = linePaint
        if (!skipLeft) {
            // top-left
            canvas.drawLine(x - gap - len, y - gap, x - gap, y - gap, paint)
            canvas.drawLine(x - gap, y - gap - len, x - gap, y - gap, paint)
            // bottom-left
            canvas.drawLine(x - gap - len, y + gap, x - gap, y + gap, paint)
            canvas.drawLine(x - gap, y + gap + len, x - gap, y + gap, paint)
        }
        if (!skipRight) {
            canvas.drawLine(x + gap, y - gap, x + gap + len, y - gap, paint)
            canvas.drawLine(x + gap, y - gap - len, x + gap, y - gap, paint)
            canvas.drawLine(x + gap, y + gap, x + gap + len, y + gap, paint)
            canvas.drawLine(x + gap, y + gap + len, x + gap, y + gap, paint)
        }
    }
}
