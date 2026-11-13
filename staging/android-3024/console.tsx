import { tier1Cleanup } from "@/lib/voice-link/tier1-cleanup";
import { ensureBanglaScript } from "@/lib/voice-link/bangla-script";
import { levelFromDb } from "@/lib/voice-link/waveform";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { recordDictation } from "@/lib/voice-link/usage-stats";
import { RouteBadge } from "@/components/flow/route-badge";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from "@/lib/voice-link/speech-recognition";
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { Alert, Animated, AppState, InteractionManager, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { ScreenContainer } from "@/components/screen-container";
import { CursorFlowBrand } from "@/components/flow/brand";
import { ScanCamera } from "@/components/flow/scan-camera";
import { ScanActions, type ScanAction } from "@/components/flow/scan-actions";
import type { ScannedCode } from "@/lib/voice-link/scan";
import { applySpokenPunctuation, joinDictation } from "@/lib/voice-link/spoken-punctuation";
import { DraftComposer, MicControl, SendActions, SendBar, SmartConsentSheet } from "@/components/flow/console-panels";
import { PcConnectionSheet, PcStatusCard } from "@/components/flow/pc-connection";
import type { ChipTone } from "@/components/flow/ui";
import { FLOW_RADIUS, FLOW_SPACING, FLOW_TOUCH, FLOW_TYPE } from "@/constants/flow-theme";
import { createManualRecognitionOptions, finalTranscriptFromResults } from "@/lib/voice-link/auto-listening";
import { chooseSpeechRoute, isNetworkReachable } from "@/lib/voice-link/offline-fallback";
import { describeReadiness, diagnoseConnectionIssue } from "@/lib/voice-link/model/connection";
import { speechDraftView, type CaptureSession } from "@/lib/voice-link/model/speech";
import { TRANSFER_LABELS, TRANSFER_MEANINGS, applyDesktopStatus, type Transfer } from "@/lib/voice-link/model/transfer";
import { createActionEnvelope } from "@/lib/voice-link/action-router";
import { resolveQuickStartShortcut } from "@/lib/voice-link/quick-start";
import { trpc } from "@/lib/trpc";
import { normalizeVocabulary } from "@/shared/vocabulary";
import { createRecognitionTiming } from "@/lib/voice-link/latency";
import { getCloudRelayStatus, getRelayStatus, revokeRelaySession, sendCloudRelayText, sendRelayText } from "@/lib/voice-link/local-relay";
import { lanHostFromRelayUrl } from "@/lib/voice-link/pairing";
import { runSmartCleanup, type CleanupCapability } from "@/lib/voice-link/smart-cleanup";
import { queueLocally, reconcileTransfers, submitDraft } from "@/lib/voice-link/transfer-coordinator";
import { useDraftStore } from "@/lib/voice-link/store/draft-store";
import { shiftCaret, typingLabel, useLiveDraft } from "@/lib/voice-link/live-draft";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useRelayConnection, testRelayConnection } from "@/lib/voice-link/use-connection-state";
import { fastFinish, toBengaliScript } from "@/lib/voice-link/fast-text";
import { applyAllCommands, fastLiveEdit, validateLiveEdit } from "@/lib/voice-link/live-edit";
import { applySnippets } from "@/lib/voice-link/snippets";
import { styledFormat, useVoiceLink, type VerifiedRelayConnection, type VoiceLinkPalette } from "@/lib/voice-link/voice-link-provider";
import { cloudCleanup } from "@/lib/voice-link/cloud-cleanup";
import { supabase } from "@/lib/supabase";
import { setAudioModeAsync, useAudioRecorder } from "expo-audio";
import { CLOUD_RECORDING_OPTIONS, CloudDictationError, cleanupLiveText, liveEditRemote, cloudSignedIn as hasCloudSession, transcribeRecordingWithCloud } from "@/lib/voice-link/cloud-dictation";
import { cancelLiveMic, liveMicStatusText, onLiveMicStatus, onLiveMicText } from "@/lib/voice-link/voice-keyboard";
import { CLOUD_CLEANUP_BUDGET_MS, cleanupRouteFor, createUtteranceId, deliverUtterance, neverReachedPc, prunePending, removeDeliveredText, shouldDropFinal, type PendingUtterance, type SpeechSignal, type UtteranceAck } from "@/lib/voice-link/utterance-delivery";

type PairingSheetProps = {
  visible: boolean;
  onClose: () => void;
  palette: VoiceLinkPalette;
  onPaired: (input: { deviceName: string; relay: VerifiedRelayConnection; test: { ok: boolean; message: string } }) => void;
};

const SPEAKING_LANGUAGES = ["Auto-detect", "বাংলা", "English", "हिन्दी", "Español", "Français"] as const;

function haptic(kind: "start" | "success" | "error") {
  if (Platform.OS === "web") return;
  if (kind === "start") void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  if (kind === "success") void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  if (kind === "error") void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
}

function detectedLanguageLabel(language: string | undefined) {
  return ({ bn: "বাংলা", "bn-BD": "বাংলা", en: "English", "en-US": "English", hi: "हिन्दी", "hi-IN": "हिन्दी", es: "Español", "es-ES": "Español", fr: "Français", "fr-FR": "Français" } as Record<string, string>)[language ?? ""] ?? language ?? "your language";
}

function shortTime(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function recognitionErrorText(code: string) {
  if (code.includes(" ")) return code;
  switch (code) {
    case "microphone-permission": case "not-allowed": return "Microphone access is off.";
    case "no-recognizer": return "No speech service on this phone.";
    case "network": case "server": return "Speech service could not be reached.";
    case "language-not-supported": return "This language is not available on this phone.";
    case "audio-capture": case "busy": case "client": case "interrupted": return "The microphone was busy.";
    default: return "Listening stopped early.";
  }
}

/** Words of `raw` spoken after `base`, tolerant to case, punctuation and re-spelling of earlier words. */
function rawTailAfter(base: string, raw: string): string | null {
  if (raw.startsWith(base)) return raw.slice(base.length).trim();
  const norm = (w: string) => w.toLowerCase().replace(/[\p{P}\p{S}]/gu, "");
  const b = base.trim().split(/\s+/).filter(Boolean);
  const r = raw.trim().split(/\s+/).filter(Boolean);
  if (r.length < b.length) return null;
  let same = 0;
  for (let i = 0; i < b.length; i += 1) if (norm(b[i]) === norm(r[i])) same += 1;
  // Most earlier words still line up: treat the rest as the new tail.
  if (b.length && same / b.length < 0.6) return null;
  return r.slice(b.length).join(" ");
}

/** Speech often gets a saved word's spelling or case wrong; use the saved spelling. */
function applyVocabulary(text: string, vocabulary: string[]): string {
  let out = text;
  for (const term of vocabulary) {
    const t = term.trim();
    if (t.length < 2 || t.length > 60) continue;
    const esc = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    try { out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, "giu"), t); } catch { /* engine without lookbehind: keep text */ }
  }
  return out;
}

function withTimeout<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms);
    work.then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(fallback); });
  });
}

