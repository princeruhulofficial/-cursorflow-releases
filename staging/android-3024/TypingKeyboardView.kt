
package com.voicelink.mobile

import android.content.Context
import android.content.res.Configuration
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.media.AudioManager
import android.view.HapticFeedbackConstants
import android.widget.PopupWindow
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import kotlin.math.abs
import kotlin.math.hypot

/**
 * Built-in typing panel: QWERTY / Avro phonetic / Probhat / InScript / glide typing.
 */
class TypingKeyboardView(
  context: Context,
  private val onCommit: (String) -> Unit,
  private val onDelete: (Int) -> Unit,
  private val onEnter: () -> Unit,
  private val onDeleteWord: () -> Unit,
  private val onMoveCursor: (Int) -> Unit,
  private val onCorrectWord: () -> Unit,
  private val onShowVoice: () -> Unit,
  private val onToggleVoice: () -> Unit,
  private val onSwitchExternal: () -> Unit,
  private val getBeforeCursor: () -> String,
  private val learnedWords: () -> List<String>,
  /** Longer text before the cursor (for Translate). */
  private val getFieldTextBeforeCursor: () -> String = getBeforeCursor,
  /** Translates [text] into [target]; calls back on any thread with (translation, error). */
  private val onTranslate: (text: String, target: String, done: (String?, String?) -> Unit) -> Unit = { _, _, done -> done(null, "Translate is not available here.") },
) : LinearLayout(context) {
  private val night = VoiceKeyboardSecureStore.isNight(context)
  // Gboard-like balanced palettes for light and dark.
  private val surface = if (night) Color.rgb(32, 33, 36) else Color.rgb(232, 234, 237)
  private val keyBg = if (night) Color.rgb(60, 64, 67) else Color.WHITE
  private val keyBgSpecial = if (night) Color.rgb(45, 47, 50) else Color.rgb(207, 211, 217)
  private val keyPressed = if (night) Color.rgb(95, 99, 104) else Color.rgb(189, 193, 198)
  private val keyShadow = if (night) Color.rgb(20, 21, 23) else Color.rgb(176, 180, 186)
  private val ink = if (night) Color.rgb(232, 234, 237) else Color.rgb(32, 33, 36)
  private val muted = if (night) Color.rgb(189, 193, 198) else Color.rgb(80, 84, 90)
  private val suggestBg = if (night) Color.rgb(41, 42, 45) else Color.rgb(241, 243, 244)
  private val keySound = VoiceKeyboardSecureStore.getKeySound(context)
  // Keyboard Settings (toolbar gear) own these three; they are read on every use.
  private var keyHaptics = VoiceKeyboardSecureStore.getKeyHaptics(context)
  private var swipeEnabled = VoiceKeyboardSecureStore.getSwipeTyping(context)
  private var autocorrectEnabled = VoiceKeyboardSecureStore.getAutocorrect(context)
  private val audio = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
  private var previewWindow: PopupWindow? = null
  private var previewText: TextView? = null
  private var deleteRepeat: Runnable? = null
  private val trailColor = if (night) Color.argb(180, 230, 230, 230) else Color.argb(180, 70, 70, 70)

  private var langId = TypingLayouts.supportedId(VoiceKeyboardSecureStore.getTypingLanguage(context))
  private var inputMode = when (VoiceKeyboardSecureStore.getTypingInputMode(context)) {
    "fixed" -> TypingLayouts.InputMode.FIXED
    else -> TypingLayouts.InputMode.PHONETIC
  }
  private var page = TypingLayouts.Page.LETTERS
  private var shift = TypingLayouts.ShiftState.OFF
  private var composing = StringBuilder() // committed-script composing / latin for phonetic
  private var latinBuffer = StringBuilder() // Avro/Hindi phonetic latin
  private val handler = Handler(Looper.getMainLooper())

  private val suggestRow = LinearLayout(context)
  private val board = KeyboardBoardView(context)
  private val topBar = LinearLayout(context)
  private var popup: TextView? = null
  private var longPressKey: TypingLayouts.KeyDef? = null
  private var longPressRunnable: Runnable? = null
  private var spaceSwipeStartX = 0f
  private var spaceSwiping = false
  // Space-bar trackpad: hold space, then slide to move the cursor.
  private var trackpadActive = false
  private val panelHost = LinearLayout(context)
  private var openPanel: String? = null
  private val toolIcons = HashMap<String, ToolIcon>()
  private var statusChip: TextView? = null

  // Glide
  private var glideActive = false
  private val glideChars = mutableListOf<Char>()
  private val glidePoints = mutableListOf<GlideDecoder.Point>()
  private var lastGlideLabel = ""
  private var glideStartX = 0f
  private var glideStartY = 0f
  private var glideCandidates: List<String> = emptyList()
  private var glideReplacement = ""

  init {
    SuggestEngine.init(context)
    orientation = VERTICAL
    setBackgroundColor(surface)
    // Gboard-like: almost no gap above the keys; toolbar sits flush on the board.
    setPadding(dp(4), dp(2), dp(4), dp(2))
    buildBar()
    addView(board, LayoutParams(LayoutParams.MATCH_PARENT, dp(232)))
    panelHost.orientation = VERTICAL
    panelHost.visibility = View.GONE
    addView(panelHost, LayoutParams(LayoutParams.MATCH_PARENT, dp(278)))
    renderBoard()
    // Prefetch active language dict off UI thread
    Thread { SuggestEngine.ensureLoaded(langId); post { refreshSuggestions() } }.start()
    refreshSuggestions()
  }

  fun setVoiceState(listening: Boolean, processing: Boolean) {
    toolIcons["mic"]?.let {
      it.active = listening || processing
      it.glow = listening
      it.contentDescription = if (listening) "Stop Detection" else if (processing) "Finishing Detection" else "Detection mic"
      it.invalidate()
    }
  }

  /** Short status line for the typing toolbar (voice captions when the Detection page is hidden). */
  fun showStatus(message: String) {
    statusChip?.let {
      it.text = message
      it.visibility = if (message.isBlank()) View.GONE else View.VISIBLE
    }
  }

  private var enterLabel = "↵"
  fun setEditorAction(kind: String) {
    enterLabel = when (kind) { "search" -> "Search"; "send" -> "Send"; "go" -> "Go"; "next" -> "Next"; "done" -> "Done"; else -> "↵" }
    board.invalidate()
  }

  fun setLanguage(id: String) {
    langId = id
    VoiceKeyboardSecureStore.putTypingLanguage(context, id)
    page = TypingLayouts.Page.LETTERS
    shift = TypingLayouts.ShiftState.OFF
    latinBuffer.clear()
    composing.clear()
    renderBoard()
    Thread { SuggestEngine.ensureLoaded(langId); post { refreshSuggestions() } }.start()
    refreshSuggestions()
  }

  // Compact Gboard-style strip flush on the keys:
  // [gear] [ suggestions ] [Detection page] [clipboard] [translate] [handwriting] [mic → far right]
  // EN language chip and the unclear "I"/logo mark are gone from the toolbar.
  private fun buildBar() {
    topBar.orientation = HORIZONTAL
    topBar.gravity = Gravity.CENTER_VERTICAL
    topBar.setBackgroundColor(suggestBg)
    topBar.setPadding(dp(1), 0, dp(1), 0)
    fun tool(kind: String, desc: String, onClick: () -> Unit): ToolIcon = ToolIcon(context, kind, ink, surface).apply {
      contentDescription = desc
      background = android.graphics.drawable.RippleDrawable(
        android.content.res.ColorStateList.valueOf(if (night) Color.argb(60, 255, 255, 255) else Color.argb(40, 0, 0, 0)), null, null)
      isClickable = true
      setOnClickListener { haptic(false, this); onClick() }
    }.also { toolIcons[kind] = it }
    fun slot() = LayoutParams(dp(36), dp(36)).apply { marginStart = dp(0); marginEnd = dp(0) }
    topBar.addView(tool("gear", "Keyboard settings") { togglePanel("settings") }, slot())
    suggestRow.orientation = HORIZONTAL
    suggestRow.gravity = Gravity.CENTER
    topBar.addView(suggestRow, LayoutParams(0, dp(32), 1f).apply { marginStart = dp(2); marginEnd = dp(2) })
    suggestRow.addOnLayoutChangeListener { _, l, _, r, _, ol, _, or2, _ -> if (r - l != or2 - ol && openPanel == null) post { refreshSuggestions() } }
    // Clear switch back to the voice Detection page (replaces the confusing "I" mark).
    topBar.addView(tool("detection", "Open Detection page") { closePanel(); onShowVoice() }, slot())
    topBar.addView(tool("clip", "Clipboard history") { togglePanel("clip") }, slot())
    topBar.addView(tool("translate", "Translate") { togglePanel("translate") }, slot())
    topBar.addView(tool("handwrite", "Handwriting touchpad") { togglePanel("handwrite") }, slot())
    // Detection mic stays at the far right and glows while listening.
    topBar.addView(tool("mic", "Detection mic") { closePanel(); onToggleVoice() }, slot())
    val wrap = LinearLayout(context).apply { orientation = VERTICAL }
    wrap.addView(topBar, LayoutParams(LayoutParams.MATCH_PARENT, dp(36)))
    statusChip = TextView(context).apply {
      textSize = 11f
      setTextColor(muted)
      visibility = View.GONE
      setPadding(dp(8), 0, dp(8), dp(2))
      maxLines = 1
      ellipsize = android.text.TextUtils.TruncateAt.END
    }
    wrap.addView(statusChip, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
    // No divider line and almost no gap: toolbar sits on the keys.
    addView(wrap, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply { bottomMargin = dp(1) })
  }

  private fun updateLangIcon() {
    // Language lives in Settings now; keep a no-op for callers that still refresh the chip.
  }

  // ---- Toolbar panels: they take the keys' place, same height, so nothing jumps ----
  private fun togglePanel(kind: String) {
    if (openPanel == kind) { closePanel(); return }
    openPanel = kind
    panelHost.removeAllViews()
    when (kind) {
      "clip" -> buildClipboardPanel()
      "settings" -> buildSettingsPanel()
      "translate" -> buildTranslatePanel()
      "handwrite" -> buildHandwritingPanel()
    }
    // The bar stays (so the open tool shows as active); the panel takes only the keys' place.
    val h = (board.layoutParams as? LayoutParams)?.height ?: dp(232)
    (panelHost.layoutParams as? LayoutParams)?.let { lp -> lp.height = h; panelHost.layoutParams = lp }
    suggestRow.visibility = View.INVISIBLE
    board.visibility = View.GONE
    panelHost.visibility = View.VISIBLE
    toolIcons.forEach { (name, icon) -> if (name != "mic") { icon.active = name == kind; icon.invalidate() } }
  }

  private fun closePanel() {
    if (openPanel == null) return
    openPanel = null
    panelHost.removeAllViews()
    panelHost.visibility = View.GONE
    suggestRow.visibility = View.VISIBLE
    board.visibility = View.VISIBLE
    toolIcons.forEach { (name, icon) -> if (name != "mic") { icon.active = false; icon.invalidate() } }
    refreshSuggestions()
  }

  private fun panelHeader(title: String, action: String? = null, onAction: (() -> Unit)? = null) {
    val row = LinearLayout(context).apply { orientation = HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
    row.addView(TextView(context).apply {
      text = title; textSize = 15f; setTextColor(ink); typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
    }, LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f))
    if (action != null && onAction != null) row.addView(actionChip(action) { onAction() }.apply { setPadding(dp(14), 0, dp(14), 0) }, LayoutParams(LayoutParams.WRAP_CONTENT, dp(32)).apply { marginEnd = dp(6) })
    row.addView(actionChip("Done") { closePanel() }.apply { setPadding(dp(14), 0, dp(14), 0) }, LayoutParams(LayoutParams.WRAP_CONTENT, dp(32)))
    panelHost.addView(row, LayoutParams(LayoutParams.MATCH_PARENT, dp(38)).apply { bottomMargin = dp(6) })
  }

  private fun note(text: String) = TextView(context).apply { this.text = text; textSize = 13f; setTextColor(muted); setPadding(dp(4), dp(4), dp(4), dp(4)) }

  private fun buildClipboardPanel() {
    // Local only: what was copied while this keyboard was open, encrypted on this phone.
    val items = runCatching { ClipboardHistoryStore.read(context) }.getOrDefault(emptyList())
    panelHeader("Clipboard", if (items.isNotEmpty()) "Clear" else null) {
      runCatching { ClipboardHistoryStore.clear(context) }
      openPanel = null; togglePanel("clip")
    }
    if (items.isEmpty()) {
      panelHost.addView(note("Text you copy shows up here. It stays on this phone."))
      return
    }
    val list = LinearLayout(context).apply { orientation = VERTICAL }
    items.forEach { item ->
      list.addView(TextView(context).apply {
        text = item.replace(Regex("\\s+"), " ").trim()
        textSize = 14f; setTextColor(ink); maxLines = 2
        ellipsize = android.text.TextUtils.TruncateAt.END
        setPadding(dp(12), dp(9), dp(12), dp(9))
        background = rounded(keyBg, 12)
        isClickable = true
        contentDescription = "Paste clip"
        setOnClickListener {
          haptic(false, this)
          flushPhonetic(); composing.clear()
          onCommit(item)
          closePanel()
        }
      }, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply { bottomMargin = dp(6) })
    }
    panelHost.addView(ScrollView(context).apply { addView(list) }, LayoutParams(LayoutParams.MATCH_PARENT, 0, 1f))
  }

  private fun buildSettingsPanel() {
    panelHeader("Keyboard settings")
    fun toggleRow(title: String, detail: String, value: Boolean, onChange: (Boolean) -> Unit) {
      val row = LinearLayout(context).apply {
        orientation = HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
        setPadding(dp(12), dp(6), dp(8), dp(6)); background = rounded(keyBg, 12)
      }
      val texts = LinearLayout(context).apply { orientation = VERTICAL }
      texts.addView(TextView(context).apply { text = title; textSize = 15f; setTextColor(ink) })
      texts.addView(TextView(context).apply { text = detail; textSize = 12f; setTextColor(muted) })
      row.addView(texts, LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f))
      @Suppress("DEPRECATION")
      val sw = android.widget.Switch(context).apply {
        isChecked = value
        contentDescription = title
        setOnCheckedChangeListener { _, checked -> onChange(checked); if (checked) haptic(false, this) }
      }
      row.setOnClickListener { sw.toggle() }
      row.addView(sw, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT))
      panelHost.addView(row, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply { bottomMargin = dp(6) })
    }
    toggleRow("Swipe typing", "Slide across letters to type a word.", swipeEnabled) {
      swipeEnabled = it; VoiceKeyboardSecureStore.putSwipeTyping(context, it)
    }
    toggleRow("Autocorrect", "Fix a clear typo when you press space.", autocorrectEnabled) {
      autocorrectEnabled = it; VoiceKeyboardSecureStore.putAutocorrect(context, it)
    }
    toggleRow("Haptics", "A light tap on each key.", keyHaptics) {
      keyHaptics = it; VoiceKeyboardSecureStore.putKeyHaptics(context, it)
    }
    val langRow = LinearLayout(context).apply {
      orientation = HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
      setPadding(dp(12), dp(8), dp(8), dp(8)); background = rounded(keyBg, 12)
    }
    langRow.addView(TextView(context).apply {
      text = "Typing language"
      textSize = 15f; setTextColor(ink)
    }, LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f))
    val langChip = actionChip(langChipLabel()) {
      cycleLanguage()
      closePanel()
      togglePanel("settings")
    }.apply { setPadding(dp(14), 0, dp(14), 0) }
    langRow.addView(langChip, LayoutParams(LayoutParams.WRAP_CONTENT, dp(32)))
    panelHost.addView(langRow, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply { bottomMargin = dp(6) })
  }

  private fun buildHandwritingPanel() {
    panelHeader("Handwriting")
    panelHost.addView(note("Write any language with your finger. Lift to keep drawing; tap Insert to type it into the field and your PC."))
    val pad = HandwritingPadView(context, ink, muted, keyBg, surface) { recognized ->
      if (recognized.isNotBlank()) {
        flushPhonetic(); composing.clear()
        val before = getBeforeCursor()
        if (before.isNotEmpty() && !before.last().isWhitespace()) onCommit(" ")
        onCommit(recognized)
        showStatus("Handwriting inserted")
        closePanel()
      }
    }
    panelHost.addView(pad, LayoutParams(LayoutParams.MATCH_PARENT, 0, 1f))
  }

  private var translating = false

  private fun buildTranslatePanel() {
    panelHeader("Translate")
    panelHost.addView(note("Translates the text before the cursor in this field."))
    val status = note("")
    val chips = LinearLayout(context).apply { orientation = HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
    TRANSLATE_TARGETS.forEach { (label, target) ->
      chips.addView(actionChip(label) { runTranslate(target, label, status) }, LayoutParams(0, dp(40), 1f).apply { marginEnd = dp(6) })
    }
    panelHost.addView(chips, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply { topMargin = dp(6); bottomMargin = dp(6) })
    panelHost.addView(status)
  }

  private fun runTranslate(target: String, label: String, status: TextView) {
    if (translating) return
    flushPhonetic(); composing.clear()
    val before = getFieldTextBeforeCursor()
    val source = before.trim()
    if (source.isEmpty()) { status.text = "Type something first, then pick a language."; return }
    translating = true
    status.text = "Translating to $label"
    onTranslate(source, target) { result, error ->
      post {
        translating = false
        val out = result?.trim().orEmpty()
        when {
          error != null || out.isEmpty() -> status.text = "Could not translate. Your text was not changed." + (error?.let { "\n$it" } ?: "")
          out.equals(source, ignoreCase = true) || !TranslateCheck.looksLike(out, target) ->
            status.text = if (TranslateCheck.looksLike(source, target)) "It is already in $label." else "Could not translate. Your text was not changed."
          else -> {
            val now = getFieldTextBeforeCursor()
            val trimmed = now.trimEnd()
            if (!trimmed.endsWith(source)) { status.text = "The text changed while translating. Try again."; return@post }
            onDelete(source.length + (now.length - trimmed.length))
            onCommit(out)
            closePanel()
          }
        }
      }
    }
  }

  private fun langChipLabel(): String {
    val base = currentLang().short
    return when {
      langId == "bn" && inputMode == TypingLayouts.InputMode.PHONETIC -> "$base Avro"
      langId == "bn" -> "$base Probhat"
      langId == "hi" && inputMode == TypingLayouts.InputMode.PHONETIC -> "$base Phon"
      langId == "hi" -> "$base InSc"
      else -> base
    }
  }

  private fun actionChip(label: String, onClick: () -> Unit): TextView {
    return TextView(context).apply {
      text = label
      textSize = 13f
      gravity = Gravity.CENTER
      setTextColor(ink)
      background = rounded(keyBgSpecial, 16)
      isClickable = true
      setOnClickListener { onClick() }
    }
  }

  private fun currentLang() = TypingLayouts.languages.firstOrNull { it.id == langId } ?: TypingLayouts.languages.first()

  private fun cycleLanguage() {
    val langs = TypingLayouts.languages
    val idx = langs.indexOfFirst { it.id == langId }.let { if (it < 0) 0 else (it + 1) % langs.size }
    setLanguage(langs[idx].id)
    updateLangIcon()
    haptic(false)
  }

  private fun toggleInputMode() {
    val lang = currentLang()
    if (!lang.supportsPhonetic) {
      page = TypingLayouts.Page.EMOJI
      renderBoard()
      return
    }
    inputMode = if (inputMode == TypingLayouts.InputMode.PHONETIC)
      TypingLayouts.InputMode.FIXED else TypingLayouts.InputMode.PHONETIC
    VoiceKeyboardSecureStore.putTypingInputMode(
      context,
      if (inputMode == TypingLayouts.InputMode.FIXED) "fixed" else "phonetic",
    )
    latinBuffer.clear()
    composing.clear()
    updateLangIcon()
    renderBoard()
    refreshSuggestions()
    haptic(false)
  }

  private fun usingPhonetic(): Boolean =
    (langId == "bn" || langId == "hi") && inputMode == TypingLayouts.InputMode.PHONETIC && page == TypingLayouts.Page.LETTERS

  private fun renderBoard() {
    val rows = when (page) {
      TypingLayouts.Page.LETTERS -> TypingLayouts.letters(langId, shift, inputMode)
      TypingLayouts.Page.NUMBERS -> TypingLayouts.numbers()
      TypingLayouts.Page.SYMBOLS -> TypingLayouts.symbols()
      TypingLayouts.Page.EMOJI -> TypingLayouts.emojiRows()
    }
    // Five rows (digits on top) get a taller board so keys keep their size.
    val wantH = dp(if (rows.size >= 5) 280 else 232)
    (board.layoutParams as? LayoutParams)?.let { lp -> if (lp.height != wantH) { lp.height = wantH; board.layoutParams = lp } }
    board.setRows(rows, keyBg, keyBgSpecial, ink, muted, trailColor, ::onKeyTouch)
  }

  private fun onKeyTouch(key: TypingLayouts.KeyDef, action: Int, x: Float, y: Float, view: View): Boolean {
    when (action) {
      MotionEvent.ACTION_DOWN -> {
        glideReplacement = ""
        haptic(true, view)
        click(key)
        showPreview(key)
        longPressKey = key
        if (key.code == "DEL") {
          // Delete fires on key-down, then repeats and speeds up while held (Gboard style).
          handleTap(key)
          var delay = 400L
          val r = object : Runnable {
            override fun run() {
              if (longPressKey != key) return
              flushPhonetic()
              composing.clear()
              onDeleteWord()
              refreshSuggestions()
              haptic(true, view)
              delay = (delay * 0.8).toLong().coerceAtLeast(150L)
              handler.postDelayed(this, delay)
            }
          }
          deleteRepeat = r
          handler.postDelayed(r, delay)
          return true
        }
        longPressRunnable?.let { handler.removeCallbacks(it) }
        if (key.code == "SPACE") {
          spaceSwipeStartX = x
          spaceSwiping = false
          trackpadActive = false
          val hold = Runnable {
            if (longPressKey == key && !spaceSwiping) {
              trackpadActive = true
              flushPhonetic(); composing.clear()
              haptic(false, view)
              board.invalidate()
            }
          }
          longPressRunnable = hold
          handler.postDelayed(hold, 350)
        } else if (swipeEnabled && !key.isAction && key.label.length == 1 && key.label[0].isLetter() && page == TypingLayouts.Page.LETTERS) {
          // Swipe works on fixed layouts and on English; phonetic Bangla/Hindi keep letter taps.
          if (usingPhonetic() && langId != "en") {
            // Phonetic pads are latin→script; glide stays off so Avro/Hindi input is not broken.
          } else {
            if (alternatesShowing) hideAlternates()
            trackpadActive = false
            spaceSwiping = false
            glideActive = true
            glideChars.clear()
            glidePoints.clear()
            glideCandidates = emptyList()
            lastGlideLabel = key.label
            // Board now passes local coordinates; keep a raw→local fallback for safety.
            val local = if (x in 0f..board.width.toFloat() && y in 0f..board.height.toFloat()) x to y else board.toLocal(x, y)
            glideStartX = local.first; glideStartY = local.second
            glideChars.add(key.label.lowercase().first())
            board.keyCenter(key)?.let { glidePoints.add(it) } ?: glidePoints.add(GlideDecoder.Point(local.first, local.second))
            board.setTrail(glidePoints)
          }
        }
        if (key.alternates.isNotEmpty() || key.code == "SHIFT") {
          val r = Runnable {
            if (longPressKey == key) {
              if (key.code == "SHIFT") {
                shift = TypingLayouts.ShiftState.LOCKED
                renderBoard()
              } else if (key.alternates.isNotEmpty()) {
                showAlternates(key)
              }
            }
          }
          longPressRunnable = r
          handler.postDelayed(r, 300)
        }
        return true
      }
      MotionEvent.ACTION_MOVE -> {
        if (key.code == "SPACE") {
          val dx = x - spaceSwipeStartX
          // Trackpad (after a hold) moves one character per small step; a quick slide still works.
          val step = if (trackpadActive) dp(7) else dp(12)
          if (abs(dx) > step) {
            if (!spaceSwiping) { spaceSwiping = true; trackpadActive = true; board.invalidate() }
            flushPhonetic(); composing.clear()
            repeat((abs(dx) / step).toInt().coerceIn(1, 6)) { onMoveCursor(if (dx > 0) 1 else -1) }
            spaceSwipeStartX = x
            longPressRunnable?.let { handler.removeCallbacks(it) }
          }
        } else if (glideActive) {
          val local = if (x in 0f..board.width.toFloat() && y in 0f..board.height.toFloat()) x to y else board.toLocal(x, y)
          // Moving means a swipe, never a long press for accents.
          if (hypot(local.first - glideStartX, local.second - glideStartY) > dp(4)) longPressRunnable?.let { handler.removeCallbacks(it) }
          glidePoints.add(GlideDecoder.Point(local.first, local.second))
          (board.hitKeyLocal(local.first, local.second) ?: board.nearestKeyLocal(local.first, local.second, dp(18).toFloat()))?.let { hit ->
            if (!hit.isAction && hit.label.length == 1 && hit.label.lowercase() != lastGlideLabel.lowercase()) {
              lastGlideLabel = hit.label
              glideChars.add(hit.label.lowercase().first())
            }
          }
          board.setTrail(glidePoints)
        }
        return true
      }
      MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
        longPressRunnable?.let { handler.removeCallbacks(it) }
        deleteRepeat?.let { handler.removeCallbacks(it) }
        deleteRepeat = null
        hidePreview()
        val wasLongPressAlt = alternatesShowing
        longPressKey = null
        if (key.code == "DEL") return true
        if (wasLongPressAlt) {
          // Release over an alternate commits it, like Gboard.
          val pick = pickAlternateAt(x)
          hideAlternates()
          if (pick != null) {
            onCommit(pick)
            if (pick.any { it.isLetter() }) composing.append(pick)
            refreshSuggestions()
          }
          clearGlide()
          return true
        }
        hideAlternates()
        if (action == MotionEvent.ACTION_CANCEL) {
          clearGlide()
          return true
        }
        if (key.code == "SPACE" && (spaceSwiping || trackpadActive)) {
          spaceSwiping = false
          trackpadActive = false
          board.invalidate()
          clearGlide()
          refreshSuggestions()
          return true
        }
        // Slightly lower thresholds so short swipes still resolve; taps that barely slide stay taps.
        if (glideActive && glidePathLength() >= dp(24) && (glideChars.size >= 2 || glidePathLength() >= dp(56))) {
          SuggestEngine.ensureLoaded(langId)
          val smoothed = GlideDecoder.smoothPath(glidePoints)
          val centers = board.letterCenters()
          val geo = runCatching { GlideDecoder.decodeGeometric(smoothed, centers, langId, learnedWords(), 5) }.getOrDefault(emptyList())
          val shape = runCatching { SuggestEngine.resolveGlideCandidates(glideChars.toList(), langId, learnedWords(), 5) }.getOrDefault(emptyList())
          val seq = runCatching { GlideDecoder.decode(glideChars.toList(), langId, learnedWords(), 5) }.getOrDefault(emptyList())
          glideCandidates = (geo + shape + seq).distinct().take(3)
          clearGlide(keepCandidates = true)
          if (glideCandidates.isNotEmpty()) {
            showGlideSuggestions(glideCandidates)
            // A swiped word is a new word: never eat letters typed before it.
            val before = getBeforeCursor()
            if (before.isNotEmpty() && !before.last().isWhitespace() && before.last() !in "([{\"'") onCommit(" ")
            composing.clear()
            var word = glideCandidates.first()
            if (shift != TypingLayouts.ShiftState.OFF) word = word.replaceFirstChar { it.uppercaseChar() }
            onCommit(word)
            onCommit(" ")
            glideReplacement = "$word "
            if (shift == TypingLayouts.ShiftState.ONCE) { shift = TypingLayouts.ShiftState.OFF; renderBoard() }
            refreshSuggestions(keepGlideExtras = glideCandidates.drop(1))
            return true
          }
          // A real swipe that matched no word types nothing (never a stray first letter).
          clearGlide()
          refreshSuggestions()
          return true
        }
        clearGlide()
        handleTap(key)
        return true
      }
    }
    return false
  }

  private fun glidePathLength(): Float {
    var total = 0f
    for (i in 1 until glidePoints.size) total += hypot(glidePoints[i].x - glidePoints[i - 1].x, glidePoints[i].y - glidePoints[i - 1].y)
    return total
  }

  private fun clearGlide(keepCandidates: Boolean = false) {
    glideActive = false
    glideChars.clear()
    glidePoints.clear()
    board.setTrail(emptyList())
    if (!keepCandidates) glideCandidates = emptyList()
  }

  private fun handleTap(key: TypingLayouts.KeyDef) {
    when (key.code) {
      "SHIFT" -> {
        shift = when (shift) {
          TypingLayouts.ShiftState.OFF -> TypingLayouts.ShiftState.ONCE
          TypingLayouts.ShiftState.ONCE -> TypingLayouts.ShiftState.OFF
          TypingLayouts.ShiftState.LOCKED -> TypingLayouts.ShiftState.OFF
        }
        renderBoard()
      }
      "DEL" -> {
        if (usingPhonetic() && latinBuffer.isNotEmpty()) {
          latinBuffer.deleteCharAt(latinBuffer.length - 1)
          replacePhoneticPreview()
        } else {
          if (composing.isNotEmpty()) composing.deleteCharAt(composing.length - 1)
          onDelete(1)
        }
        refreshSuggestions()
      }
      "SPACE" -> maybeAutocorrectThenSpace()
      "ENTER" -> {
        flushPhonetic()
        composing.clear()
        onEnter()
        refreshSuggestions()
      }
      "NUMBERS" -> { page = TypingLayouts.Page.NUMBERS; renderBoard() }
      "SYMBOLS" -> { page = TypingLayouts.Page.SYMBOLS; renderBoard() }
      "LETTERS" -> { page = TypingLayouts.Page.LETTERS; renderBoard() }
      "EMOJI" -> {
        if (TypingLayouts.emojiCategory < 0 && TypingLayouts.emojiRecents.isEmpty()) TypingLayouts.emojiCategory = 0
        page = TypingLayouts.Page.EMOJI; renderBoard()
      }
      "NOOP" -> Unit
      "LANG" -> cycleLanguage()
      "INPUT_MODE" -> toggleInputMode()
      else -> {
        if (key.code.startsWith("EMOCAT:")) {
          TypingLayouts.emojiCategory = key.code.removePrefix("EMOCAT:").toIntOrNull() ?: 0
          renderBoard()
          return
        }
        if (key.code.startsWith("EMO:")) {
          val emoji = key.code.removePrefix("EMO:")
          flushPhonetic()
          composing.clear()
          onCommit(emoji)
          TypingLayouts.rememberEmoji(emoji)
          return
        }
        if (usingPhonetic() && key.label.length == 1 && key.label[0].isLetter()) {
          latinBuffer.append(if (shift != TypingLayouts.ShiftState.OFF) key.label else key.label.lowercase())
          replacePhoneticPreview()
          if (shift == TypingLayouts.ShiftState.ONCE) {
            shift = TypingLayouts.ShiftState.OFF
            renderBoard()
          }
          refreshSuggestions()
        } else {
          flushPhonetic()
          val text = key.code
          onCommit(text)
          if (text.length == 1 && text[0].isLetter()) composing.append(text) else composing.clear()
          if (shift == TypingLayouts.ShiftState.ONCE && page == TypingLayouts.Page.LETTERS) {
            shift = TypingLayouts.ShiftState.OFF
            renderBoard()
          }
          refreshSuggestions()
        }
      }
    }
  }

  private fun phoneticPreview(): String = when (langId) {
    "bn" -> AvroPhonetic.preview(latinBuffer.toString())
    "hi" -> HindiPhonetic.preview(latinBuffer.toString())
    else -> latinBuffer.toString()
  }

  private var lastPhoneticCommitted = ""

  private fun replacePhoneticPreview() {
    val next = phoneticPreview()
    if (lastPhoneticCommitted.isNotEmpty()) onDelete(lastPhoneticCommitted.length)
    if (next.isNotEmpty()) onCommit(next)
    lastPhoneticCommitted = next
    composing.clear()
    composing.append(next)
  }

  private fun flushPhonetic() {
    if (latinBuffer.isEmpty()) return
    // Final form already committed via preview
    latinBuffer.clear()
    lastPhoneticCommitted = ""
  }

  private fun maybeAutocorrectThenSpace() {
    if (usingPhonetic() && latinBuffer.isNotEmpty()) {
      flushPhonetic()
      onCommit(" ")
      composing.clear()
      refreshSuggestions()
      return
    }
    val token = composing.toString()
    if (token.isNotEmpty() && autocorrectEnabled) {
      val fix = SuggestEngine.autocorrect(token, langId, learnedWords())
      if (fix != null && !fix.equals(token, true)) {
        onDelete(token.length)
        onCommit(fix)
      }
    }
    onCommit(" ")
    composing.clear()
    refreshSuggestions()
  }

  private fun commitToken(word: String) {
    val token = composing.toString()
    if (token.isNotEmpty()) onDelete(token.length)
    onCommit(word)
    composing.clear()
    composing.append(word)
  }

  private fun showGlideSuggestions(words: List<String>) {
    // Immediately reflected via refreshSuggestions keepGlideExtras
  }

  private fun refreshSuggestions(keepGlideExtras: List<String> = emptyList()) {
    suggestRow.removeAllViews()
    val before = getBeforeCursor().takeLast(48)
    // After a space the previous word is the last one typed; mid-word it is the one before.
    val words = before.trimEnd().split(Regex("\\s+")).filter { it.isNotEmpty() }
    val prevWord = (if (before.isEmpty() || before.last().isWhitespace()) words.lastOrNull() else words.dropLast(1).lastOrNull()).orEmpty()
    val token = when {
      usingPhonetic() && latinBuffer.isNotEmpty() -> latinBuffer.toString()
      composing.isNotEmpty() -> composing.toString()
      else -> before.split(Regex("\\s+")).lastOrNull().orEmpty()
    }
    val fromDict = if (token.isBlank()) {
      SuggestEngine.suggest("", langId, learnedWords(), 3, previousWord = prevWord)
    } else if (usingPhonetic()) {
      // Suggest Bangla/Hindi completions from dict matching phonetic preview prefix
      val preview = phoneticPreview()
      SuggestEngine.suggest(preview, langId, learnedWords(), 3)
    } else {
      SuggestEngine.suggest(token, langId, learnedWords(), 3, previousWord = prevWord)
    }
    // The middle of the bar is narrower than a full row: two chips on small phones, three when they fit.
    val w = suggestRow.width
    val slots = when { w in 1 until dp(110) -> 1; w in 1 until dp(200) -> 2; else -> 3 }
    val suggestions = (keepGlideExtras + fromDict).distinct().take(slots)
    // Nothing to suggest: leave the bar empty rather than an inert label that looks broken.
    if (suggestions.isEmpty()) return
    suggestions.forEach { word ->
      val chip = TextView(context).apply {
        text = word
        textSize = 14f
        gravity = Gravity.CENTER
        setTextColor(ink)
        maxLines = 1
        ellipsize = android.text.TextUtils.TruncateAt.END
        setPadding(dp(6), 0, dp(6), 0)
        background = rounded(keyBg, 12)
        isClickable = true
        setOnClickListener {
          if (glideReplacement.isNotEmpty()) {
            if (!getBeforeCursor().endsWith(glideReplacement)) { refreshSuggestions(); return@setOnClickListener }
            onDelete(glideReplacement.length)
            glideReplacement = ""
          } else if (usingPhonetic() && latinBuffer.isNotEmpty()) {
            if (lastPhoneticCommitted.isNotEmpty()) onDelete(lastPhoneticCommitted.length)
            latinBuffer.clear()
            lastPhoneticCommitted = ""
          } else {
            val cur = composing.toString().ifBlank {
              getBeforeCursor().takeLast(40).split(Regex("\\s+")).lastOrNull().orEmpty()
            }
            if (cur.isNotEmpty()) onDelete(cur.length)
          }
          onCommit(word)
          onCommit(" ")
          composing.clear()
          refreshSuggestions()
          haptic(false)
        }
      }
      suggestRow.addView(chip, LayoutParams(0, LayoutParams.MATCH_PARENT, 1f).apply {
        marginStart = dp(2); marginEnd = dp(2); topMargin = dp(2); bottomMargin = dp(2)
      })
    }
  }

  private var alternatesShowing = false
  private var altViews: List<Pair<String, View>> = emptyList()

  private fun pickAlternateAt(rawX: Float): String? {
    if (altViews.isEmpty()) return null
    val loc = IntArray(2)
    return altViews.minByOrNull { (_, v) ->
      v.getLocationOnScreen(loc)
      abs(rawX - (loc[0] + v.width / 2f))
    }?.first
  }

  private fun click(key: TypingLayouts.KeyDef) {
    if (!keySound) return
    val fx = when (key.code) {
      "DEL" -> AudioManager.FX_KEYPRESS_DELETE
      "SPACE" -> AudioManager.FX_KEYPRESS_SPACEBAR
      "ENTER" -> AudioManager.FX_KEYPRESS_RETURN
      else -> AudioManager.FX_KEYPRESS_STANDARD
    }
    runCatching { audio?.playSoundEffect(fx, 0.5f) }
  }

  private fun showPreview(key: TypingLayouts.KeyDef) {
    if (key.isAction || key.label.isBlank() || key.code == "SPACE" || key.label.length > 2) return
    val rect = board.rectFor(key) ?: return
    val tv = previewText ?: TextView(context).apply {
      gravity = Gravity.CENTER
      textSize = 28f
      setTextColor(ink)
      background = rounded(if (night) Color.rgb(80, 84, 88) else Color.WHITE, 10)
      elevation = dp(6).toFloat()
    }.also { previewText = it }
    tv.text = key.label
    val w = (rect.width() * 1.15f).toInt().coerceAtLeast(dp(44))
    val h = (rect.height() * 1.25f).toInt()
    val win = previewWindow ?: PopupWindow(tv, w, h, false).apply {
      isTouchable = false
      isClippingEnabled = false
      animationStyle = 0
      elevation = dp(6).toFloat()
    }.also { previewWindow = it }
    val loc = IntArray(2)
    board.getLocationInWindow(loc)
    val x = loc[0] + (rect.centerX() - w / 2f).toInt()
    val y = loc[1] + (rect.top - h - dp(4)).toInt()
    runCatching {
      if (win.isShowing) win.update(x, y, w, h) else {
        win.width = w; win.height = h
        win.showAtLocation(board, Gravity.NO_GRAVITY, x, y)
      }
    }
  }

  private fun hidePreview() {
    runCatching { previewWindow?.dismiss() }
  }

  private fun showAlternates(key: TypingLayouts.KeyDef) {
    hideAlternates()
    hidePreview()
    val altList = mutableListOf<Pair<String, View>>()
    val row = LinearLayout(context).apply {
      orientation = HORIZONTAL
      background = rounded(suggestBg, 14)
      setPadding(dp(6), dp(6), dp(6), dp(6))
      elevation = dp(8).toFloat()
      key.alternates.forEach { alt ->
        val b = TextView(context).apply {
          text = alt
          textSize = 20f
          setTextColor(ink)
          setPadding(dp(12), dp(8), dp(12), dp(8))
          background = rounded(keyBg, 10)
          setOnClickListener {
            onCommit(alt)
            if (alt.any { it.isLetter() }) composing.append(alt)
            hideAlternates()
            refreshSuggestions()
          }
        }
        addView(b, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply { marginEnd = dp(4) })
        altList.add(alt to b)
      }
    }
    altViews = altList
    alternatesShowing = true
    val lp = LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply {
      gravity = Gravity.CENTER_HORIZONTAL
      bottomMargin = dp(4)
    }
    addView(row, 2, lp)
    row.tag = "altPopup"
  }

  private fun hideAlternates() {
    val doomed = mutableListOf<View>()
    for (i in 0 until childCount) {
      val c = getChildAt(i)
      if (c.tag == "altPopup") doomed.add(c)
    }
    doomed.forEach { removeView(it) }
    popup = null
    alternatesShowing = false
    altViews = emptyList()
  }

  private fun haptic(light: Boolean, view: View? = null) {
    if (!keyHaptics) return
    if (view != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
      view.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP, HapticFeedbackConstants.FLAG_IGNORE_GLOBAL_SETTING)
      return
    }
    runCatching {
      val vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        context.getSystemService(VibratorManager::class.java)?.defaultVibrator
      } else {
        @Suppress("DEPRECATION")
        context.getSystemService(Vibrator::class.java)
      } ?: return
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        vibrator.vibrate(VibrationEffect.createOneShot(if (light) 12L else 22L, VibrationEffect.DEFAULT_AMPLITUDE))
      } else {
        @Suppress("DEPRECATION")
        vibrator.vibrate(if (light) 12L else 22L)
      }
    }
  }

  private fun rounded(color: Int, radiusDp: Int) = GradientDrawable().apply {
    setColor(color)
    cornerRadius = dp(radiusDp).toFloat()
  }

  private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

  private inner class KeyboardBoardView(context: Context) : View(context) {
    private var rows: List<List<TypingLayouts.KeyDef>> = emptyList()
    private var keyRects = listOf<Triple<TypingLayouts.KeyDef, RectF, Boolean>>()
    private var bg = keyBg
    private var bgSpecial = keyBgSpecial
    private var textColor = ink
    private var mutedColor = muted
    private var trail = trailColor
    private var listener: ((TypingLayouts.KeyDef, Int, Float, Float, View) -> Boolean)? = null
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val trailPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      style = Paint.Style.STROKE
      strokeWidth = dp(4).toFloat()
      strokeCap = Paint.Cap.ROUND
      strokeJoin = Paint.Join.ROUND
    }
    private val textPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      textAlign = Paint.Align.CENTER
      typeface = Typeface.create(Typeface.DEFAULT, Typeface.NORMAL)
    }
    private var pressed: TypingLayouts.KeyDef? = null
    private var trailPts: List<GlideDecoder.Point> = emptyList()
    private val trailPath = Path()

    fun setRows(
      rows: List<List<TypingLayouts.KeyDef>>,
      bg: Int,
      bgSpecial: Int,
      textColor: Int,
      mutedColor: Int,
      trail: Int,
      listener: (TypingLayouts.KeyDef, Int, Float, Float, View) -> Boolean,
    ) {
      this.rows = rows
      this.bg = bg
      this.bgSpecial = bgSpecial
      this.textColor = textColor
      this.mutedColor = mutedColor
      this.trail = trail
      this.listener = listener
      invalidate()
    }

    fun setTrail(pts: List<GlideDecoder.Point>) {
      trailPts = GlideDecoder.smoothPath(pts)
      invalidate()
    }

    fun keyCenter(key: TypingLayouts.KeyDef): GlideDecoder.Point? =
      keyRects.firstOrNull { it.first === key || (it.first.label == key.label && it.first.code == key.code) }
        ?.second?.let { GlideDecoder.Point(it.centerX(), it.centerY()) }

    fun letterCenters(): Map<Char, GlideDecoder.Point> {
      val map = HashMap<Char, GlideDecoder.Point>()
      for ((key, rect, _) in keyRects) {
        if (!key.isAction && key.label.length == 1) {
          val c = key.label.lowercase().first()
          if (c.isLetter()) map[c] = GlideDecoder.Point(rect.centerX(), rect.centerY())
        }
      }
      return map
    }

    fun toLocal(rawX: Float, rawY: Float): Pair<Float, Float> {
      val loc = IntArray(2)
      getLocationOnScreen(loc)
      return (rawX - loc[0]) to (rawY - loc[1])
    }

    fun hitKey(rawX: Float, rawY: Float): TypingLayouts.KeyDef? {
      val (x, y) = toLocal(rawX, rawY)
      return hitKeyLocal(x, y)
    }

    fun rectFor(key: TypingLayouts.KeyDef): RectF? = keyRects.firstOrNull { it.first === key }?.second

    fun hitKeyLocal(x: Float, y: Float): TypingLayouts.KeyDef? =
      keyRects.firstOrNull { it.second.contains(x, y) }?.first

    /** The key closest to a touch that landed in the gap between keys, within [maxDist]. */
    fun nearestKeyLocal(x: Float, y: Float, maxDist: Float): TypingLayouts.KeyDef? {
      var best: TypingLayouts.KeyDef? = null
      var bestD = maxDist
      for ((key, r, _) in keyRects) {
        val dx = maxOf(r.left - x, 0f, x - r.right)
        val dy = maxOf(r.top - y, 0f, y - r.bottom)
        val d = hypot(dx, dy)
        if (d <= bestD) { bestD = d; best = key }
      }
      return best
    }

    override fun onDraw(canvas: Canvas) {
      super.onDraw(canvas)
      if (rows.isEmpty() || width == 0 || height == 0) return
      val gap = dp(6).toFloat()
      val vGap = dp(9).toFloat()
      val rowH = (height - vGap * (rows.size + 1)) / rows.size
      val built = mutableListOf<Triple<TypingLayouts.KeyDef, RectF, Boolean>>()
      rows.forEachIndexed { ri, row ->
        val totalW = row.sumOf { it.widthWeight.toDouble() }.toFloat()
        val usable = width - gap * (row.size + 1)
        var x = gap
        val y = vGap + ri * (rowH + vGap)
        row.forEach { key ->
          val w = usable * (key.widthWeight / totalW)
          val rect = RectF(x, y, x + w, y + rowH)
          val special = key.isAction
          paint.style = Paint.Style.FILL
          val radius = dp(6).toFloat()
          paint.color = keyShadow
          canvas.drawRoundRect(RectF(rect.left, rect.top + dp(1), rect.right, rect.bottom + dp(1)), radius, radius, paint)
          paint.color = when {
            pressed == key || (key.code == "SPACE" && trackpadActive) -> keyPressed
            key.code == "ENTER" -> if (night) Color.rgb(232, 234, 237) else Color.rgb(32, 33, 36)
            special -> bgSpecial
            else -> bg
          }
          canvas.drawRoundRect(rect, radius, radius, paint)
          textPaint.color = when {
            key.code == "ENTER" -> if (night) Color.rgb(32, 33, 36) else Color.WHITE
            special -> mutedColor
            else -> textColor
          }
          textPaint.textSize = when {
            key.code == "ENTER" && enterLabel.length > 1 -> dp(13).toFloat()
            key.code == "SPACE" -> dp(13).toFloat()
            !key.isAction && key.label.length == 1 -> dp(22).toFloat()
            key.code == "INPUT_MODE" -> dp(12).toFloat()
            key.label.length > 2 && !key.isAction -> dp(16).toFloat()
            else -> dp(18).toFloat()
          }
          val label = when (key.code) {
            "ENTER" -> enterLabel
            "SPACE" -> if (trackpadActive) "◀  move cursor  ▶" else "space"
            "INPUT_MODE" -> if (langId == "bn") {
              if (inputMode == TypingLayouts.InputMode.PHONETIC) "Avro" else "Probhat"
            } else if (langId == "hi") {
              if (inputMode == TypingLayouts.InputMode.PHONETIC) "Phon" else "InSc"
            } else key.label
            else -> key.label
          }
          canvas.drawText(label, rect.centerX(), rect.centerY() - (textPaint.ascent() + textPaint.descent()) / 2f, textPaint)
          built.add(Triple(key, rect, special))
          x += w + gap
        }
      }
      keyRects = built
      // Gesture trail
      if (trailPts.size >= 2) {
        trailPath.reset()
        trailPath.moveTo(trailPts[0].x, trailPts[0].y)
        for (i in 1 until trailPts.size) trailPath.lineTo(trailPts[i].x, trailPts[i].y)
        trailPaint.color = trail
        canvas.drawPath(trailPath, trailPaint)
      }
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
      val x = event.x
      val y = event.y
      val hit = keyRects.firstOrNull { it.second.contains(x, y) }?.first
        ?: if (event.actionMasked == MotionEvent.ACTION_DOWN) nearestKeyLocal(x, y, dp(10).toFloat()) else null
      when (event.actionMasked) {
        MotionEvent.ACTION_DOWN -> {
          pressed = hit
          invalidate()
          // Pass board-local coordinates so swipe/trackpad never depend on screen origin.
          if (hit != null) return listener?.invoke(hit, MotionEvent.ACTION_DOWN, x, y, this) ?: false
        }
        MotionEvent.ACTION_MOVE -> {
          if (glideActive) {
            listener?.invoke(pressed ?: hit ?: return true, MotionEvent.ACTION_MOVE, x, y, this)
            return true
          }
          if (pressed?.code == "SPACE") {
            listener?.invoke(pressed!!, MotionEvent.ACTION_MOVE, x, y, this)
            return true
          }
        }
        MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
          val key = pressed
          pressed = null
          invalidate()
          if (key != null) return listener?.invoke(key, event.actionMasked, x, y, this) ?: false
        }
      }
      return hit != null || pressed != null
    }
  }
}

