
package com.voicelink.mobile

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.inputmethodservice.InputMethodService
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.MediaRecorder
import android.media.ToneGenerator
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.os.Looper
import android.view.View
import android.view.inputmethod.EditorInfo
import android.widget.FrameLayout
import org.json.JSONObject
import android.view.inputmethod.ExtractedTextRequest
import android.view.inputmethod.InputMethodManager
import java.util.ArrayList
import java.util.Locale
import java.util.concurrent.Executors
import kotlin.math.max
import kotlin.math.sqrt

/**
 * Cursor Flow global IME.
 * Tap to start, tap again to finish. Live cloud partials; finish merges partials + finals.
 * Modes: Dictate, Speak to edit, Help me write, Translate.
 */
class VoiceKeyboardService : InputMethodService() {
  private val samplesPerSegment = 16_000 * 25
  // No wall-clock cap: record until the user taps finish.
  @Volatile private var lastVoiceAt = 0L
  private val LONG_SILENCE_MS = 120_000L
  private val maxSessionSamples = Int.MAX_VALUE / 4
  private val mainHandler = Handler(Looper.getMainLooper())
  private val inferenceExecutor = Executors.newSingleThreadExecutor()
  private val polishExecutor = Executors.newSingleThreadExecutor()
  private val chunkExecutor = Executors.newSingleThreadExecutor()
  /** Stop waits at most this long for the live engine's last words, so finishing feels instant. */
  // Upper bound only: finish returns as soon as the engine sends the last words.
  private val LIVE_FINISH_MS = 1800L
  private val KEYBOARD_FINISH_LIMIT_MS = 2600L
  // Stop with a quiet tail (no voice for this long, nothing still pending): the words are
  // already final, so wait only for the server's short goodbye instead of the full cap.
  private val QUIET_TAIL_MS = 900L
  private val QUIET_TAIL_FINISH_MS = 400L
  private var latestCloudTranscript = ""
  // Recording mode fallback: when the live stream hears nothing, pieces are cut on pauses and
  // transcribed + cleaned while the user is still speaking, so stop only waits for the last piece.
  private val batchExecutor = Executors.newFixedThreadPool(2)
  private class RecPiece(val raw: String) { @Volatile var cleaned: String? = null; @Volatile var done = false }
  private val recPieces = java.util.Collections.synchronizedList(ArrayList<RecPiece>())
  /** Recording mode real-time edit: text after spoken edits, covering the first [recEditedUpTo] pieces. */
  @Volatile private var recEditedText: String? = null
  @Volatile private var recEditedUpTo = 0
  @Volatile private var recEditSeq = 0
  private var micButton: CursorFlowKeyboardView? = null
  private var committedForSession = false
  private var sessionClaimed = false
  @Volatile private var cloudRecording = false
  private var userWantsListening = false
  private var finishing = false
  // Live typing: partial words go into the field as composing text.
  private var inlineActive = false
  private var liveOwnershipLost = false
  private var liveWriteAttempted = false
  private var inlinePrefix = ""
  private var finishTimeout: Runnable? = null
  private var audioRecord: AudioRecord? = null
  private var audioThread: Thread? = null
  private var inputSessionId = 0L
  private var captureSessionId = -1L
  private var tone: ToneGenerator? = null
  private var mode = CursorFlowKeyboardView.UiMode.DICTATE
  private var editSource = ""
  private var editSelection = ""
  private var translateTarget = "Japanese"
  private val dictation = DictationSegments()
  private var latestPartial: String
    get() = dictation.partial
    set(value) { dictation.partial = value }
  /** Text already written into the field live during this dictation (segments). */
  private var liveCommitted = ""
  private var sessionPrefix = ""
  private var finishedMarked = ""
  private var finishedTail = ""
  // Cloud live dictation: each finalized piece is typed for good and cleaned in the background.
  private var liveRun = 0
  @Volatile private var liveOpen = false
  private var liveChunkMode = false
  private var liveComposing = ""
  private var liveFinishChunked = false
  private var liveFinishTail = ""
  @Volatile private var lastCleanupPath = ""
  private var lastCommittedText = ""
  private var lastCommittedAt = 0L
  private var undoExpire: Runnable? = null
  private var pendingOfflinePcm: ShortArray? = null
  private var imeHost: FrameLayout? = null
  private var typingPanel: TypingKeyboardView? = null
  private var showingTyping = false
  private var mixedVoiceTyping = false
  private var voiceUiListening = false
  private var voiceUiProcessing = false
  private var offlineDrainRunning = false
  private var offlineBackoffMs = 2500L
  private val retryOfflineReceiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context?, intent: Intent?) {
      if (intent?.action != "com.voicelink.mobile.RETRY_OFFLINE_DICTATION") return
      offlineBackoffMs = 800L
      drainOfflineQueueSoon(0L)
    }
  }
  private var retryOfflineReceiverRegistered = false

  private val clipboard by lazy { getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager }
  private val clipboardListener = android.content.ClipboardManager.OnPrimaryClipChangedListener { rememberPhoneClipboard() }
  private fun phoneClipboardText(): String? {
    val clip = clipboard.primaryClip ?: return null
    return clip.takeIf { it.itemCount > 0 }?.getItemAt(0)?.text?.toString()
  }
  private fun rememberPhoneClipboard() {
    if (!isInputViewShown || !VoiceInputTargetPolicy.allows(currentInputEditorInfo)) return
    runCatching {
      // Android marks passwords/other sensitive copies. Never persist those snippets.
      if (clipboard.primaryClipDescription?.extras?.getBoolean("android.content.extra.IS_SENSITIVE", false) == true) return
      phoneClipboardText()?.let { ClipboardHistoryStore.remember(this, it) }
    }
  }
  private fun pastePhoneClipboard() {
    rememberPhoneClipboard()
    val text = runCatching { phoneClipboardText() }.getOrNull()
    if (text.isNullOrEmpty()) { setCaption("Phone clipboard is empty"); return }
    pastePhoneText(text)
  }
  private fun pastePhoneText(text: String) {
    beforeManualEdit()
    val ok = runCatching { currentInputConnection?.commitText(text, 1) == true }.getOrDefault(false)
    setCaption(if (ok) "Pasted on phone" else "No text field selected")
  }

  override fun onCreate() {
    super.onCreate()
    clipboard.addPrimaryClipChangedListener(clipboardListener)
    tone = runCatching { ToneGenerator(AudioManager.STREAM_MUSIC, 70) }.getOrNull()
    if (!retryOfflineReceiverRegistered) {
      val filter = IntentFilter("com.voicelink.mobile.RETRY_OFFLINE_DICTATION")
      if (Build.VERSION.SDK_INT >= 33) {
        registerReceiver(retryOfflineReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
      } else {
        registerReceiver(retryOfflineReceiver, filter)
      }
      retryOfflineReceiverRegistered = true
    }
  }

  private var builtNight: Boolean? = null

  override fun onCreateInputView(): View {
    builtNight = VoiceKeyboardSecureStore.isNight(this)
    translateTarget = VoiceKeyboardSecureStore.getTranslateTarget(this)
    // Detection (voice) is always the first page; Text is one tap away.
    showingTyping = false
    val voice = CursorFlowKeyboardView(
      this,
      onSpeak = { toggleListening() },
      onCancel = { cancelListening() },
      onHide = { requestHideSelf(0) },
      onSwitchKeyboard = { switchAwayFromVoiceKeyboard() },
      onModeSelected = { name ->
        mode = when (name) {
          "edit" -> CursorFlowKeyboardView.UiMode.EDIT
          "write" -> CursorFlowKeyboardView.UiMode.WRITE
          "translate" -> CursorFlowKeyboardView.UiMode.TRANSLATE
          else -> CursorFlowKeyboardView.UiMode.DICTATE
        }
        micButton?.setMode(mode)
      },
      onTranslateLanguage = { label ->
        translateTarget = label
        VoiceKeyboardSecureStore.putTranslateTarget(this, label)
        micButton?.setTranslateLanguage(label)
      },
      onDictationLanguage = { label ->
        VoiceKeyboardSecureStore.putLanguage(this, label)
        micButton?.setDictationLanguage(label)
      },
      onBackspace = { beforeManualEdit(); justInserted = false; smartDelete(); refreshActionKey() },
      onTranslatePick = { name -> pickTranslate(name) },
      onUndoLastInsert = { undoLastInsert() },
      onToggleTyping = { showTypingPanel(true) },
      onPencil = { startSmartPencil() },
      onQuickEdit = { instruction -> quickEdit(instruction) },
      onHoldStart = { if (!userWantsListening && !finishing) startListening() },
      onEditorAction = { justInserted = false; sendEditorEnter(); refreshActionKey() },
      onSpace = { beforeManualEdit(); justInserted = false; currentInputConnection?.commitText(" ", 1) },
      onClipboard = { pastePhoneClipboard() },
      onClipboardHistory = {
        rememberPhoneClipboard()
        micButton?.showClipboardHistory(ClipboardHistoryStore.read(this),
          paste = { pastePhoneText(it) }, clear = { ClipboardHistoryStore.clear(this) })
      },
    )
    micButton = voice
    micButton?.setTranslateRecents(VoiceKeyboardSecureStore.getTranslateRecents(this))
    micButton?.setDetectedLanguage(VoiceKeyboardSecureStore.getLastDetected(this))
    micButton?.setMode(mode)
    micButton?.setTranslateLanguage(translateTarget)
    micButton?.setDictationLanguage(VoiceKeyboardSecureStore.getLanguage(this))

    val typing = TypingKeyboardView(
      this,
      onCommit = { text -> beforeManualEdit(); currentInputConnection?.commitText(text, 1) },
      onDelete = { n -> beforeManualEdit(); if (n == 1) smartDelete() else currentInputConnection?.deleteSurroundingText(n, 0) },
      onEnter = { sendEditorEnter() },
      onDeleteWord = { deletePreviousWord() },
      onMoveCursor = { direction -> moveTypingCursor(direction) },
      onCorrectWord = { reSpeakWord() },
      onShowVoice = { showTypingPanel(false) },
      onToggleVoice = { toggleListening() },
      onSwitchExternal = { switchAwayFromVoiceKeyboard() },
      getBeforeCursor = {
        runCatching { currentInputConnection?.getTextBeforeCursor(64, 0)?.toString().orEmpty() }.getOrDefault("")
      },
      learnedWords = { cachedLearnedWords() },
      getFieldTextBeforeCursor = {
        runCatching { currentInputConnection?.getTextBeforeCursor(2000, 0)?.toString().orEmpty() }.getOrDefault("")
      },
      onTranslate = { text, target, done -> translateTyped(text, target, done) },
    )
    typingPanel = typing

    val host = FrameLayout(this)
    host.addView(voice, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT))
    host.addView(typing, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT))
    imeHost = host
    applyPanelVisibility()
    updateTargetState()
    drainOfflineQueueSoon()
    return host
  }

  private fun setListeningState(active: Boolean, level: Float = 0f) {
    voiceUiListening = active
    if (active) voiceUiProcessing = false
    micButton?.setListening(active, level)
    typingPanel?.setVoiceState(voiceUiListening, voiceUiProcessing)
  }

  private fun setProcessingState(active: Boolean) {
    voiceUiProcessing = active
    if (active) voiceUiListening = false
    micButton?.setProcessing(active)
    typingPanel?.setVoiceState(voiceUiListening, voiceUiProcessing)
  }

  /** Manual edits end our replacement ownership, not microphone capture. */
  private fun beforeManualEdit() {
    lastCommittedText = ""
    liveEditSeq++
    if (!(userWantsListening || cloudRecording || finishing || liveOpen)) return
    mixedVoiceTyping = true
    // Keep the words the user has already seen. Manual edits revoke replacement ownership.
    liveOwnershipLost = true
    liveComposing = ""
    liveCommitted = ""
    sessionPrefix = ""
    inlinePrefix = ""
  }

  /** Toolbar Translate. Never returns the original text as a translation. */
  private fun translateTyped(text: String, target: String, done: (String?, String?) -> Unit) {
    // Password and other private fields never leave the phone.
    if (!VoiceInputTargetPolicy.allows(currentInputEditorInfo) || runCatching { currentDictationContext().disableVoice }.getOrDefault(true)) {
      done(null, "Translate is off in this field."); return
    }
    if (!cloudReady()) { done(null, "Translate needs sign-in and an internet connection."); return }
    inferenceExecutor.execute {
      try {
        val out = CloudKeyboardTranscriber.translate(
          VoiceKeyboardSecureStore.getApiBaseUrl(this) ?: "",
          KeyboardSession.freshAccessToken(this) ?: "",
          text.take(2000),
          target,
        ).trim()
        if (out.isBlank()) done(null, "No translation came back.") else done(out, null)
      } catch (error: Throwable) {
        val msg = error.message.orEmpty()
        done(null, when {
          msg.contains("credit", true) || msg.contains("402") || msg.contains("quota", true) -> "Flow AI needs cloud credit."
          msg.contains("sign in", true) || msg.contains("401") -> "Sign in to Cursor Flow first."
          else -> "Check your internet and try again."
        })
      }
    }
  }

  private fun showTypingPanel(show: Boolean) {
    showingTyping = show
    VoiceKeyboardSecureStore.putImePanel(this, if (show) "typing" else "voice")
    applyPanelVisibility()
  }

  private fun applyPanelVisibility() {
    micButton?.visibility = if (showingTyping) View.GONE else View.VISIBLE
    typingPanel?.visibility = if (showingTyping) View.VISIBLE else View.GONE
    matchNavigationBar()
  }

  /** The band under the keys takes the panel's color, so it never looks like empty space. */
  private fun matchNavigationBar() {
    runCatching {
      val w = window?.window ?: return
      val night = VoiceKeyboardSecureStore.isNight(this)
      val color = if (showingTyping) { if (night) android.graphics.Color.rgb(32, 33, 36) else android.graphics.Color.rgb(232, 234, 237) }
        else { if (night) android.graphics.Color.rgb(25, 25, 25) else android.graphics.Color.rgb(238, 240, 243) }
      @Suppress("DEPRECATION")
      w.navigationBarColor = color
      if (Build.VERSION.SDK_INT >= 30) {
        val light = android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
        w.insetsController?.setSystemBarsAppearance(if (night) 0 else light, light)
      }
    }
  }

  private fun sendEditorEnter() {
    beforeManualEdit()
    val ic = currentInputConnection ?: return
    val info = currentInputEditorInfo
    val action = editorActionId(info)
    if (action != null) {
      if (!ic.performEditorAction(action)) {
        ic.sendKeyEvent(android.view.KeyEvent(android.view.KeyEvent.ACTION_DOWN, android.view.KeyEvent.KEYCODE_ENTER))
        ic.sendKeyEvent(android.view.KeyEvent(android.view.KeyEvent.ACTION_UP, android.view.KeyEvent.KEYCODE_ENTER))
      }
    } else if (isMultiline(info)) {
      ic.sendKeyEvent(android.view.KeyEvent(android.view.KeyEvent.ACTION_DOWN, android.view.KeyEvent.KEYCODE_ENTER))
      ic.sendKeyEvent(android.view.KeyEvent(android.view.KeyEvent.ACTION_UP, android.view.KeyEvent.KEYCODE_ENTER))
    } else {
      ic.commitText("\n", 1)
    }
  }

  /**
   * Backspace: deletes the selection when there is one, otherwise one whole
   * character (emoji, surrogate pair, or Bangla cluster), never half of one.
   * Falls back to a DEL key event when the editor ignores the connection.
   */
  private fun smartDelete() {
    val ic = currentInputConnection ?: return
    val selected = runCatching { ic.getSelectedText(0) }.getOrNull()
    if (!selected.isNullOrEmpty()) {
      if (!runCatching { ic.commitText("", 1) }.getOrDefault(false)) sendDelKey(ic)
      return
    }
    val before = runCatching { ic.getTextBeforeCursor(16, 0)?.toString() }.getOrNull()
    if (before == null) { sendDelKey(ic); return }
    if (before.isEmpty()) { sendDelKey(ic); return }
    val it = java.text.BreakIterator.getCharacterInstance()
    it.setText(before)
    val end = it.last()
    val start = it.previous().let { p -> if (p == java.text.BreakIterator.DONE) 0 else p }
    val n = (end - start).coerceAtLeast(1)
    if (!runCatching { ic.deleteSurroundingText(n, 0) }.getOrDefault(false)) sendDelKey(ic)
  }

  private fun deletePreviousWord() {
    beforeManualEdit()
    val ic = currentInputConnection ?: return
    val before = ic.getTextBeforeCursor(256, 0)?.toString().orEmpty()
    val word = Regex("\\S+\\s*$").find(before)?.value ?: before
    if (word.isNotEmpty()) ic.deleteSurroundingText(word.length, 0)
  }

  private fun moveTypingCursor(direction: Int) {
    beforeManualEdit()
    val ic = currentInputConnection ?: return
    ic.finishComposingText()
    val key = if (direction < 0) android.view.KeyEvent.KEYCODE_DPAD_LEFT else android.view.KeyEvent.KEYCODE_DPAD_RIGHT
    ic.sendKeyEvent(android.view.KeyEvent(android.view.KeyEvent.ACTION_DOWN, key))
    ic.sendKeyEvent(android.view.KeyEvent(android.view.KeyEvent.ACTION_UP, key))
  }

  /** Tap the word in the editor, then Re-speak. An existing selection also works. */
  private fun reSpeakWord() {
    if (userWantsListening || finishing) return
    val ic = currentInputConnection ?: return
    if (ic.getSelectedText(0).isNullOrBlank()) {
      val extracted = ic.getExtractedText(ExtractedTextRequest(), 0) ?: return
      val pos = extracted.startOffset + extracted.selectionStart
      val left = Regex("[\\p{L}\\p{M}\\p{N}'’-]+$").find(ic.getTextBeforeCursor(96, 0)?.toString().orEmpty())?.value.orEmpty()
      val right = Regex("^[\\p{L}\\p{M}\\p{N}'’-]+").find(ic.getTextAfterCursor(96, 0)?.toString().orEmpty())?.value.orEmpty()
      if (left.isEmpty() && right.isEmpty()) { setCaption("Tap a word or select it, then Re-speak"); return }
      if (!ic.setSelection(pos - left.length, pos + right.length)) return
    }
    startListening()
  }

  private fun sendDelKey(ic: android.view.inputmethod.InputConnection) {
    ic.sendKeyEvent(android.view.KeyEvent(android.view.KeyEvent.ACTION_DOWN, android.view.KeyEvent.KEYCODE_DEL))
    ic.sendKeyEvent(android.view.KeyEvent(android.view.KeyEvent.ACTION_UP, android.view.KeyEvent.KEYCODE_DEL))
  }

  /** Learned words read from protected storage once, then reused (was decrypted on every key). */
  private var learnedCache: List<String> = emptyList()
  private var learnedCacheAt = 0L
  private fun cachedLearnedWords(): List<String> {
    val now = android.os.SystemClock.elapsedRealtime()
    if (learnedCacheAt == 0L || now - learnedCacheAt > 60_000L) {
      learnedCache = runCatching {
        VoiceKeyboardSecureStore.getVocabulary(this) + VoiceKeyboardSecureStore.getLearnedVocabulary(this)
      }.getOrDefault(learnedCache)
      learnedCacheAt = now
    }
    return learnedCache
  }

  /** True after dictation inserts text, until the user deletes or edits. */
  private var justInserted = false

  private fun isMultiline(info: EditorInfo?): Boolean =
    info != null && (info.inputType and android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE) != 0

  /** The field's IME action, or null when Enter should insert a newline. */
  private fun editorActionId(info: EditorInfo?): Int? {
    info ?: return null
    if ((info.imeOptions and EditorInfo.IME_FLAG_NO_ENTER_ACTION) != 0) return null
    if (info.actionId != 0 && !info.actionLabel.isNullOrEmpty()) return info.actionId
    val action = info.imeOptions and EditorInfo.IME_MASK_ACTION
    return when (action) {
      EditorInfo.IME_ACTION_SEARCH, EditorInfo.IME_ACTION_SEND, EditorInfo.IME_ACTION_GO,
      EditorInfo.IME_ACTION_NEXT, EditorInfo.IME_ACTION_DONE, EditorInfo.IME_ACTION_PREVIOUS -> action
      EditorInfo.IME_ACTION_NONE -> null
      else -> if (isMultiline(info)) null else EditorInfo.IME_ACTION_DONE
    }
  }

  /** Updates the smart action key: icon from the field, highlighted when empty or right after dictation. */
  private fun refreshActionKey() {
    val info = currentInputEditorInfo
    val kind = when (editorActionId(info)) {
      EditorInfo.IME_ACTION_SEARCH -> "search"
      EditorInfo.IME_ACTION_SEND -> "send"
      EditorInfo.IME_ACTION_GO -> "go"
      EditorInfo.IME_ACTION_NEXT -> "next"
      EditorInfo.IME_ACTION_DONE -> "done"
      else -> "enter"
    }
    val ic = currentInputConnection
    val empty = runCatching {
      (ic?.getTextBeforeCursor(1, 0)?.isEmpty() ?: true) && (ic?.getTextAfterCursor(1, 0)?.isEmpty() ?: true)
    }.getOrDefault(false)
    micButton?.setEditorAction(kind, empty || justInserted)
    typingPanel?.setEditorAction(kind)
  }

  /** Hold + slide translate (or More list). Translates the current session, or starts one. */
  private fun pickTranslate(name: String) {
    translateTarget = name
    VoiceKeyboardSecureStore.putTranslateTarget(this, name)
    VoiceKeyboardSecureStore.pushTranslateRecent(this, name)
    micButton?.setTranslateLanguage(name)
    micButton?.setTranslateRecents(VoiceKeyboardSecureStore.getTranslateRecents(this))
    mode = CursorFlowKeyboardView.UiMode.TRANSLATE
    micButton?.setMode(mode)
    if (cloudRecording || userWantsListening) finishListening()
    else if (!finishing) startListening()
  }

  /** Smart pencil: selection or text in the field means edit; an empty field means write. */
  private fun startSmartPencil() {
    val ic = currentInputConnection ?: return
    val selected = runCatching { ic.getSelectedText(0)?.toString().orEmpty() }.getOrDefault("")
    val existing = runCatching { ic.getExtractedText(ExtractedTextRequest(), 0)?.text?.toString().orEmpty().ifBlank {
      ic.getTextBeforeCursor(20_000, 0)?.toString().orEmpty() + ic.getTextAfterCursor(20_000, 0)?.toString().orEmpty()
    } }.getOrDefault("")
    mode = if (selected.isNotBlank() || existing.isNotBlank()) CursorFlowKeyboardView.UiMode.EDIT else CursorFlowKeyboardView.UiMode.WRITE
    micButton?.setEditTarget(selected.isNotBlank())
    micButton?.setMode(mode)
    startListening()
  }

  /** One-tap edit chip in the edit sheet: stop listening and apply the instruction. */
  private fun quickEdit(instruction: String) {
    stopCaptureForTargetChange()
    captureSessionId = inputSessionId
    mode = CursorFlowKeyboardView.UiMode.EDIT
    val ic = currentInputConnection
    editSelection = ic?.getSelectedText(0)?.toString().orEmpty()
    editSource = editSelection.ifBlank {
      ic?.getExtractedText(ExtractedTextRequest(), 0)?.text?.toString().orEmpty().ifBlank {
        ic?.getTextBeforeCursor(20_000, 0)?.toString().orEmpty() + ic?.getTextAfterCursor(20_000, 0)?.toString().orEmpty()
      }
    }
    handleRecognizedText(instruction)
  }

  /** Pencil and translate are one-shot: go back to plain dictation afterwards. */
  private fun endOneShot() {
    if (mode == CursorFlowKeyboardView.UiMode.DICTATE) return
    mode = CursorFlowKeyboardView.UiMode.DICTATE
    micButton?.setMode(mode)
  }

  private enum class SpokenCommand { NONE, SEND, SCRATCH, DELETE_WORD }
  private var pendingSend = false

  /** Spoken commands. Returns the text to insert (may be empty) and the trailing command. */
  private fun parseSpokenCommands(raw: String): Pair<String, SpokenCommand> {
    var t = raw.trim()
    val norm = t.lowercase().trimEnd('.', '!', '?', ',', '।').trim()
    when (norm) {
      "scratch that", "delete that", "undo that" -> return "" to SpokenCommand.SCRATCH
      "delete last word", "delete the last word" -> return "" to SpokenCommand.DELETE_WORD
      "send", "send it", "send message", "send the message", "পাঠাও", "সেন্ড", "सेंड", "भेजो" -> return "" to SpokenCommand.SEND
    }
    var cmd = SpokenCommand.NONE
    val sendTail = Regex("[\\s,.]+(send it|send message|send the message)[.!]?$", RegexOption.IGNORE_CASE)
    if (sendTail.containsMatchIn(t)) { t = t.replace(sendTail, ""); cmd = SpokenCommand.SEND }
    t = t.replace(Regex("\\s*\\bnew paragraph\\b[,.]?\\s*", RegexOption.IGNORE_CASE), "\n\n")
    t = t.replace(Regex("\\s*\\b(new line|next line)\\b[,.]?\\s*", RegexOption.IGNORE_CASE), "\n")
    return t to cmd
  }

  private fun deleteLastWord() {
    val ic = currentInputConnection ?: return
    val before = runCatching { ic.getTextBeforeCursor(80, 0)?.toString().orEmpty() }.getOrDefault("")
    if (before.isEmpty()) return
    val trimmedEnd = before.trimEnd()
    val start = trimmedEnd.lastIndexOfAny(charArrayOf(' ', '\n')) + 1
    ic.deleteSurroundingText(before.length - start, 0)
  }

  /** Speech language from the recognizer (API 34+) or the script of the text. */
  private fun noteDetectedLanguage(code: String?) {
    val c = code?.substringBefore('-')?.lowercase()?.takeIf { it.isNotBlank() } ?: return
    VoiceKeyboardSecureStore.putLastDetected(this, c)
    micButton?.setDetectedLanguage(c)
  }

  private fun playCue(start: Boolean) {
    // 3.0.0: no beeps. A light haptic is the only start/stop cue.
    lightHaptic(start)
  }

  private fun lightHaptic(start: Boolean) {
    runCatching {
      val vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        getSystemService(VibratorManager::class.java)?.defaultVibrator
      } else {
        @Suppress("DEPRECATION")
        getSystemService(Vibrator::class.java)
      } ?: return
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        val ms = if (start) 18L else 28L
        vibrator.vibrate(VibrationEffect.createOneShot(ms, VibrationEffect.DEFAULT_AMPLITUDE))
      } else {
        @Suppress("DEPRECATION")
        vibrator.vibrate(if (start) 18L else 28L)
      }
    }
  }

  private fun currentDictationContext(): InputContextResolver.DictationContext {
    val info = currentInputEditorInfo
    val pkg = info?.packageName.orEmpty()
    val override = VoiceKeyboardSecureStore.getAppStyleOverride(this, pkg)
    // Privacy: only the app package and field type are used, never text from the app.
    val resolved = InputContextResolver.resolve(info, override)
    val tone = VoiceKeyboardSecureStore.getPersonalStyleNote(this)
    return if (tone.isBlank()) resolved else resolved.copy(styleNotes = (resolved.styleNotes + " " + tone).trim())
  }

  private fun learnFromCorrectionIfAny() {
    if (lastCommittedText.isBlank()) return
    val now = System.currentTimeMillis()
    if (now - lastCommittedAt > 20_000L) return
    val window = lastCommittedText.length + 120
    val before = runCatching {
      currentInputConnection?.getTextBeforeCursor(window, 0)?.toString().orEmpty()
    }.getOrDefault("")
    if (before.isBlank()) return
    if (before.endsWith(lastCommittedText)) return
    val oursTokens = lastCommittedText.split(Regex("\\s+")).filter { it.isNotBlank() }
    val region = before.takeLast(max(lastCommittedText.length + 60, 24))
    val theirsTokens = region.split(Regex("\\s+")).filter { it.isNotBlank() }
    if (oursTokens.isNotEmpty() && theirsTokens.isNotEmpty()) {
      val oursSet = oursTokens.map { it.lowercase() }.toSet()
      val novel = theirsTokens.filter { it.lowercase() !in oursSet && it.any(Char::isLetter) && it.length >= 2 }.take(8)
      if (novel.isNotEmpty()) VoiceKeyboardSecureStore.addLearnedVocabulary(this, novel)
      val n = minOf(oursTokens.size, theirsTokens.size)
      for (i in 0 until n) {
        val a = oursTokens[i]
        val b = theirsTokens.getOrNull(theirsTokens.size - n + i) ?: continue
        if (!a.equals(b, true) && a.any(Char::isLetter) && b.any(Char::isLetter)) {
          VoiceKeyboardSecureStore.addCorrectionPair(this, a, b)
        }
      }
      if (kotlin.math.abs(region.length - lastCommittedText.length) <= 40) {
        VoiceKeyboardSecureStore.addCorrectionPair(this, lastCommittedText, region.trim())
      }
    }
  }

  private fun drainOfflineQueueSoon(delayMs: Long = offlineBackoffMs) {
    mainHandler.postDelayed({ drainOfflineQueue() }, delayMs)
  }

  private fun drainOfflineQueue() {
    if (offlineDrainRunning) return
    val item = OfflineDictationQueue.nextReady(this) ?: run {
      if (OfflineDictationQueue.load(this).isNotEmpty()) {
        offlineBackoffMs = (offlineBackoffMs * 2).coerceAtMost(60_000L)
        drainOfflineQueueSoon(offlineBackoffMs)
      } else {
        offlineBackoffMs = 2500L
      }
      return
    }
    if (!cloudReady()) {
      offlineBackoffMs = (offlineBackoffMs * 2).coerceAtMost(60_000L)
      drainOfflineQueueSoon(offlineBackoffMs)
      return
    }
    offlineDrainRunning = true
    val sessionAtStart = inputSessionId
    inferenceExecutor.execute {
      try {
        val base = VoiceKeyboardSecureStore.getApiBaseUrl(this).orEmpty()
        val token = KeyboardSession.freshAccessToken(this).orEmpty()
        val vocab = VoiceKeyboardSecureStore.getVocabulary(this) + VoiceKeyboardSecureStore.getLearnedVocabulary(this)
        val style = VoiceKeyboardSecureStore.getFormatStyle(this)
        val text = when (item.kind) {
          "text" -> {
            val meta = OfflineDictationQueue.readTextMeta(this, item.id)
            val raw = meta?.optString("text").orEmpty()
            if (raw.isBlank()) throw IllegalStateException("Empty offline text")
            val ctxJson = meta?.optString("inputContext").orEmpty()
            val ctx = runCatching { if (ctxJson.isNotBlank()) JSONObject(ctxJson) else null }.getOrNull()
            if (VoiceKeyboardSecureStore.getCleanAndFormat(this)) CloudKeyboardTranscriber.polishTextOrNull(base, token, raw, vocab, meta?.optString("formatStyle") ?: style, ctx, 1_200) ?: raw else raw
          }
          else -> {
            val wav = OfflineDictationQueue.peekWav(this, item.id) ?: throw IllegalStateException("Missing wav")
            if (wav.size <= 44) throw IllegalStateException("Empty wav")
            CloudKeyboardTranscriber.transcribeWav(
              base, token, wav, item.language,
              VoiceKeyboardSecureStore.getCleanAndFormat(this),
              vocab, style, null,
            )
          }
        }
        mainHandler.post {
          offlineDrainRunning = false
          offlineBackoffMs = 2500L
          // A recovered upload no longer owns a live cursor span. Never append it later.
          DictationHistoryStore.append(this, text, item.packageName, item.language, "offline")
          OfflineDictationQueue.remove(this, item.id)
          setCaption("Recovered dictation saved to History")
          drainOfflineQueueSoon(800L)
        }
      } catch (e: Exception) {
        mainHandler.post {
          offlineDrainRunning = false
          OfflineDictationQueue.markAttempt(this, item.id, e.message)
          offlineBackoffMs = (offlineBackoffMs * 2).coerceAtMost(60_000L)
          // Background queue status is never a keyboard caption; History shows saved items.
          drainOfflineQueueSoon(offlineBackoffMs)
        }
      }
    }
  }

  private fun switchAwayFromVoiceKeyboard() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      if (switchToPreviousInputMethod()) return
    }
    if (shouldOfferSwitchingToNextInputMethod() && switchToNextInputMethod(false)) return
    if (switchToNextInputMethod(false)) return
    getSystemService(InputMethodManager::class.java)?.showInputMethodPicker()
  }

  override fun onStartInput(attribute: android.view.inputmethod.EditorInfo?, restarting: Boolean) {
    super.onStartInput(attribute, restarting)
    inputSessionId += 1
    stopCaptureForTargetChange()
    updateTargetState()
    justInserted = false
    learnedCacheAt = 0L
    refreshActionKey()
    drainOfflineQueueSoon(1200L)
  }

  override fun onUpdateSelection(oldSelStart: Int, oldSelEnd: Int, newSelStart: Int, newSelEnd: Int, candidatesStart: Int, candidatesEnd: Int) {
    super.onUpdateSelection(oldSelStart, oldSelEnd, newSelStart, newSelEnd, candidatesStart, candidatesEnd)
    // A selection/tap during voice relinquishes replacement ownership, not the microphone.
    if (inlineActive && (userWantsListening || liveOpen) &&
      (newSelStart != newSelEnd || (candidatesEnd >= 0 && newSelStart != candidatesEnd))) {
      beforeManualEdit()
    }
    // Cursor moved back (user deleting or editing): stop emphasising the action.
    if (justInserted && newSelStart < oldSelStart) justInserted = false
    refreshActionKey()
  }

  override fun onFinishInput() {
    learnFromCorrectionIfAny()
    stopCaptureForTargetChange()
    inputSessionId += 1
    super.onFinishInput()
  }

  override fun onStartInputView(info: android.view.inputmethod.EditorInfo?, restarting: Boolean) {
    super.onStartInputView(info, restarting)
    matchNavigationBar()
    // Rebuild when the app theme (or system theme) changed since the views were made.
    if (builtNight != null && builtNight != VoiceKeyboardSecureStore.isNight(this) &&
      !cloudRecording && !userWantsListening && !finishing) {
      setInputView(onCreateInputView())
    }
    if (!cloudRecording && !userWantsListening && !finishing) micButton?.clearLiveTranscript()
    // A fresh keyboard open starts on Detection. A restart within the same field
    // (restarting == true) keeps the Text page so an in-progress typing session is not interrupted.
    if (!restarting && showingTyping && !cloudRecording && !userWantsListening && !finishing) {
      showTypingPanel(false)
    }
    refreshActionKey()
  }

  override fun onFinishInputView(finishingInput: Boolean) {
    stopCaptureForTargetChange()
    super.onFinishInputView(finishingInput)
  }

  /** Recognizer callbacks are ignored once the session was committed, cancelled or replaced. */
  private fun recognizerSessionLive(): Boolean = userWantsListening || finishing

  override fun onWindowHidden() {
    learnFromCorrectionIfAny()
    stopCaptureForTargetChange()
    super.onWindowHidden()
  }

  private fun updateTargetState() {
    val allowed = VoiceInputTargetPolicy.allows(currentInputEditorInfo)
    micButton?.isEnabled = allowed
    if (!allowed) setCaption(VoiceInputTargetPolicy.denialReason(currentInputEditorInfo))
  }

  private fun stopCaptureForTargetChange() {
    liveOpen = false
    liveRun++
    val was = cloudRecording || userWantsListening || finishing
    clearFinishTimeout()
    finishing = false
    userWantsListening = false
    cloudRecording = false
    audioRecord?.let { stopRecorderOnly(it) }
    captureSessionId = -1L
    dictation.clear()
    latestPartial = ""
    setListeningState(false)
    setProcessingState(false)
    micButton?.clearLiveTranscript()
    keepInline()
    if (was) playCue(false)
  }

  private fun cancelListening() {
    stopCaptureForTargetChange()
    pendingSend = false
    endOneShot()
    setCaption("Cancelled")
  }

  private fun toggleListening() {
    when {
      // A stuck "finishing" state used to swallow every later tap on the Detection mic.
      finishing && !cloudRecording && !userWantsListening && audioRecord == null -> {
        forceIdleAfterInsert()
        startListening()
      }
      finishing -> return
      cloudRecording || userWantsListening -> finishListening()
      else -> startListening()
    }
  }

  private fun clearFinishTimeout() {
    finishTimeout?.let { mainHandler.removeCallbacks(it) }
    finishTimeout = null
  }

  private fun heardText(): String = dictation.plain()

  private fun finishListening() {
    if (cloudRecording) {
      stopCloudRecording()
      return
    }
    if (finishing) return
    finishing = true
    StopTiming.start("device")
    userWantsListening = false
    setListeningState(false)
    setProcessingState(true)
    setCaption("Finishing")

    // If we already have live text, we can commit even if the OEM never sends a final.
    val already = heardText()

    val timeout = Runnable { completeAndroidFinish("timeout") }
    finishTimeout = timeout
    mainHandler.postDelayed(timeout, if (already.isNotEmpty()) 450 else 900)
  }

  private fun completeAndroidFinish(reason: String) {
    clearFinishTimeout()
    if (!finishing && reason != "results" && reason != "error") return
    finishing = false
    val text = heardText()
    finishedMarked = dictation.marked()
    finishedTail = dictation.partial
    dictation.clear()
    latestPartial = ""
    setProcessingState(false)
    playCue(false)
    if (text.isNotEmpty()) {
      handleRecognizedText(text)
    } else {
      setListeningState(false)
      micButton?.isEnabled = true
      micButton?.clearLiveTranscript()
      clearInline()
      setCaption("No speech detected")
    }
  }

  private fun startListening() {
    // Always clear a leftover finishing latch before a fresh Detection tap.
    if (finishing && !cloudRecording && audioRecord == null) {
      finishing = false
      setProcessingState(false)
    }
    val target = currentInputEditorInfo
    if (!VoiceInputTargetPolicy.allows(target)) {
      setCaption(VoiceInputTargetPolicy.denialReason(target))
      return
    }
    if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
      setCaption("Allow microphone access in Cursor Flow first")
      return
    }
    // Voice needs the Cursor Flow account. Signed out: one action, open the app to sign in or scan.
    if (runCatching { VoiceKeyboardSecureStore.get(this).isNullOrBlank() }.getOrDefault(true)) {
      setCaption("Sign in to start")
      openAppToSignIn()
      return
    }
    if (mode == CursorFlowKeyboardView.UiMode.EDIT) {
      val ic = currentInputConnection
      editSelection = ic?.getSelectedText(0)?.toString().orEmpty()
      editSource = editSelection.ifBlank {
        ic?.getExtractedText(ExtractedTextRequest(), 0)?.text?.toString().orEmpty().ifBlank {
          ic?.getTextBeforeCursor(20_000, 0)?.toString().orEmpty() + ic?.getTextAfterCursor(20_000, 0)?.toString().orEmpty()
        }
      }
      if (editSource.isBlank()) { setCaption("Type or select text first, then use Edit"); return }
    }
    mixedVoiceTyping = false
    lastCommittedText = ""
    lastCommittedAt = 0L
    liveEditSeq++
    dictation.clear()
    latestPartial = ""
    finishing = false
    committedForSession = false
    sessionClaimed = false
    micButton?.clearLiveTranscript()
    clearInline()
    playCue(true)
    // The keyboard always uses Cursor Flow cloud speech. Never launch a device engine.
    if (cloudReady()) startCloudRecording()
    else {
      // Signed in (checked above) but no voice address could be found or recovered.
      setCaption("Voice is not ready. Check your internet and try again")
      playCue(false)
    }
  }

  private fun modePrompt(): String = when (mode) {
    CursorFlowKeyboardView.UiMode.EDIT -> "Say how to change it"
    CursorFlowKeyboardView.UiMode.WRITE -> "Say what to write"
    CursorFlowKeyboardView.UiMode.TRANSLATE -> "Listening"
    else -> "Listening"
  }

  private fun startCloudRecording() {
    try {
      val minimumBuffer = AudioRecord.getMinBufferSize(16000, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
      // 4 s of headroom: the first words are never dropped while the stream is still connecting.
      val recorder = AudioRecord(MediaRecorder.AudioSource.MIC, 16000, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, max(minimumBuffer, 16000 * 2 * 4))
      if (recorder.state != AudioRecord.STATE_INITIALIZED) throw IllegalStateException("Android could not open the microphone")
      audioRecord = recorder
      cloudRecording = true
      userWantsListening = true
      committedForSession = false
      sessionClaimed = false
      captureSessionId = inputSessionId
      setListeningState(true, 0.25f)
      setCaption(modePrompt())
      micButton?.setLiveTranscript("Listening")
      recorder.startRecording()
      if (recorder.recordingState != AudioRecord.RECORDSTATE_RECORDING) throw IllegalStateException("Microphone is busy")
      lastVoiceAt = System.currentTimeMillis()
      val liveSession = inputSessionId
      val run = ++liveRun
      latestCloudTranscript = ""
      batchPending = false
      liveFailed = false
      liveChunkMode = false
      liveOpen = true
      recPieces.clear()
      recEditedText = null; recEditedUpTo = 0; recEditSeq++
      var sttRef: RealtimeStt? = null
      val live: RealtimeStt? = run {
        if (mode == CursorFlowKeyboardView.UiMode.DICTATE) beginInline()
        liveChunkMode = mode == CursorFlowKeyboardView.UiMode.DICTATE && inlineActive
        RealtimeStt(
          VoiceKeyboardSecureStore.getApiBaseUrl(this) ?: "",
          // The sign-in token is read inside connect(), off the main thread, so the mic starts at once.
          "",
          VoiceKeyboardSecureStore.getLanguage(this),
          VoiceKeyboardSecureStore.getVocabulary(this) + VoiceKeyboardSecureStore.getLearnedVocabulary(this),
          onText = { t ->
            // Snapshot on the socket callback, not later after another final/partial has arrived.
            val partialSnapshot = sttRef?.partialText().orEmpty()
            mainHandler.post {
              if (liveSession != inputSessionId || run != liveRun || !liveOpen) return@post
              latestCloudTranscript = t
              // Finalized pieces are already in the field; only the words in progress stay composing.
              if (mode != CursorFlowKeyboardView.UiMode.DICTATE) micButton?.setLiveTranscript(t)
              else if (liveChunkMode && inlineActive) partialSnapshot.takeIf { it.isNotBlank() }?.let { showLive(it) }
              else if (t.isNotBlank() && !mixedVoiceTyping) showLive(t)
            }
          },
          onFailed = { _ -> liveFailed = true },
          onCommitted = { seg ->
            mainHandler.post {
              if (liveSession != inputSessionId || run != liveRun || !liveOpen) return@post
              if (mode != CursorFlowKeyboardView.UiMode.DICTATE) return@post
              if (liveChunkMode && inlineActive) onLiveChunk(seg)
              // Recording mode (live typing off): clean each finished piece while still speaking.
              else onRecordingSegment(seg)
            }
          },
          tokenProvider = { KeyboardSession.freshAccessToken(this) ?: "" },
          voiceKeyboard = true,
        ).also { sttRef = it }
      }
      live?.let { stt -> Thread { runCatching { stt.connect() } }.also { it.isDaemon = true }.start() }
      audioThread = Thread {
        var store = ShortArray(16_000 * 30)
        var totalSamples = 0
        val pcm = ShortArray(1024)
        // Progressive pieces (only when the live stream is not hearing anything).
        var progressive = false
        var cutStart = 0
        var silentRun = 0
        var voicedSamples = 0
        val pieces = ArrayList<java.util.concurrent.Future<String>>()
        val pieceText = java.util.Collections.synchronizedMap(HashMap<Int, String>())
        val ctx = if (live != null) currentDictationContextSafe() else null
        fun submitPiece(from: Int, to: Int) {
          if (to - from < 16_000 / 3) return
          val part = store.copyOfRange(from, to)
          val index = pieces.size
          pieces.add(batchExecutor.submit<String> {
            val text = withAuthRetry { token -> CloudKeyboardTranscriber.transcribe(
              VoiceKeyboardSecureStore.getApiBaseUrl(this) ?: "", token, part,
              VoiceKeyboardSecureStore.getLanguage(this), VoiceKeyboardSecureStore.getCleanAndFormat(this),
              (VoiceKeyboardSecureStore.getVocabulary(this) + VoiceKeyboardSecureStore.getLearnedVocabulary(this)).distinct().take(32),
              ctx?.formatStyle?.takeIf { it.isNotBlank() } ?: VoiceKeyboardSecureStore.getFormatStyle(this).ifBlank { "natural" },
              ctx?.toJson(),
            ) }.trim()
            pieceText[index] = text
            val sofar = synchronized(pieceText) { pieceText.toSortedMap().values.joinToString(" ") }
            mainHandler.post { if (run == liveRun && !inlineActive && cloudRecording) micButton?.setLiveTranscript(sofar) }
            text
          })
        }
        while (cloudRecording) {
          val read = recorder.read(pcm, 0, pcm.size)
          if (read < 0) { cloudRecording = false; break }
          if (read > 0) {
            live?.let { stt -> if (!stt.failed && !progressive) runCatching { stt.sendPcm(pcm, read) } }
            if (totalSamples + read > store.size) store = store.copyOf(maxOf(store.size * 2, totalSamples + read))
            var sumSq = 0.0
            for (index in 0 until read) {
              val s = pcm[index]
              store[totalSamples + index] = s
              sumSq += (s * s).toDouble()
            }
            totalSamples += read
            // Soft safety only: ~3 hours at 16 kHz. User finish is the normal stop.
            if (totalSamples >= maxSessionSamples) cloudRecording = false
            val rms = sqrt(sumSq / read.coerceAtLeast(1)).toFloat() / 4000f
            if (rms > 0.02f) { lastVoiceAt = System.currentTimeMillis(); voicedSamples += read; silentRun = 0 }
            else {
              silentRun += read
              if (System.currentTimeMillis() - lastVoiceAt > LONG_SILENCE_MS) {
                // Pauses never end the session; only a very long silence does.
                cloudRecording = false
              }
            }
            if (live != null && !progressive && (live.failed || (mode == CursorFlowKeyboardView.UiMode.DICTATE && live.readyForMs() > 8_000 && voicedSamples > 16_000 * 8 && !live.heardAnything()))) {
              // The live engine is down or silent: switch to pieces now instead of one long upload after stop.
              progressive = true
              runCatching { live.cancel() }
            }
            if (progressive) {
              val len = totalSamples - cutStart
              if ((len >= 16_000 * 8 && silentRun >= 16_000 / 2) || len >= 16_000 * 25) {
                submitPiece(cutStart, totalSamples)
                cutStart = totalSamples
              }
            }
            mainHandler.post { micButton?.setMicLevel(rms.coerceIn(0f, 1f)) }
          }
        }
        stopRecorderOnly(recorder)
        cloudRecording = false
        userWantsListening = false
        if (captureSessionId != inputSessionId) {
          live?.cancel()
          pieces.forEach { it.cancel(true) }
          return@Thread
        }
        // The live stream is final for every language: pieces were typed and cleaned while
        // speaking, so stop only waits briefly for the last words. Pieces are the fallback
        // when the live stream failed or heard nothing; the full-audio pass is the last resort.
        if (live != null && !live.failed && !progressive) {
          // The words already heard are final enough: never fall back to a slow full
          // re-upload just because the last final did not arrive inside the short wait.
          val quietTail = System.currentTimeMillis() - lastVoiceAt >= QUIET_TAIL_MS
          StopTiming.path = if (quietTail) "live_quiet" else "live"
          StopTiming.step("recorder_stopped")
          val streamed = runCatching { live.finish(LIVE_FINISH_MS, if (quietTail) QUIET_TAIL_FINISH_MS else 0L) }.getOrNull().orEmpty().trim()
            .ifEmpty { runCatching { live.partialText() }.getOrNull().orEmpty().trim() }
          StopTiming.step("live_finished", streamed.length)
          if (streamed.isNotEmpty() && !live.failed && captureSessionId == inputSessionId) {
            mainHandler.post {
              if (run != liveRun || liveSession != inputSessionId || committedForSession) return@post
              setListeningState(false)
              setProcessingState(false)
              if (mode == CursorFlowKeyboardView.UiMode.DICTATE) finishLiveDictation(live, streamed, run)
              else {
                liveOpen = false
                playCue(false)
                handleRecognizedText(streamed)
              }
            }
            return@Thread
          }
        }
        // From here the words come from an upload, which can take longer than the finish gate.
        batchPending = voicedSamples > 0
        StopTiming.path = if (progressive) "pieces" else "batch"
        StopTiming.step("upload_fallback")
        if (progressive && mode == CursorFlowKeyboardView.UiMode.DICTATE) {
          submitPiece(cutStart, totalSamples)
          mainHandler.post {
            if (run != liveRun || liveSession != inputSessionId || committedForSession) return@post
            if (run == liveRun) liveOpen = false
            setListeningState(false)
            setProcessingState(true)
            setCaption("Transcribing audio")
          }
          // Earlier pieces were cleaned while speaking; only the last one is still in flight.
          val deadline = System.currentTimeMillis() + 2_500
          val joined = runCatching { pieces.map { it.get((deadline - System.currentTimeMillis()).coerceAtLeast(300), java.util.concurrent.TimeUnit.MILLISECONDS) }.filter { it.isNotBlank() }.joinToString(" ").trim() }.getOrNull()
          if (!joined.isNullOrBlank() && captureSessionId == inputSessionId) {
            mainHandler.post {
              if (run != liveRun || liveSession != inputSessionId || committedForSession) return@post
              playCue(false)
              setProcessingState(false)
              commitOnce(joined, "Inserted")
            }
            return@Thread
          }
          // A piece failed: fall through to the full-audio pass (it saves offline when needed).
        }
        val segments = listOf(store.copyOf(totalSamples))
        mainHandler.post { if (run == liveRun) liveOpen = false }
        live?.cancel()
        val all = merge(segments)
        if (all.isEmpty()) {
          mainHandler.post {
            if (run != liveRun || liveSession != inputSessionId || committedForSession) return@post
            setListeningState(false)
            setProcessingState(false)
            setCaption("No speech detected")
            playCue(false)
          }
          return@Thread
        }
        mainHandler.post {
          if (run != liveRun || liveSession != inputSessionId || committedForSession) return@post
          setListeningState(false)
          setProcessingState(true)
          setCaption("Transcribing audio")
        }
        inferenceExecutor.execute {
          try {
            processCloudPcm(all, run, liveSession)
          } catch (error: Throwable) {
            mainHandler.post {
              if (run != liveRun || liveSession != inputSessionId || committedForSession) return@post
              setProcessingState(false)
              setCaption("Please say that again")
              playCue(false)
              micButton?.isEnabled = true
              setCaption(friendlyCloudError(error))
            }
          }
        }
      }.also { it.start() }
    } catch (error: Throwable) {
      cloudRecording = false
      userWantsListening = false
      audioRecord?.let { stopRecorderOnly(it) }
      setListeningState(false)
      playCue(false)
      setCaption("Microphone could not start. Check microphone access and try again.")
    }
  }

  private fun processCloudPcm(all: ShortArray, run: Int, session: Long) {
    if (run != liveRun || session != inputSessionId || committedForSession || sessionClaimed) return
    when (mode) {
      CursorFlowKeyboardView.UiMode.EDIT -> runVoiceEditFromPcm(all)
      CursorFlowKeyboardView.UiMode.WRITE -> runHelpMeWriteFromPcm(all)
      CursorFlowKeyboardView.UiMode.TRANSLATE -> {
        sessionClaimed = true
        runTranslateFromPcm(all)
      }
      CursorFlowKeyboardView.UiMode.DICTATE -> {
        val ctx = currentDictationContext()
        try {
          // Long dictation: send at most 60 s per request so nothing is cut off or times out.
          val chunk = 16_000 * 60
          val pieces = if (all.size <= chunk + 16_000 * 5) listOf(all) else (all.indices step chunk).map { all.copyOfRange(it, minOf(all.size, it + chunk)) }
          val text = pieces.joinToString(" ") { part -> withAuthRetry { token -> CloudKeyboardTranscriber.transcribe(
            VoiceKeyboardSecureStore.getApiBaseUrl(this) ?: "",
            token,
            part,
            VoiceKeyboardSecureStore.getLanguage(this),
            VoiceKeyboardSecureStore.getCleanAndFormat(this),
            (VoiceKeyboardSecureStore.getVocabulary(this) + VoiceKeyboardSecureStore.getLearnedVocabulary(this)).distinct().take(32),
            ctx.formatStyle.ifBlank { VoiceKeyboardSecureStore.getFormatStyle(this).ifBlank { "natural" } },
            ctx.toJson(),
          ) }.trim() }.trim()
          mainHandler.post {
            if (run != liveRun || session != inputSessionId || committedForSession) {
              // Recovery belongs in History, never at a later cursor or in a new recording.
              if (text.isNotBlank()) runCatching { DictationHistoryStore.append(this, text, ctx.packageName, VoiceKeyboardSecureStore.getLanguage(this), "keyboard", "saved") }
              return@post
            }
            playCue(false)
            setProcessingState(false)
            commitOnce(text, "Inserted")
          }
        } catch (error: Throwable) {
          OfflineDictationQueue.enqueue(this, all, VoiceKeyboardSecureStore.getLanguage(this), ctx.packageName)
          mainHandler.post {
            if (run != liveRun || session != inputSessionId || committedForSession) return@post
            playCue(false)
            setProcessingState(false)
            // A refused upload (no active plan, minutes used up) is not an offline problem: say why.
            val refused = error.message.orEmpty().contains("(429)")
            setCaption(if (refused) friendlyCloudError(error) else "Saved offline. Recover it from History when connected.")
            setListeningState(false)
            micButton?.isEnabled = true
            drainOfflineQueueSoon()
          }
        }
      }
    }
  }

  private fun runHelpMeWriteFromPcm(pcm: ShortArray) {
    try {
      val instruction = CloudKeyboardTranscriber.transcribe(
        VoiceKeyboardSecureStore.getApiBaseUrl(this) ?: "",
        KeyboardSession.freshAccessToken(this) ?: "",
        pcm,
        VoiceKeyboardSecureStore.getLanguage(this),
        false,
        emptyList(),
        "natural",
      )
      if (instruction.isBlank()) throw IllegalStateException("No writing prompt heard")
      val written = CloudKeyboardTranscriber.generate(
        VoiceKeyboardSecureStore.getApiBaseUrl(this) ?: "",
        KeyboardSession.freshAccessToken(this) ?: "",
        instruction,
      )
      mainHandler.post {
        playCue(false)
        setProcessingState(false)
        commitOnce(written, "Written")
      }
    } catch (error: Throwable) {
      mainHandler.post {
        playCue(false)
        setProcessingState(false)
        setListeningState(false)
        micButton?.isEnabled = true
        setCaption(friendlyCloudError(error))
      }
    }
  }

  private fun runTranslateFromPcm(pcm: ShortArray) {
    try {
      val spoken = latestCloudTranscript.trim().ifBlank {
        CloudKeyboardTranscriber.transcribe(
          VoiceKeyboardSecureStore.getApiBaseUrl(this) ?: "",
          KeyboardSession.freshAccessToken(this) ?: "",
          pcm,
          VoiceKeyboardSecureStore.getLanguage(this),
          false,
          emptyList(),
          "natural",
        )
      }
      if (spoken.isBlank()) throw IllegalStateException("No speech to translate")
      val translated = CloudKeyboardTranscriber.translate(
        VoiceKeyboardSecureStore.getApiBaseUrl(this) ?: "",
        KeyboardSession.freshAccessToken(this) ?: "",
        spoken,
        translateTarget,
      )
      mainHandler.post {
        playCue(false)
        setProcessingState(false)
        commitOnce(translated, "Translated")
      }
    } catch (error: Throwable) {
      mainHandler.post {
        playCue(false)
        setProcessingState(false)
        setListeningState(false)
        micButton?.isEnabled = true
        setCaption(friendlyCloudError(error))
        endOneShot()
      }
    }
  }

  private fun runVoiceEditFromPcm(pcm: ShortArray) {
    val selected = editSelection
    val source = editSource
    if (source.isBlank()) {
      mainHandler.post {
        playCue(false)
        setProcessingState(false)
        setListeningState(false)
        setCaption("Type or select text first, then use Edit")
      }
      return
    }
    try {
      val instruction = CloudKeyboardTranscriber.transcribe(
        VoiceKeyboardSecureStore.getApiBaseUrl(this) ?: "",
        KeyboardSession.freshAccessToken(this) ?: "",
        pcm,
        VoiceKeyboardSecureStore.getLanguage(this),
        false,
        emptyList(),
        "natural",
      )
      if (instruction.isBlank()) throw IllegalStateException("No edit instruction heard")
      applyRewrite(source, selected, instruction)
    } catch (error: Throwable) {
      mainHandler.post {
        playCue(false)
        setProcessingState(false)
        setListeningState(false)
        micButton?.isEnabled = true
        setCaption(friendlyCloudError(error))
      }
    }
  }

  private fun applyRewrite(source: String, selected: String, instruction: String) {
    try {
      // Refresh an expired sign-in once instead of failing the edit.
      val rewritten = withAuthRetry { token -> CloudKeyboardTranscriber.rewrite(
        VoiceKeyboardSecureStore.getApiBaseUrl(this) ?: "",
        token,
        source,
        instruction,
      ) }
      mainHandler.post {
        playCue(false)
        setProcessingState(false)
        if (captureSessionId != inputSessionId) {
          setCaption("Field changed; edit cancelled")
        } else if (rewritten.isNotBlank()) {
          val ic = currentInputConnection
          val ok = if (selected.isNotBlank()) {
            ic?.commitText(rewritten, 1) == true
          } else {
            // Replace the whole field. Many editors reject a huge delete range, so
            // select all first and fall back to the real lengths around the cursor.
            runCatching {
              ic?.beginBatchEdit()
              val selectedAll = ic?.performContextMenuAction(android.R.id.selectAll) == true &&
                !ic?.getSelectedText(0).isNullOrEmpty()
              if (!selectedAll) {
                ic?.finishComposingText()
                val before = ic?.getTextBeforeCursor(20_000, 0)?.length ?: 0
                val after = ic?.getTextAfterCursor(20_000, 0)?.length ?: 0
                ic?.deleteSurroundingText(before, after)
              }
              val done = ic?.commitText(rewritten, 1) == true
              ic?.endBatchEdit()
              done
            }.getOrDefault(false)
          }
          if (ok) { lastCommittedText = rewritten; lastCommittedAt = System.currentTimeMillis() }
          setCaption(if (ok) "Edited" else "This field did not accept the edit")
        } else {
          setCaption("Edit returned empty text")
        }
        setListeningState(false)
        micButton?.isEnabled = true
        endOneShot()
      }
    } catch (error: Throwable) {
      mainHandler.post {
        playCue(false)
        setProcessingState(false)
        setListeningState(false)
        micButton?.isEnabled = true
        setCaption(friendlyCloudError(error))
        endOneShot()
      }
    }
  }

  private fun friendlyCloudError(error: Throwable): String {
    val msg = error.message.orEmpty()
    return when {
      // Bangla and other upload-based speech stop here when the signed-in account has no plan.
      msg.contains("subscription_inactive") -> "This account has no active Cursor Flow plan. Open Cursor Flow and check your account."
      msg.contains("monthly_minutes_exceeded") -> "This month's voice minutes are used up. Open Cursor Flow to see your plan."
      msg.contains("rate_limited") -> "Too many requests right now. Wait a moment and try again."
      msg.contains("(401)") -> "Sign in to Cursor Flow again to use voice."
      msg.contains("Cloud transcription failed") -> "Voice could not finish. Check your internet and try again."
      msg.contains("credit", true) || msg.contains("402") || msg.contains("quota", true) ->
        "Flow AI needs cloud credit. Raw dictation still works."
      else -> msg.ifBlank { "Flow AI could not finish. Try again." }
    }
  }

  private fun networkOnline(): Boolean = runCatching {
    val cm = getSystemService(android.net.ConnectivityManager::class.java)
    val caps = cm?.getNetworkCapabilities(cm.activeNetwork)
    caps?.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_INTERNET) == true
  }.getOrDefault(false)

  /** Runs a cloud call; on an expired sign-in, silently refreshes once and retries. */
  private fun <T> withAuthRetry(block: (String) -> T): T {
    return try {
      block(KeyboardSession.freshAccessToken(this) ?: "")
    } catch (error: Throwable) {
      if (error.message?.contains("(401)") != true) throw error
      block(KeyboardSession.freshAccessToken(this, force = true) ?: "")
    }
  }

  private fun cloudReady(): Boolean {
    val signedIn = runCatching { !VoiceKeyboardSecureStore.get(this).isNullOrBlank() }.getOrDefault(false)
    return signedIn && !VoiceKeyboardSecureStore.getApiBaseUrl(this).isNullOrBlank()
  }

  private fun handleRecognizedText(text: String) {
    val trimmed = text.trim()
    if (trimmed.isEmpty()) {
      setCaption("No speech detected")
      setListeningState(false)
      micButton?.isEnabled = true
      return
    }
    if (VoiceKeyboardSecureStore.getLanguage(this) == "Auto-detect" && mode != CursorFlowKeyboardView.UiMode.EDIT) {
      val fallback = VoiceKeyboardSecureStore.getLastDetected(this) ?: Locale.getDefault().language
      noteDetectedLanguage(FlowLanguages.detectFromText(trimmed, fallback))
    }
    if (mode == CursorFlowKeyboardView.UiMode.DICTATE) {
      val (rest, cmd) = parseSpokenCommands(trimmed)
      if (rest.isBlank() && cmd != SpokenCommand.NONE) {
        clearInline()
        forceIdleAfterInsert()
        when (cmd) {
          SpokenCommand.SCRATCH -> undoLastInsert()
          SpokenCommand.DELETE_WORD -> { deleteLastWord(); setCaption("Deleted last word") }
          SpokenCommand.SEND -> { sendEditorEnter(); setCaption("Sent") }
          else -> Unit
        }
        return
      }
      pendingSend = cmd == SpokenCommand.SEND
      handleDictation(rest)
      return
    }
    handleDictation(trimmed)
  }

  private fun handleDictation(trimmed: String) {
    when (mode) {
      CursorFlowKeyboardView.UiMode.EDIT -> {
        if (!cloudReady()) {
          setCaption("Voice edit needs Flow AI cloud. Heard: ${trimmed.take(40)}")
          setListeningState(false)
          micButton?.isEnabled = true
          endOneShot()
          return
        }
        setProcessingState(true)
        setCaption("Flow AI is editing")
        val selected = editSelection
        val source = editSource
        if (source.isBlank()) {
          setProcessingState(false)
          setCaption("Type or select text first, then use Edit")
          micButton?.isEnabled = true
          endOneShot()
          return
        }
        inferenceExecutor.execute { applyRewrite(source, selected, trimmed) }
      }
      CursorFlowKeyboardView.UiMode.WRITE -> {
        if (!cloudReady()) {
          // Still insert the prompt so the user is not stuck.
          commitOnce(trimmed, "Inserted (Flow AI offline)")
          return
        }
        setProcessingState(true)
        setCaption("Flow AI is writing")
        inferenceExecutor.execute {
          try {
            val written = CloudKeyboardTranscriber.generate(
              VoiceKeyboardSecureStore.getApiBaseUrl(this) ?: "",
              KeyboardSession.freshAccessToken(this) ?: "",
              trimmed,
            )
            mainHandler.post {
              setProcessingState(false)
              commitOnce(written, "Written")
            }
          } catch (error: Throwable) {
            mainHandler.post {
              setProcessingState(false)
              commitOnce(trimmed, friendlyCloudError(error))
            }
          }
        }
      }
      CursorFlowKeyboardView.UiMode.TRANSLATE -> {
        if (committedForSession || sessionClaimed) return
        if (!cloudReady()) {
          setCaption("Translation needs sign-in and an internet connection")
          setListeningState(false)
          setProcessingState(false)
          micButton?.isEnabled = true
          endOneShot()
          return
        }
        sessionClaimed = true
        setProcessingState(true)
        setCaption("Flow AI is translating")
        inferenceExecutor.execute {
          try {
            val translated = CloudKeyboardTranscriber.translate(
              VoiceKeyboardSecureStore.getApiBaseUrl(this) ?: "",
              KeyboardSession.freshAccessToken(this) ?: "",
              trimmed,
              translateTarget,
            )
            mainHandler.post {
              setProcessingState(false)
              commitOnce(translated, "Translated")
            }
          } catch (error: Throwable) {
            mainHandler.post {
              setProcessingState(false)
              setListeningState(false)
              micButton?.isEnabled = true
              setCaption(friendlyCloudError(error))
              endOneShot()
            }
          }
        }
      }
      else -> {
        // Dictate: context-aware Flow AI polish when clean-and-format is on.
        val ctx = currentDictationContext()
        if (ctx.disableVoice) {
          setCaption("Voice input is disabled for password fields")
          clearInline()
          setListeningState(false)
          setProcessingState(false)
          micButton?.isEnabled = true
          return
        }
        // Step 1: instant rule pass, committed right away. Step 2: Flow AI (cloud,
        // else offline) silently swaps in the polished text if it lands in time.
        val vocab = (VoiceKeyboardSecureStore.getVocabulary(this) + VoiceKeyboardSecureStore.getLearnedVocabulary(this)).distinct().take(32)
        val ruleOptions = InputContextResolver.ruleOptions(ctx)
        // Use the pause-marked segments when they are the same words: pauses become sentence breaks.
        val marked = finishedMarked.takeIf { it.replace(FlowRulePass.PAUSE.toString(), " ").replace(Regex("\\s+"), " ").trim() == trimmed.replace(Regex("\\s+"), " ") } ?: trimmed
        finishedMarked = ""
        val polishedMode = VoiceKeyboardSecureStore.getCleanAndFormat(this)
        val ruled = Snippets.apply(this, if (polishedMode) LiveEdit.applyAll(FlowRulePass.apply(marked, vocab, ruleOptions).ifBlank { trimmed }) else FlowRulePass.verbatim(trimmed, vocab))
        val willAutoSend = pendingSend
        // Cloud live session: earlier pieces were cleaned while speaking, only the last piece is left.
        val chunkedFinish = liveFinishChunked && (ctx.category == "unknown" || ctx.category == "social")
        val tail = liveFinishTail.trim()
        commitOnce(ruled, "Inserted")
        if (mixedVoiceTyping) return
        val source = if (!chunkedFinish) ruled else tail.takeIf { ruled.endsWith(it) && chunkWantsCloud(ctx, it) }.orEmpty()
        val useCloud = cloudReady() && VoiceKeyboardSecureStore.getCleanAndFormat(this)
        val localStatus = runCatching { FlowLlm.status(this)["state"]?.toString() ?: "unknown" }.getOrDefault("unknown")
        val useLocal = VoiceKeyboardSecureStore.getCleanAndFormat(this) && VoiceKeyboardSecureStore.getOfflineFlowAi(this) && !FlowRulePass.isMostlyBangla(ruled) && ruled.length <= 1_800
        recordCleanupPath("basic", when {
          FlowRulePass.isMostlyBangla(ruled) && !useCloud -> "Bangla uses cloud only"
          !useCloud && !useLocal -> if (!VoiceKeyboardSecureStore.getOfflineFlowAi(this)) "offline off, cloud unavailable" else "cloud unavailable"
          else -> "waiting for Flow AI"
        })
        if (!willAutoSend && source.isNotEmpty() && lastCommittedText.endsWith(ruled) && (useCloud || useLocal)) {
          val formatStyle = ctx.formatStyle.ifBlank { VoiceKeyboardSecureStore.getFormatStyle(this).ifBlank { "natural" } }
          val contextJson = ctx.toJson()
          val session = inputSessionId
          val committedAt = lastCommittedAt
          val committedOut = lastCommittedText
          if (useLocal) FlowLlm.prewarm(this)
          polishExecutor.execute {
            val began = System.currentTimeMillis()
            var polished: String? = null
            if (useCloud) {
              polished = FlowCleanupGuard.accept(source, CloudKeyboardTranscriber.polishTextOrNull(
                VoiceKeyboardSecureStore.getApiBaseUrl(this) ?: "",
                KeyboardSession.freshAccessToken(this) ?: "",
                source, vocab, formatStyle, contextJson, 1_200, liveChunk = chunkedFinish,
              ))
            }
            var path = "basic"
            var why = if (useCloud) "cloud did not answer" else "cloud unavailable"
            if (polished != null) path = "cloud"
            if (polished == null && useLocal && System.currentTimeMillis() - began < 1_200) {
              val budget = (1_200 - (System.currentTimeMillis() - began)).coerceAtLeast(0)
              polished = FlowCleanupGuard.accept(source, runCatching { FlowLlm.clean(this, source, budget) }.getOrNull())
              if (polished != null) path = "offline" else why = "$why, offline model $localStatus"
            }
            recordCleanupPath(path, if (path == "basic") why else "")
            val finalText = polished?.let { if (chunkedFinish) FlowRulePass.liveSegment(it, vocab) else if (it.contains('\n')) it else FlowRulePass.apply(it, vocab, ruleOptions) }
            if (finalText != null && finalText != source && System.currentTimeMillis() - began <= 1_200) {
              mainHandler.post { replaceCommittedSilently(committedOut, source, finalText, session, committedAt) }
            }
          }
        }
      }
    }
  }

  private fun recordCleanupPath(path: String, reason: String) {
    lastCleanupPath = path
    runCatching { VoiceKeyboardSecureStore.putLastCleanup(this, path, reason) }
  }

  /** Swap the just-inserted rule-pass text for the Flow AI version, only if untouched. */
  private fun replaceCommittedSilently(committedOut: String, ruled: String, polished: String, session: Long, committedAt: Long) {
    if (inputSessionId != session || lastCommittedText != committedOut || lastCommittedAt != committedAt) return
    if (System.currentTimeMillis() - committedAt > 1_200) return
    val ic = currentInputConnection ?: return
    val before = runCatching { ic.getTextBeforeCursor(committedOut.length + 4, 0)?.toString() }.getOrNull() ?: return
    if (!before.endsWith(committedOut)) return
    val prefix = committedOut.removeSuffix(ruled)
    val replacement = prefix + polished
    val ok = runCatching {
      ic.beginBatchEdit()
      try {
        DictationSpan.replace(before, committedOut, replacement, System.currentTimeMillis() - committedAt, inputSessionId == session,
          delete = { ic.deleteSurroundingText(it, 0) }, commit = { ic.commitText(it, 1) })
      } finally { ic.endBatchEdit() }
    }.getOrDefault(false)
    if (ok) {
      lastCommittedText = replacement
      lastCommittedAt = System.currentTimeMillis()
      showUndoChip(polished)
    }
  }

  private fun merge(segments: List<ShortArray>): ShortArray {
    if (segments.isEmpty()) return ShortArray(0)
    if (segments.size == 1) return segments[0]
    val total = segments.sumOf { it.size }
    val out = ShortArray(total)
    var at = 0
    for (s in segments) {
      System.arraycopy(s, 0, out, at, s.size)
      at += s.size
    }
    return out
  }

  @Volatile private var batchPending = false
  @Volatile private var liveFailed = false

  private fun stopCloudRecording() {
    StopTiming.start("cloud")
    cloudRecording = false
    userWantsListening = false
    if (mode == CursorFlowKeyboardView.UiMode.DICTATE || mode == CursorFlowKeyboardView.UiMode.TRANSLATE) {
      finishing = true
      val run = liveRun
      val session = inputSessionId
      clearFinishTimeout()
      val timeout = Runnable {
        if (run != liveRun || session != inputSessionId || committedForSession || sessionClaimed || !finishing) return@Runnable
        StopTiming.path = "finish_limit"
        // Use words already heard. Never append a late batch transcript to the next utterance.
        val heard = (liveCommitted + liveComposing).trim().ifBlank { latestCloudTranscript.trim() }
        liveOpen = false
        if (heard.isNotBlank()) handleRecognizedText(heard)
        else if (batchPending) {
          // The audio is still being transcribed; let that upload insert it (or explain its failure).
          finishing = false
          setCaption("Transcribing audio")
        }
        else {
          committedForSession = true
          forceIdleAfterInsert()
          setCaption(if (liveFailed) "Could not reach voice service. Check your internet and try again." else "No speech heard. Tap and speak again.")
        }
      }
      finishTimeout = timeout
      mainHandler.postDelayed(timeout, KEYBOARD_FINISH_LIMIT_MS)
    }
    audioRecord?.let { stopRecorderOnly(it) }
    setListeningState(false)
    setProcessingState(true)
    setCaption("Finishing")
  }

  private fun stopRecorderOnly(recorder: AudioRecord) {
    runCatching { recorder.stop() }
    runCatching { recorder.release() }
    if (audioRecord === recorder) audioRecord = null
  }

  private fun copyFallback(text: String) {
    val ok = runCatching {
      val cm = getSystemService(android.content.Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
      cm.setPrimaryClip(android.content.ClipData.newPlainText("Dictation", text))
      true
    }.getOrDefault(false)
    setCaption(if (ok) "Copied, paste it" else "Could not type here")
    if (ok) runCatching { DictationHistoryStore.append(this, text, currentInputEditorInfo?.packageName ?: "", VoiceKeyboardSecureStore.getLanguage(this), "keyboard", "copied") }
  }

  private fun commitOnce(rawText: String, successMessage: String) {
    if (mixedVoiceTyping) {
      // Live pieces and manual edits already landed. Never replace them with a full transcript.
      currentInputConnection?.finishComposingText()
      inlineActive = false
      committedForSession = true
      runCatching { DictationHistoryStore.append(this, rawText, currentInputEditorInfo?.packageName ?: "", VoiceKeyboardSecureStore.getLanguage(this), "keyboard", "saved") }
      forceIdleAfterInsert()
      setCaption("Words kept. Copy available in History.")
      return
    }
    val text = Snippets.apply(this, if (mode != CursorFlowKeyboardView.UiMode.DICTATE || VoiceKeyboardSecureStore.getCleanAndFormat(this)) LiveEdit.applyAll(rawText) else rawText).ifBlank { if (liveEdited) "" else rawText }
    liveEdited = false
    liveEditSeq++
    learnFromCorrectionIfAny()
    val ctx = currentDictationContext()
    if (ctx.disableVoice) {
      setCaption(VoiceInputTargetPolicy.denialReason(currentInputEditorInfo))
      forceIdleAfterInsert()
      return
    }
    val allowed = VoiceInputTargetPolicy.allows(currentInputEditorInfo)
    if (!SpeechFinishResolver.canCommit(text, captureSessionId == inputSessionId, committedForSession, allowed)) {
      when {
        text.isBlank() -> setCaption("No speech detected")
        captureSessionId != inputSessionId || !allowed -> setCaption("The focused field changed; nothing was inserted")
        committedForSession -> setCaption(successMessage)
        else -> setCaption("No speech detected")
      }
    } else {
      committedForSession = true
      val ic = currentInputConnection
      if (ic == null) {
        copyFallback(text.trim())
      } else {
        val wasInline = inlineActive
        val owned = liveCommitted + liveComposing
        var out = if (wasInline || owned.isNotEmpty()) sessionPrefix + text.trim() else text
        val ok = runCatching {
          ic.beginBatchEdit()
          try {
            if (liveOwnershipLost) return@runCatching false
            if (owned.isNotEmpty()) {
              val before = ic.getTextBeforeCursor(owned.length + 4, 0)?.toString().orEmpty()
              // The live preview is real committed text, not a fragile composing region.
              // Editors may end composition themselves; always replace our exact suffix.
              DictationSpan.replace(before, owned, out, 0, captureSessionId == inputSessionId,
                delete = { ic.deleteSurroundingText(it, 0) }, commit = { ic.commitText(it, 1) })
            } else if (liveWriteAttempted) {
              false // An editor may have inserted despite returning false. Never retry blind.
            } else {
              liveWriteAttempted = true
              ic.commitText(out, 1)
            }
          } finally { ic.endBatchEdit() }
        }.getOrDefault(false)
        liveCommitted = ""
        liveComposing = ""
        inlineActive = false
        inlinePrefix = ""
        micButton?.inlineMode = false
        StopTiming.end(if (ok) "text_inserted" else "insert_failed")
        if (ok) {
          lastCommittedText = out
          lastCommittedAt = System.currentTimeMillis()
          setCaption(if (successMessage == "Inserted") "✓ Typed" else successMessage)
          runCatching { DictationHistoryStore.append(this, text.trim(), currentInputEditorInfo?.packageName ?: "", VoiceKeyboardSecureStore.getLanguage(this), "keyboard", "inserted") }
          showUndoChip(text)
          if (pendingSend) { pendingSend = false; sendEditorEnter(); setCaption("Sent") }
        } else {
          copyFallback(text.trim())
        }
      }
    }
    forceIdleAfterInsert()
  }

  private fun showUndoChip(text: String) {
    justInserted = true
    refreshActionKey()
    undoExpire?.let { mainHandler.removeCallbacks(it) }
    micButton?.showUndoChip(true)
    val expire = Runnable { micButton?.showUndoChip(false) }
    undoExpire = expire
    mainHandler.postDelayed(expire, 2000L)
  }

  private fun undoLastInsert() {
    val text = lastCommittedText
    if (text.isBlank()) {
      micButton?.showUndoChip(false)
      return
    }
    val ic = currentInputConnection
    val deleted = runCatching {
      ic?.deleteSurroundingText(text.length, 0)
      true
    }.getOrDefault(false)
    undoExpire?.let { mainHandler.removeCallbacks(it) }
    micButton?.showUndoChip(false)
    if (deleted) {
      setCaption("Undone")
      lastCommittedText = ""
    } else {
      setCaption("Could not undo")
    }
  }


  private fun inlineAllowed(): Boolean {
    if (!VoiceKeyboardSecureStore.getLiveTyping(this)) return false
    if (mode != CursorFlowKeyboardView.UiMode.DICTATE) return false
    val info = currentInputEditorInfo ?: return false
    val type = info.inputType
    if (type == android.text.InputType.TYPE_NULL) return false
    val cls = type and android.text.InputType.TYPE_MASK_CLASS
    val variation = type and android.text.InputType.TYPE_MASK_VARIATION
    if (cls == android.text.InputType.TYPE_CLASS_TEXT && (
        variation == android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD ||
        variation == android.text.InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD ||
        variation == android.text.InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD)) return false
    if (cls == android.text.InputType.TYPE_CLASS_NUMBER &&
        variation == android.text.InputType.TYPE_NUMBER_VARIATION_PASSWORD) return false
    if (!VoiceInputTargetPolicy.allows(info)) return false
    return currentInputConnection != null
  }

  private fun beginInline() {
    inlineActive = inlineAllowed()
    liveOwnershipLost = false
    liveWriteAttempted = false
    inlinePrefix = ""
    liveCommitted = ""
    sessionPrefix = ""
    if (inlineActive) {
      val before = runCatching { currentInputConnection?.getTextBeforeCursor(1, 0)?.toString() }.getOrNull().orEmpty()
      val selected = currentInputConnection?.getSelectedText(0)
      inlinePrefix = if (selected.isNullOrEmpty() && before.isNotEmpty() && !before.last().isWhitespace()) " " else ""
    }
    sessionPrefix = inlinePrefix
    micButton?.inlineMode = inlineActive
  }

  /** Show live words: composing text in the field, or the card as fallback. */
  private fun showLive(text: String) {
    val t = Snippets.apply(this, if (VoiceKeyboardSecureStore.getCleanAndFormat(this)) FlowRulePass.dropPauseCommas(text.trim()) else FlowRulePass.verbatim(text))
    if (inlineActive && t.isNotEmpty() && !liveOwnershipLost) {
      val out = inlinePrefix + t
      if (writeLivePreview(out)) return
    }
    micButton?.setLiveTranscript(t)
  }

  /** Never trust composing state: some editors silently commit it before final results arrive. */
  private fun writeLivePreview(out: String): Boolean {
    if (liveOwnershipLost || captureSessionId != inputSessionId) return false
    val ic = currentInputConnection ?: return false
    val owned = liveComposing
    val ok = runCatching {
      ic.beginBatchEdit()
      try {
        if (owned.isNotEmpty()) {
          val before = ic.getTextBeforeCursor(owned.length + 4, 0)?.toString().orEmpty()
          DictationSpan.replace(before, owned, out, 0, true,
            delete = { ic.deleteSurroundingText(it, 0) }, commit = { ic.commitText(it, 1) })
        } else {
          // Verify the earlier finalized pieces are still immediately before the cursor.
          if (liveCommitted.isNotEmpty() && ic.getTextBeforeCursor(liveCommitted.length + 4, 0)?.toString()?.endsWith(liveCommitted) != true) return@runCatching false
          liveWriteAttempted = true
          ic.commitText(out, 1)
        }
      } finally { ic.endBatchEdit() }
    }.getOrDefault(false)
    if (ok) liveComposing = out else liveOwnershipLost = true
    return ok
  }

  /** Keep already visible words on field change/hide. A late final cannot acquire them again. */
  private fun keepInline() {
    liveOwnershipLost = liveWriteAttempted
    liveComposing = ""
    liveChunkMode = false
    inlineActive = false
    inlinePrefix = ""
    micButton?.inlineMode = false
  }

  private fun clearInline() {
    if (!liveOwnershipLost && liveComposing.isNotEmpty() && captureSessionId == inputSessionId) {
      val owned = liveComposing
      runCatching {
        val ic = currentInputConnection ?: return@runCatching
        if (ic.getTextBeforeCursor(owned.length + 4, 0)?.toString()?.endsWith(owned) == true) ic.deleteSurroundingText(owned.length, 0)
      }
    }
    liveComposing = ""
    liveChunkMode = false
    inlineActive = false
    inlinePrefix = ""
    micButton?.inlineMode = false
  }

  private fun openAppToSignIn() {
    runCatching {
      val intent = packageManager.getLaunchIntentForPackage(packageName) ?: return
      intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
      intent.putExtra("cursorflow.signin", true)
      startActivity(intent)
    }
  }

  private fun setCaption(value: String) {
    micButton?.setStatus(value)
    // Text keyboard Detection mic must show the same status, or failures look like "mic does nothing".
    typingPanel?.showStatus(value)
  }

  private fun appendFinal(chunk: String) {
    val added = dictation.addFinal(chunk)
    if (inlineActive) { if (added != null) commitLiveSegment(added) }
    else showLive(dictation.plain())
  }

  /** Keep the live partial before a SpeechRecognizer restart so nothing is lost. */
  private fun flushPartialBeforeRestart() {
    val kept = dictation.flushPartial() ?: return
    if (inlineActive) commitLiveSegment(kept) else showLive(dictation.plain())
  }

  /**
   * Live edit: each finalized segment is cleaned by the rule pass and written into
   * the field for good, so a 20 minute dictation never sits in one fragile
   * composing region. The final pass later replaces this range once.
   */
  private fun commitLiveSegment(segment: String): String? {
    if (mode != CursorFlowKeyboardView.UiMode.DICTATE || captureSessionId != inputSessionId) return null
    val ic = currentInputConnection ?: return null
    val vocab = VoiceKeyboardSecureStore.getVocabulary(this).take(32)
    val polishedMode = VoiceKeyboardSecureStore.getCleanAndFormat(this)
    val live = Snippets.apply(this, if (polishedMode) FlowRulePass.liveSegment(segment, vocab).ifBlank { segment.trim() } else FlowRulePass.verbatim(segment, vocab))
    if (live.isEmpty()) return null
    if (liveCommitted.isEmpty()) sessionPrefix = inlinePrefix
    // Real-time editing: a spoken command ("delete the last sentence", "এই শব্দটা ভুল হয়েছে, মুছে দাও")
    // rewrites only the text this session typed.
    val previous = liveCommitted.trim()
    val edit = if (polishedMode) runCatching { LiveEdit.fast(previous, live) }.getOrNull() else null
    if (edit != null && edit.edited) {
      if (replaceLiveSpan(edit.text)) setCaption(if (edit.removed.isEmpty()) "Edited" else "Removed: " + edit.removed.joinToString(" ").take(40))
      return null
    }
    // A spoken mark ("comma", "full stop") attaches to the word before; a new line takes no space.
    val out = FlowRulePass.attach(inlinePrefix, live)
    val ok = writeLivePreview(out)
    if (ok) liveComposing = ""
    if (ok) {
      liveCommitted += out
      inlinePrefix = FlowRulePass.nextPrefix(live)
      if (edit != null && edit.needsLlm) requestLiveEdit(previous, live)
      return live
    }
    return null
  }

  /** A finalized live piece: type it for good now, then clean it in the background. */
  /** Context read on the audio thread; never throws. */
  private fun currentDictationContextSafe(): InputContextResolver.DictationContext? = runCatching { currentDictationContext() }.getOrNull()

  /** Recording mode: keep each finished piece and clean it in the background while the user keeps talking. */
  private fun onRecordingSegment(segment: String) {
    val raw = segment.trim()
    if (raw.isEmpty()) return
    val piece = RecPiece(raw)
    // Real-time edit while speaking ("delete the last sentence", "X না, Y"): apply it to
    // the words so far right away, even though live text is not shown on screen.
    val previous = recTextSoFar()
    val edit = if (VoiceKeyboardSecureStore.getCleanAndFormat(this)) runCatching { LiveEdit.fast(previous, raw) }.getOrNull() else null
    recPieces.add(piece)
    if (edit != null && (edit.edited || edit.needsLlm)) {
      piece.done = true
      val covered = recPieces.size
      if (edit.edited) { recEditedText = edit.text; recEditedUpTo = covered; return }
      val seq = ++recEditSeq
      val base = VoiceKeyboardSecureStore.getApiBaseUrl(this).orEmpty()
      polishExecutor.execute {
        val token = KeyboardSession.freshAccessToken(this) ?: return@execute
        val result = runCatching { CloudKeyboardTranscriber.liveEditOrNull(base, token, previous, raw) }.getOrNull() ?: return@execute
        if (seq == recEditSeq && recPieces.size == covered) { recEditedText = result; recEditedUpTo = covered }
      }
      return
    }
    val ctx = currentDictationContext()
    if (!chunkWantsCloud(ctx, raw)) { piece.done = true; return }
    val vocab = (VoiceKeyboardSecureStore.getVocabulary(this) + VoiceKeyboardSecureStore.getLearnedVocabulary(this)).distinct().take(32)
    val formatStyle = ctx.formatStyle.ifBlank { VoiceKeyboardSecureStore.getFormatStyle(this).ifBlank { "natural" } }
    val contextJson = ctx.toJson()
    chunkExecutor.execute {
      try {
        val polished = FlowCleanupGuard.accept(raw, CloudKeyboardTranscriber.polishTextOrNull(
          VoiceKeyboardSecureStore.getApiBaseUrl(this) ?: "",
          KeyboardSession.freshAccessToken(this) ?: "",
          raw, vocab, formatStyle, contextJson, 1_200, liveChunk = true,
        ))
        if (polished != null) piece.cleaned = Snippets.apply(this, FlowRulePass.liveSegment(polished, vocab))
      } catch (_: Throwable) {
      } finally {
        piece.done = true
      }
    }
  }

  private fun recTextSoFar(): String {
    val pieces = synchronized(recPieces) { ArrayList(recPieces) }
    val upTo = recEditedUpTo.coerceAtMost(pieces.size)
    val head = recEditedText?.takeIf { upTo > 0 }
    return (listOfNotNull(head) + pieces.drop(if (head != null) upTo else 0).map { it.cleaned ?: it.raw })
      .filter { it.isNotBlank() }.joinToString(" ").trim()
  }

  private fun onLiveChunk(segment: String) {
    val shown = commitLiveSegment(segment) ?: return
    val ctx = currentDictationContext()
    if (!chunkWantsCloud(ctx, shown)) return
    val run = liveRun
    val session = inputSessionId
    val vocab = (VoiceKeyboardSecureStore.getVocabulary(this) + VoiceKeyboardSecureStore.getLearnedVocabulary(this)).distinct().take(32)
    val formatStyle = ctx.formatStyle.ifBlank { VoiceKeyboardSecureStore.getFormatStyle(this).ifBlank { "natural" } }
    val contextJson = ctx.toJson()
    val began = System.currentTimeMillis()
    chunkExecutor.execute {
      val polished = FlowCleanupGuard.accept(shown, CloudKeyboardTranscriber.polishTextOrNull(
        VoiceKeyboardSecureStore.getApiBaseUrl(this) ?: "",
        KeyboardSession.freshAccessToken(this) ?: "",
        shown, vocab, formatStyle, contextJson, 1_200, liveChunk = true,
      )) ?: return@execute
      val out = Snippets.apply(this, FlowRulePass.liveSegment(polished, vocab))
      if (out.isNotBlank() && out != shown) mainHandler.post {
        if (System.currentTimeMillis() - began <= 1_200) swapLiveChunk(session, run, shown, out)
      }
    }
  }

  /**
   * Only apps where the full text would go to Flow AI get piece-by-piece cleanup.
   * Chat, search and code stay rule-only (free); email and notes get one layout pass at the end.
   * Short pieces are skipped: the rules already cover them.
   */
  private fun chunkWantsCloud(ctx: InputContextResolver.DictationContext, piece: String): Boolean {
    if (ctx.category != "unknown" && ctx.category != "social") return false
    if (!cloudReady() || !VoiceKeyboardSecureStore.getCleanAndFormat(this)) return false
    return piece.trim().split(Regex("\\s+")).size >= 4
  }

  /**
   * Swap one cleaned piece into the text this dictation typed. Only our own range is touched,
   * and only while the field still ends with it (no cursor move, no user edit); else skip.
   */
  private fun swapLiveChunk(session: Long, run: Int, old: String, new: String) {
    if (session != inputSessionId || run != liveRun || old.isBlank() || old == new) return
    val ic = currentInputConnection ?: return
    if (liveOpen && liveCommitted.isNotEmpty()) {
      val span = liveCommitted
      val at = span.lastIndexOf(old)
      if (at < 0) return
      val next = span.substring(0, at) + new + span.substring(at + old.length)
      val composing = liveComposing
      runCatching {
        ic.beginBatchEdit()
        try {
          if (liveOwnershipLost) return@runCatching
          val owned = span + composing
          val before = ic.getTextBeforeCursor(owned.length + 4, 0)?.toString().orEmpty()
          if (DictationSpan.replace(before, owned, next + composing, 0, true,
            delete = { ic.deleteSurroundingText(it, 0) }, commit = { ic.commitText(it, 1) })) liveCommitted = next
          else liveOwnershipLost = true
        } finally {
          ic.endBatchEdit()
        }
      }
      return
    }
    // Already inserted: same check against the final text, for a short while only.
    val committed = lastCommittedText
    if (committed.isEmpty() || System.currentTimeMillis() - lastCommittedAt > 1_200) return
    val at = committed.lastIndexOf(old)
    if (at < 0) return
    val next = committed.substring(0, at) + new + committed.substring(at + old.length)
    val ok = runCatching {
      ic.beginBatchEdit()
      try {
        val before = ic.getTextBeforeCursor(committed.length + 4, 0)?.toString().orEmpty()
        if (!before.endsWith(committed)) return@runCatching false
        if (!ic.deleteSurroundingText(committed.length, 0)) return@runCatching false
        ic.commitText(next, 1)
      } finally {
        ic.endBatchEdit()
      }
    }.getOrDefault(false)
    if (ok) {
      lastCommittedText = next
      lastCommittedAt = System.currentTimeMillis()
    }
  }

  /** Stop: the pieces are already typed, so commit right away with the rules; Flow AI polishes the last piece later. */
  private fun finishLiveDictation(live: RealtimeStt, streamed: String, run: Int) {
    if (run != liveRun) return
    val chunked = liveChunkMode && inlineActive
    liveOpen = false
    liveChunkMode = false
    var text = streamed
    var tail = ""
    var finishChunked = chunked
    if (chunked) {
      val leftover = live.partialText()
      if (leftover.isNotBlank()) tail = commitLiveSegment(leftover).orEmpty()
      if (liveCommitted.isNotBlank()) text = liveCommitted.trim()
    } else {
      // Recording mode: pieces cleaned while speaking are used as they are; only the pieces
      // still being cleaned (the last words) are polished after stop.
      val pieces = synchronized(recPieces) { ArrayList(recPieces) }
      val edited = recEditedText
      val editedUpTo = recEditedUpTo.coerceAtMost(pieces.size)
      recPieces.clear()
      recEditedText = null; recEditedUpTo = 0; recEditSeq++
      val norm = { v: String -> v.replace(Regex("\\s+"), " ").trim() }
      val leftover = live.partialText().trim()
      if (edited != null) {
        // Spoken edits already shaped the earlier words; keep them and add the rest.
        val restRaw = (pieces.drop(editedUpTo).map { it.raw } + leftover).filter { it.isNotEmpty() }
        val rest = (pieces.drop(editedUpTo).map { it.cleaned ?: it.raw } + leftover).filter { it.isNotEmpty() }
        tail = restRaw.joinToString(" ")
        text = (listOf(edited) + rest).filter { it.isNotBlank() }.joinToString(" ")
        liveEdited = true
        liveFinishChunked = true
        liveFinishTail = tail
        handleRecognizedText(text)
        liveFinishChunked = false
        liveFinishTail = ""
        return
      }
      val rawAll = norm((pieces.map { it.raw } + leftover).filter { it.isNotEmpty() }.joinToString(" "))
      if (pieces.any { it.cleaned != null } && rawAll == norm(streamed)) {
        val firstOpen = pieces.indexOfFirst { !it.done }.let { if (it < 0) pieces.size else it }
        val head = pieces.take(firstOpen).map { it.cleaned ?: it.raw }
        tail = (pieces.drop(firstOpen).map { it.raw } + leftover).filter { it.isNotEmpty() }.joinToString(" ")
        text = (head + tail).filter { it.isNotEmpty() }.joinToString(" ")
        finishChunked = true
      }
    }
    if (mixedVoiceTyping) { commitOnce(streamed, "Inserted"); return }
    liveFinishChunked = finishChunked
    liveFinishTail = tail
    handleRecognizedText(text)
    liveFinishChunked = false
    liveFinishTail = ""
  }

  /** Swap this session's typed span for [text], only if the field still ends with it. */
  private fun replaceLiveSpan(text: String): Boolean {
    val ic = currentInputConnection ?: return false
    val span = liveCommitted
    if (span.isEmpty() || liveOwnershipLost || captureSessionId != inputSessionId || liveComposing.isNotEmpty()) return false
    val ok = runCatching {
      ic.beginBatchEdit()
      try {
        if (span.isNotEmpty()) {
          val before = ic.getTextBeforeCursor(span.length + 4, 0)?.toString().orEmpty()
          if (!before.endsWith(span)) return@runCatching false
          if (!ic.deleteSurroundingText(span.length, 0)) return@runCatching false
        }
        val out = if (text.isBlank()) "" else sessionPrefix + text.trim()
        if (out.isNotEmpty()) ic.commitText(out, 1)
        liveCommitted = out
        inlinePrefix = if (out.isEmpty()) sessionPrefix else " "
        liveEdited = true
        true
      } finally {
        ic.endBatchEdit()
      }
    }.getOrDefault(false)
    return ok
  }

  private var liveEditSeq = 0
  private var liveEdited = false

  /** Model-backed edit ("no I meant Thursday", "X না, Y"); applied only if nothing new was typed meanwhile. */
  private fun requestLiveEdit(previous: String, segment: String) {
    val seq = ++liveEditSeq
    val snapshot = liveCommitted
    val session = inputSessionId
    val base = VoiceKeyboardSecureStore.getApiBaseUrl(this).orEmpty()
    polishExecutor.execute {
      val token = KeyboardSession.freshAccessToken(this) ?: return@execute
      val result = CloudKeyboardTranscriber.liveEditOrNull(base, token, previous, segment) ?: return@execute
      mainHandler.post {
        if (seq != liveEditSeq || session != inputSessionId || liveCommitted != snapshot) return@post
        if (replaceLiveSpan(result)) setCaption("Edited")
      }
    }
  }

  /** After text is inserted: release mic, destroy recognizer, stop waveform, idle UI. */
  private fun forceIdleAfterInsert() {
    liveOpen = false
    liveChunkMode = false
    clearFinishTimeout()
    finishing = false
    userWantsListening = false
    cloudRecording = false
    audioRecord?.let { stopRecorderOnly(it) }
    dictation.clear()
    latestPartial = ""
    setListeningState(false)
    setProcessingState(false)
    micButton?.setMicLevel(0f)
    micButton?.clearLiveTranscript()
    clearInline()
    micButton?.isEnabled = true
    pendingSend = false
    endOneShot()
  }

  override fun onDestroy() {
    clipboard.removePrimaryClipChangedListener(clipboardListener)
    stopCaptureForTargetChange()
    if (retryOfflineReceiverRegistered) {
      runCatching { unregisterReceiver(retryOfflineReceiver) }
      retryOfflineReceiverRegistered = false
    }
    runCatching { tone?.release() }
    tone = null
    inferenceExecutor.shutdownNow()
    polishExecutor.shutdownNow()
    batchExecutor.shutdownNow()
    super.onDestroy()
  }
}