export default function ConsoleScreen() {
  const router = useRouter();
  const { openPairing, details, open: openPanel } = useLocalSearchParams<{ openPairing?: string; details?: string; open?: string }>();
  const {
    device,
    relayConnection,
    relaySuspended,
    hydrated,
    preferences,
    palette,
    pairDevice,
    setRelaySuspended,
    forgetDevice,
    addActivity,
    updateActivityByHandoff,
    updatePreferences,
    resolvedTheme,
  } = useVoiceLink();
  const flow = useDraftStore();

  const [session, setSession] = useState<CaptureSession | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [recognitionError, setRecognitionError] = useState<string | null>(null);
  const [pairingOpen, setPairingOpen] = useState(false);
  const [PairingSheet, setPairingSheet] = useState<ComponentType<PairingSheetProps> | null>(null);
  const [speechListenersArmed, setSpeechListenersArmed] = useState(false);
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [consentOpen, setConsentOpen] = useState(false);
  const [sendBusy, setSendBusy] = useState(false);
  const [liveSendPending, setLiveSendPending] = useState(false);
  const [cleanupBusy, setCleanupBusy] = useState(false);
  const [result, setResult] = useState<{ label: string; tone: ChipTone; detail?: string } | null>(null);
  const [testMessage, setTestMessage] = useState<{ tone: ChipTone; message: string } | null>(null);
  const [supportedLocales, setSupportedLocales] = useState<string[]>([]);
  const [desktopListening, setDesktopListening] = useState(false);
  const [lastDetectedLanguage, setLastDetectedLanguage] = useState<string | null>(null);
  const styles = useMemo(() => createStyles(palette), [palette]);

  const [cloudSignedIn, setCloudSignedIn] = useState<boolean | null>(null);
  useEffect(() => {
    if (!supabase) { setCloudSignedIn(false); return; }
    let active = true;
    void supabase.auth.getSession().then(({ data }) => { if (active) setCloudSignedIn(Boolean(data.session)); });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => setCloudSignedIn(Boolean(session)));
    return () => { active = false; listener.subscription.unsubscribe(); };
  }, []);
  const capability: CleanupCapability = useMemo(() => {
    if (cloudSignedIn === null) return { available: false, requiresSignIn: true, maxChars: 2000, reason: "Checking your Cursor Flow account..." };
    if (!cloudSignedIn) return { available: false, requiresSignIn: true, maxChars: 2000, reason: "Sign in to your Cursor Flow account to use AI Clean-up. Original text and typing are unaffected." };
    return { available: true, requiresSignIn: true, maxChars: 2000, reason: null };
  }, [cloudSignedIn]);

  const relay: VerifiedRelayConnection | null = relaySuspended ? null : relayConnection;
  const relayRef = useRef(relay);
  relayRef.current = relay;
  const deviceRef = useRef(device);
  deviceRef.current = device;
  // Live Draft: on by default when paired. Phone is the main controller.
  const [liveOn, setLiveOn] = useState(true);
  const [oldPcNoticeSeen, setOldPcNoticeSeen] = useState(true);
  const caretRef = useRef({ start: 0, end: 0 });
  const [forcedCaret, setForcedCaret] = useState<{ start: number; end: number } | undefined>(undefined);
  useEffect(() => {
    void AsyncStorage.multiGet(["cf.liveDraft.on", "cf.liveDraft.oldPcSeen"]).then(([on, seen]) => {
      if (on[1] === "0") setLiveOn(false);
      setOldPcNoticeSeen(seen[1] === "1");
    }).catch(() => undefined);
  }, []);
  // Vocabulary saved on the PC or the account applies here too, without opening Controls.
  const accountVocabulary = trpc.voice.vocabulary.get.useQuery(undefined, { staleTime: 300_000, retry: false });
  useEffect(() => {
    const data = accountVocabulary.data as { available?: boolean; snapshot?: { terms?: string[] } } | undefined;
    const terms = data?.available ? data.snapshot?.terms ?? [] : [];
    if (!terms.length) return;
    const merged = normalizeVocabulary([...(preferences.customVocabulary ?? []), ...terms]);
    if (merged.length !== (preferences.customVocabulary ?? []).length) updatePreferences({ customVocabulary: merged });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountVocabulary.data]);
  const liveRef = useRef(false);
  // Utterances the PC did not acknowledge yet. Their words sit in the draft as a
  // fallback and are re-sent with the same id, so Live Draft must not type them too.
  const [pendingUtterances, setPendingUtterances] = useState<PendingUtterance[]>([]);
  const pendingRef = useRef<PendingUtterance[]>([]);
  pendingRef.current = pendingUtterances;
  const { status: liveStatus, typing: liveTyping, flush: flushLiveDraft } = useLiveDraft({
    relay,
    enabled: liveOn && pendingUtterances.length === 0,
    hold: session?.phase === "listening" || session?.phase === "receiving",
    text: flow.draft?.currentEditedText ?? "",
    setText: (next, remote) => {
      const caret = caretRef.current;
      const moved = { start: shiftCaret(caret.start, remote), end: shiftCaret(caret.end, remote) };
      caretRef.current = moved;
      flow.updateText(next);
      setForcedCaret(moved);
      setTimeout(() => setForcedCaret(undefined), 0);
    },
  });
  liveRef.current = liveOn && liveStatus === "synced";
  // True once the PC has typed this draft live into the app in front, so Send
  // must not type the same words a second time.
  const liveTypedRef = useRef(false);
  const draftHasText = Boolean(flow.draft?.currentEditedText.trim());
  if (!draftHasText) liveTypedRef.current = false;
  else if (liveOn && liveTyping?.status === "typing") liveTypedRef.current = true;
  const flushLiveRef = useRef(flushLiveDraft);
  flushLiveRef.current = flushLiveDraft;
  useEffect(() => {
    if (liveStatus === "old_pc" && !oldPcNoticeSeen) void AsyncStorage.setItem("cf.liveDraft.oldPcSeen", "1").catch(() => undefined);
  }, [liveStatus, oldPcNoticeSeen]);
  const liveLabel = !liveOn ? "To PC cursor · Live off" : liveStatus === "synced" ? (typingLabel(liveTyping) ?? "Live · Synced with PC") : liveStatus === "syncing" ? "Live · Syncing…" : liveStatus === "connecting" ? "Live · Connecting…" : null;

  // ---- refs used by native callbacks so late events can never touch new work ----
  const sessionRef = useRef<CaptureSession | null>(null);
  const transfersRef = useRef<Transfer[]>(flow.transfers);
  const saveNowRef = useRef(flow.saveNow);
  const flowRef = useRef(flow);
  const prefsRef = useRef(preferences);
  const draftRef = useRef(flow.draft);
  const autoCleanupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const relayRepairNoticeShownRef = useRef(false);
  saveNowRef.current = flow.saveNow;
  flowRef.current = flow;
  prefsRef.current = preferences;
  draftRef.current = flow.draft;
  transfersRef.current = flow.transfers;

  useEffect(() => {
    if (openPairing === "1") setPairingOpen(true);
    if (details === "1") setConnectionOpen(true);
  }, [openPairing, details]);

  // Pairing sheet (and its camera import) loads only when the sheet is opened.
  useEffect(() => {
    if (!pairingOpen || PairingSheet) return;
    let alive = true;
    void import("@/components/flow/pairing-sheet")
      .then((mod) => {
        if (alive) setPairingSheet(() => mod.PairingSheet);
      })
      .catch((error) => console.warn("[Console] Pairing sheet unavailable", error));
    return () => {
      alive = false;
    };
  }, [pairingOpen, PairingSheet]);

  // Never touch the floating-bubble TurboModule unless the user enabled it.
  // Syncing relay prefs on every Console paint still constructed the overlay
  // native module on cold start and could abort the process on some OEMs.
  useEffect(() => {
    if (Platform.OS !== "android" || !preferences.floatingBubbleEnabled) return;
    const task = InteractionManager.runAfterInteractions(() => {
      void (async () => {
        try {
          const bubble = await import("@/lib/voice-link/floating-bubble");
          if (!bubble.isFloatingBubbleSupported()) return;
          if (relay) await bubble.syncFloatingCaptureRelay(relay);
          else await bubble.clearFloatingCaptureRelay();
          await bubble.syncFloatingCapturePreferences(preferences.language, preferences.translateOnRequest);
          await bubble.setFloatingBubbleTarget("pc");
        } catch (error) {
          console.warn("[Console] floating capture sync skipped", error);
        }
      })();
    });
    return () => {
      task.cancel?.();
    };
  }, [preferences.bubbleTarget, preferences.floatingBubbleEnabled, preferences.language, preferences.translateOnRequest, relay]);

  useEffect(() => {
    if (Platform.OS !== "android" || !preferences.floatingBubbleEnabled) return;
    let subscription: { remove: () => void } | undefined;
    const task = InteractionManager.runAfterInteractions(() => {
      void (async () => {
        try {
          const bubble = await import("@/lib/voice-link/floating-bubble");
          if (!bubble.isFloatingBubbleSupported()) return;
          const restoreBubble = async () => {
            try {
              if (!(await bubble.hasFloatingBubblePermission()) || !(await bubble.areFloatingCaptureNotificationsEnabled())) return;
              await bubble.startFloatingBubble(preferences.floatingBubbleSize);
            } catch (error) {
              console.warn("[Console] floating bubble restore skipped", error);
            }
          };
          await restoreBubble();
          subscription = AppState.addEventListener("change", (state) => {
            if (state === "active") void restoreBubble();
          });
        } catch (error) {
          console.warn("[Console] floating bubble module skipped", error);
        }
      })();
    });
    return () => {
      task.cancel?.();
      subscription?.remove();
    };
  }, [preferences.floatingBubbleEnabled, preferences.floatingBubbleSize]);

  // The timer counts from the session start. It used to reset on every session
  // update and stop once live words arrived ("receiving"), so it could sit at 0s.
  const timerSessionId = session && (session.phase === "listening" || session.phase === "receiving") ? session.id : null;
  const timerStartedAt = session?.startedAt ?? 0;
  useEffect(() => {
    if (!timerSessionId) return;
    const tick = () => setElapsedSeconds(Math.max(0, Math.floor((Date.now() - timerStartedAt) / 1000)));
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [timerSessionId, timerStartedAt]);

  // ---- desktop status: one poll drives the card, the transfer ledger and readiness ----
  const applyHandoffs = useCallback((handoffs: Awaited<ReturnType<typeof getRelayStatus>>["handoffs"]) => {
    const now = new Date().toISOString();
    for (const handoff of handoffs) {
      const matching = transfersRef.current.find((transfer) => transfer.id === handoff.id);
      if (!matching) continue;
      const updated = applyDesktopStatus(matching, { pcId: device?.id ?? "pc-unknown", status: handoff, now });
      if (updated.applied) flowRef.current.recordTransfer(updated.transfer);
      if (updated.transfer.state !== matching.state) {
        updateActivityByHandoff(handoff.id, updated.transfer.state === "insertion_verified" || updated.transfer.state === "received_by_pc" ? "delivered" : updated.transfer.state === "blocked" ? "failed" : "dispatched", updated.transfer.lastStatusMessage ?? TRANSFER_LABELS[updated.transfer.state]);
      }
    }
  }, [device?.id, updateActivityByHandoff]);

  const { connection, probe, lastError, refresh } = useRelayConnection({
    relay,
    suspended: relaySuspended,
    onSnapshot: (snapshot) => {
      setDesktopListening(snapshot.captureState?.source === "desktop" && snapshot.captureState.status === "listening");
      applyHandoffs(snapshot.handoffs);
    },
    onSessionRepair: () => {
      if (relayRepairNoticeShownRef.current) return;
      relayRepairNoticeShownRef.current = true;
      Alert.alert("Windows link needs pairing again", "This Windows relay no longer recognises the saved phone session. Create a fresh QR code in Cursor Flow for Windows, scan it once, then continue.");
    },
  });

  useEffect(() => {
    if (!relay) return;
    // Re-querying unresolved transfers on foreground is required; re-sending is not (§13.3).
    const onAppActive = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      void (async () => {
        await refresh();
        const next = await reconcileTransfers({
          transfers: transfersRef.current,
          destinationPcId: device?.id ?? "pc-unknown",
          deps: { send: async () => null, query: async () => getRelayStatus(relay) },
        });
        if (next.updated) flowRef.current.setTransfers(next.transfers);
      })();
    });
    return () => onAppActive.remove();
  }, [device?.id, refresh, relay]);

  const diagnostics = useMemo(() => diagnoseConnectionIssue({ probe: probe ? { ...probe } : null, sameSsidConfirmed: false }), [probe]);
  const activeTransfer = useMemo(() => {
    if (!flow.draft) return null;
    return flow.transfers.find((transfer) => transfer.draftId === flow.draft?.id) ?? null;
  }, [flow.draft, flow.transfers]);

  // ---- speech recognition (existing engine, new destination: the draft) ----
  const manualStopRequestedRef = useRef(false);
  const manualAccumulatedRef = useRef("");
  const manualFinalRef = useRef<string | null>(null);
  const manualLastRef = useRef<string | null>(null);
  const manualGraceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const manualRequestedRef = useRef(false);
  const lastDetectedLanguageRef = useRef<string | null>(null);
  const manualMergedRef = useRef("");
  const runCleanupRef = useRef<(() => Promise<void>) | null>(null);
  const beginRecordingRef = useRef<(() => Promise<void>) | null>(null);
  const stopRecordingRef = useRef<(() => void) | null>(null);
  // Cursor Flow Cloud is the default engine; Android recognition is the fallback.
  const cloudRecorder = useAudioRecorder(CLOUD_RECORDING_OPTIONS as never);
  const cloudActiveRef = useRef(false);
  const liveActiveRef = useRef(false);
  // Mic warm-up: the network check, sign-in check, mic permission, audio mode and recorder are
  // prepared when Home is shown, so a tap starts recording at once instead of after 1 to 2 s of checks.
  const warmRef = useRef({ online: null as boolean | null, onlineAt: 0, signedIn: null as boolean | null, signedAt: 0, mic: false, audioMode: false, prepared: false, warming: false });
  const warmMic = useCallback(() => {
    const w = warmRef.current;
    void isNetworkReachable(fetch, 3000).then((v) => { w.online = v; w.onlineAt = Date.now(); }).catch(() => undefined);
    void hasCloudSession().then((v) => { w.signedIn = v; w.signedAt = Date.now(); }).catch(() => undefined);
    void ExpoSpeechRecognitionModule.getPermissionsAsync().then((p: { granted?: boolean }) => { w.mic = Boolean(p.granted); }).catch(() => undefined);
    if (w.warming || w.prepared || sessionRef.current || cloudActiveRef.current) return;
    w.warming = true;
    void (async () => {
      try {
        if (!w.audioMode) { await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true }); w.audioMode = true; }
        const perm = await ExpoSpeechRecognitionModule.getPermissionsAsync().catch(() => null);
        // Preparing does not open the microphone; recording starts only on tap.
        if (perm?.granted && !sessionRef.current && !cloudActiveRef.current) { await cloudRecorder.prepareToRecordAsync(); w.prepared = true; }
      } catch { w.prepared = false; } finally { w.warming = false; }
    })();
  }, [cloudRecorder]);
  useFocusEffect(useCallback(() => {
    warmMic();
    const sub = AppState.addEventListener("change", (state) => { if (state === "active") warmMic(); });
    return () => sub.remove();
  }, [warmMic]));
  // Real-time editing: spoken commands ("delete the last sentence", "এই শব্দটা ভুল হয়েছে, মুছে দাও")
  // are applied on each short pause. `edited` replaces the raw text up to `baseRaw`.
  const liveEditRef = useRef({ baseRaw: "", edited: "", raw: "", seq: 0, timer: null as ReturnType<typeof setTimeout> | null, abort: null as AbortController | null });
  const [fadingWords, setFadingWords] = useState<{ id: number; words: string[] } | null>(null);
  const resetLiveEdit = useCallback(() => {
    const st = liveEditRef.current;
    if (st.timer) clearTimeout(st.timer);
    st.abort?.abort();
    liveEditRef.current = { baseRaw: "", edited: "", raw: "", seq: st.seq + 1, timer: null, abort: null };
  }, []);
  const liveEditedFrom = useCallback((raw: string) => {
    const st = liveEditRef.current;
    if (!st.baseRaw) return raw.trim();
    // The final pass may re-spell or re-punctuate earlier words. Keep the edits
    // already made instead of throwing them away when the prefix is not exact.
    const tail = rawTailAfter(st.baseRaw, raw);
    if (tail === null) { st.baseRaw = ""; st.edited = ""; return raw.trim(); }
    return joinDictation(st.edited, tail).trim();
  }, []);
  const showLiveEdited = useCallback(() => {
    const active = sessionRef.current;
    if (!active || !liveActiveRef.current) return;
    const next = { ...active, phase: "receiving" as const, partialText: applySpokenPunctuation(applySnippets(toBengaliScript(liveEditedFrom(liveEditRef.current.raw)), prefsRef.current.snippets)) };
    sessionRef.current = next;
    setSession(next);
  }, [liveEditedFrom]);
  const runLiveEdit = useCallback(async (finalPass = false) => {
    const st = liveEditRef.current;
    const raw = st.raw;
    let segment = raw.trim();
    if (st.baseRaw) {
      const tail = rawTailAfter(st.baseRaw, raw);
      if (tail === null) { st.baseRaw = ""; st.edited = ""; } else segment = tail;
    }
    if (!segment) return;
    const current = st.edited;
    const consume = (text: string, removed: string[]) => {
      st.baseRaw = raw;
      st.edited = text;
      if (removed.length) { setFadingWords({ id: Date.now(), words: removed }); }
      showLiveEdited();
    };
    const fast = fastLiveEdit(current, segment);
    if (fast.edited || !fast.needsLlm || finalPass) { consume(fast.text, fast.removed); return; }
    const my = ++st.seq;
    st.abort?.abort();
    const controller = new AbortController();
    st.abort = controller;
    const remote = await liveEditRemote({ text: current, segment, signal: controller.signal, timeoutMs: 1800 });
    if (my !== liveEditRef.current.seq || liveEditRef.current !== st || !liveActiveRef.current) return;
    const checked = remote?.edited ? validateLiveEdit(current, segment, remote.text) : null;
    if (checked !== null) consume(checked, remote?.removed ?? []);
    else consume(fast.text, []);
  }, [showLiveEdited]);
  const sentRouteRef = useRef<"wifi" | "internet" | null>(null);
  const [liveNotice, setLiveNotice] = useState<string | null>(null);
  useEffect(() => onLiveMicStatus((status) => {
    if (!liveActiveRef.current) return;
    setLiveNotice(liveMicStatusText(status));
  }), []);
  useEffect(() => onLiveMicText((text) => {
    const active = sessionRef.current;
    if (!active || !liveActiveRef.current || !text.trim()) return;
    const st = liveEditRef.current;
    st.raw = text;
    showLiveEdited();
    if (st.timer) clearTimeout(st.timer);
    st.timer = setTimeout(() => { void runLiveEdit(); }, 700);
  }), [runLiveEdit, showLiveEdited]);
  const cloudFallbackUntilRef = useRef(0);
  const audioRetryRef = useRef(false);
  // Noise gate input: recording length, voiced time from the meter, recognizer confidence.
  const speechSignalRef = useRef<SpeechSignal>({});
  const meterRef = useRef({ samples: 0, voicedMs: 0, timer: null as ReturnType<typeof setInterval> | null });
  const confidenceRef = useRef<number | null>(null);
  const stopMeter = useCallback(() => {
    const m = meterRef.current;
    if (m.timer) clearInterval(m.timer);
    m.timer = null;
    // Without enough meter readings the voiced time is unknown, never zero.
    return m.samples >= 5 ? m.voicedMs : null;
  }, []);
  const stopMeterRef = useRef(stopMeter);
  const deliverRef = useRef<((text: string, cleaned: boolean, startedAt: number) => Promise<void>) | null>(null);
  const cleanedRef = useRef(false);
  /** Stops the meter and a cloud recorder that is still recording, so the mic is free. */
  const stopStrayRecorder = useCallback(async () => {
    stopMeter();
    try {
      if (cloudRecorder.getStatus().isRecording) await cloudRecorder.stop();
    } catch { /* not recording */ }
  }, [cloudRecorder, stopMeter]);

  const commitFinalTranscript = useCallback(async (incoming: string) => {
    const rawText = ensureBanglaScript(incoming, prefsRef.current.language);
    const words = applySpokenPunctuation(prefsRef.current.cleanAndFormatSpeech ? applyAllCommands(tier1Cleanup(fastFinish(rawText)) || fastFinish(rawText)) : rawText);
    let text = applyVocabulary(applySnippets(words, prefsRef.current.snippets), prefsRef.current.customVocabulary ?? []);
    resetLiveEdit();
    const active = sessionRef.current;
    const signal = speechSignalRef.current;
    speechSignalRef.current = {};
    if (!active || !text.trim() || shouldDropFinal(text, signal)) {
      // Nothing to commit (or only noise such as "Tik"): leave Finishing so the mic
      // never sticks, and clear the live line so no stray words stay on screen.
      sessionRef.current = null;
      setSession(null);
      if (active) flowRef.current.endRecording(null);
      manualRequestedRef.current = false;
      manualStopRequestedRef.current = false;
      manualAccumulatedRef.current = "";
      manualFinalRef.current = null;
      manualLastRef.current = null;
      return;
    }
    // One fixed cleanup rule: short text keeps the light local formatting above,
    // long text goes to the cloud cleanup. Signed-out or offline keeps the local text.
    let cleaned = Boolean(prefsRef.current.cleanAndFormatSpeech) && text !== rawText.trim();
    if (prefsRef.current.cleanAndFormatSpeech && cleanupRouteFor(text) === "cloud") {
      const prefs = prefsRef.current;
      const cloud = await withTimeout(cleanupLiveText({ text, language: prefs.language, vocabulary: prefs.customVocabulary ?? [], formatStyle: styledFormat(prefs), timeoutMs: CLOUD_CLEANUP_BUDGET_MS }), CLOUD_CLEANUP_BUDGET_MS, text);
      if (sessionRef.current?.id !== active.id) return;
      if (cloud.trim() && cloud.trim() !== text.trim()) { text = cloud.trim(); cleaned = true; }
    }
    cleanedRef.current = cleaned;
    void recordDictation(text);
    // Live mode with a paired PC: the finished words go straight to the PC in the
    // background. The draft box is used only if the PC cannot be reached.
    if (!prefsRef.current.reviewBeforeSending && deviceRef.current && relayRef.current && deliverRef.current) {
      sessionRef.current = null;
      setSession(null);
      flowRef.current.endRecording(null);
      manualRequestedRef.current = false;
      manualStopRequestedRef.current = false;
      manualAccumulatedRef.current = "";
      manualFinalRef.current = null;
      manualLastRef.current = null;
      manualMergedRef.current = "";
      haptic("success");
      void deliverRef.current(text, cleaned, active.startedAt);
      return;
    }
    flowRef.current.commitRecognition({ sessionId: active.id, text, isFinal: true, detectedLanguage: lastDetectedLanguageRef.current });
    // The words are in the draft now; drop the live line so it never lingers below.
    setSession(null);
    sessionRef.current = null;
    flowRef.current.endRecording(null);
    manualRequestedRef.current = false;
    manualAccumulatedRef.current = "";
    manualFinalRef.current = null;
    manualLastRef.current = null;
    const merged = [manualMergedRef.current].filter(Boolean).join(" ").trim();
    manualMergedRef.current = "";
    haptic("success");
    await flowRef.current.saveNow();
    if (prefsRef.current.reviewBeforeSending) addActivity({
      durationSeconds: Math.max(1, Math.round((Date.now() - active.startedAt) / 1000)),
      status: "transcribed",
      language: prefsRef.current.language === "Auto-detect" ? lastDetectedLanguageRef.current ?? "Auto-detect" : prefsRef.current.language,
      translateOnRequest: prefsRef.current.translateOnRequest,
      text: merged || text,
      summary: `Draft updated on this phone: ${merged || text.trim()}`,
    });
    if (!prefsRef.current.reviewBeforeSending) {
      // Live mode: the finished words go straight to the PC cursor.
      setLiveSendPending(true);
      return;
    }
    setResult({ label: "In draft", tone: "neutral", detail: cleaned ? "Cleaned up. Tap Send when ready." : "Tap Send when ready." });
    if (prefsRef.current.cleanAndFormatSpeech && prefsRef.current.smartCleanupEnabled && prefsRef.current.smartCleanupAfterVoice && prefsRef.current.smartConsentAccepted) {
      if (autoCleanupTimerRef.current) clearTimeout(autoCleanupTimerRef.current);
      autoCleanupTimerRef.current = setTimeout(() => void runCleanupRef.current?.(), 260);
    }
  }, [addActivity]);

  const finishRecognition = useCallback(() => {
    if (manualGraceRef.current) clearTimeout(manualGraceRef.current);
    manualGraceRef.current = null;
    const finalSegment = manualFinalRef.current ?? (manualStopRequestedRef.current ? manualLastRef.current : null);
    const merged = [manualAccumulatedRef.current, finalSegment?.trim() ?? ""].filter(Boolean).join(" ").trim();
    manualMergedRef.current = merged;
    manualStopRequestedRef.current = false;
    const sessionStart = sessionRef.current?.startedAt;
    speechSignalRef.current = { durationMs: sessionStart ? Date.now() - sessionStart : null, voicedMs: null, confidence: confidenceRef.current };
    confidenceRef.current = null;
    if (merged) void commitFinalTranscript(merged);
    else {
      const active = sessionRef.current;
      if (active) {
        setSession({ ...active, phase: manualRequestedRef.current ? "cancelled" : "completed" });
        sessionRef.current = null;
      }
      manualRequestedRef.current = false;
      flowRef.current.endRecording(null);
      setRecognitionError("No final transcript was returned. Speak a little longer, then tap to finish.");
      haptic("error");
    }
  }, [commitFinalTranscript]);

  useSpeechRecognitionEvent("result", (event) => {
    const active = sessionRef.current;
    if (!active || !manualRequestedRef.current) return;
    const transcript = finalTranscriptFromResults(event.results);
    if (!transcript) return;
    const confidence = (event.results as { confidence?: number }[] | undefined)?.[0]?.confidence;
    if (event.isFinal && typeof confidence === "number" && confidence > 0) confidenceRef.current = confidence;
    manualLastRef.current = transcript;
    if (event.isFinal) {
      manualFinalRef.current = transcript;
      setSession({ ...active, phase: manualStopRequestedRef.current ? "finalizing" : "receiving", finalText: transcript, partialText: "" });
      if (manualStopRequestedRef.current) finishRecognition();
      return;
    }
    // Provisional only: preview in the composer, never committed text (§8.3).
    setSession({ ...active, phase: "receiving", partialText: applySnippets([manualAccumulatedRef.current, transcript].filter(Boolean).join(" ").trim(), prefsRef.current.snippets) });
  }, speechListenersArmed);

  useSpeechRecognitionEvent("languagedetection", (event) => {
    if (!manualRequestedRef.current) return;
    const label = detectedLanguageLabel(event.detectedLanguage);
    lastDetectedLanguageRef.current = label;
    setLastDetectedLanguage(label);
  }, speechListenersArmed);

  useSpeechRecognitionEvent("error", (event) => {
    if (!manualRequestedRef.current) return;
    if (event.error === "no-speech" || event.error === "speech-timeout") {
      if (manualLastRef.current?.trim()) {
        manualAccumulatedRef.current = [manualAccumulatedRef.current, manualLastRef.current.trim()].filter(Boolean).join(" ").trim();
        manualLastRef.current = null;
        // That segment is now in the accumulated text; keeping it as the final segment too doubled it.
        manualFinalRef.current = null;
      }
      return;
    }
    if (event.error === "aborted" || event.error === "no-match") {
      // Benign: our own abort() before start, or a pause with nothing matched.
      if (manualStopRequestedRef.current) finishRecognition();
      return;
    }
    if ((event.error === "audio-capture" || event.error === "client" || event.error === "busy" || event.error === "interrupted") && !audioRetryRef.current && !manualStopRequestedRef.current) {
      // The mic was still held by another recorder. Release ours and retry once.
      audioRetryRef.current = true;
      try { ExpoSpeechRecognitionModule.abort(); } catch { /* nothing active */ }
      const retryOptions = createManualRecognitionOptions(prefsRef.current.language, prefsRef.current.keepAudioLocal, supportedLocales, prefsRef.current.noiseReductionEnabled, false);
      setTimeout(() => {
        if (!manualRequestedRef.current) return;
        try { ExpoSpeechRecognitionModule.start(retryOptions); } catch { /* handled by the next error event */ }
      }, 600);
      return;
    }
    if ((manualAccumulatedRef.current || manualLastRef.current || manualFinalRef.current)?.trim() && event.error !== "not-allowed") {
      // Keep what was already heard instead of failing the whole capture.
      finishRecognition();
      return;
    }
    manualRequestedRef.current = false;
    if (manualGraceRef.current) clearTimeout(manualGraceRef.current);
    manualGraceRef.current = null;
    const active = sessionRef.current;
    if (active) {
      setSession({ ...active, phase: "failed", error: event.error });
      sessionRef.current = null;
    }
    flowRef.current.endRecording(null);
    setRecognitionError(event.error);
    haptic("error");
    if (event.error === "not-allowed") {
      Alert.alert("Microphone access is off", "Allow it in Settings, then tap the mic again.");
    }
  }, speechListenersArmed);

  useSpeechRecognitionEvent("end", () => {
    if (!manualRequestedRef.current) return;
    if (manualStopRequestedRef.current) {
      finishRecognition();
      return;
    }
    // Recognizer restarts stay inside one capture session so a restart cannot
    // drop completed segments; the accumulated text is preserved either way.
    if (manualLastRef.current?.trim()) {
      manualAccumulatedRef.current = [manualAccumulatedRef.current, manualLastRef.current.trim()].filter(Boolean).join(" ").trim();
      manualLastRef.current = null;
      manualFinalRef.current = null;
    }
  }, speechListenersArmed);

  const beginRecording = useCallback(async () => {
    const existing = sessionRef.current;
    if (existing) {
      // A leftover session after a failed finish used to block every later tap
      // (first tap worked, the next "start" looked like it only stopped).
      if (existing.phase === "listening" || existing.phase === "receiving" || existing.phase === "finalizing" || existing.phase === "preparing" || existing.phase === "requesting_permission") {
        return;
      }
      sessionRef.current = null;
      setSession(null);
    }
    setSpeechListenersArmed(true);
    const warm = warmRef.current;
    const permission = warm.mic ? { granted: true } : await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (permission.granted) warm.mic = true;
    if (!permission.granted) {
      setRecognitionError("microphone-permission");
      flowRef.current.endRecording(null);
      Alert.alert("Speech access is needed", "Allow microphone access so Cursor Flow can recognize speech on your phone.");
      haptic("error");
      return;
    }
    audioRetryRef.current = false;
    // Make sure no earlier recognizer session still holds the microphone.
    try { ExpoSpeechRecognitionModule.abort(); } catch { /* nothing active */ }
    // Cached checks from the warm-up (online is trusted for 60 s, offline for 5 s); refreshed in the background.
    const onlineFresh = warm.online !== null && Date.now() - warm.onlineAt < (warm.online ? 60_000 : 5_000);
    const online = onlineFresh ? Boolean(warm.online) : await isNetworkReachable(fetch, 2500).catch(() => false);
    const signedFresh = warm.signedIn === true && Date.now() - warm.signedAt < 5 * 60_000;
    const signedIn = async () => (signedFresh ? true : await hasCloudSession().catch(() => false));
    void isNetworkReachable(fetch, 3000).then((v) => { warm.online = v; warm.onlineAt = Date.now(); }).catch(() => undefined);
    if (online && !prefsRef.current.keepAudioLocal && Date.now() > cloudFallbackUntilRef.current && (await signedIn())) {
      const captureId = `cap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const created = { id: captureId, draftId: draftRef.current?.id ?? "draft", startedAt: Date.now(), phase: "preparing" as const, partialText: "", finalText: "", detectedLanguage: null, error: null };
      // Main indicator records a clip, then submits it once after stop. Live STT is keyboard-only.
      setLiveNotice(null);
      try {
        if (!warm.audioMode) { await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true }); warm.audioMode = true; }
        // A recorder still running from an earlier capture (watchdog, error) holds the
        // mic and makes this one close at once. Free it first.
        if (!warm.prepared) await stopStrayRecorder();
        let started = false;
        if (warm.prepared) {
          warm.prepared = false;
          try { cloudRecorder.record(); started = true; } catch { started = false; }
        }
        if (!started) {
          await cloudRecorder.prepareToRecordAsync();
          cloudRecorder.record();
        }
        cloudActiveRef.current = true;
        // Voiced time for the noise gate, read from the recorder meter.
        stopMeter();
        meterRef.current = { samples: 0, voicedMs: 0, timer: setInterval(() => {
          // Never read the recorder once this capture ended: a status read while
          // the recorder stops on the main thread can crash the app.
          if (!cloudActiveRef.current) { stopMeter(); return; }
          try {
            const db = (cloudRecorder.getStatus() as { metering?: number }).metering;
            if (typeof db !== "number") return;
            meterRef.current.samples += 1;
            if (levelFromDb(db) > 0.1) meterRef.current.voicedMs += 100;
          } catch { /* recorder gone */ }
        }, 100) };
        setRecognitionError(null);
        setElapsedSeconds(0);
        sessionRef.current = { ...created, phase: "listening" };
        setSession({ ...created, phase: "listening" });
        flowRef.current.beginRecording({ sessionId: captureId, requestedLanguage: prefsRef.current.language });
        haptic("start");
        return;
      } catch {
        cloudActiveRef.current = false;
        stopMeter();
        try { await cloudRecorder.stop(); } catch { /* not started */ }
        // Fall through to Android recognition.
      }
    }
    if (!ExpoSpeechRecognitionModule.isRecognitionAvailable()) {
      setRecognitionError("no-recognizer");
      Alert.alert("No speech service", "This Android device has no speech recognition service available. You can still type your draft.");
      return;
    }
    let localesForStart = supportedLocales;
    try {
      const loaded = await ExpoSpeechRecognitionModule.getSupportedLocales({});
      localesForStart = loaded.locales ?? [];
      setSupportedLocales(localesForStart);
    } catch {
      localesForStart = [];
      setSupportedLocales([]);
    }
    const networkReachable = await isNetworkReachable().catch(() => false);
    const speechRoute = chooseSpeechRoute({
      networkReachable,
      localModel: { installed: false, active: false, path: null },
    });
    const forceOnDevice = speechRoute !== "cloud";
    const captureId = `cap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    manualRequestedRef.current = true;
    manualStopRequestedRef.current = false;
    manualAccumulatedRef.current = "";
    manualFinalRef.current = null;
    manualLastRef.current = null;
    confidenceRef.current = null;
    setRecognitionError(null);
    setElapsedSeconds(0);
    const created = { id: captureId, draftId: draftRef.current?.id ?? "draft", startedAt: Date.now(), phase: "preparing" as const, partialText: "", finalText: "", detectedLanguage: null, error: null };
    sessionRef.current = created;
    setSession(created);
    flowRef.current.beginRecording({ sessionId: captureId, requestedLanguage: prefsRef.current.language });
    try {
      ExpoSpeechRecognitionModule.start(createManualRecognitionOptions(prefsRef.current.language, prefsRef.current.keepAudioLocal, localesForStart, prefsRef.current.noiseReductionEnabled, forceOnDevice));
      setSession({ ...created, phase: "listening" });
      sessionRef.current = { ...created, phase: "listening" };
      haptic("start");
    } catch {
      manualRequestedRef.current = false;
      sessionRef.current = null;
      setSession({ ...created, phase: "failed", error: "start-failed" });
      flowRef.current.endRecording(null);
      haptic("error");
    }
  }, [supportedLocales, cloudRecorder, stopMeter, stopStrayRecorder]);

  const finishCloudRecording = useCallback(async () => {
    const active = sessionRef.current;
    cloudActiveRef.current = false;
    warmRef.current.prepared = false;
    if (!active) return;
    setSession({ ...active, phase: "finalizing" });
    sessionRef.current = { ...active, phase: "finalizing" };
    const recordedMs = Date.now() - active.startedAt;
    const voicedMs = stopMeter();
    try {
      await cloudRecorder.stop();
      const uri = cloudRecorder.uri;
      if (!uri) throw new CloudDictationError("empty", "empty");
      // A tap that was over before any speech could start is not sent at all.
      if (recordedMs < 450 || (voicedMs === 0 && meterRef.current.samples >= 10)) throw new CloudDictationError("empty", "empty");
      const prefs = prefsRef.current;
      const raw = await transcribeRecordingWithCloud({
        uri,
        durationMs: recordedMs,
        language: prefs.language,
        vocabulary: prefs.customVocabulary ?? [],
        formatStyle: styledFormat(prefs),
        cleanAndFormat: false,
      });
      if (sessionRef.current?.id !== active.id) return;
      // Transcription can take longer; cleanup has its own strict 1.2 s budget.
      // Show the authoritative submitted-audio words immediately, before formatting.
      sessionRef.current = { ...active, phase: "finalizing", finalText: raw, partialText: "" };
      setSession(sessionRef.current);
      // Cleanup runs once in commitFinalTranscript with the fixed short/long rule.
      if (sessionRef.current?.id !== active.id) return;
      manualMergedRef.current = raw;
      speechSignalRef.current = { durationMs: recordedMs, voicedMs, confidence: null };
      await commitFinalTranscript(raw);
    } catch (error) {
      if (sessionRef.current?.id !== active.id) return;
      const kind = error instanceof CloudDictationError ? error.kind : "failed";
      if (kind === "credit" || kind === "quota") cloudFallbackUntilRef.current = Date.now() + 10 * 60_000;
      sessionRef.current = null;
      setSession({ ...active, phase: "failed", error: kind });
      flowRef.current.endRecording(null);
      if (kind === "empty") {
        // Silence or a very short tap: nothing to send, and no error to explain.
        setSession(null);
        setResult({ label: "No words heard", tone: "neutral" });
        return;
      }
      haptic("error");
      const message = kind === "credit"
          ? "Cursor Flow Cloud is paused right now. Tap the mic to try again."
          : kind === "quota"
            ? error instanceof Error && error.message === "subscription_inactive"
              ? "This account has no active Cursor Flow plan. Check which account you are signed in with."
              : error instanceof Error && error.message === "rate_limited"
                ? "Too many requests right now. Wait a moment, then tap the mic."
                : "You have used this period's cloud minutes. Tap the mic to try again."
            : kind === "auth"
              ? "Sign in again to use Cursor Flow Cloud. Tap the mic to try again."
              : "Cursor Flow Cloud could not finish this time. Tap the mic again to use on-device recognition.";
      setRecognitionError(message);
    }
  }, [cloudRecorder, commitFinalTranscript, stopMeter]);

  const stopRecording = useCallback(() => {
    if (cloudActiveRef.current) {
      void finishCloudRecording();
      return;
    }
    if (!manualRequestedRef.current) return;
    manualStopRequestedRef.current = true;
    try {
      ExpoSpeechRecognitionModule.stop();
    } catch {
      finishRecognition();
      return;
    }
    setSession((current) => (current ? { ...current, phase: "finalizing" } : current));
    if (manualGraceRef.current) clearTimeout(manualGraceRef.current);
    manualGraceRef.current = setTimeout(() => {
      if (manualRequestedRef.current && manualStopRequestedRef.current) finishRecognition();
    }, 2500);
  }, [finishRecognition, finishCloudRecording]);

  const cancelRecording = useCallback(() => {
    stopMeter();
    if (cloudActiveRef.current) {
      cloudActiveRef.current = false;
      if (liveActiveRef.current) { liveActiveRef.current = false; cancelLiveMic(); }
      else void cloudRecorder.stop().catch(() => undefined);
    }
    manualRequestedRef.current = false;
    manualStopRequestedRef.current = false;
    if (manualGraceRef.current) clearTimeout(manualGraceRef.current);
    manualGraceRef.current = null;
    manualAccumulatedRef.current = "";
    manualFinalRef.current = null;
    manualLastRef.current = null;
    try {
      ExpoSpeechRecognitionModule.abort();
    } catch {
      /* No native session was active. */
    }
    sessionRef.current = null;
    setSession(null);
    flowRef.current.cancelRecording();
    setRecognitionError(null);
  }, [cloudRecorder, stopMeter]);

  beginRecordingRef.current = beginRecording;
  stopRecordingRef.current = stopRecording;
  // Voice level for the listening waveform, read from the recorder's meter.
  const getMicLevel = useCallback(() => {
    if (!cloudActiveRef.current || liveActiveRef.current) return 0;
    try { return levelFromDb((cloudRecorder.getStatus() as { metering?: number }).metering); } catch { return 0; }
  }, [cloudRecorder]);
  // Re-arm the recorder once a capture has fully finished so the next tap is instant too.
  const sessionIdle = !session || session.phase === "idle" || session.phase === "completed" || session.phase === "cancelled" || session.phase === "failed";
  useEffect(() => {
    if (!sessionIdle) return;
    const t = setTimeout(() => { if (!sessionRef.current && !cloudActiveRef.current) warmMic(); }, 1200);
    return () => clearTimeout(t);
  }, [sessionIdle, warmMic]);

  // Watchdog: Finishing must always end. If a callback was missed, commit what was heard.
  const finalizingId = session?.phase === "finalizing" ? session.id : null;
  useEffect(() => {
    if (!finalizingId) return;
    const t = setTimeout(() => {
      const active = sessionRef.current;
      if (!active || active.id !== finalizingId) return;
      const heard = liveEditedFrom(liveEditRef.current.raw) || manualAccumulatedRef.current || active.finalText || active.partialText || "";
      cloudActiveRef.current = false;
      // Free the mic too, or the next tap opens and closes at once.
      void stopStrayRecorder();
      if (liveActiveRef.current) { liveActiveRef.current = false; cancelLiveMic(); }
      void commitFinalTranscript(heard);
    }, 25000); // audio upload/transcription watchdog only; cleanup is independently capped at 1200 ms
    return () => clearTimeout(t);
  }, [finalizingId, commitFinalTranscript, liveEditedFrom, stopStrayRecorder]);

  // The optional overlay bubble asks the app to start or stop capture.
  useEffect(() => {
    const startFromBubble = (url: string | null) => {
      if (!url?.includes("voiceCapture=1")) return;
      setRecognitionError(null);
      if (sessionRef.current) {
        stopRecordingRef.current?.();
        return;
      }
      setTimeout(() => void beginRecordingRef.current?.(), 180);
    };
    void Linking.getInitialURL().then(startFromBubble);
    const subscription = Linking.addEventListener("url", ({ url }) => startFromBubble(url));
    return () => subscription.remove();
  }, []);

  useEffect(() => () => {
    manualRequestedRef.current = false;
    sessionRef.current = null;
    cloudActiveRef.current = false;
    stopMeterRef.current();
    if (manualGraceRef.current) clearTimeout(manualGraceRef.current);
    if (autoCleanupTimerRef.current) clearTimeout(autoCleanupTimerRef.current);
    try {
      ExpoSpeechRecognitionModule.abort();
    } catch {
      /* No native session was active. */
    }
  }, []);

  // ---- Smart cleanup ----
  const runCleanup = useCallback(async () => {
    const draft = draftRef.current;
    if (!draft) return;
    const text = draft.currentEditedText;
    if (!text.trim()) return;
    if (!prefsRef.current.smartCleanupEnabled) return;
    if (!prefsRef.current.smartConsentAccepted) {
      setConsentOpen(true);
      return;
    }
    const sourceRevision = draft.revision;
    await saveNowRef.current();
    flowRef.current.startCleanup();
    setCleanupBusy(true);
    const outcome = await runSmartCleanup({
      draft,
      sourceText: text,
      sourceRevision,
      enabled: true,
      consented: prefsRef.current.smartConsentAccepted,
      capability,
      operationId: `op-${Date.now().toString(36)}`,
      language: prefsRef.current.language,
      vocabulary: prefsRef.current.customVocabulary,
      formatStyle: styledFormat(prefsRef.current) as typeof prefsRef.current.formatStyle,
      transport: (request) => cloudCleanup(request),
    });
    setCleanupBusy(false);
    if (outcome.status === "applied") {
      flowRef.current.holdCleanup({ text: outcome.text, reason: "", safetyOk: true, sourceRevision });
      setResult({ label: "Smart version ready", tone: "good", detail: "Review it, then send." });
      return;
    }
    if (outcome.status === "held") {
      flowRef.current.holdCleanup({ text: outcome.text, reason: outcome.reason, safetyOk: false, sourceRevision });
      setResult({ label: "Smart needs review", tone: "warn", detail: outcome.reason });
      return;
    }
    const reason = outcome.status === "skipped" ? outcome.reason : outcome.status === "failed" ? outcome.reason : outcome.reason;
    flowRef.current.failCleanupRun(reason);
    setResult({ label: "Smart did not run", tone: "warn", detail: reason });
  }, [capability]);

  runCleanupRef.current = runCleanup;

  // ---- Home Detection: finished words go straight to the PC ----
  const utteranceRoutesRef = useRef(new Map<string, "wifi" | "internet">());
  const sendUtterance = useCallback(async (id: string, text: string, startedAt: number | null): Promise<UtteranceAck | null> => {
    const target = relayRef.current;
    if (!target) throw new Error("Your PC is not connected.");
    const prefs = prefsRef.current;
    const action = prefs.listeningMode === "action" || resolveQuickStartShortcut(text, prefs.quickStartShortcuts ?? [])
      ? createActionEnvelope({ id, createdAt: new Date().toISOString(), source: "voice", language: prefs.language, text, quickStartShortcuts: prefs.quickStartShortcuts })
      : undefined;
    // The utterance id is the handoff id and the idempotency key on every route and retry.
    const handoffInput = {
      id, text, translateOnRequest: prefs.translateOnRequest, timing: createRecognitionTiming(startedAt, Date.now()), action,
      transferId: id, destinationPcId: deviceRef.current?.id, deliveryMode: "relay_input" as const,
    };
    const { getConnectionRoute, pickRoute, forgetLanRoute } = await import("@/lib/voice-link/route-pick");
    const senders = {
      wifi: () => sendRelayText({ ...target, ...handoffInput }),
      internet: () => sendCloudRelayText({ cloudRelay: target.cloudRelay!, ...handoffInput }),
    };
    // One utterance sticks to one route. Older PCs only dedupe within a route, so a retry
    // after a lost answer must go the same way. Auto switches only when the first route
    // surely never reached the PC.
    const routes = utteranceRoutesRef.current;
    const pinned = routes.get(id);
    let route: "wifi" | "internet";
    let response: Awaited<ReturnType<typeof senders.wifi>> | Awaited<ReturnType<typeof senders.internet>>;
    if (pinned) {
      route = pinned;
      response = await senders[pinned]();
    } else {
      const pref = await getConnectionRoute();
      route = await pickRoute(target, pref);
      routes.set(id, route);
      try {
        response = await senders[route]();
      } catch (error) {
        forgetLanRoute();
        const other = route === "wifi" ? "internet" : "wifi";
        const cloudOk = Boolean(target.cloudRelay && Date.parse(target.cloudRelay.expiresAt) > Date.now());
        if (pref !== "auto" || (other === "internet" && !cloudOk) || !neverReachedPc(error)) throw error;
        route = other;
        routes.set(id, route);
        response = await senders[route]();
      }
    }
    const handoff = response?.handoff;
    return { id: handoff?.id ?? id, status: handoff?.status, route };
  }, []);

  const savePending = useCallback((raw: PendingUtterance[]) => {
    const next = raw.map((item) => ({ ...item, route: item.route ?? utteranceRoutesRef.current.get(item.id) }));
    next.forEach((item) => { if (item.route) utteranceRoutesRef.current.set(item.id, item.route); });
    pendingRef.current = next;
    setPendingUtterances(next);
    void AsyncStorage.setItem("cf.pendingUtterances.v1", JSON.stringify(next.slice(-20))).catch(() => undefined);
  }, []);
  useEffect(() => {
    void AsyncStorage.getItem("cf.pendingUtterances.v1").then((raw) => {
      const list = raw ? (JSON.parse(raw) as PendingUtterance[]) : [];
      if (Array.isArray(list) && list.length) savePending(list.filter((item) => item && typeof item.id === "string" && typeof item.text === "string"));
    }).catch(() => undefined);
  }, [savePending]);

  const deliverInBackground = useCallback(async (text: string, cleaned: boolean, startedAt: number) => {
    const id = createUtteranceId();
    const pcName = deviceRef.current?.name ?? "your PC";
    const mark = cleaned ? "Cleaned up" : undefined;
    setResult({ label: "Sending to PC", tone: "neutral", detail: mark });
    console.info(`[CursorFlowSend] utterance=${id} chars=${text.length}`);
    const outcome = await deliverUtterance({ id, text, send: (uid, words) => sendUtterance(uid, words, startedAt), attempts: 2, backoffMs: 600 });
    const language = prefsRef.current.language === "Auto-detect" ? lastDetectedLanguageRef.current ?? "Auto-detect" : prefsRef.current.language;
    if (outcome.ok) {
      utteranceRoutesRef.current.delete(id);
      addActivity({ handoffId: id, durationSeconds: Math.max(1, Math.round((Date.now() - startedAt) / 1000)), status: "delivered", language, translateOnRequest: prefsRef.current.translateOnRequest, text, summary: `Sent to ${pcName}` });
      const via = outcome.ack.route === "internet" ? "Internet" : outcome.ack.route === "wifi" ? "Wi-Fi" : null;
      setResult({ label: via ? `Delivered to PC via ${via}` : "Delivered to PC", tone: "good", detail: mark });
      return;
    }
    // PC unreachable: keep the words in the draft and retry later with the same id.
    savePending([...pendingRef.current, { id, text, createdAt: Date.now(), attempts: outcome.attempts }]);
    const current = draftRef.current?.currentEditedText ?? "";
    flowRef.current.updateText(current.trim() ? joinDictation(current.trim(), text) : text);
    addActivity({ handoffId: id, durationSeconds: 0, status: "transcribed", language, translateOnRequest: prefsRef.current.translateOnRequest, text, summary: `Saved on this phone for ${pcName}: ${outcome.error}` });
    setResult({ label: "Saved in draft", tone: "warn", detail: "Your PC did not answer. It is sent once, by itself, when the PC is back." });
    haptic("error");
  }, [addActivity, savePending, sendUtterance]);
  deliverRef.current = deliverInBackground;

  // Retry pending utterances with their own ids; on the PC's ack, take the words out of the draft.
  const retryingRef = useRef(false);
  const retryPending = useCallback(async () => {
    if (retryingRef.current || !relayRef.current || !pendingRef.current.length) return;
    retryingRef.current = true;
    try {
      // Words the user edited or removed are theirs now; they go with a normal Send.
      const kept = prunePending(pendingRef.current, draftRef.current?.currentEditedText ?? "");
      if (kept.length !== pendingRef.current.length) savePending(kept);
      for (const item of kept) {
        const outcome = await deliverUtterance({ id: item.id, text: item.text, send: (uid, words) => sendUtterance(uid, words, null), attempts: 1 });
        if (!outcome.ok) {
          savePending(pendingRef.current.map((p) => (p.id === item.id ? { ...p, attempts: p.attempts + 1 } : p)));
          break;
        }
        savePending(pendingRef.current.filter((p) => p.id !== item.id));
        utteranceRoutesRef.current.delete(item.id);
        const left = removeDeliveredText(draftRef.current?.currentEditedText ?? "", item.text);
        if (left !== null) flowRef.current.updateText(left);
        updateActivityByHandoff(item.id, "delivered", "Sent after the PC came back");
        setResult({ label: "Delivered to PC", tone: "good", detail: "Sent once the PC was back, and cleared from the draft." });
      }
    } finally {
      retryingRef.current = false;
    }
  }, [savePending, sendUtterance, updateActivityByHandoff]);
  useEffect(() => {
    if (!pendingUtterances.length || !relay) return;
    void retryPending();
    const timer = setInterval(() => void retryPending(), 5000);
    const sub = AppState.addEventListener("change", (state) => { if (state === "active") void retryPending(); });
    return () => { clearInterval(timer); sub.remove(); };
  }, [pendingUtterances.length, relay, connection.canDeliver, retryPending]);

  // ---- sending ----
  const handleSend = useCallback(async () => {
    const draft = draftRef.current;
    if (!draft) return;
    // A manual Send carries every word in the box, so pending fallback words are
    // no longer re-sent on their own (that would type them twice).
    // Saved too, so a restart cannot bring them back and send them a second time.
    if (pendingRef.current.length) savePending([]);
    const localReason = !device
      ? "No PC is paired yet."
      : relaySuspended
        ? "Your PC is disconnected. Reconnect to send."
        : connection.state === "pc_locked"
          ? "Your PC is locked. Unlock it, then tap Retry."
          : "Your PC did not answer. Tap Retry when it is on.";
    if (!relay) {
      await flowRef.current.saveNow();
      const queued = queueLocally({
        draft,
        destinationPcId: device?.id ?? "unpaired-pc",
        destinationPcName: device?.name ?? "Windows PC",
        deliveryMode: "relay_input",
        reason: localReason,
      });
      if (queued) {
        flowRef.current.recordTransfer(queued.transfer);
        addActivity({
          handoffId: queued.transfer.id,
          durationSeconds: 0,
          status: "transcribed",
          language: draft.detectedLanguage ?? draft.requestedLanguage ?? prefsRef.current.language,
          translateOnRequest: prefsRef.current.translateOnRequest,
          text: queued.transfer.submittedText,
          summary: `Saved on this phone for ${queued.transfer.destinationPcName}: ${localReason}`,
        });
        setResult({ label: "Failed", tone: "bad", detail: "Your PC is not reachable. Tap Retry in History when it is on." });
      } else {
        setResult({ label: "Failed", tone: "bad", detail: localReason });
      }
      haptic("error");
      return;
    }
    // Live typing already put the words in the PC app. Send makes the current draft
    // the final text there (edits sync first), then clears the draft without
    // typing it again. Clearing never backspaces the PC text.
    if (liveRef.current && liveTypedRef.current && liveOn && !resolveQuickStartShortcut(draft.currentEditedText, prefsRef.current.quickStartShortcuts ?? [])) {
      setSendBusy(true);
      const finalText = draft.currentEditedText;
      const flushed = await flushLiveRef.current().catch(() => false);
      setSendBusy(false);
      if (flushed) {
        addActivity({
          durationSeconds: 0,
          status: "delivered",
          language: draft.detectedLanguage ?? draft.requestedLanguage ?? prefsRef.current.language,
          translateOnRequest: prefsRef.current.translateOnRequest,
          text: finalText,
          summary: `Typed live on ${device?.name ?? "your PC"}`,
        });
        liveTypedRef.current = false;
        flowRef.current.newDraft();
        setResult({ label: "Sent", tone: "good", detail: "Your final text is on the PC." });
        haptic("success");
        return;
      }
      // Live link dropped: fall through to a normal send. The PC skips words it already typed.
    }
    setSendBusy(true);
    sentRouteRef.current = null;
    setResult({ label: "Sending to PC", tone: "neutral", detail: "Sending your words to the PC." });
    await flowRef.current.saveNow();
    flowRef.current.startSend();
    const outcome = await submitDraft({
      draft,
      transfers: transfersRef.current,
      // A paired PC is always tried for real. A single missed status poll used to
      // block the send with "Your PC is offline" even when the relay was fine.
      connection: { ...connection, canDeliver: true },
      destinationPcId: device?.id ?? "pc-unknown",
      destinationPcName: device?.name ?? "Windows PC",
      deliveryMode: "relay_input",
      deps: {
        send: async ({ transfer, text }) => {
          // Quick Start phrases open their link from any mode, not only Action mode.
          const action = prefsRef.current.listeningMode === "action" || resolveQuickStartShortcut(text, prefsRef.current.quickStartShortcuts ?? [])
            ? createActionEnvelope({ id: transfer.id, createdAt: new Date().toISOString(), source: draft.sourceType === "type" ? "type" : "voice", language: draft.detectedLanguage ?? draft.requestedLanguage ?? "Auto-detect", text, quickStartShortcuts: prefsRef.current.quickStartShortcuts })
            : undefined;
          const handoffInput = {
            id: transfer.id, text, translateOnRequest: prefsRef.current.translateOnRequest,
            timing: createRecognitionTiming(sessionRef.current?.startedAt ?? null, Date.now()), action,
            transferId: transfer.id, draftRevision: transfer.draftRevision,
            textProcessing: { applied: transfer.textProcessing.applied, manuallyEdited: transfer.textProcessing.manuallyEdited },
            destinationPcId: transfer.destinationPcId, deliveryMode: transfer.deliveryMode,
          } as const;
          const { sendByRoute } = await import("@/lib/voice-link/route-pick");
          const sent = await sendByRoute(relay, {
            wifi: () => sendRelayText({ ...relay, ...handoffInput }),
            internet: () => sendCloudRelayText({ cloudRelay: relay.cloudRelay!, ...handoffInput }),
          });
          sentRouteRef.current = sent.route;
          const response = sent.response;
          return response?.handoff ?? null;
        },
        query: async () => {
          if (relay.cloudRelay) {
            try { return (await getCloudRelayStatus({ cloudRelay: relay.cloudRelay })) as unknown as { handoffs: never[] }; } catch { /* try Wi-Fi */ }
          }
          return (await getRelayStatus(relay)) ?? { handoffs: [] };
        },
      },
    });
    setSendBusy(false);
    if (outcome.status === "queued") {
      flowRef.current.finishSend({ transfer: outcome.transfer, verified: false });
      addActivity({
        handoffId: outcome.transfer.id,
        durationSeconds: 0,
        status: "transcribed",
        language: draft.detectedLanguage ?? draft.requestedLanguage ?? prefsRef.current.language,
        translateOnRequest: prefsRef.current.translateOnRequest,
        text: outcome.transfer.submittedText,
        summary: `Kept on this phone for ${outcome.transfer.destinationPcName}: ${outcome.message}`,
      });
      setResult({ label: "Failed", tone: "bad", detail: outcome.message });
      haptic("error");
      return;
    }
    if (outcome.status === "rejected") {
      // Leave the draft editable instead of stuck on "Sending".
      flowRef.current.cancelSend();
      setResult({ label: "Failed", tone: "bad", detail: outcome.message });
      haptic("error");
      return;
    }
    flowRef.current.finishSend({ transfer: outcome.transfer, verified: outcome.status === "submitted" && outcome.verified });
    addActivity({
      handoffId: outcome.transfer.id,
      durationSeconds: 0,
      status: outcome.status === "submitted" ? (outcome.verified ? "delivered" : "dispatched") : "failed",
      language: draft.detectedLanguage ?? draft.requestedLanguage ?? "Auto-detect",
      translateOnRequest: prefsRef.current.translateOnRequest,
      text: outcome.transfer.submittedText,
      summary: outcome.status === "submitted"
        ? `Sent to ${outcome.transfer.destinationPcName}: ${TRANSFER_LABELS[outcome.transfer.state]}`
        : outcome.status === "blocked"
          ? `Windows refused this handoff: ${outcome.message}`
          : `Delivery result is uncertain: ${outcome.message}`,
    });
    haptic(outcome.status === "submitted" ? "success" : "error");
    const via = sentRouteRef.current === "internet" ? "Internet" : sentRouteRef.current === "wifi" ? "Wi-Fi" : null;
    setResult({
      label: outcome.status === "submitted" && via ? `Delivered to PC via ${via}` : TRANSFER_LABELS[outcome.transfer.state],
      tone: outcome.status === "submitted" ? "good" : "bad",
      detail: outcome.transfer.lastStatusMessage ?? TRANSFER_MEANINGS[outcome.transfer.state],
    });
    // A sent version leaves the box, so the draft never says Sent and Not sent at once.
    // The PC received it (even when Windows could not confirm the insert): the
    // copy lives in History with Retry, so the box starts fresh for the next words.
    if (outcome.status === "submitted" || (outcome.status === "uncertain" && sentRouteRef.current)) flowRef.current.newDraft();
  }, [addActivity, connection, device, relay, relaySuspended, liveOn, savePending]);

  // Live mode: send right after the finished words land in the draft.
  useEffect(() => {
    if (!liveSendPending) return;
    setLiveSendPending(false);
    if (!draftRef.current?.currentEditedText.trim()) return;
    if (!device) {
      const words = draftRef.current.currentEditedText.trim();
      addActivity({
        durationSeconds: 0,
        status: "transcribed",
        language: prefsRef.current.language,
        translateOnRequest: prefsRef.current.translateOnRequest,
        text: words,
        summary: `Saved on this phone: ${words}`,
      });
      setResult({ label: "In draft", tone: "neutral", detail: "Saved on this phone. Pair your PC to send." });
      return;
    }
    void handleSend();
  }, [liveSendPending, handleSend, device, addActivity]);

  const handlePaired = useCallback((input: { deviceName: string; relay: VerifiedRelayConnection; test: { ok: boolean; message: string } }) => {
    pairDevice({ name: input.deviceName, relayConnection: input.relay });
    setRelaySuspended(false);
    setPairingOpen(false);
    setTestMessage({ tone: input.test.ok ? "good" : "bad", message: input.test.message });
    haptic(input.test.ok ? "success" : "error");
  }, [pairDevice, setRelaySuspended]);

  const [clipboardBusy, setClipboardBusy] = useState(false);
  // Tap: phone clipboard to PC clipboard. Long-press: PC clipboard to phone.
  // Without a paired PC, tap adds the copied text to the draft instead.
  const handleClipboardToPc = useCallback(async () => {
    if (clipboardBusy) return;
    let clip = "";
    try { clip = (await Clipboard.getStringAsync()) ?? ""; } catch { setResult({ label: "Clipboard not read", tone: "bad", detail: "The phone did not share the clipboard." }); return; }
    if (!clip.trim()) { setResult({ label: "Clipboard is empty", tone: "neutral", detail: "Copy some text first." }); return; }
    if (!device || !relay) {
      const current = flow.draft?.currentEditedText ?? "";
      flow.updateText(current.trim() ? `${current.replace(/\s+$/, "")} ${clip.trim()}` : clip.trim());
      setResult({ label: "Added to draft", tone: "good", detail: "Pair your PC to copy straight to its clipboard." });
      haptic("success");
      return;
    }
    setClipboardBusy(true);
    setResult({ label: "Copying to PC…", tone: "neutral" });
    try {
      const { sendClipboardToPc } = await import("@/lib/voice-link/clipboard-bridge");
      const sent = await sendClipboardToPc(relay, clip);
      setResult({ label: sent.label, tone: "good", detail: sent.detail });
      haptic("success");
    } catch (error) {
      setResult({ label: "Not copied to PC", tone: "bad", detail: error instanceof Error ? error.message : String(error) });
    } finally { setClipboardBusy(false); }
  }, [clipboardBusy, device, relay, flow]);
  const handleClipboardFromPc = useCallback(async () => {
    if (clipboardBusy) return;
    if (!device || !relay) { setResult({ label: "Pair your PC first", tone: "neutral", detail: "Then long-press Clipboard to bring the PC clipboard here." }); return; }
    setClipboardBusy(true);
    setResult({ label: "Getting PC clipboard…", tone: "neutral" });
    try {
      const { pullClipboardFromPc } = await import("@/lib/voice-link/clipboard-bridge");
      const text = await pullClipboardFromPc(relay);
      if (!text) { setResult({ label: "PC clipboard is empty", tone: "neutral", detail: "Copy some text on the PC first." }); return; }
      await Clipboard.setStringAsync(text);
      setResult({ label: "Copied from PC", tone: "good", detail: "It is on this phone's clipboard. Paste it anywhere, or into the draft." });
      haptic("success");
    } catch (error) {
      setResult({ label: "PC clipboard not received", tone: "bad", detail: error instanceof Error ? error.message : String(error) });
    } finally { setClipboardBusy(false); }
  }, [clipboardBusy, device, relay]);

  const [attachmentBusy, setAttachmentBusy] = useState<string | null>(null);
  const [attachmentProgress, setAttachmentProgress] = useState<number | null>(null);
  // ---- Enter: presses Enter once on the PC over the same encrypted channel.
  const [enterBusy, setEnterBusy] = useState(false);
  const handlePressEnter = useCallback(async () => {
    if (!device || !relay) { setResult({ label: "Pair your PC first", tone: "neutral", detail: "Then Enter presses Enter on your PC." }); return; }
    setEnterBusy(true);
    try {
      const { pressEnterOnPc } = await import("@/lib/voice-link/clipboard-bridge");
      const status = await pressEnterOnPc(relay);
      setResult(status.pressed ? { label: status.label, tone: "good" } : { label: status.label, tone: "bad", detail: status.detail });
      // Live typing already put the words in the PC app, and Enter sent them there.
      // Start a fresh box so the next words do not repeat or backspace the sent ones.
      if (status.pressed && liveRef.current && draftRef.current?.currentEditedText.trim()) flowRef.current.newDraft();
    } catch (error) {
      setResult({ label: "Enter not pressed", tone: "bad", detail: error instanceof Error ? error.message : "The PC did not answer." });
    } finally { setEnterBusy(false); }
  }, [device, relay]);
  const handlePickAttachment = useCallback(async (kind: "image" | "file") => {
    if (attachmentBusy) return;
    if (!device || !relay) {
      Alert.alert("Pair your PC first", "Connect this phone to your Windows PC, then you can send photos and files to it.");
      return;
    }
    const wifiReady = /^https:/i.test(relay.relayUrl);
    // Check the route while the picker is open, not before it, so the picker
    // opens at once and no time is spent after the user picks.
    const routeCheck = import("@/lib/voice-link/route-pick").then(({ pickRoute }) => pickRoute(relay)).then((route) => ({ route, error: null as unknown }), (error) => ({ route: null, error }));
    // Open the internet socket while the picker is open, so the first chunk goes out at once.
    void routeCheck.then(async (checked) => {
      if (checked.route === "internet" && relay.cloudRelay) (await import("@/lib/voice-link/cloud-payload")).warmCloudChannel(relay.cloudRelay);
    }).catch(() => undefined);
    let progressTimer: ReturnType<typeof setTimeout> | null = null;
    try {
      const { pickPayloads, sendPayloadToPc, cloudPayloadTransport } = await import("@/lib/voice-link/payload-send");
      const pickedAll = await pickPayloads(kind);
      if (!pickedAll.length) return;
      setAttachmentBusy(`Sending ${pickedAll[0].name}…`);
      const checked = await routeCheck;
      if (checked.error) {
        Alert.alert("Internet only is on", checked.error instanceof Error ? checked.error.message : "Pair again to use the internet link.");
        return;
      }
      const useCloud = checked.route === "internet";
      if (!wifiReady && !useCloud) {
        Alert.alert("Use the same Wi-Fi or Internet mode", "Connect the phone and PC to the same Wi-Fi, or sign in and pair again for Internet mode.");
        return;
      }
      const target = useCloud && relay.cloudRelay ? cloudPayloadTransport(relay.cloudRelay) : relay;
      const many = pickedAll.length > 1;
      // One bar for the whole batch, only moving forward; hidden for small, quick sends.
      const { batchDone, createTransferProgress, PROGRESS_DELAY_MS } = await import("@/lib/voice-link/transfer-progress");
      const sizes = pickedAll.map((item) => item.size);
      const meter = createTransferProgress(sizes.reduce((sum, size) => sum + size, 0));
      if (meter.visible()) setAttachmentProgress(0);
      progressTimer = setTimeout(() => setAttachmentProgress(meter.fraction()), PROGRESS_DELAY_MS);
      const savedNames: string[] = [];
      let lastFolder = "your PC";
      let lastAttached = false;
      let lastAttaching = false;
      for (let i = 0; i < pickedAll.length; i += 1) {
        const picked = pickedAll[i];
        const tag = many ? ` (${i + 1} of ${pickedAll.length})` : "";
        setAttachmentBusy(`Sending ${picked.name}${tag}`);
        const sent = await sendPayloadToPc(target, picked, (done) => {
          const fraction = meter.update(batchDone(sizes, i, done));
          if (meter.visible()) setAttachmentProgress(fraction);
        });
        savedNames.push(sent.savedAs ?? sent.name);
        lastFolder = sent.folder ? (sent.folder.split(/[\\/]/).filter(Boolean).pop() ?? sent.folder) : "your PC";
        lastAttached = Boolean(sent.attached);
        lastAttaching = Boolean(sent.attaching);
        addActivity({
          handoffId: `file-${Date.now()}-${i}`,
          durationSeconds: 0,
          status: "delivered",
          language: "Auto-detect",
          translateOnRequest: false,
          text: sent.name,
          summary: `File sent to ${device.name}: ${sent.savedAs ?? sent.name}`,
        });
      }
      haptic("success");
      const names = savedNames.join(", ");
      setResult({ label: many ? `${savedNames.length} files sent` : lastAttached ? "Attached on your PC" : `Saved to ${lastFolder}`, tone: "good", detail: lastAttached ? `${names} attached and also saved to ${lastFolder}.` : lastAttaching ? `${names} saved on ${device.name}. If the open app takes files, it is attached there too.` : `${names} saved on ${device.name}.` });
    } catch (error) {
      haptic("error");
      setResult({ label: "File not sent", tone: "bad", detail: error instanceof Error ? error.message : "The file could not be sent." });
    } finally {
      if (progressTimer) clearTimeout(progressTimer);
      setAttachmentProgress(null);
      setAttachmentBusy(null);
    }
  }, [addActivity, attachmentBusy, device, relay]);

  const handleUnpair = useCallback(async () => {
    Alert.alert("Unpair this PC?", "This phone will stop trusting the Windows session and delete the saved token. Your drafts and history stay on this phone.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Unpair",
        style: "destructive",
        onPress: async () => {
          if (relayConnection) await revokeRelaySession(relayConnection);
          forgetDevice();
          setConnectionOpen(false);
          setTestMessage(null);
        },
      },
    ]);
  }, [forgetDevice, relayConnection]);

  const handleCopy = useCallback(async () => {
    const text = draftRef.current?.currentEditedText.trim();
    if (!text) return;
    await Clipboard.setStringAsync(text);
    setResult({ label: "Copied", tone: "neutral", detail: "Paste it on the PC yourself if sending is not available." });
  }, []);

  // ---- Scan: pages to one PDF for the PC; QR/barcodes only on tap. Nothing sends without a tap.
  const [scanOpen, setScanOpen] = useState(false);
  useEffect(() => { if (openPanel === "scan") setScanOpen(true); }, [openPanel]);
  // Shortcuts from Home tiles and the quick panel bubble.
  useEffect(() => {
    if (openPanel === "clipboard") void handleClipboardToPc();
    else if (openPanel === "attach") void handlePickAttachment("file");
    else if (openPanel === "panel") {
      if (Platform.OS !== "android") { Alert.alert("Android only", "The quick panel is available on Android."); return; }
      void (async () => {
        const bubble = await import("@/lib/voice-link/floating-bubble");
        if (await bubble.hasFloatingBubblePermission()) {
          updatePreferences({ floatingBubbleEnabled: true });
          return;
        }
        Alert.alert(
          "Show the quick panel over other apps?",
          "Cursor Flow places a small bubble at the edge of your screen so you can start Detection, send Clipboard, Scan or Attach without opening the app. It never reads what is on your screen. On the next screen, turn on Allow display over other apps for Cursor Flow.",
          [
            { text: "Not now", style: "cancel" },
            { text: "Continue", onPress: () => { updatePreferences({ floatingBubbleEnabled: true }); void bubble.openFloatingBubbleSettings(); } },
          ],
        );
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openPanel]);
  const [scanBusy, setScanBusy] = useState<string | null>(null);
  const [scanPanel, setScanPanel] = useState<{ photoUri: string | null; code: ScannedCode | null; pdfPages?: string[] } | null>(null);
  // Scan makes a document: pages photographed (or picked) in order, turned into one PDF for the PC.
  const [scanPages, setScanPages] = useState<string[]>([]);
  const [pendingSend, setPendingSend] = useState<string | null>(null);
  useEffect(() => {
    if (pendingSend === null || (flow.draft?.currentEditedText ?? "") !== pendingSend) return;
    setPendingSend(null);
    void handleSend();
  }, [pendingSend, flow.draft?.currentEditedText, handleSend]);
  const putInDraft = useCallback((text: string) => { flow.updateText(text); }, [flow]);
  const scanPhoto = useCallback(async (uri: string) => {
    setScanOpen(false);
    setScanPanel({ photoUri: uri, code: null });
    setScanBusy("Reading text…");
    try {
      const { readPhotoText } = await import("@/lib/voice-link/scan");
      const out = await readPhotoText(uri, prefsRef.current.language, (label) => setScanBusy(label));
      putInDraft(out.text);
      recordDictation(out.text);
      haptic("success");
      setResult({ label: "Text ready in the draft", tone: "good", detail: "Check it, then Send or pick an action below." });
    } catch (error) {
      haptic("error");
      setResult({ label: "No text read", tone: "bad", detail: error instanceof Error ? error.message : "Try a clearer, closer photo." });
    } finally { setScanBusy(null); }
  }, [putInDraft]);
  const scanGallery = useCallback(async () => {
    try {
      const { pickPayloads } = await import("@/lib/voice-link/payload-send");
      const picked = await pickPayloads("image");
      if (!picked.length) { setScanOpen(true); return; }
      setScanPages((pages) => [...pages, ...picked.map((item) => item.uri)]);
      setScanPanel(null);
      setScanOpen(true);
    } catch (error) {
      setResult({ label: "Photo not opened", tone: "bad", detail: error instanceof Error ? error.message : String(error) });
    }
  }, []);
  const scanFinish = useCallback(() => {
    setScanOpen(false);
    if (!scanPages.length) return;
    setResult(null);
    setScanPanel({ photoUri: null, code: null, pdfPages: scanPages });
  }, [scanPages]);
  const scanSendPdf = useCallback(async (pages: string[]) => {
    if (!pages.length) return;
    setScanBusy("Making the PDF…");
    let pdfName = "Scan.pdf";
    try {
      const { makeScanPdfFile } = await import("@/lib/voice-link/scan-pdf");
      const pdf = await makeScanPdfFile(pages);
      pdfName = pdf.name;
      if (!device || !relay) {
        addActivity({ handoffId: `file-${Date.now()}`, durationSeconds: 0, status: "failed", language: "Auto-detect", translateOnRequest: false, text: pdf.name, summary: `Scan PDF not sent (${pdf.pages} ${pdf.pages === 1 ? "page" : "pages"}). Pair your PC, then tap Send PDF again.` });
        setResult({ label: "PDF ready, PC not paired", tone: "neutral", detail: "Pair your PC, then tap Send PDF to PC again. Your pages are kept." });
        return;
      }
      setScanBusy("Sending PDF…");
      const { pickRoute } = await import("@/lib/voice-link/route-pick");
      const { assetToPayload, sendPayloadToPc, cloudPayloadTransport } = await import("@/lib/voice-link/payload-send");
      const route = await pickRoute(relay);
      const useCloud = route === "internet";
      if (!useCloud && !/^https:/i.test(relay.relayUrl)) throw new Error("Use the same Wi-Fi, or sign in and pair again for Internet mode.");
      const payload = await assetToPayload({ uri: pdf.uri, name: pdf.name, size: pdf.size, mimeType: "application/pdf" }, "file");
      const target = useCloud && relay.cloudRelay ? cloudPayloadTransport(relay.cloudRelay) : relay;
      const { createTransferProgress } = await import("@/lib/voice-link/transfer-progress");
      const meter = createTransferProgress(payload.size);
      const sent = await sendPayloadToPc(target, payload, (done) => {
        const fraction = meter.update(done);
        if (meter.visible()) setScanBusy(`Sending PDF… ${Math.round(fraction * 100)}%`);
      });
      addActivity({ handoffId: `file-${Date.now()}`, durationSeconds: 0, status: "delivered", language: "Auto-detect", translateOnRequest: false, text: sent.name, summary: `Scan PDF sent to ${device.name} (${pdf.pages} ${pdf.pages === 1 ? "page" : "pages"}): ${sent.savedAs ?? sent.name}` });
      haptic("success");
      setScanPages([]);
      setScanPanel(null);
      const folder = sent.folder ? (sent.folder.split(/[\\/]/).filter(Boolean).pop() ?? sent.folder) : device.name;
      setResult({ label: "PDF sent", tone: "good", detail: `${sent.savedAs ?? sent.name} (${pdf.pages} ${pdf.pages === 1 ? "page" : "pages"}) is in ${folder} on ${device.name}.` });
    } catch (error) {
      haptic("error");
      addActivity({ handoffId: `file-${Date.now()}`, durationSeconds: 0, status: "failed", language: "Auto-detect", translateOnRequest: false, text: pdfName, summary: `Scan PDF not sent: ${error instanceof Error ? error.message : String(error)}. Tap Send PDF to PC again.` });
      setResult({ label: "PDF not sent", tone: "bad", detail: `${error instanceof Error ? error.message : String(error)} Your pages are kept, try Send PDF to PC again.` });
    } finally { setScanBusy(null); }
  }, [device, relay, addActivity]);
  const scanCode = useCallback(async (data: string, type: string) => {
    setScanOpen(false);
    const { parseScannedCode } = await import("@/lib/voice-link/scan");
    const code = parseScannedCode(data, type);
    haptic("success");
    setScanPanel({ photoUri: null, code });
    if (code.kind === "text") {
      putInDraft(code.value);
      setResult({ label: `${code.label} read`, tone: "good", detail: "The value is in the draft." });
    } else setResult(null);
  }, [putInDraft]);
  const scanCopy = useCallback(async (text: string, what = "Text") => {
    if (!text.trim()) return;
    await Clipboard.setStringAsync(text);
    if (!device || !relay) { setResult({ label: `${what} copied`, tone: "good", detail: "Copied on this phone. Pair your PC to copy there too." }); return; }
    setScanBusy("Copying to PC…");
    try {
      const { sendClipboardToPc } = await import("@/lib/voice-link/clipboard-bridge");
      const sent = await sendClipboardToPc(relay, text);
      setResult({ label: sent.typed ? `${what} typed on PC` : `${what} copied`, tone: "good", detail: sent.typed ? `${sent.detail} Also copied on this phone.` : "On this phone and on the PC clipboard." });
    } catch (error) {
      setResult({ label: `${what} copied on phone only`, tone: "neutral", detail: error instanceof Error ? error.message : String(error) });
    } finally { setScanBusy(null); }
  }, [device, relay]);
  const scanAi = useCallback(async (kind: "translate" | "summary" | "table") => {
    const text = (draftRef.current?.currentEditedText ?? "").trim();
    if (!text) { setResult({ label: "Draft is empty", tone: "neutral", detail: "Scan some text first." }); return; }
    setScanBusy(kind === "translate" ? "Translating…" : kind === "summary" ? "Summarizing…" : "Making a table…");
    try {
      const scan = await import("@/lib/voice-link/scan");
      const out = kind === "translate" ? await scan.translateScan(text) : kind === "summary" ? await scan.summarizeScan(text) : (await scan.tableScan(text)).text;
      if (!out.trim()) throw new Error("Nothing came back. Try again.");
      putInDraft(out);
      setResult({ label: kind === "translate" ? "Translated in the draft" : kind === "summary" ? "Summary in the draft" : "Table in the draft", tone: "good", detail: kind === "table" ? "Copy it and paste into Excel or Sheets." : "Check it, then Send." });
    } catch (error) {
      setResult({ label: "Not done", tone: "bad", detail: error instanceof Error ? error.message : String(error) });
    } finally { setScanBusy(null); }
  }, [putInDraft]);
  const scanSendImage = useCallback(async (uri: string) => {
    if (!device || !relay) { setResult({ label: "Pair your PC first", tone: "neutral", detail: "Then you can send the photo with the text." }); return; }
    setScanBusy("Sending photo…");
    try {
      const { pickRoute } = await import("@/lib/voice-link/route-pick");
      const { assetToPayload, sendPayloadToPc, cloudPayloadTransport } = await import("@/lib/voice-link/payload-send");
      const route = await pickRoute(relay);
      const useCloud = route === "internet";
      if (!useCloud && !/^https:/i.test(relay.relayUrl)) throw new Error("Use the same Wi-Fi, or sign in and pair again for Internet mode.");
      const payload = await assetToPayload({ uri, name: `scan-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")}.jpg`, mimeType: "image/jpeg" }, "image");
      const target = useCloud && relay.cloudRelay ? cloudPayloadTransport(relay.cloudRelay) : relay;
      const { createTransferProgress } = await import("@/lib/voice-link/transfer-progress");
      const meter = createTransferProgress(payload.size);
      const sent = await sendPayloadToPc(target, payload, (done) => {
        const fraction = meter.update(done);
        if (meter.visible()) setScanBusy(`Sending photo… ${Math.round(fraction * 100)}%`);
      });
      addActivity({ handoffId: `file-${Date.now()}`, durationSeconds: 0, status: "delivered", language: "Auto-detect", translateOnRequest: false, text: sent.name, summary: `Scan photo sent to ${device.name}: ${sent.savedAs ?? sent.name}` });
      setScanBusy(null);
      if ((draftRef.current?.currentEditedText ?? "").trim()) await handleSend();
      else setResult({ label: "Photo sent", tone: "good", detail: `${sent.savedAs ?? sent.name} is on ${device.name}.` });
    } catch (error) {
      setResult({ label: "Photo not sent", tone: "bad", detail: error instanceof Error ? error.message : String(error) });
    } finally { setScanBusy(null); }
  }, [device, relay, addActivity, handleSend]);
  const scanOpenUrl = useCallback(async (url: string) => {
    if (!device || !relay) { setResult({ label: "Pair your PC first", tone: "neutral", detail: "Then the link can open on the PC." }); return; }
    setScanBusy("Opening on PC…");
    try {
      const { openUrlOnPc } = await import("@/lib/voice-link/clipboard-bridge");
      await openUrlOnPc(relay, url);
      haptic("success");
      setResult({ label: "Opened on PC", tone: "good", detail: url });
    } catch (error) {
      setResult({ label: "Not opened on PC", tone: "bad", detail: error instanceof Error ? error.message : String(error) });
    } finally { setScanBusy(null); }
  }, [device, relay]);
  const scanView = useMemo((): { title: string; lines?: string[]; images?: string[]; actions: ScanAction[] } | null => {
    if (!scanPanel) return null;
    const pdfPages = scanPanel.pdfPages;
    if (pdfPages?.length) return {
      title: `PDF document, ${pdfPages.length} ${pdfPages.length === 1 ? "page" : "pages"}`,
      lines: [device ? `Goes to ${device.name} as one PDF file.` : "Pair your PC to send this PDF."],
      images: pdfPages,
      actions: [
        { id: "pdf", label: "Send PDF to PC", icon: "picture-as-pdf", onPress: () => void scanSendPdf(pdfPages) },
        { id: "add", label: "Add pages", icon: "add-a-photo", onPress: () => { setScanPanel(null); setScanOpen(true); } },
        { id: "discard", label: "Discard", icon: "delete-outline", onPress: () => { setScanPages([]); setScanPanel(null); } },
      ],
    };
    const code = scanPanel.code;
    const sendText = (text: string) => { putInDraft(text); setPendingSend(text); };
    if (code?.kind === "url") return {
      title: "Link found",
      lines: [code.url],
      actions: [
        { id: "open", label: "Open on PC", icon: "open-in-new", onPress: () => void scanOpenUrl(code.url) },
        { id: "text", label: "Send as text", icon: "send", onPress: () => sendText(code.url) },
        { id: "copy", label: "Copy", icon: "content-copy", onPress: () => void scanCopy(code.url, "Link") },
      ],
    };
    if (code?.kind === "wifi") {
      const text = `Wi-Fi: ${code.ssid}\nPassword: ${code.password || "(none)"}`;
      return {
        title: "Wi-Fi network",
        lines: [`Network: ${code.ssid || "(hidden)"}`, `Password: ${code.password || "(none)"}`],
        actions: [
          { id: "send", label: "Send to PC", icon: "send", onPress: () => sendText(text) },
          { id: "copy", label: "Copy password", icon: "content-copy", disabled: !code.password, onPress: () => void scanCopy(code.password, "Password") },
        ],
      };
    }
    const draftText = flow.draft?.currentEditedText ?? "";
    if (code?.kind === "text") return {
      title: code.label,
      actions: [
        { id: "send", label: "Send to PC", icon: "send", onPress: () => void handleSend() },
        { id: "copy", label: "Copy", icon: "content-copy", onPress: () => void scanCopy(draftText) },
      ],
    };
    const actions: ScanAction[] = [
      { id: "send", label: "Send to PC", icon: "send", onPress: () => void handleSend() },
      { id: "copy", label: "Copy", icon: "content-copy", onPress: () => void scanCopy(draftText) },
      { id: "translate", label: "Translate", icon: "translate", onPress: () => void scanAi("translate") },
      { id: "summary", label: "Summary", icon: "short-text", onPress: () => void scanAi("summary") },
      { id: "table", label: "Table", icon: "table-chart", onPress: () => void scanAi("table") },
    ];
    if (scanPanel.photoUri) actions.push({ id: "image", label: "Send with image", icon: "image", onPress: () => void scanSendImage(scanPanel.photoUri as string) });
    return { title: "Scanned text", actions };
  }, [scanPanel, flow.draft?.currentEditedText, putInDraft, scanOpenUrl, scanCopy, handleSend, scanAi, scanSendImage, scanSendPdf, device]);

  const view = speechDraftView({ committedText: flow.draft?.currentEditedText ?? "", session });
  const micPhase = session ? (session.phase === "listening" || session.phase === "receiving" ? "listening" : session.phase === "finalizing" ? "finalizing" : session.phase === "preparing" || session.phase === "requesting_permission" ? "busy" : "idle") : "idle";
  const hasText = Boolean(flow.draft?.currentEditedText.trim());
  // A paired-but-unreachable PC may still be tapped: the frozen revision is kept
  // on the phone as "Saved on phone" and resent from Activity. An unpaired or
  // deliberately disconnected phone offers no destination, so Send stays blocked.
  const canAttemptSend = connection.canDeliver || (Boolean(device) && !relaySuspended);
  const sendBlockedReason = !canAttemptSend
    ? relaySuspended
      ? "Delivery is disconnected. Reconnect from the PC card to send."
      : "Pair your PC to send. Your draft stays here."
    : null;
  const readiness = `${describeReadiness(probe ? { ...probe } : null)}${lastError ? ` Last error: ${lastError}` : ""}`;

  const languageLabel = preferences.language === "Auto-detect" ? "Auto" : preferences.language;

  return (
    <ScreenContainer className="px-5" containerClassName="bg-background">
      <ScrollView contentContainerStyle={styles.page} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
          <View style={styles.brandSlot}>
            <CursorFlowBrand palette={palette} align="center" />
          </View>
          <View style={styles.headerActions}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Switch to the ${resolvedTheme === "dark" ? "light" : "dark"} theme`}
              onPress={() => updatePreferences({ appearance: resolvedTheme === "dark" ? "light" : "dark" })}
              style={styles.headerButton}
            >
              <MaterialIcons name={resolvedTheme === "dark" ? "light-mode" : "dark-mode"} size={18} color={palette.textMuted} />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Open Controls"
              onPress={() => router.push("/controls" as never)}
              style={styles.headerButton}
            >
              <MaterialIcons name="settings" size={18} color={palette.textMuted} />
            </Pressable>
          </View>
        </View>

        <View style={styles.hero}>
          <Text style={styles.title}>Speak or Type.</Text>
          <Text style={styles.subtitle}>Your phone. Your voice. Your cursor.</Text>
          <RouteBadge relay={relay} palette={palette} />
        </View>

        <MicControl
          palette={palette}
          phase={micPhase}
          elapsedSeconds={elapsedSeconds}
          reducedMotion={preferences.reducedMotion}
          label={micPhase === "listening" ? `Listening · ${elapsedSeconds}s` : micPhase === "finalizing" ? "Finishing" : recognitionError ? "Tap to try again" : "Tap to speak"}
          hint={micPhase === "listening" && liveNotice ? liveNotice : micPhase === "listening" ? preferences.reviewBeforeSending ? "Tap again when you finish." : "Tap again when you finish. The text goes to your PC." : recognitionError ? `${recognitionErrorText(recognitionError)} Your draft is safe.` : "Speak, or type and tap Send."}
          onPress={() => {
            if (micPhase === "listening") stopRecording();
            else if (micPhase === "idle") void beginRecording();
            else if (micPhase === "finalizing") {
              // Recover a stuck Finishing state so the next Detection tap can start.
              cancelRecording();
            }
          }}
          onCancel={cancelRecording}
          getLevel={getMicLevel}
        />

        {fadingWords ? <FadingWords key={fadingWords.id} words={fadingWords.words} color={palette.textMuted} onDone={() => setFadingWords(null)} /> : null}
        <DraftComposer
          palette={palette}
          draft={flow.draft}
          provisionalText={view.showProvisional ? view.provisionalText : ""}
          listening={micPhase === "listening"}
          saveState={flow.saveState}
          showPreviews={true}
          headerActions={
            <SendActions
              palette={palette}
              destinationName={device?.name ?? null}
              hasText={hasText}
              canSend={canAttemptSend}
              busy={sendBusy}
              onSend={() => void handleSend()}
              onEnter={() => void handlePressEnter()}
              enterBusy={enterBusy}
            />
          }
          disabled={!hydrated || micPhase === "listening"}
          attachments={flow.draft?.attachments}
          onPickAttachment={(kind) => { void handlePickAttachment(kind); }}
          onPasteClipboard={() => { void handleClipboardToPc(); }}
          onPullClipboard={() => { void handleClipboardFromPc(); }}
          onScan={() => { setResult(null); setScanOpen(true); }}
          scanBusy={Boolean(scanBusy)}
          attachmentBusy={attachmentBusy}
          attachmentProgress={attachmentProgress}
          onRemoveAttachment={(id) => flow.setAttachments((flow.draft?.attachments ?? []).filter((attachment) => attachment.id !== id))}
          onChangeText={(text) => {
            if (micPhase === "listening") stopRecording();
            flow.updateText(text);
          }}
          selection={forcedCaret}
          onSelectionChange={(selection) => { caretRef.current = selection; }}
        />
        {relay && liveLabel && liveStatus !== "old_pc" ? (
          <Pressable
            accessibilityRole="switch"
            accessibilityState={{ checked: liveOn }}
            accessibilityLabel="Live Draft sync with PC"
            onPress={() => { const next = !liveOn; setLiveOn(next); void AsyncStorage.setItem("cf.liveDraft.on", next ? "1" : "0").catch(() => undefined); }}
            style={styles.liveChip}
          >
            <View style={[styles.liveDot, { backgroundColor: liveOn && liveStatus === "synced" ? palette.success : palette.textMuted }]} />
            <Text style={[styles.liveText, { color: palette.textMuted }]}>{liveLabel}</Text>
          </Pressable>
        ) : null}
        {relay && liveOn && liveStatus === "old_pc" && !oldPcNoticeSeen ? (
          <Text style={[styles.liveText, { color: palette.textMuted }]}>Update Cursor Flow on your PC for Live Draft</Text>
        ) : null}

        <SendBar
          palette={palette}
          destinationName={device?.name ?? null}
          hasText={hasText}
          canSend={canAttemptSend}
          busy={sendBusy}
          resultLabel={result?.label ?? (activeTransfer ? TRANSFER_LABELS[activeTransfer.state] : null)}
          resultTone={result?.tone ?? "neutral"}
          blockedReason={sendBlockedReason}
          onSend={() => void handleSend()}
          onCopy={() => void handleCopy()}
          onNewDraft={() => {
            flow.newDraft();
            setResult(null);
          }}
          showNewDraft={hasText}
          onEnter={() => void handlePressEnter()}
          enterBusy={enterBusy}
        />
        {result?.detail ? <Text style={styles.resultDetail}>{result.detail}</Text> : null}
        {scanView ? <ScanActions palette={palette} title={scanView.title} lines={scanView.lines} images={scanView.images} busy={scanBusy} actions={scanView.actions} onClose={() => setScanPanel(null)} /> : null}

        <View style={styles.languageCard}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Language ${languageLabel}. Cycle speaking language`}
            onPress={() => {
              const index = SPEAKING_LANGUAGES.indexOf(preferences.language as (typeof SPEAKING_LANGUAGES)[number]);
              const next = SPEAKING_LANGUAGES[(index + 1) % SPEAKING_LANGUAGES.length] ?? SPEAKING_LANGUAGES[0];
              updatePreferences({ language: next });
            }}
            style={styles.languageMain}
          >
            <MaterialIcons name="public" size={20} color={palette.text} />
            <Text style={styles.languageValue} numberOfLines={1}>{languageLabel}</Text>
            <MaterialIcons name="expand-more" size={20} color={palette.textMuted} />
          </Pressable>
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.languageScroll}>
          {SPEAKING_LANGUAGES.map((language) => (
            <Pressable
              key={language}
              accessibilityRole="radio"
              accessibilityState={{ selected: preferences.language === language }}
              onPress={() => updatePreferences({ language })}
              style={[styles.languageChip, preferences.language === language && styles.languageChipActive]}
            >
              <Text style={[styles.languageChipText, preferences.language === language && styles.languageChipTextActive]}>{language}</Text>
            </Pressable>
          ))}
        </ScrollView>
        {preferences.language === "Auto-detect" && supportedLocales.length && !supportedLocales.some((locale) => /^bn/i.test(locale)) ? (
          <Text style={styles.autoHint}>Automatic detection is unavailable with this speech provider. Pick a language instead.</Text>
        ) : lastDetectedLanguage ? <Text style={styles.autoHint}>Detected {lastDetectedLanguage}.</Text> : null}


        <PcStatusCard
          palette={palette}
          deviceName={device?.name ?? null}
          connection={connection}
          note={desktopListening ? "Windows is listening on its own microphone." : lastError && connection.state !== "connected" ? lastError : null}
          onConnect={() => setPairingOpen(true)}
          onTrouble={() => setConnectionOpen(true)}
        />

        <View style={styles.privacyNote}>
          <MaterialIcons name="privacy-tip" size={16} color={palette.textMuted} />
          <Text style={styles.privacyText}>
            {"Dictation runs on Cursor Flow Cloud. Delivery to your PC goes over Wi-Fi or internet, encrypted."}
          </Text>
        </View>
      </ScrollView>

      <PcConnectionSheet
        visible={connectionOpen}
        onClose={() => setConnectionOpen(false)}
        palette={palette}
        deviceName={device?.name ?? null}
        connection={connection}
        probe={probe}
        readiness={readiness}
        diagnostics={diagnostics}
        suspended={relaySuspended}
        busy={false}
        testMessage={testMessage?.message ?? null}
        testTone={testMessage?.tone ?? "neutral"}
        pairedAtLabel={device?.pairedAt ? shortTime(device.pairedAt) : null}
        onTest={async () => {
          const outcome = await testRelayConnection(relay);
          setTestMessage({ tone: outcome.ok ? "good" : "bad", message: outcome.message });
        }}
        onReconnect={() => {
          setRelaySuspended(false);
          setTestMessage({ tone: "warn", message: "Reconnecting…" });
          void refresh();
        }}
        onDisconnect={() => {
          setRelaySuspended(true);
          setTestMessage(null);
        }}
        onUnpair={() => void handleUnpair()}
        onRescan={() => {
          setConnectionOpen(false);
          setPairingOpen(true);
        }}
      />

      {PairingSheet ? (
        <PairingSheet visible={pairingOpen} onClose={() => setPairingOpen(false)} palette={palette} onPaired={handlePaired} />
      ) : null}

      <SmartConsentSheet
        visible={consentOpen}
        onClose={() => setConsentOpen(false)}
        palette={palette}
        route={capability.available ? "Cursor Flow cloud" : "not configured"}
        onAllow={() => {
          updatePreferences({ smartConsentAccepted: true, smartCleanupEnabled: true });
          setConsentOpen(false);
        }}
        onKeepOriginal={() => {
          updatePreferences({ smartCleanupEnabled: false });
          setConsentOpen(false);
        }}
      />
      {scanOpen ? <ScanCamera palette={palette} pages={scanPages} onPhoto={(uri) => setScanPages((pages) => [...pages, uri])} onRemovePage={(index) => setScanPages((pages) => pages.filter((_, i) => i !== index))} onDone={scanFinish} onGallery={() => { setScanOpen(false); void scanGallery(); }} onCode={(data, type) => void scanCode(data, type)} onClose={() => { setScanOpen(false); if (scanPages.length) setScanPanel({ photoUri: null, code: null, pdfPages: scanPages }); }} /> : null}
    </ScreenContainer>
  );
}

