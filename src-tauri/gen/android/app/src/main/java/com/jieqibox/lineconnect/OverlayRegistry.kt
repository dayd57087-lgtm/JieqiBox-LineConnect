package com.jieqibox.lineconnect

import android.graphics.Rect
import android.util.Log
import android.view.View
import java.util.concurrent.ConcurrentHashMap

/**
 * Keeps track of where our own floating windows are on the screen.
 *
 * The record capture mirrors the whole display, so the floating chessboard - and
 * the control bar - are captured along with the game. Their pieces used to be
 * recognised as if they sat on the board, which quietly corrupted the position
 * (the chessboard overlay draws the very same pieces the model is looking for).
 *
 * Knowing the rectangles lets the recognition layer:
 *
 *  - drop detections that fall inside one of our windows, and
 *  - warn when a window covers so much of the board that the result cannot be
 *    trusted.
 *
 * Reads happen on the capture/JS thread while the views are only touched on the
 * main thread, hence the concurrent map. `getLocationOnScreen` must be called on
 * the main thread, which is where [update] is always invoked from.
 */
object OverlayRegistry {

    private const val TAG = "OverlayRegistry"

    private val rects = ConcurrentHashMap<String, Rect>()

    /** Records (or clears) the bounds of one of our floating windows. */
    fun update(key: String, view: View?) {
        if (view == null) {
            rects.remove(key)
            return
        }
        try {
            val location = IntArray(2)
            view.getLocationOnScreen(location)
            val width = view.width
            val height = view.height
            if (width <= 0 || height <= 0) {
                rects.remove(key)
                return
            }
            rects[key] = Rect(location[0], location[1], location[0] + width, location[1] + height)
        } catch (e: Exception) {
            Log.w(TAG, "Failed to read the bounds of $key", e)
            rects.remove(key)
        }
    }

    fun remove(key: String) {
        rects.remove(key)
    }

    fun clear() {
        rects.clear()
    }

    /** Snapshot in screen pixels, safe to hand to another thread. */
    fun snapshot(): List<Rect> {
        val out = ArrayList<Rect>(rects.size)
        for (rect in rects.values) {
            if (!rect.isEmpty) out.add(Rect(rect))
        }
        return out
    }
}
