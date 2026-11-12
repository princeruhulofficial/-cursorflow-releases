package com.voicelink.mobile

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.widget.LinearLayout
import android.widget.TextView
import kotlin.math.abs
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min

/**
 * Finger handwriting touchpad. Strokes stay on this phone until Insert.
 * Recognition prefers on-device shape matching for Latin/digits; Bangla and Hindi
 * use the same stroke canvas plus script chips so any language can still be typed
 * and sent to the PC through the normal commit path.
 */
class HandwritingPadView(
  context: Context,
  private val ink: Int,
  private val muted: Int,
  private val keyBg: Int,
  private val surface: Int,
  private val onInsert: (String) -> Unit,
) : LinearLayout(context) {
  private val handler = Handler(Looper.getMainLooper())
  private val canvasView = InkCanvas(context)
  private val preview = TextView(context).apply {
    textSize = 18f
    setTextColor(ink)
    setPadding(dp(10), dp(6), dp(10), dp(6))
    text = ""
    maxLines = 3
  }
  private val composed = StringBuilder()
  private var settle: Runnable? = null

  init {
    orientation = VERTICAL
    setBackgroundColor(surface)
    addView(preview, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
    addView(canvasView, LayoutParams(LayoutParams.MATCH_PARENT, 0, 1f).apply {
      setMargins(dp(4), dp(2), dp(4), dp(2))
    })
    val actions = LinearLayout(context).apply { orientation = HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
    fun chip(label: String, action: () -> Unit): TextView = TextView(context).apply {
      text = label
      textSize = 14f
      setTextColor(ink)
      gravity = Gravity.CENTER
      setPadding(dp(12), 0, dp(12), 0)
      background = rounded(keyBg, 16)
      isClickable = true
      setOnClickListener { action() }
    }
    actions.addView(chip("Clear") {
      canvasView.clear()
      composed.clear()
      preview.text = ""
    }, LayoutParams(0, dp(36), 1f).apply { marginEnd = dp(6) })
    actions.addView(chip("Space") {
      composed.append(' ')
      preview.text = composed.toString()
    }, LayoutParams(0, dp(36), 1f).apply { marginEnd = dp(6) })
    actions.addView(chip("⌫") {
      if (composed.isNotEmpty()) composed.deleteCharAt(composed.lastIndex)
      preview.text = composed.toString()
    }, LayoutParams(0, dp(36), 1f).apply { marginEnd = dp(6) })
    actions.addView(chip("Insert") {
      val text = composed.toString().ifBlank { canvasView.guessLatin() }
      if (text.isNotBlank()) onInsert(text.trim())
    }, LayoutParams(0, dp(36), 1.2f))
    addView(actions, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply {
      topMargin = dp(6); bottomMargin = dp(2)
    })
    val scripts = LinearLayout(context).apply { orientation = HORIZONTAL }
    val scroll = android.widget.HorizontalScrollView(context).apply { isHorizontalScrollBarEnabled = false }
    val row = LinearLayout(context).apply { orientation = HORIZONTAL }
    val letters = ("অআইঈউঊএঐওঔকখগঘঙচছজঝঞটঠডঢণতথদধনপফবভমযরলশষসহ" +
      "अआइईउऊएऐओऔकखगघङचछजझञटठडढणतथदधनपफबभमयरलवशषसह" +
      "abcdefghijklmnopqrstuvwxyz0123456789").toList().distinct()
    letters.forEach { ch ->
      row.addView(chip(ch.toString()) {
        composed.append(ch)
        preview.text = composed.toString()
        canvasView.clear()
      }, LayoutParams(dp(34), dp(34)).apply { marginEnd = dp(4) })
    }
    scroll.addView(row)
    scripts.addView(scroll, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
    addView(TextView(context).apply {
      text = "Or tap a letter after you draw"
      textSize = 11f
      setTextColor(muted)
      setPadding(dp(6), dp(4), dp(6), 0)
    })
    addView(scripts, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
    canvasView.onStrokeEnd = {
      settle?.let { handler.removeCallbacks(it) }
      val task = Runnable {
        val guess = canvasView.guessLatin()
        if (guess.isNotBlank()) {
          composed.append(guess)
          preview.text = composed.toString()
          canvasView.clear()
        }
      }
      settle = task
      handler.postDelayed(task, 700)
    }
  }

  private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

  private fun rounded(color: Int, radiusDp: Int) = android.graphics.drawable.GradientDrawable().apply {
    setColor(color)
    cornerRadius = dp(radiusDp).toFloat()
  }

  private inner class InkCanvas(context: Context) : View(context) {
    private val strokes = mutableListOf<MutableList<Pair<Float, Float>>>()
    private var current: MutableList<Pair<Float, Float>>? = null
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      color = ink
      style = Paint.Style.STROKE
      strokeWidth = dp(3).toFloat()
      strokeCap = Paint.Cap.ROUND
      strokeJoin = Paint.Join.ROUND
    }
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = keyBg; style = Paint.Style.FILL }
    var onStrokeEnd: (() -> Unit)? = null

    fun clear() {
      strokes.clear()
      current = null
      invalidate()
    }

    /** Very small Latin/digit guesser from stroke geometry (single character). */
    fun guessLatin(): String {
      if (strokes.isEmpty()) return ""
      val all = strokes.flatten()
      if (all.size < 4) return ""
      val minX = all.minOf { it.first }; val maxX = all.maxOf { it.first }
      val minY = all.minOf { it.second }; val maxY = all.maxOf { it.second }
      val w = max(1f, maxX - minX); val h = max(1f, maxY - minY)
      val aspect = w / h
      val strokeCount = strokes.size
      val pathLen = strokes.sumOf { s ->
        var n = 0.0
        for (i in 1 until s.size) n += hypot((s[i].first - s[i - 1].first).toDouble(), (s[i].second - s[i - 1].second).toDouble())
        n
      }
      // Coarse shape classes — enough for digits and a few letters while the script strip covers the rest.
      return when {
        strokeCount == 1 && aspect in 0.75f..1.35f && pathLen > (w + h) * 2.2f -> "O"
        strokeCount == 1 && aspect < 0.45f -> "1"
        strokeCount == 1 && aspect > 2.2f && h < w * 0.35f -> "-"
        strokeCount == 2 && aspect < 0.55f -> "T"
        strokeCount >= 2 && aspect in 0.7f..1.3f -> "A"
        strokeCount == 1 && pathLen > (w + h) * 1.6f && aspect in 0.5f..0.9f -> "S"
        strokeCount == 1 -> "c"
        else -> ""
      }.lowercase()
    }

    override fun onDraw(canvas: Canvas) {
      super.onDraw(canvas)
      canvas.drawRoundRect(RectF(0f, 0f, width.toFloat(), height.toFloat()), dp(12).toFloat(), dp(12).toFloat(), fill)
      val path = Path()
      for (stroke in strokes) {
        if (stroke.isEmpty()) continue
        path.reset()
        path.moveTo(stroke[0].first, stroke[0].second)
        for (i in 1 until stroke.size) path.lineTo(stroke[i].first, stroke[i].second)
        canvas.drawPath(path, paint)
      }
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
      when (event.actionMasked) {
        MotionEvent.ACTION_DOWN -> {
          parent?.requestDisallowInterceptTouchEvent(true)
          val stroke = mutableListOf(event.x to event.y)
          current = stroke
          strokes.add(stroke)
          invalidate()
          return true
        }
        MotionEvent.ACTION_MOVE -> {
          current?.add(event.x to event.y)
          invalidate()
          return true
        }
        MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
          current = null
          onStrokeEnd?.invoke()
          return true
        }
      }
      return false
    }
  }
}
