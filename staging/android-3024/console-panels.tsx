import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { FLOW_DRAFT_CHAR_LIMIT, FLOW_MOTION, FLOW_RADIUS, FLOW_SPACING, FLOW_TOUCH, FLOW_TYPE } from "@/constants/flow-theme";
import { attachmentPreview, type AttachmentDescriptor } from "@/lib/voice-link/model/attachment";
import type { CleanupHoldReason, Draft, DraftProcessingState } from "@/lib/voice-link/model/draft";
import type { SaveState } from "@/lib/voice-link/store/draft-store";
import type { ConnectionView } from "@/lib/voice-link/model/connection";
import { TRANSFER_LABELS, TRANSFER_MEANINGS, type Transfer } from "@/lib/voice-link/model/transfer";
import type { VoiceLinkPalette } from "@/lib/voice-link/voice-link-provider";

import { FlowButton, FlowNotice, FlowSheet, StatusChip, type ChipTone } from "./ui";
import { VoiceWaveform } from "./voice-waveform";

const PROCESSING_LABEL: Record<DraftProcessingState, string | null> = {
  idle: null,
  capturing: "Listening on this phone",
  cleanup_running: "Smart cleanup is working",
  cleanup_ready: "Smart version ready",
  cleanup_review: "Smart answer needs your review",
  cleanup_failed: "Smart cleanup did not run",
  sending: "Sending…",
};

export function RelayStatusCard(props: {
  palette: VoiceLinkPalette;
  connection: ConnectionView;
  destinationName: string | null;
  activeTransfer: Transfer | null;
  desktopListening: boolean;
  lastError?: string | null;
  onOpen: () => void;
}) {
  const styles = useMemo(() => createStyles(props.palette), [props.palette]);
  const connectionTone = props.connection.state === "connected" ? "good" : props.connection.state === "connecting" ? "neutral" : "warn";
  const transfer = props.activeTransfer;
  return (
    <View style={styles.relayCard}>
      <View style={styles.relayHeader}>
        <View style={styles.relayTitleRow}>
          <View style={styles.relayIcon}><MaterialIcons name="swap-vert" size={19} color={props.palette.primary} /></View>
          <View style={styles.relayCopy}>
            <Text style={styles.relayTitle}>PC handoff</Text>
            <Text style={styles.relayMeta}>{props.destinationName ? `Windows · ${props.destinationName}` : "No Windows PC paired"}</Text>
          </View>
        </View>
        <StatusChip palette={props.palette} tone={connectionTone} icon={props.connection.state === "connected" ? "check-circle" : "sync"} label={props.connection.label} />
      </View>
      <Text style={styles.relayDetail}>{props.desktopListening ? "Windows is listening from its own microphone. Phone dictation remains independent." : props.connection.detail}</Text>
      {transfer ? (
        <View style={styles.handoffRow}>
          <MaterialIcons name={transfer.state === "insertion_verified" ? "check-circle" : transfer.state === "blocked" ? "error-outline" : "outbox"} size={18} color={transfer.state === "insertion_verified" ? props.palette.success : transfer.state === "blocked" ? props.palette.error : props.palette.primary} />
          <View style={styles.relayCopy}><Text style={styles.handoffLabel}>{TRANSFER_LABELS[transfer.state]}</Text><Text style={styles.handoffMeaning}>{transfer.lastStatusMessage ?? TRANSFER_MEANINGS[transfer.state]}</Text></View>
        </View>
      ) : null}
      {props.lastError ? <Text style={styles.relayError} numberOfLines={2}>{props.lastError}</Text> : null}
      <Pressable accessibilityRole="button" accessibilityLabel="Open Windows relay details" onPress={props.onOpen} style={({ pressed }) => [styles.relayAction, pressed && styles.buttonPressed]}>
        <Text style={styles.relayActionText}>Relay details</Text>
        <MaterialIcons name="chevron-right" size={18} color={props.palette.primary} />
      </Pressable>
    </View>
  );
}

function saveLabel(saveState: SaveState, draft: Draft | null) {
  if (!draft || !draft.currentEditedText.trim()) return "Nothing to save yet";
  if (saveState === "error") return "Saving failed. Keep this screen open.";
  if (draft.savedRevision >= draft.revision) return `Saved on phone · v${draft.savedRevision}`;
  return `Saving… (v${draft.revision} in memory)`;
}

/**
 * The one editable draft shared by Voice and Type (M-05). Provisional recognizer
 * text is displayed as a preview and never written into the field, so a partial
 * callback can't destroy a manual edit (§8.3).
 */