function createStyles(palette: VoiceLinkPalette) {
  return StyleSheet.create({
    page: {
      flexGrow: 1,
      paddingTop: FLOW_SPACING.md,
      paddingBottom: FLOW_SPACING.xl + FLOW_TOUCH.min,
      gap: FLOW_SPACING.md,
    },
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      minHeight: FLOW_TOUCH.compact,
      position: "relative",
    },
    brandSlot: { flex: 1, alignItems: "center" },
    headerActions: {
      position: "absolute",
      right: 0,
      top: 0,
      flexDirection: "row",
      gap: FLOW_SPACING.xs,
    },
    hero: { alignItems: "center", gap: 6, paddingTop: FLOW_SPACING.xs },
    title: {
      color: palette.text,
      fontSize: FLOW_TYPE.pageHeading,
      fontWeight: "800",
      letterSpacing: -0.7,
      textAlign: "center",
    },
    subtitle: {
      color: palette.textMuted,
      fontSize: FLOW_TYPE.secondary,
      lineHeight: 20,
      textAlign: "center",
    },
    headerButton: {
      width: FLOW_TOUCH.compact,
      height: FLOW_TOUCH.compact,
      borderRadius: FLOW_TOUCH.compact / 2,
      borderColor: palette.border,
      borderWidth: 1,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: palette.panel,
    },
    languageCard: {
      flexDirection: "row",
      alignItems: "center",
      minHeight: FLOW_TOUCH.primary,
      borderRadius: FLOW_RADIUS.pill,
      borderWidth: 1,
      borderColor: palette.border,
      backgroundColor: palette.panel,
      paddingLeft: FLOW_SPACING.md,
      paddingRight: FLOW_SPACING.xs,
      gap: FLOW_SPACING.xs,
    },
    languageMain: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      gap: FLOW_SPACING.xs,
      minHeight: FLOW_TOUCH.min,
    },
    languageValue: {
      flexShrink: 1,
      color: palette.text,
      fontSize: FLOW_TYPE.body,
      fontWeight: "700",
    },
    languageTranslate: {
      width: FLOW_TOUCH.compact,
      height: FLOW_TOUCH.compact,
      borderRadius: FLOW_TOUCH.compact / 2,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: palette.panelSoft,
    },
    languageTranslateActive: {
      backgroundColor: palette.cta,
    },
    languageScroll: { gap: 6, paddingVertical: 2 },
    languageChip: {
      minHeight: 36,
      paddingHorizontal: 12,
      borderRadius: FLOW_RADIUS.pill,
      borderWidth: 1,
      borderColor: palette.border,
      backgroundColor: palette.panel,
      justifyContent: "center",
    },
    languageChipActive: {
      backgroundColor: palette.panelSoft,
      borderColor: palette.text,
    },
    languageChipText: { color: palette.textMuted, fontSize: FLOW_TYPE.meta, fontWeight: "700" },
    languageChipTextActive: { color: palette.text, fontWeight: "800" },
    autoHint: { color: palette.textMuted, fontSize: FLOW_TYPE.meta, lineHeight: 18 },
    resultDetail: { color: palette.textMuted, fontSize: FLOW_TYPE.meta, lineHeight: 18 },
    liveChip: { flexDirection: "row", alignItems: "center", alignSelf: "flex-start", gap: 6, paddingVertical: 4, paddingHorizontal: 2, minHeight: 28 },
    liveDot: { width: 8, height: 8, borderRadius: 4 },
    liveText: { fontSize: FLOW_TYPE.meta, fontWeight: "600" },
    privacyNote: { flexDirection: "row", gap: FLOW_SPACING.xs, paddingHorizontal: 4, paddingTop: FLOW_SPACING.xs },
    privacyText: { flex: 1, color: palette.textMuted, fontSize: FLOW_TYPE.meta, lineHeight: 18 },
  });
}

/** Words removed by a live edit, shown struck through and fading out. */
function FadingWords({ words, color, onDone }: { words: string[]; color: string; onDone: () => void }) {
  const opacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const anim = Animated.timing(opacity, { toValue: 0, duration: 1400, delay: 300, useNativeDriver: true });
    anim.start(({ finished }) => { if (finished) onDone(); });
    return () => anim.stop();
  }, [opacity, onDone]);
  return (
    <Animated.Text numberOfLines={1} style={{ opacity, color, fontSize: 13, textDecorationLine: "line-through", marginBottom: 4, paddingHorizontal: 4 }}>
      {words.join(" ")}
    </Animated.Text>
  );
}