private val TRANSLATE_TARGETS = listOf(
  "English" to "English",
  "বাংলা" to "Bangla (Bengali script)",
  "हिन्दी" to "Hindi (Devanagari script)",
)

/** A translation must be in the target script; anything else is never inserted. */
internal object TranslateCheck {
  fun looksLike(text: String, target: String): Boolean {
    val letters = text.filter { it.isLetter() }
    if (letters.isEmpty()) return false
    val bengali = letters.count { it in '\u0980'..'\u09FF' }
    val devanagari = letters.count { it in '\u0900'..'\u097F' }
    val latin = letters.count { it in 'a'..'z' || it in 'A'..'Z' }
    return when {
      target.startsWith("Bangla") -> bengali * 2 >= letters.length
      target.startsWith("Hindi") -> devanagari * 2 >= letters.length
      else -> latin * 2 >= letters.length
    }
  }
}

/** Toolbar glyphs in our own line style, drawn on a 48 unit grid. */
internal class ToolIcon(context: Context, private val kind: String, private val ink: Int, private val surface: Int) : View(context) {
  var active = false
  /** Soft halo while Detection is listening, so the far-right mic is obviously live. */
  var glow = false
  var label = ""
  private val p = Paint(Paint.ANTI_ALIAS_FLAG).apply { strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND }
  private val glowAccent = Color.rgb(0, 168, 150)
  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    // Icons are drawn at 26 dp inside the 36–40 dp touch target, all with one stroke weight.
    val size = minOf(width, height).toFloat() * 0.66f
    val s = size / 48f
    canvas.save()
    canvas.translate((width - size) / 2f, (height - size) / 2f)
    canvas.scale(s, s)
    val fg = if (active) surface else ink
    if (glow) {
      p.style = Paint.Style.FILL
      p.color = Color.argb(70, 0, 168, 150)
      canvas.drawCircle(24f, 24f, 26f, p)
      p.color = glowAccent
      canvas.drawCircle(24f, 24f, 23f, p)
    } else if (active) {
      p.style = Paint.Style.FILL; p.color = ink; canvas.drawCircle(24f, 24f, 23f, p)
    }
    p.color = if (glow) Color.WHITE else fg
    p.strokeWidth = 3.2f
    p.style = Paint.Style.STROKE
    when (kind) {
      "detection" -> {
        // House + small waveform: unambiguous return to the Detection page.
        val roof = Path().apply { moveTo(10f, 22f); lineTo(24f, 10f); lineTo(38f, 22f) }
        canvas.drawPath(roof, p)
        canvas.drawRect(13f, 22f, 35f, 38f, p)
        canvas.drawLine(18f, 30f, 18f, 36f, p)
        canvas.drawLine(24f, 26f, 24f, 36f, p)
        canvas.drawLine(30f, 30f, 30f, 36f, p)
      }
      "handwrite" -> {
        // Pencil over a pad: handwriting touchpad.
        canvas.drawRoundRect(RectF(10f, 12f, 38f, 38f), 4f, 4f, p)
        canvas.drawLine(16f, 28f, 28f, 16f, p)
        canvas.drawLine(28f, 16f, 32f, 20f, p)
        canvas.drawLine(16f, 28f, 14f, 34f, p)
        canvas.drawLine(14f, 34f, 20f, 32f, p)
      }
      "logo" -> {
        canvas.drawRoundRect(RectF(9f, 9f, 39f, 39f), 9f, 9f, p)
        canvas.drawLine(24f, 16f, 24f, 32f, p)
      }
      "mic" -> {
        canvas.drawRoundRect(RectF(19.5f, 11f, 28.5f, 28f), 4.5f, 4.5f, p)
        val arc = Path().apply { moveTo(15f, 24f); cubicTo(15f, 36f, 33f, 36f, 33f, 24f) }
        canvas.drawPath(arc, p)
        canvas.drawLine(24f, 33f, 24f, 38f, p)
      }
      "clip" -> {
        canvas.drawRoundRect(RectF(15f, 13f, 33f, 37f), 3f, 3f, p)
        p.style = Paint.Style.FILL
        canvas.drawRoundRect(RectF(19.5f, 10f, 28.5f, 15.5f), 2f, 2f, p)
        p.style = Paint.Style.STROKE
        canvas.drawLine(19f, 22f, 29f, 22f, p)
        canvas.drawLine(19f, 28f, 26f, 28f, p)
      }
      "translate" -> {
        // Two overlapping cards: a script glyph behind, a Latin A in front.
        canvas.drawRoundRect(RectF(6f, 6f, 28f, 28f), 5f, 5f, p)
        canvas.drawRoundRect(RectF(20f, 20f, 42f, 42f), 5f, 5f, p)
        p.style = Paint.Style.FILL
        p.textAlign = Paint.Align.CENTER
        p.typeface = Typeface.DEFAULT
        p.textSize = 14f
        canvas.drawText("অ", 17f, 22.5f, p)
        p.style = Paint.Style.STROKE
        canvas.drawLine(26f, 37f, 31f, 25f, p)
        canvas.drawLine(31f, 25f, 36f, 37f, p)
        canvas.drawLine(27.6f, 33f, 34.4f, 33f, p)
      }
      "lang" -> {
        // Language: a globe outline with the active code beside the meridian.
        canvas.drawRoundRect(RectF(5f, 10f, 43f, 38f), 8f, 8f, p)
        p.style = Paint.Style.FILL
        p.textAlign = Paint.Align.CENTER
        p.typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
        p.textSize = if (label.length > 2) 12f else 15f
        canvas.drawText(label.take(3), 24f, 29.5f, p)
      }
      "gear" -> {
        canvas.drawCircle(24f, 24f, 8.5f, p)
        canvas.drawCircle(24f, 24f, 3f, p)
        for (i in 0 until 8) {
          val a = Math.toRadians(i * 45.0)
          val c = kotlin.math.cos(a).toFloat(); val sn = kotlin.math.sin(a).toFloat()
          canvas.drawLine(24f + c * 9.5f, 24f + sn * 9.5f, 24f + c * 13f, 24f + sn * 13f, p)
        }
      }
    }
    canvas.restore()
  }
}