export function DraftComposer(props: {
  palette: VoiceLinkPalette;
  draft: Draft | null;
  provisionalText: string;
  listening: boolean;
  saveState: SaveState;
  showPreviews: boolean;
  disabled?: boolean;
  onChangeText: (text: string) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  inputRef?: RefObject<TextInput | null>;
  /** Send and Enter live at the top of the composer so they never need a scroll. */
  headerActions?: ReactNode;
  attachments?: AttachmentDescriptor[];
  /** Honest stub for Attach / Image / File — must not fake a working transfer. */
  onPickAttachment?: (kind: "image" | "file") => void;
  /** Puts the phone clipboard into the draft. */
  onPasteClipboard?: () => void;
  onPullClipboard?: () => void;
  onScan?: () => void;
  scanBusy?: boolean;
  attachmentBusy?: string | null;
  /** 0 to 1 for the file being sent; null keeps the row hidden (small, quick sends). */
  attachmentProgress?: number | null;
  onRemoveAttachment?: (id: string) => void;
  /** One-shot caret position, used to keep the cursor still when Live Draft applies a PC edit. */
  selection?: { start: number; end: number };
  onSelectionChange?: (selection: { start: number; end: number }) => void;
}) {
  const styles = useMemo(() => createStyles(props.palette), [props.palette]);
  const draft = props.draft;
  const text = draft?.currentEditedText ?? "";
  const empty = text.trim().length === 0;
  const charCount = text.length;
  return (
    <View style={styles.composer}>
      {props.headerActions ? <View style={styles.composerHeader}>{props.headerActions}</View> : null}
      {props.showPreviews ? (
        <View style={styles.inputShell}>
          <TextInput
            ref={props.inputRef}
            value={text}
            onChangeText={props.onChangeText}
            selection={props.selection}
            onSelectionChange={props.onSelectionChange ? (event) => props.onSelectionChange?.(event.nativeEvent.selection) : undefined}
            onFocus={props.onFocus}
            onBlur={props.onBlur}
            editable={!props.disabled}
            multiline
            textAlignVertical="top"
            placeholder="Your voice or typed text will appear here..."
            placeholderTextColor={props.palette.textMuted}
            accessibilityLabel="Draft text"
            accessibilityHint="This is the text that will be sent to your PC"
            maxLength={FLOW_DRAFT_CHAR_LIMIT}
            style={[styles.input, empty && styles.inputEmpty]}
          />
          <Text style={styles.charCount}>{`${charCount}/${FLOW_DRAFT_CHAR_LIMIT}`}</Text>
        </View>
      ) : (
        <View style={styles.hiddenPreview}>
          <MaterialIcons name="visibility-off" size={16} color={props.palette.textMuted} />
          <Text style={styles.hiddenPreviewText}>Draft preview is off in Controls → Privacy. Editing is still available; tap to show the text.</Text>
        </View>
      )}
      {props.attachments?.length ? (
        <View style={styles.attachmentList}>
          {props.attachments.map((attachment) => (
            <View key={attachment.id} style={styles.attachmentChip}>
              <MaterialIcons name={attachment.kind === "image" ? "image" : "insert-drive-file"} size={17} color={props.palette.textMuted} />
              <Text style={styles.attachmentText} numberOfLines={1}>{attachmentPreview(attachment)}</Text>
              <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${attachment.name}`} onPress={() => props.onRemoveAttachment?.(attachment.id)} hitSlop={8}>
                <MaterialIcons name="close" size={17} color={props.palette.textMuted} />
              </Pressable>
            </View>
          ))}
        </View>
      ) : null}
      <View style={styles.attachmentActions}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Attach: send a photo or file to your PC"
          disabled={Boolean(props.attachmentBusy)}
          onPress={() => props.onPickAttachment?.("file")}
          style={({ pressed }) => [styles.attachmentAction, pressed && styles.buttonPressed]}
        >
          <MaterialIcons name="attach-file" size={20} color={props.palette.textMuted} />
          <Text style={styles.attachmentActionText} numberOfLines={1}>Attach</Text>
        </Pressable>
        <View style={styles.attachmentDivider} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Clipboard: tap to copy to your PC, long-press to get the PC clipboard"
          disabled={props.disabled}
          onPress={() => props.onPasteClipboard?.()}
          onLongPress={() => props.onPullClipboard?.()}
          delayLongPress={400}
          style={({ pressed }) => [styles.attachmentAction, pressed && styles.buttonPressed]}
        >
          <MaterialIcons name="content-paste" size={20} color={props.palette.textMuted} />
          <Text style={styles.attachmentActionText} numberOfLines={1}>Clipboard</Text>
        </Pressable>
        {props.onScan ? (
          <>
            <View style={styles.attachmentDivider} />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Scan: photograph pages into a PDF for your PC"
              disabled={Boolean(props.scanBusy)}
              onPress={() => props.onScan?.()}
              style={({ pressed }) => [styles.attachmentAction, pressed && styles.buttonPressed, props.scanBusy && { opacity: 0.6 }]}
            >
              <MaterialIcons name="document-scanner" size={20} color={props.palette.textMuted} />
              <Text style={styles.attachmentActionText} numberOfLines={1}>Scan</Text>
            </Pressable>
          </>
        ) : null}
      </View>
      {props.attachmentBusy && typeof props.attachmentProgress === "number" ? (
        <View style={styles.provisional} accessibilityLiveRegion="polite">
          <MaterialIcons name="upload-file" size={14} color={props.palette.accentBlue} />
          <View style={styles.transferBody}>
            <Text style={styles.provisionalText} numberOfLines={1}>{props.attachmentBusy}</Text>
            <View style={styles.transferTrack} accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: Math.round(props.attachmentProgress * 100) }}>
              <View style={[styles.transferFill, { width: `${Math.round(Math.min(1, Math.max(0, props.attachmentProgress)) * 100)}%` }]} />
            </View>
          </View>
        </View>
      ) : null}
      {props.provisionalText ? (
        <View style={styles.provisional} accessibilityLiveRegion="polite">
          <MaterialIcons name={props.listening ? "graphic-eq" : "hourglass-empty"} size={14} color={props.palette.accentBlue} />
          <Text style={styles.provisionalText}>{props.provisionalText}</Text>
        </View>
      ) : null}
      {PROCESSING_LABEL[draft?.processingState ?? "idle"] ? (
        <Text style={styles.footerProcessing}>{PROCESSING_LABEL[draft?.processingState ?? "idle"]}</Text>
      ) : null}
    </View>
  );
}


/** Smart vs Original, the cleanup action, and the review panel for a held answer. */
export function SmartCleanupRow(props: {
  palette: VoiceLinkPalette;
  draft: Draft | null;
  enabled: boolean;
  available: boolean;
  unavailableReason: string | null;
  busy: boolean;
  hasText: boolean;
  onToggleEnabled: (enabled: boolean) => void;
  onRunNow: () => void;
  onSelectOutput: (output: "original" | "smart") => void;
  onAcceptPending: () => void;
  onDiscardPending: () => void;
}) {
  const styles = useMemo(() => createStyles(props.palette), [props.palette]);
  const draft = props.draft;
  const holdReason: CleanupHoldReason | null = draft?.pendingSmartReason ?? null;
  return (
    <View style={styles.smartCard}>
      <View style={styles.smartHeader}>
        <View style={{ flex: 1 }}>
          <Text style={styles.composerLabel}>Smart cleanup</Text>
          <Text style={styles.smartHint}>
            {props.available
              ? "Removes spoken corrections and filler, adds punctuation, and keeps your words. Original is never overwritten."
              : props.unavailableReason ?? "Smart cleanup is unavailable on this setup. Original text always stays usable."}
          </Text>
        </View>
        <View style={styles.segment}>
          <Pressable
            accessibilityRole="radio"
            accessibilityState={{ selected: !props.enabled }}
            onPress={() => props.onToggleEnabled(false)}
            style={[styles.segmentItem, !props.enabled && styles.segmentItemActive]}
          >
            <Text style={[styles.segmentText, !props.enabled && styles.segmentTextActive]}>Original</Text>
          </Pressable>
          <Pressable
            accessibilityRole="radio"
            accessibilityState={{ selected: props.enabled, disabled: !props.available }}
            onPress={() => props.onToggleEnabled(true)}
            style={[styles.segmentItem, props.enabled && styles.segmentItemActive, !props.available && styles.segmentItemDisabled]}
          >
            <Text style={[styles.segmentText, props.enabled && styles.segmentTextActive, !props.available && styles.segmentTextDisabled]}>Smart</Text>
          </Pressable>
        </View>
      </View>
      {!props.available ? <StatusChip tone="warn" label="Smart unavailable · Original still works" palette={props.palette} icon="info-outline" /> : null}
      {props.available && draft?.smartText && draft.smartText !== draft.originalText ? (
        <View style={styles.versionRow}>
          <Text style={styles.footerText}>Sent version</Text>
          <View style={styles.segment}>
            <Pressable accessibilityRole="radio" accessibilityState={{ selected: draft.selectedOutput === "original" }} onPress={() => props.onSelectOutput("original")} style={[styles.segmentItem, draft.selectedOutput === "original" && styles.segmentItemActive]}>
              <Text style={[styles.segmentText, draft.selectedOutput === "original" && styles.segmentTextActive]}>Original</Text>
            </Pressable>
            <Pressable accessibilityRole="radio" accessibilityState={{ selected: draft.selectedOutput === "smart" }} onPress={() => props.onSelectOutput("smart")} style={[styles.segmentItem, draft.selectedOutput === "smart" && styles.segmentItemActive]}>
              <Text style={[styles.segmentText, draft.selectedOutput === "smart" && styles.segmentTextActive]}>Smart</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
      {draft?.processingState === "cleanup_running" ? (
        <View style={styles.busyRow}>
          <ActivityIndicator size="small" color={props.palette.primary} />
          <Text style={styles.footerText}>Preparing your cleaned draft…</Text>
        </View>
      ) : null}
      {draft?.processingState === "cleanup_failed" && draft.processingError ? (
        <FlowNotice tone="bad" title={draft.processingError} detail="Your draft is untouched." palette={props.palette} />
      ) : null}
      {draft?.pendingSmartText ? (
        <View style={styles.review}>
          <Text style={styles.reviewTitle}>{holdReason === "safety_guard" ? "Smart result needs your review" : "Smart finished after your edit"}</Text>
          <Text style={styles.reviewCopy}>
            {holdReason === "draft_changed"
              ? "You changed the draft while cleanup ran, so the answer was not applied over your text."
              : "The cleaned text changed something this app protects: numbers, negations, alternatives, quotes or links. Nothing was applied automatically."}
          </Text>
          <Text style={styles.reviewQuote}>{draft.pendingSmartText}</Text>
          <View style={styles.reviewActions}>
            <FlowButton label="Use this version" onPress={props.onAcceptPending} palette={props.palette} />
            <FlowButton label="Keep my text" variant="secondary" onPress={props.onDiscardPending} palette={props.palette} />
          </View>
        </View>
      ) : null}
      {props.enabled && props.available && !props.busy && draft?.processingState !== "cleanup_running" ? (
        <FlowButton label={draft?.smartText ? "Run cleanup again" : "Clean up this draft"} icon="auto-fix-high" variant="secondary" onPress={props.onRunNow} disabled={!props.hasText} palette={props.palette} />
      ) : null}
    </View>
  );
}

/** Explicit consent for the real processing route, shown once (§9.5). */
export function SmartConsentSheet(props: {
  visible: boolean;
  onClose: () => void;
  palette: VoiceLinkPalette;
  route: string;
  onAllow: () => void;
  onKeepOriginal: () => void;
}) {
  const styles = useMemo(() => createStyles(props.palette), [props.palette]);
  return (
    <FlowSheet visible={props.visible} onClose={props.onClose} palette={props.palette} title="Send your text for cleanup?" subtitle="Smart cleanup only rewrites wording. Nothing is delivered to your PC until you tap Send.">
      <View style={styles.consentList}>
        {[
          "The recognized words are kept on this phone as your Original draft.",
          `The text is sent to the Cursor Flow backend (${props.route}), not to a microphone service.`,
          "No audio is uploaded for cleanup. Only the finished text is sent.",
          "You review and can edit the result before sending. Original stays available.",
        ].map((line) => (
          <View key={line} style={styles.consentRow}>
            <MaterialIcons name="check-circle-outline" size={16} color={props.palette.primary} />
            <Text style={styles.consentText}>{line}</Text>
          </View>
        ))}
      </View>
      <FlowButton label="Allow cleanup on this phone" onPress={props.onAllow} palette={props.palette} />
      <FlowButton label="Keep Original only" variant="secondary" onPress={props.onKeepOriginal} palette={props.palette} />
      <Text style={styles.footnote}>You can change this any time in Controls → Writing.</Text>
    </FlowSheet>
  );
}

/** Send and Enter, shown in the Draft composer header (3.0.18). Same states as before. */
export function SendActions(props: {
  palette: VoiceLinkPalette;
  destinationName: string | null;
  hasText: boolean;
  canSend: boolean;
  busy: boolean;
  onSend: () => void;
  onEnter?: () => void;
  enterBusy?: boolean;
}) {
  const styles = useMemo(() => createStyles(props.palette), [props.palette]);
  const enabled = props.hasText && props.canSend && !props.busy;
  return (
    <View style={[styles.sendRow, styles.sendRowHeader]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={props.destinationName ? `Send this draft to ${props.destinationName}` : "Send to PC"}
        accessibilityState={{ disabled: !enabled, busy: props.busy }}
        onPress={enabled ? props.onSend : undefined}
        style={({ pressed }) => [styles.send, !enabled && styles.sendDisabled, pressed && enabled && styles.sendPressed]}
      >
        {props.busy ? (
          <ActivityIndicator color={props.palette.onCta} />
        ) : (
          <MaterialIcons name="send" size={20} color={enabled ? props.palette.onCta : props.palette.textMuted} />
        )}
        <Text style={[styles.sendLabel, !enabled && styles.sendLabelDisabled]}>
          {props.busy ? "Sending…" : "Send"}
        </Text>
      </Pressable>
      {props.onEnter ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Enter: press Enter on your PC"
          onPress={props.onEnter}
          disabled={props.enterBusy}
          style={({ pressed }) => [styles.voiceNote, pressed && styles.pressed, props.enterBusy && { opacity: 0.6 }]}
        >
          {props.enterBusy ? <ActivityIndicator size="small" color={props.palette.text} /> : <MaterialIcons name="keyboard-return" size={20} color={props.palette.text} />}
          <Text style={styles.voiceNoteLabel} numberOfLines={1}>Enter</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** The single primary action: explicit review-then-send with the destination named (M-08). */
export function SendBar(props: {
  palette: VoiceLinkPalette;
  destinationName: string | null;
  hasText: boolean;
  canSend: boolean;
  busy: boolean;
  resultLabel: string | null;
  resultTone: ChipTone;
  blockedReason: string | null;
  onSend: () => void;
  onCopy: () => void;
  onNewDraft: () => void;
  showNewDraft: boolean;
  /** Presses Enter once on the PC. */
  onEnter?: () => void;
  enterBusy?: boolean;
}) {
  const styles = useMemo(() => createStyles(props.palette), [props.palette]);
  return (
    <View style={styles.sendWrap}>
      {props.blockedReason && !props.busy ? <Text style={styles.sendBlock}>{props.blockedReason}</Text> : null}
      <View style={styles.sendMeta}>
        {props.resultLabel ? <StatusChip tone={props.resultTone} label={props.resultLabel} palette={props.palette} /> : <Text style={styles.sendHint}>{props.hasText ? "Nothing leaves this phone until you tap Send." : "Write or dictate something first."}</Text>}
        <View style={styles.sendMetaActions}>
          <Pressable accessibilityRole="button" onPress={props.onCopy} hitSlop={8} disabled={!props.hasText} style={({ pressed }) => [styles.metaAction, pressed && styles.pressed, !props.hasText && styles.pressed]}>
            <Text style={[styles.metaActionText, !props.hasText && styles.metaActionDisabled]}>Copy</Text>
          </Pressable>
          {props.showNewDraft ? (
            <Pressable accessibilityRole="button" onPress={props.onNewDraft} hitSlop={8} style={({ pressed }) => [styles.metaAction, pressed && styles.pressed]}>
              <Text style={styles.metaActionText}>New draft</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    </View>
  );
}


/**
 * Microphone control. The waveform only moves while a capture session is live,
 * so no animation ever pretends the mic is open (PRD §16 motion rules).
 */
export function MicControl(props: {
  palette: VoiceLinkPalette;
  phase: "idle" | "listening" | "finalizing" | "busy";
  elapsedSeconds: number;
  reducedMotion: boolean;
  label: string;
  hint: string;
  onPress: () => void;
  onCancel: () => void;
  /** Current voice level 0..1 for the live waveform. */
  getLevel?: () => number;
}) {
  const styles = useMemo(() => createStyles(props.palette), [props.palette]);
  const live = props.phase === "listening";
  const [tick, setTick] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (!live || props.reducedMotion) {
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
      return;
    }
    timerRef.current = setInterval(() => setTick((value) => (value + 1) % 8), FLOW_MOTION.normal);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
    };
  }, [live, props.reducedMotion]);
  const haloScale = live && !props.reducedMotion ? 1 + (tick % 4) * 0.04 : 1;
  return (
    <View style={styles.micCard}>
      {live || props.phase === "finalizing" ? (
        // Same premium pill as the voice keyboard: the state word above, live bars inside.
        <View style={styles.pillStack}>
          <Text style={styles.pillCaption}>{live ? "Listening" : "Finishing"}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={live ? "Stop recording" : "Cancel finishing and reset mic"}
            accessibilityHint={live ? "Tap to finish. Your draft saves automatically." : "Tap to cancel if Finishing is stuck"}
            disabled={false}
            onPress={live ? props.onPress : props.onCancel}
            style={({ pressed }) => [styles.listenPill, pressed && styles.orbPressed, !live && { opacity: 0.7 }]}
          >
            {live ? (
              <VoiceWaveform getLevel={props.getLevel} color="#1C1C1E" reducedMotion={props.reducedMotion} width={150} height={40} />
            ) : (
              <ActivityIndicator color="#1C1C1E" />
            )}
          </Pressable>
        </View>
      ) : (
      <View style={styles.orbStack}>
        <View style={[styles.orbHalo, styles.orbHaloOuter, { transform: [{ scale: haloScale }] }]} />
        <View style={[styles.orbHalo, styles.orbHaloInner]} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={live ? "Stop recording" : "Start recording"}
          accessibilityHint="Recording runs on this phone. Your draft saves automatically."
          onPress={props.onPress}
          style={({ pressed }) => [styles.orb, live && styles.orbLive, pressed && styles.orbPressed]}
        >
          <MaterialIcons
            name={live ? "stop" : "mic"}
            size={32}
            color={props.palette.onMic}
          />
        </Pressable>
      </View>
      )}
      {live || props.phase === "finalizing" ? null : <Text style={styles.micLabel}>{props.label}</Text>}
      {live || props.phase !== "idle" ? <Text style={styles.micHint}>{props.hint}</Text> : null}
      {live || props.phase === "finalizing" ? (
        <Pressable accessibilityRole="button" onPress={props.onCancel} hitSlop={8} style={styles.cancel}>
          <Text style={styles.cancelText}>Cancel this recording</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function createStyles(palette: VoiceLinkPalette) {
  return StyleSheet.create({
    pillStack: { alignItems: "center", gap: 10, width: "100%", paddingVertical: 6 },
    pillCaption: { color: palette.text, fontSize: 17, fontWeight: "500", letterSpacing: 0.2 },
    listenPill: {
      width: "92%",
      height: 76,
      borderRadius: 38,
      backgroundColor: "#FFFFFF",
      borderWidth: 1,
      borderColor: "#D9DADF",
      alignItems: "center",
      justifyContent: "center",
      shadowColor: "#000",
      shadowOpacity: 0.12,
      shadowRadius: 10,
      shadowOffset: { width: 0, height: 3 },
      elevation: 4,
    },
    composer: {
      borderRadius: FLOW_RADIUS.card,
      borderWidth: 1,
      borderColor: palette.border,
      backgroundColor: palette.panel,
      padding: FLOW_SPACING.md,
      gap: FLOW_SPACING.sm,
    },
    composerHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: FLOW_SPACING.sm },
    draftTitleRow: { flexDirection: "row", alignItems: "center", gap: FLOW_SPACING.xs },
    draftTitle: { color: palette.text, fontSize: FLOW_TYPE.body, fontWeight: "800" },
    editPill: {
      flexDirection: "row",
      alignItems: "center",
      gap: 5,
      paddingHorizontal: 12,
      minHeight: 34,
      borderRadius: FLOW_RADIUS.pill,
      backgroundColor: palette.panelSoft,
    },
    editPillText: { color: palette.textMuted, fontSize: FLOW_TYPE.meta, fontWeight: "700" },
    composerLabel: { color: palette.textMuted, fontSize: FLOW_TYPE.meta, fontWeight: "700" },
    composerMeta: { color: palette.textMuted, fontSize: FLOW_TYPE.meta, marginTop: 2 },
    inputShell: {
      borderRadius: FLOW_RADIUS.field,
      backgroundColor: palette.inset,
      borderWidth: 1,
      borderColor: palette.border,
      paddingBottom: FLOW_SPACING.xs,
      minHeight: 168,
    },
    input: {
      minHeight: 158,
      maxHeight: 240,
      color: palette.text,
      fontSize: FLOW_TYPE.body,
      lineHeight: 24,
      paddingHorizontal: FLOW_SPACING.sm,
      paddingTop: FLOW_SPACING.sm,
      paddingBottom: 4,
    },
    inputEmpty: { minHeight: 96 },
    charCount: {
      alignSelf: "flex-end",
      paddingHorizontal: FLOW_SPACING.sm,
      color: palette.textMuted,
      fontSize: FLOW_TYPE.meta,
      fontWeight: "600",
    },
    hiddenPreview: {
      flexDirection: "row",
      gap: FLOW_SPACING.xs,
      alignItems: "center",
      minHeight: 60,
      paddingHorizontal: FLOW_SPACING.sm,
      borderRadius: FLOW_RADIUS.control,
      backgroundColor: palette.panelSoft,
    },
    hiddenPreviewText: { flex: 1, color: palette.textMuted, fontSize: FLOW_TYPE.meta, lineHeight: 18 },
    provisional: {
      flexDirection: "row",
      gap: 6,
      alignItems: "flex-start",
      paddingVertical: 7,
      paddingHorizontal: FLOW_SPACING.sm,
      borderRadius: FLOW_RADIUS.control,
      borderWidth: 1,
      borderColor: `${palette.accentBlue}55`,
      borderStyle: "dashed",
      backgroundColor: `${palette.panelSoft}66`,
    },
    provisionalText: { flex: 1, color: palette.textMuted, fontSize: FLOW_TYPE.secondary, lineHeight: 20 },
    transferBody: { flex: 1, gap: 4 },
    transferTrack: { height: 3, borderRadius: 2, backgroundColor: palette.border, overflow: "hidden" },
    transferFill: { height: 3, borderRadius: 2, backgroundColor: palette.accentBlue },
    composerFooter: { flexDirection: "row", justifyContent: "space-between", gap: FLOW_SPACING.sm, alignItems: "center" },
    footerText: { color: palette.textMuted, fontSize: FLOW_TYPE.meta },
    footerProcessing: { color: palette.accentBlue, fontSize: FLOW_TYPE.meta, fontWeight: "700", flexShrink: 1 },
    attachmentList: { gap: 6 },
    attachmentChip: {
      flexDirection: "row",
      alignItems: "center",
      gap: 7,
      minHeight: 38,
      paddingHorizontal: 10,
      borderRadius: FLOW_RADIUS.control,
      backgroundColor: palette.panelSoft,
    },
    attachmentText: { flex: 1, color: palette.textMuted, fontSize: FLOW_TYPE.meta },
    attachmentActions: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-around",
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: palette.border,
      paddingTop: FLOW_SPACING.xs,
      marginTop: 2,
    },
    attachmentAction: {
      flex: 1,
      minHeight: FLOW_TOUCH.min,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 6,
    },
    attachmentActionText: { color: palette.textMuted, fontSize: FLOW_TYPE.secondary, fontWeight: "600" },
    attachmentDivider: { width: StyleSheet.hairlineWidth, height: 22, backgroundColor: palette.border },
    relayCard: {
      borderRadius: FLOW_RADIUS.card,
      borderWidth: 1,
      borderColor: palette.border,
      backgroundColor: palette.panel,
      padding: FLOW_SPACING.md,
      gap: FLOW_SPACING.xs,
    },
    relayHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: FLOW_SPACING.sm },
    relayTitleRow: { flexDirection: "row", alignItems: "center", gap: FLOW_SPACING.xs, flex: 1 },
    relayIcon: {
      width: 34,
      height: 34,
      borderRadius: 17,
      backgroundColor: palette.iconSurface,
      alignItems: "center",
      justifyContent: "center",
    },
    relayCopy: { flex: 1 },
    relayTitle: { color: palette.text, fontSize: FLOW_TYPE.secondary, fontWeight: "800" },
    relayMeta: { color: palette.textMuted, fontSize: FLOW_TYPE.meta, marginTop: 2 },
    relayDetail: { color: palette.textMuted, fontSize: FLOW_TYPE.meta, lineHeight: 18, marginTop: 4 },
    handoffRow: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: FLOW_SPACING.xs,
      padding: FLOW_SPACING.xs,
      borderRadius: FLOW_RADIUS.control,
      backgroundColor: palette.panelSoft,
      marginTop: FLOW_SPACING.xs,
    },
    handoffLabel: { color: palette.text, fontSize: FLOW_TYPE.meta, fontWeight: "800" },
    handoffMeaning: { color: palette.textMuted, fontSize: FLOW_TYPE.meta, lineHeight: 17, marginTop: 2 },
    relayError: { color: palette.error, fontSize: FLOW_TYPE.meta, lineHeight: 17, marginTop: FLOW_SPACING.xs },
    relayAction: { minHeight: 36, flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 2, marginTop: 2 },
    relayActionText: { color: palette.accentBlue, fontSize: FLOW_TYPE.meta, fontWeight: "800" },
    buttonPressed: { opacity: 0.72 },
    smartCard: {
      borderRadius: FLOW_RADIUS.card,
      borderWidth: 1,
      borderColor: palette.border,
      backgroundColor: palette.panel,
      padding: FLOW_SPACING.md,
      gap: FLOW_SPACING.sm,
    },
    smartHeader: { flexDirection: "row", alignItems: "flex-start", gap: FLOW_SPACING.sm },
    smartHint: { color: palette.textMuted, fontSize: FLOW_TYPE.meta, lineHeight: 18, marginTop: 3 },
    segment: {
      flexDirection: "row",
      padding: 3,
      borderRadius: FLOW_RADIUS.pill,
      backgroundColor: palette.panelSoft,
      borderWidth: 1,
      borderColor: palette.border,
      gap: 3,
    },
    segmentItem: {
      minHeight: 34,
      paddingHorizontal: 12,
      borderRadius: FLOW_RADIUS.pill,
      alignItems: "center",
      justifyContent: "center",
    },
    segmentItemActive: { backgroundColor: palette.cta },
    segmentItemDisabled: { opacity: 0.5 },
    segmentText: { color: palette.textMuted, fontSize: FLOW_TYPE.meta, fontWeight: "700" },
    segmentTextActive: { color: palette.onCta },
    segmentTextDisabled: { color: palette.textMuted },
    versionRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: FLOW_SPACING.sm,
      flexWrap: "wrap",
    },
    busyRow: { flexDirection: "row", alignItems: "center", gap: FLOW_SPACING.xs },
    review: {
      gap: FLOW_SPACING.xs,
      padding: FLOW_SPACING.sm,
      borderRadius: FLOW_RADIUS.control,
      borderWidth: 1,
      borderColor: `${palette.textMuted}66`,
      backgroundColor: palette.panelSoft,
    },
    reviewTitle: { color: palette.text, fontSize: FLOW_TYPE.secondary, fontWeight: "700" },
    reviewCopy: { color: palette.textMuted, fontSize: FLOW_TYPE.meta, lineHeight: 18 },
    reviewQuote: { color: palette.text, fontSize: FLOW_TYPE.secondary, lineHeight: 21, fontStyle: "italic" },
    reviewActions: { flexDirection: "row", gap: FLOW_SPACING.xs, flexWrap: "wrap" },
    consentList: { gap: FLOW_SPACING.xs },
    consentRow: { flexDirection: "row", gap: FLOW_SPACING.xs, alignItems: "flex-start" },
    consentText: { flex: 1, color: palette.text, fontSize: FLOW_TYPE.secondary, lineHeight: 20 },
    footnote: { color: palette.textMuted, fontSize: FLOW_TYPE.meta, lineHeight: 18 },
    sendWrap: { gap: FLOW_SPACING.xs },
    sendRow: { flexDirection: "row", gap: FLOW_SPACING.sm, alignItems: "stretch" },
    sendRowHeader: { flex: 1 },
    voiceNote: {
      minHeight: FLOW_TOUCH.primary,
      borderRadius: FLOW_RADIUS.pill,
      paddingHorizontal: FLOW_SPACING.md,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 6,
      borderWidth: 1,
      borderColor: palette.border,
      backgroundColor: palette.panelSoft,
      flexShrink: 1,
    },
    voiceNoteLabel: { color: palette.text, fontSize: FLOW_TYPE.secondary, fontWeight: "700", flexShrink: 1 },
    send: {
      flex: 1,
      minHeight: FLOW_TOUCH.primary,
      borderRadius: FLOW_RADIUS.pill,
      paddingHorizontal: FLOW_SPACING.lg,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: FLOW_SPACING.sm,
      backgroundColor: palette.cta,
      borderWidth: 1,
      borderColor: palette.border,
    },
    sendPressed: { opacity: 0.9 },
    sendDisabled: { backgroundColor: palette.panelSoft, borderColor: palette.border },
    sendLabel: { color: palette.onCta, fontSize: FLOW_TYPE.body, fontWeight: "800" },
    sendLabelDisabled: { color: palette.textMuted },
    sendBlock: { color: palette.textMuted, fontSize: FLOW_TYPE.meta, lineHeight: 18 },
    sendMeta: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: FLOW_SPACING.sm },
    sendMetaActions: { flexDirection: "row", gap: FLOW_SPACING.sm, alignItems: "center" },
    sendHint: { color: palette.textMuted, fontSize: FLOW_TYPE.meta, flexShrink: 1 },
    metaAction: { minHeight: FLOW_TOUCH.min, paddingHorizontal: 6, alignItems: "center", justifyContent: "center" },
    metaActionText: { color: palette.accentBlue, fontSize: FLOW_TYPE.secondary, fontWeight: "700" },
    metaActionDisabled: { color: palette.textMuted },
    pressed: { opacity: 0.7 },
    micCard: {
      alignItems: "center",
      gap: FLOW_SPACING.xs,
      paddingTop: FLOW_SPACING.md,
      paddingBottom: FLOW_SPACING.sm,
    },
    orbStack: {
      width: 128,
      height: 128,
      alignItems: "center",
      justifyContent: "center",
    },
    orbHalo: {
      position: "absolute",
      borderRadius: 999,
      borderWidth: 1,
    },
    orbHaloOuter: {
      width: 128,
      height: 128,
      borderColor: `${palette.accentBlue}33`,
      backgroundColor: `${palette.accentBlue}10`,
    },
    orbHaloInner: {
      width: 104,
      height: 104,
      borderColor: `${palette.accentBlue}22`,
      backgroundColor: `${palette.panel}88`,
    },
    orb: {
      width: 84,
      height: 84,
      borderRadius: 42,
      backgroundColor: palette.mic,
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 1,
      borderColor: palette.border,
      zIndex: 2,
    },
    orbLive: {
      borderWidth: 3,
      borderColor: palette.accentBlue,
    },
    orbPressed: { opacity: 0.88 },
    waveTap: { width: 128, height: 128, alignItems: "center", justifyContent: "center", borderRadius: 999 },
    micLabel: {
      color: palette.textMuted,
      fontSize: FLOW_TYPE.secondary,
      fontWeight: "600",
      textAlign: "center",
      marginTop: 2,
    },
    micHint: { color: palette.textMuted, fontSize: FLOW_TYPE.meta, lineHeight: 18, textAlign: "center", maxWidth: 300 },
    cancel: { minHeight: FLOW_TOUCH.min, paddingHorizontal: 10, alignItems: "center", justifyContent: "center" },
    cancelText: { color: palette.error, fontSize: FLOW_TYPE.meta, fontWeight: "700" },
  });
}
