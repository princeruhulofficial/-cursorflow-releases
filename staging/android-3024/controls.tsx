
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import * as Clipboard from "expo-clipboard";
import Constants from "expo-constants";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useState, type ComponentType } from "react";
import { getConnectionRoute, setConnectionRoute, type ConnectionRoute } from "@/lib/voice-link/route-pick";
import { Alert, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";

import { CursorFlowBrand } from "@/components/flow/brand";
import { PermissionsCard } from "@/components/flow/permissions-card";
import { InputModeCard } from "@/components/flow/input-mode-card";
import { ConnectedPcCard } from "@/components/flow/connected-pc-card";
import { PcConnectionSheet } from "@/components/flow/pc-connection";
import { FlowButton, FlowNotice, FlowRow, FlowSheet, type ChipTone } from "@/components/flow/ui";
import { ScreenContainer } from "@/components/screen-container";
import { FLOW_RADIUS, FLOW_SPACING, FLOW_TOUCH, FLOW_TYPE } from "@/constants/flow-theme";
import { getApiBaseUrl } from "@/constants/oauth";
import { useAuth } from "@/hooks/use-auth";
import { signOutSupabase } from "@/lib/supabase-auth";
import { getSupabaseFunctionsUrl } from "@/lib/supabase";
import { describeOfflineAi, getLastCleanup, getOfflineAiStatus, startOfflineAiDownload, type OfflineAiStatus } from "@/lib/voice-link/voice-keyboard";
import { trpc } from "@/lib/trpc";
import { speechLanguageLabel, speechLanguageRows } from "@/lib/voice-link/speech-languages";
import { AUTO_LISTENING_MIN_ANDROID_API, isAutoDetectLanguage, recognitionLocaleCandidatesForLanguage, resolveRecognitionLocale } from "@/lib/voice-link/auto-listening";
import { revokeRelaySession } from "@/lib/voice-link/local-relay";
import { CLEANUP_INSTRUCTION_TEXT, languageHintsForPreference } from "@/lib/voice-link/model/cleanup";
import { describeReadiness, diagnoseConnectionIssue } from "@/lib/voice-link/model/connection";
import { canUseCloudProcessing, describeProcessingLocation } from "@/lib/voice-link/model/data-policy";
import { buildRecoveryPlan } from "@/lib/voice-link/model/persist";
import { lanHostFromRelayUrl, MILESTONE1_NETWORK_DETAIL } from "@/lib/voice-link/pairing";
import { formatQuotaMinutes, getVoiceQuotaSummary, pullSharedAccountState, quotaProgress, type VoiceQuotaSummary } from "@/lib/voice-link/quota";
import { planDisplayName } from "@/lib/voice-link/quota-helpers";
import { useDraftStore } from "@/lib/voice-link/store/draft-store";
import { testRelayConnection, useRelayConnection } from "@/lib/voice-link/use-connection-state";
import { snippetCleanupNote } from "@/lib/voice-link/snippets";
import { personalStyleNote, useVoiceLink, type VerifiedRelayConnection, type VoiceLinkPalette } from "@/lib/voice-link/voice-link-provider";
import { normalizeVocabulary } from "@/shared/vocabulary";

type PairingSheetProps = {
  visible: boolean;
  onClose: () => void;
  palette: VoiceLinkPalette;
  onPaired: (input: { deviceName: string; relay: VerifiedRelayConnection; test: { ok: boolean; message: string } }) => void;
};

const SUBSCRIPTION_GOLD = "#C9A227";
const APP_VERSION = Constants.expoConfig?.version ?? "unknown";
const APP_BUILD = String(Constants.expoConfig?.android?.versionCode ?? "?");


function SwitchRow({ title, detail, value, onChange, disabled, palette }: { title: string; detail: string; value: boolean; onChange: (next: boolean) => void; disabled?: boolean; palette: VoiceLinkPalette }) {
  const styles = useMemo(() => createStyles(palette), [palette]);
  return (
    <View style={styles.row}>
      <View style={styles.rowCopy}>
        <Text style={styles.rowTitle}>{title}</Text>
        <Text style={styles.rowDetail}>{detail}</Text>
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        disabled={disabled}
        trackColor={{ false: palette.border, true: palette.primary }}
        thumbColor={palette.panel}
        accessibilityRole="switch"
        accessibilityLabel={title}
        accessibilityHint={detail}
      />
    </View>
  );
}

function Segment({ options, value, onChange, palette, disabled }: { options: { value: string; label: string; hint?: string }[]; value: string; onChange: (next: string) => void; palette: VoiceLinkPalette; disabled?: string | null }) {
  const styles = useMemo(() => createStyles(palette), [palette]);
  return (
    <View style={styles.segment}>
      {options.map((option) => {
        const active = option.value === value;
        const blocked = Boolean(disabled);
        return (
          <Text
            key={option.value}
            accessibilityRole="radio"
            accessibilityState={{ selected: active, disabled: blocked }}
            onPress={() => {
              if (blocked) {
                Alert.alert("Not available here", disabled ?? "This option is unavailable on this phone.");
                return;
              }
              onChange(option.value);
            }}
          >
            <View style={[styles.segmentItem, active && styles.segmentItemActive, blocked && styles.segmentItemDisabled]}>
              <Text style={[styles.segmentText, active && styles.segmentTextActive]}>{option.label}</Text>
            </View>
          </Text>
        );
      })}
    </View>
  );
}

export default function ControlsScreen() {
  const router = useRouter();
  const { logout } = useAuth({ autoFetch: false });
  const {
    device,
    relayConnection,
    relaySuspended,
    preferences,
    updatePreferences,
    palette,
    resolvedTheme,
    setRelaySuspended,
    forgetDevice,
    pairDevice,
    activities,
    clearActivities,
  } = useVoiceLink();
  const flow = useDraftStore();
  const relay = relaySuspended ? null : relayConnection;
  const styles = useMemo(() => createStyles(palette), [palette]);
  const [pairingOpen, setPairingOpen] = useState(false);
  const [PairingSheet, setPairingSheet] = useState<ComponentType<PairingSheetProps> | null>(null);
  const [manageOpen, setManageOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [connectionRoute, setConnectionRouteState] = useState<ConnectionRoute>("auto");
  useEffect(() => { void getConnectionRoute().then(setConnectionRouteState); }, []);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [personalizationOpen, setPersonalizationOpen] = useState(false);
  const [languageOpen, setLanguageOpen] = useState(false);
  const [languageQuery, setLanguageQuery] = useState("");
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const [supportedLocales, setSupportedLocales] = useState<string[]>([]);
  const [installedLocales, setInstalledLocales] = useState<string[]>([]);
  const [micPermission, setMicPermission] = useState<"unknown" | "granted" | "denied">("unknown");
  const [testResult, setTestResult] = useState<{ tone: ChipTone; message: string } | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [quotaSummary, setQuotaSummary] = useState<VoiceQuotaSummary | null>(null);
  const [quotaError, setQuotaError] = useState<string | null>(null);
  const [accountPullBusy, setAccountPullBusy] = useState(false);
  const [accountPullMessage, setAccountPullMessage] = useState<string | null>(null);
  const [vocabularySyncBusy, setVocabularySyncBusy] = useState(false);
  const [vocabularySyncMessage, setVocabularySyncMessage] = useState<string | null>(null);
  const refreshQuota = useCallback(() => {
    void getVoiceQuotaSummary()
      .then((summary) => { setQuotaSummary(summary); setQuotaError(null); })
      .catch(() => setQuotaError("Quota details are temporarily unavailable."));
  }, []);
  const { connection, probe, refresh } = useRelayConnection({ relay, suspended: relaySuspended, intervalMs: 8000 });

  const smartQuery = trpc.voice.cleanupCapabilities.useQuery(undefined, { staleTime: 120_000, retry: false });
  const accountQuery = trpc.auth.me.useQuery(undefined, { staleTime: 300_000, retry: false });
  const usageQuery = trpc.voice.usageSummary.useQuery({ days: 30 }, { staleTime: 60_000, retry: false, enabled: Boolean(accountQuery.data) });
  const vocabularyQuery = trpc.voice.vocabulary.get.useQuery(undefined, { staleTime: 30_000, retry: false, enabled: Boolean(accountQuery.data) });
  const vocabularyUpdate = trpc.voice.vocabulary.update.useMutation();
  // Flow AI cleanup is always active: cloud, then the offline model, then the rule pass.
  const smartAvailable = true;
  const [offlineAi, setOfflineAi] = useState<OfflineAiStatus | null>(null);
  const [lastCleanup, setLastCleanup] = useState("");
  const refreshOfflineAi = useCallback(() => {
    void getOfflineAiStatus().then(setOfflineAi);
    void getLastCleanup().then(setLastCleanup);
  }, []);
  useEffect(() => {
    if (!voiceOpen) return;
    refreshOfflineAi();
    const timer = setInterval(refreshOfflineAi, 1500);
    return () => clearInterval(timer);
  }, [voiceOpen, refreshOfflineAi]);
  const smartReason = smartQuery.data?.reason ?? "The cleanup service could not be reached, so Smart is marked unavailable.";

  const pullAccount = useCallback(async () => {
    setAccountPullBusy(true);
    setAccountPullMessage(null);
    try {
      const result = await pullSharedAccountState();
      setQuotaSummary(result.quota);
      await Promise.all([accountQuery.refetch(), usageQuery.refetch()]);
      setAccountPullMessage(result.accountId ? "Shared account state is up to date. Local drafts were kept unchanged." : "Sign in to pull shared account state.");
    } catch {
      setAccountPullMessage("Could not pull shared account state. Check your connection and try again.");
    } finally {
      setAccountPullBusy(false);
    }
  }, [accountQuery, usageQuery]);

  const pullAndMergeVocabulary = useCallback(async () => {
    if (!accountQuery.data) {
      setVocabularySyncMessage("Sign in to sync vocabulary across devices.");
      return;
    }
    setVocabularySyncBusy(true);
    setVocabularySyncMessage(null);
    try {
      const first = (await vocabularyQuery.refetch()).data;
      if (!first?.available) {
        setVocabularySyncMessage("Account sync is temporarily unavailable; local terms were kept.");
        return;
      }
      let remote = first.snapshot;
      let merged = normalizeVocabulary([...preferences.customVocabulary, ...remote.terms]);
      if (merged.join("\u0000") === remote.terms.join("\u0000")) {
        updatePreferences({ customVocabulary: merged });
        setVocabularySyncMessage(`Already synced · ${merged.length} term${merged.length === 1 ? "" : "s"} · revision ${remote.revision}.`);
        return;
      }
      let response = await vocabularyUpdate.mutateAsync({ expectedRevision: remote.revision, terms: merged });
      if (response.result.status === "conflict") {
        const latest = (await vocabularyQuery.refetch()).data;
        if (!latest?.available) throw new Error("The account changed while syncing.");
        remote = latest.snapshot;
        merged = normalizeVocabulary([...preferences.customVocabulary, ...remote.terms]);
        response = await vocabularyUpdate.mutateAsync({ expectedRevision: remote.revision, terms: merged });
      }
      updatePreferences({ customVocabulary: merged });
      setVocabularySyncMessage(response.result.status === "updated" ? `Pulled and merged · ${merged.length} term${merged.length === 1 ? "" : "s"} · revision ${response.result.snapshot.revision}.` : "Another device changed the vocabulary. Try again.");
    } catch {
      setVocabularySyncMessage("Vocabulary sync failed; your local terms were kept.");
    } finally {
      setVocabularySyncBusy(false);
    }
  }, [accountQuery.data, preferences.customVocabulary, updatePreferences, vocabularyQuery, vocabularyUpdate]);

  // Load PairingSheet only when opened — keeps camera graph off Controls cold mount.
  useEffect(() => {
    if (!pairingOpen || PairingSheet) return;
    let alive = true;
    void import("@/components/flow/pairing-sheet")
      .then((mod) => {
        if (alive) setPairingSheet(() => mod.PairingSheet);
      })
      .catch((error) => console.warn("[Controls] Pairing sheet unavailable", error));
    return () => {
      alive = false;
    };
  }, [pairingOpen, PairingSheet]);

  useEffect(() => {
    if (Platform.OS !== "android") return;
    void (async () => {
      try {
        const { ExpoSpeechRecognitionModule } = await import("@/lib/voice-link/speech-recognition");
        try {
          const loaded = await ExpoSpeechRecognitionModule.getSupportedLocales({});
          setSupportedLocales(loaded.locales ?? []);
        } catch {
          setSupportedLocales([]);
        }
        try {
          const installed = await ExpoSpeechRecognitionModule.getOnDeviceRecognitionLocales();
          setInstalledLocales(installed?.locales ?? []);
        } catch {
          setInstalledLocales([]);
        }
        try {
          const status = await ExpoSpeechRecognitionModule.getPermissionStatusAsync();
          setMicPermission(status === "granted" ? "granted" : status === "undetermined" ? "unknown" : "denied");
        } catch {
          setMicPermission("unknown");
        }
      } catch (error) {
        console.warn("[Controls] speech recognition probe skipped", error);
        setSupportedLocales([]);
        setInstalledLocales([]);
        setMicPermission("unknown");
      }
    })();
  }, []);

  useEffect(() => {
    refreshQuota();
    const timer = setInterval(refreshQuota, 5_000);
    return () => clearInterval(timer);
  }, [refreshQuota]);

  useEffect(() => {
    void import("@/lib/voice-link/voice-keyboard")
      .then(({ syncVoiceKeyboardCloudConfig }) =>
        syncVoiceKeyboardCloudConfig({
          // An API URL is deliberately withheld in local-only mode. The native
          // IME treats a non-empty URL as permission to upload microphone audio.
          apiBaseUrl: getSupabaseFunctionsUrl() || getApiBaseUrl(),
          language: preferences.language,
          cleanAndFormat: preferences.cleanAndFormatSpeech,
          offlineFlowAi: preferences.offlineFlowAi,
          vocabulary: preferences.customVocabulary,
          formatStyle: preferences.formatStyle,
          personalStyleNote: [personalStyleNote(preferences.personalStyle), snippetCleanupNote(preferences.snippets)].filter(Boolean).join(" "),
          snippetsJson: JSON.stringify(preferences.snippets ?? []),
        }),
      )
      .catch((error) => console.warn("[Controls] voice keyboard config sync skipped", error));
  }, [preferences.dataPolicy, preferences.language, preferences.cleanAndFormatSpeech, preferences.offlineFlowAi, preferences.customVocabulary, preferences.formatStyle, preferences.personalStyle, preferences.snippets]);

  const androidApiLevel = Platform.Version as number;
  const autoDetectSupported = Platform.OS === "android" ? androidApiLevel >= AUTO_LISTENING_MIN_ANDROID_API : false;
  const selectedLocale = resolveRecognitionLocale(preferences.language, supportedLocales);
  const languageAvailable = isAutoDetectLanguage(preferences.language) || recognitionLocaleCandidatesForLanguage(preferences.language).length === 0 || Boolean(selectedLocale);
  const retentionCount = Math.max(flow.transfers.length, activities.length);
  const unresolvedCount = buildRecoveryPlan(flow.transfers, flow.drafts).query.length;

  const disconnect = useCallback(() => {
    setRelaySuspended(true);
    // The optional overlay bubble must lose the relay too, or it would keep
    // handing captured text to a session the user just stopped.
    void import("@/lib/voice-link/floating-bubble")
      .then(({ clearFloatingCaptureRelay }) => clearFloatingCaptureRelay())
      .catch(() => undefined);
    setTestResult({ tone: "warn", message: "Disconnected. The pairing stays on this phone, so you can reconnect without a new QR code." });
  }, [setRelaySuspended]);

  const unpair = useCallback(() => {
    Alert.alert("Unpair this PC?", "This removes the saved session from this phone and revokes it on Windows when the companion supports that call. Your drafts and history stay.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Unpair",
        style: "destructive",
        onPress: async () => {
          if (relayConnection) await revokeRelaySession(relayConnection);
          try {
            const bubble = await import("@/lib/voice-link/floating-bubble");
            await bubble.clearFloatingCaptureRelay();
            void bubble.stopFloatingBubble();
          } catch {
            // Bubble native may be omitted in the minimal-open build.
          }
          updatePreferences({ floatingBubbleEnabled: false });
          forgetDevice();
          setTestResult({ tone: "neutral", message: "This phone no longer trusts that PC." });
        },
      },
    ]);
  }, [forgetDevice, relayConnection, updatePreferences]);

  const copyDiagnostics = useCallback(async () => {
    // Redacted by construction: identifiers and statuses only, never draft text.
    const payload = [
      `Cursor Flow Android ${APP_VERSION} (build ${APP_BUILD})`,
      `Theme: ${resolvedTheme} (choice ${preferences.appearance})`,
      `PC: ${device ? `${device.name} · ${relaySuspended ? "disconnected" : "session saved"}` : "not paired"}`,
      `Language: ${preferences.language} · resolved ${selectedLocale ?? "provider default"} · auto-detect ${autoDetectSupported ? "supported" : "not supported on this Android version"}`,
      `Recognition: ${micPermission === "granted" ? "microphone allowed" : micPermission === "denied" ? "microphone denied" : "microphone not asked yet"} · local-only ${preferences.keepAudioLocal ? "required" : "provider default"}`,
      `Cleanup route: ${smartAvailable ? "advertised by backend" : "unavailable"}`,
      `Local records: ${retentionCount} history entries · ${unresolvedCount} unresolved handoff(s) · drafts on this phone only`,
    ].join("\n");
    await Clipboard.setStringAsync(payload);
    Alert.alert("Diagnostics copied", "No draft text, pairing code or token is included.");
  }, [autoDetectSupported, device, micPermission, preferences.appearance, preferences.keepAudioLocal, preferences.language, retentionCount, resolvedTheme, selectedLocale, smartAvailable, unresolvedCount, relaySuspended]);

  const appearanceDetail =
    preferences.appearance === "light"
      ? "Light mode · Theme · UI density"
      : preferences.appearance === "system"
        ? "System · Theme · UI density"
        : "Dark mode · Theme · UI density";

  const logOut = useCallback(() => {
    if (!accountQuery.data) {
      Alert.alert("Not signed in", "There is no account session on this phone to sign out of. Pairing and drafts stay local.");
      return;
    }
    Alert.alert("Log out?", "This clears the account session on this phone. Your PC pairing, drafts, and local history stay.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Log Out",
        style: "destructive",
        onPress: () => {
          void (async () => {
            try {
              await signOutSupabase();
            } catch {
              // Local session clear still proceeds via logout().
            }
            await logout();
            Alert.alert("Signed out", "Account session cleared on this phone.");
          })();
        },
      },
    ]);
  }, [accountQuery.data, logout]);

  return (
    <ScreenContainer className="px-5" containerClassName="bg-background">
      <ScrollView contentContainerStyle={styles.page} showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <CursorFlowBrand palette={palette} align="left" size="sm" />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Notifications"
            onPress={() => Alert.alert("Notifications", "Push notifications are not available in this build yet.")}
            style={styles.headerButton}
          >
            <MaterialIcons name="notifications-none" size={18} color={palette.textMuted} />
          </Pressable>
        </View>

        <ConnectedPcCard
          palette={palette}
          deviceName={device?.name ?? null}
          connectionState={connection.state}
          connected={connection.state === "connected" && !relaySuspended}
          osLabel="Windows"
          lanHost={lanHostFromRelayUrl(relayConnection?.relayUrl)}
          onManage={() => (device ? setManageOpen(true) : setPairingOpen(true))}
          onPair={() => setPairingOpen(true)}
        />
        {testResult ? <FlowNotice tone={testResult.tone} title={testResult.message} palette={palette} /> : null}

        <Text style={styles.sectionLabel}>USAGE</Text>
        <View style={styles.card}>
          <FlowRow
            palette={palette}
            icon="insights"
            title="Usage & sync"
            detail="Voice allowance, speech usage and account sync"
            onPress={() => setProfileOpen(true)}
          />
        </View>

        <Text style={styles.sectionLabel}>CONNECTION & DEVICE</Text>
        <View style={styles.card}>
          <FlowRow
            palette={palette}
            icon="wifi"
            title="Network"
            detail={device ? MILESTONE1_NETWORK_DETAIL : "Same Wi-Fi or Internet · pair to enable transfer"}
            onPress={() => {
              Alert.alert(
                "Local Wi-Fi",
                "Choose Same Wi-Fi or Internet under Connection below. Internet mode uses the encrypted Cursor Flow relay and needs sign-in.",
              );
            }}
          />
          <View style={styles.divider} />
          <FlowRow
            palette={palette}
            icon="devices"
            title="Paired Devices"
            detail={device ? (relaySuspended ? "1 device saved · disconnected" : connection.state === "connected" ? "1 device connected" : "1 device paired") : "No devices paired"}
            onPress={() => (device ? setManageOpen(true) : setPairingOpen(true))}
          />
          <View style={styles.divider} />
          <FlowRow
            palette={palette}
            icon="security"
            title="Security"
            detail="Encryption • Device Authorization"
            onPress={() => {
              Alert.alert(
                "Local relay security",
                "Pairing uses HTTPS on your Wi-Fi with a certificate pin from the Windows QR or Device Link. Cleartext HTTP is not used.",
              );
            }}
          />
        </View>

        <Text style={styles.sectionLabel}>INPUT & FILE TRANSFER</Text>
        <View style={styles.card}>
          <FlowRow
            palette={palette}
            icon="mic-none"
            title="Voice Settings"
            detail="Language · Speech Engine · Sensitivity"
            onPress={() => setVoiceOpen(true)}
          />
          <View style={styles.divider} />
          <FlowRow
            palette={palette}
            icon="image"
            title="File & Image Transfer"
            detail="Images, PDFs, documents · Up to 2 GB · Same Wi-Fi or Internet"
            onPress={() => {
              Alert.alert(
                "File and image transfer",
                "Use Attach, Image or File on the Console tab. Files up to 1 GB are sent over the same Wi-Fi (PC app 1.8 or newer; older PC apps stop at 50 MB) and saved in the Cursor Flow files folder on your PC. They are not pasted automatically.",
              );
            }}
          />
          <View style={styles.divider} />
          <FlowRow
            palette={palette}
            icon="keyboard"
            title="Keyboard & Input"
            detail="Language · Shortcuts · Auto-correct"
            onPress={() => {
              void import("@/lib/voice-link/voice-keyboard")
                .then(({ getVoiceKeyboardStatus }) => getVoiceKeyboardStatus())
                .catch(() => undefined);
              router.push("/voice-keyboard");
            }}
          />
        </View>

        <Text style={styles.sectionLabel}>INPUT MODE</Text>
        <InputModeCard palette={palette} cardStyle={styles.card} />

        <Text style={styles.sectionLabel}>PERMISSIONS & KEYBOARD</Text>
        <PermissionsCard palette={palette} cardStyle={styles.card} />

        <Text style={styles.sectionLabel}>APP & SYSTEM</Text>
        <View style={styles.card}>
          <FlowRow
            palette={palette}
            icon="tune"
            title="Appearance"
            detail={appearanceDetail}
            onPress={() => setAppearanceOpen(true)}
          />
          <View style={styles.divider} />
          <FlowRow
            palette={palette}
            icon="system-update-alt"
            title="App Updates"
            detail="Check for latest version"
            trailing={
              <View style={styles.versionPill}>
                <Text style={styles.versionPillText}>v{APP_VERSION}</Text>
              </View>
            }
            onPress={() => {
              Alert.alert(
                "App updates",
                `This build is Cursor Flow Android ${APP_VERSION} (build ${APP_BUILD}). In-app update checks are not wired yet; install the APK your team distributes.`,
              );
            }}
          />
          <View style={styles.divider} />
          <FlowRow
            palette={palette}
            icon="description"
            title="Logs & Diagnostics"
            detail="View logs · Report issues"
            onPress={() => setDiagnosticsOpen(true)}
          />
        </View>

        <Text style={styles.sectionLabel}>SUPPORT & INFO</Text>
        <View style={styles.card}>
          <FlowRow
            palette={palette}
            icon="help-outline"
            title="Help & Support"
            detail="FAQs · Contact us"
            onPress={() => setHelpOpen(true)}
          />
          <View style={styles.divider} />
          <FlowRow
            palette={palette}
            icon="info-outline"
            title="About Cursor Flow"
            detail={`Version ${APP_VERSION} · Build ${APP_BUILD}`}
            onPress={() => {
              Alert.alert(
                "About Cursor Flow",
                `Cursor Flow Android ${APP_VERSION} (build ${APP_BUILD}). Local Wi-Fi companion for drafting voice or typed text to your Windows PC. ${smartAvailable ? "Smart cleanup runs through the backend." : "Smart cleanup is unavailable until an approved provider route is configured."}`,
              );
            }}
          />
        </View>

      </ScrollView>

      <FlowSheet visible={profileOpen} onClose={() => setProfileOpen(false)} palette={palette} title="Usage & sync" subtitle="Sign in and your plan live on the Account tab. Pairing and drafts stay local.">
        <View style={styles.rowStack}>
          <Text style={styles.rowTitle}>Shared account sync</Text>
          <Text style={styles.rowDetail}>Pull the latest subscription and usage state from Supabase. This merges account metadata only; local drafts, audio, and keyboard preferences are never replaced.</Text>
          <FlowButton label={accountPullBusy ? "Pulling…" : "Pull & merge latest"} variant="secondary" onPress={() => { void pullAccount(); }} disabled={accountPullBusy} palette={palette} />
          {accountPullMessage ? <Text style={styles.rowDetail}>{accountPullMessage}</Text> : null}
        </View>
        <View style={styles.divider} />
        <View style={styles.rowStack}>
          <Text style={styles.rowTitle}>Shared allowance</Text>
          <Text style={styles.rowDetail}>
            {quotaSummary
              ? `${planDisplayName(quotaSummary.plan_code)} · ${formatQuotaMinutes(quotaSummary.consumed_ms + quotaSummary.reserved_ms).toFixed(1)} of ${quotaSummary.limit_minutes} minutes used`
              : quotaError ?? "Loading your shared account allowance…"}
          </Text>
          {quotaSummary ? <View style={styles.quotaTrack}><View style={[styles.quotaFill, { width: `${Math.round(quotaProgress(quotaSummary) * 100)}%` }]} /></View> : null}
          {quotaSummary ? <Text style={styles.rowDetail}>{formatQuotaMinutes(quotaSummary.remaining_ms).toFixed(1)} minutes remaining · resets {quotaSummary.period_end}</Text> : null}
        </View>
        <View style={styles.divider} />
        <View style={styles.rowStack}>
          <Text style={styles.rowTitle}>Speech usage · last 30 days</Text>
          <Text style={styles.rowDetail}>
            {usageQuery.isPending
              ? "Loading account usage…"
              : usageQuery.data?.available
                ? `${usageQuery.data.totalEvents} cloud event${usageQuery.data.totalEvents === 1 ? "" : "s"} · ${(usageQuery.data.totalDurationMs / 60000).toFixed(1)} transcription minutes. This includes signed-in desktop and mobile activity; transcript text and audio are not stored.`
                : "Usage summary is unavailable until the server usage table is configured."}
          </Text>
        </View>
      </FlowSheet>

      <FlowSheet visible={voiceOpen} onClose={() => setVoiceOpen(false)} palette={palette} title="Voice Settings" subtitle="How your voice becomes text.">
        <SwitchRow
          palette={palette}
          title="Review before sending"
          detail={preferences.reviewBeforeSending ? "Your words land in the draft. Tap Send when ready." : "Off. Your words are typed as you finish speaking."}
          value={preferences.reviewBeforeSending}
          onChange={(value) => updatePreferences({ reviewBeforeSending: value })}
        />
        <View style={styles.divider} />
        <View style={styles.rowStack}>
          <Text style={styles.rowTitle}>Dictation style</Text>
          <Text style={styles.rowDetail}>{preferences.cleanAndFormatSpeech ? "Polished: tidy wording and formatting, with a short cleanup pass." : "Verbatim: keep my words. No automatic rewriting."}</Text>
          <Segment
            palette={palette}
            value={preferences.cleanAndFormatSpeech ? "polished" : "verbatim"}
            onChange={(value) => updatePreferences({ cleanAndFormatSpeech: value === "polished", smartCleanupOptIn: true })}
            options={[{ value: "verbatim", label: "Verbatim" }, { value: "polished", label: "Polished" }]}
          />
        </View>
        <View style={styles.divider} />
        <SwitchRow
          palette={palette}
          title="Smart cleanup"
          detail="Detection already cleans on send; this keeps the manual/advanced cleanup option."
          value={preferences.smartCleanupEnabled}
          onChange={(value) => {
            if (value && !preferences.smartConsentAccepted) {
              updatePreferences({ smartConsentAccepted: true, smartCleanupEnabled: true });
            } else {
              updatePreferences({ smartCleanupEnabled: value });
            }
          }}
        />
        <View style={styles.divider} />
        <SwitchRow
          palette={palette}
          title="Clean up after voice automatically"
          detail={preferences.smartCleanupAfterVoice ? "Runs once when a voice session finishes, never on partial text." : "Off. Run cleanup yourself when you want it."}
          value={preferences.smartCleanupAfterVoice}
          onChange={(value) => updatePreferences({ smartCleanupAfterVoice: value })}
          disabled={!preferences.smartCleanupEnabled}
        />
        <View style={styles.divider} />
        <View style={styles.rowStack}>
          <Text style={styles.rowTitle}>Connection</Text>
          <Text style={styles.rowDetail}>{connectionRoute === "wifi" ? "Wi-Fi only. The phone and PC must be on the same Wi-Fi." : connectionRoute === "internet" ? "Internet only. Works from anywhere while the PC is online." : "Auto. Wi-Fi when the PC is on the same network, otherwise the internet."}</Text>
          <Segment
            palette={palette}
            value={connectionRoute}
            onChange={(next) => { const v = next as ConnectionRoute; setConnectionRouteState(v); void setConnectionRoute(v); }}
            options={[
              { value: "auto", label: "Auto" },
              { value: "wifi", label: "Wi-Fi" },
              { value: "internet", label: "Internet" },
            ]}
          />
        </View>
        <View style={styles.divider} />
        <View style={styles.rowStack}>
          <Text style={styles.rowTitle}>Offline Flow AI</Text>
          <Text style={styles.rowDetail}>{describeOfflineAi(offlineAi, true)}</Text>
        </View>
        {offlineAi && offlineAi.state === "downloading" ? (
          <View style={[styles.offlineBar, { backgroundColor: palette.border }]}>
            <View style={{ width: `${offlineAi.percent}%`, height: "100%", backgroundColor: palette.primary, borderRadius: 2 }} />
          </View>
        ) : null}
        {offlineAi && (offlineAi.state === "idle" || offlineAi.state === "failed" || offlineAi.state === "waiting_wifi") ? (
          <Pressable accessibilityRole="button" onPress={() => { void startOfflineAiDownload().then(refreshOfflineAi); }} style={[styles.offlineButton, { borderColor: palette.border }]}>
            <Text style={[styles.rowTitle, { color: palette.primary }]}>{offlineAi.state === "failed" ? "Retry" : "Download"}</Text>
          </Pressable>
        ) : null}
        {lastCleanup ? (
          <Text style={[styles.diagLine, { color: palette.textMuted }]}>Last cleanup: {lastCleanup}</Text>
        ) : null}
        <View style={styles.divider} />
        <SwitchRow
          palette={palette}
          title="Live typing"
          detail={preferences.keyboardLiveTyping !== false ? "Words appear as you speak." : "Off. Text is inserted when you finish."}
          value={preferences.keyboardLiveTyping !== false}
          onChange={(value) => updatePreferences({ keyboardLiveTyping: value })}
        />
        <View style={styles.divider} />
        <SwitchRow
          palette={palette}
          title="Key sound"
          detail={preferences.keyboardKeySound ? "A soft click on each key." : "Off."}
          value={preferences.keyboardKeySound === true}
          onChange={(value) => updatePreferences({ keyboardKeySound: value })}
        />
        <View style={styles.divider} />
        <SwitchRow
          palette={palette}
          title="Vibration"
          detail={preferences.keyboardHaptics !== false ? "A light tap on each key." : "Off."}
          value={preferences.keyboardHaptics !== false}
          onChange={(value) => updatePreferences({ keyboardHaptics: value })}
        />
        <View style={styles.divider} />
        <FlowRow
          palette={palette}
          icon="language"
          title="Language"
          detail={speechLanguageLabel(preferences.language)}
          onPress={() => setLanguageOpen(true)}
        />
        <View style={styles.divider} />
        <FlowRow
          palette={palette}
          icon="tune"
          title="Voice personalization"
          detail={`${preferences.customVocabulary.length} vocabulary term${preferences.customVocabulary.length === 1 ? "" : "s"}`}
          onPress={() => setPersonalizationOpen(true)}
        />
        <View style={styles.divider} />
        <FlowRow palette={palette} icon="lock" title="About privacy" detail="Online, Flow AI turns speech into text. Offline, it stays on this phone. Audio is never stored." onPress={() => setPrivacyOpen(true)} />
        <View style={styles.divider} />
        <View style={styles.rowStack}>
          <Text style={styles.rowTitle}>On this phone</Text>
          <Text style={styles.rowDetail}>
            {retentionCount} recent entr{retentionCount === 1 ? "y" : "ies"} and your drafts are stored on this device only. {unresolvedCount} handoff{unresolvedCount === 1 ? "" : "s"} still need review and are kept even after clearing history.
          </Text>
        </View>
        <View style={styles.divider} />
        <FlowRow palette={palette} icon="delete-sweep" title="Clear recent history" detail="Settled entries leave the list. Unresolved handoffs and their text stay." onPress={() => {
          Alert.alert("Clear recent history?", unresolvedCount ? `${unresolvedCount} handoff${unresolvedCount === 1 ? "" : "s"} still need your review, so they stay listed. Everything already settled will be removed.` : "This removes the visible list on this phone. Nothing on your PC is deleted.", [
            { text: "Cancel", style: "cancel" },
            { text: "Clear", style: "destructive", onPress: () => { flow.clearHistory(); clearActivities(); } },
          ]);
        }} />
        <View style={styles.divider} />
        <FlowRow palette={palette} icon="notes" title="Delete drafts" detail="Removes saved draft text from this phone, including pending Smart versions." destructive onPress={() => {
          Alert.alert("Delete all drafts?", "This removes the draft text saved on this phone, including any text that was not sent yet. This cannot be undone.", [
            { text: "Cancel", style: "cancel" },
            { text: "Delete drafts", style: "destructive", onPress: () => flow.clearDrafts() },
          ]);
        }} />
        <View style={styles.divider} />
        <FlowRow
          palette={palette}
          icon="settings"
          title="Advanced"
          detail="Detection or Action Mode, translation, microphones, noise reduction, offline models."
          onPress={() => setAdvancedOpen(true)}
        />
      </FlowSheet>

      <FlowSheet visible={appearanceOpen} onClose={() => setAppearanceOpen(false)} palette={palette} title="Appearance" subtitle="Your previous choice is preserved. System follows Android’s light or dark setting.">
        <View style={styles.rowStack}>
          <Text style={styles.rowTitle}>Theme</Text>
          <Text style={styles.rowDetail}>Light and dark match the Cursor Flow mockups. No redesign drift.</Text>
          <Segment
            palette={palette}
            value={preferences.appearance}
            onChange={(next) => updatePreferences({ appearance: next as "dark" | "light" | "system" })}
            options={[
              { value: "system", label: "System" },
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
            ]}
          />
        </View>
        <View style={styles.divider} />
        <SwitchRow palette={palette} title="Reduce motion" detail={preferences.reducedMotion ? "The recording indicator stays still. Transitions are shortened." : "Android's reduced-motion setting can also be honoured by the system."} value={preferences.reducedMotion} onChange={(value) => updatePreferences({ reducedMotion: value })} />
      </FlowSheet>

      <FlowSheet visible={diagnosticsOpen} onClose={() => setDiagnosticsOpen(false)} palette={palette} title="Logs & Diagnostics" subtitle="Redacted identifiers only — never draft text.">
        <FlowButton label="Copy redacted diagnostics" icon="bug-report" variant="secondary" onPress={() => void copyDiagnostics()} palette={palette} />
        <FlowNotice tone="neutral" title="What is included" detail="App version, theme choice, pairing status, language, microphone permission, cleanup route availability, and local history counts." palette={palette} />
      </FlowSheet>

      <FlowSheet visible={advancedOpen} onClose={() => setAdvancedOpen(false)} palette={palette} title="Advanced" subtitle="Optional engines and modes. Defaults stay simple.">
        <SwitchRow palette={palette} title="Translate when asked" detail="Off keeps your language. Requests are only honoured when the Windows companion supports them." value={preferences.translateOnRequest} onChange={(value) => updatePreferences({ translateOnRequest: value })} />
        <View style={styles.divider} />
        <View style={styles.rowStack}>
          <Text style={styles.rowTitle}>Input source</Text>
          <Text style={styles.rowDetail}>{preferences.inputMode === "phone" ? "Phone microphone, started by you." : "Desktop microphone, controlled from Windows."}</Text>
          <FlowButton label="Switch input source" variant="secondary" onPress={() => updatePreferences({ inputMode: preferences.inputMode === "phone" ? "desktop" : "phone" })} palette={palette} />
        </View>
        <View style={styles.divider} />
        <View style={styles.rowStack}>
          <Text style={styles.rowTitle}>Voice mode</Text>
          <Text style={styles.rowDetail}>Detection Mode sends plain text. Action Mode sends a versioned action request for the Windows Agent, which still decides and confirms on the PC.</Text>
          <Segment
            palette={palette}
            value={preferences.listeningMode}
            onChange={(next) => updatePreferences({ listeningMode: next === "action" ? "action" : "detection" })}
            options={[
              { value: "detection", label: "Detection" },
              { value: "action", label: "Action" },
            ]}
          />
        </View>
        <View style={styles.divider} />
        <SwitchRow palette={palette} title="On-device noise reduction" detail="Requests Android's voice-processing effects when the speech service supports them." value={preferences.noiseReductionEnabled} onChange={(value) => updatePreferences({ noiseReductionEnabled: value })} />
        <View style={styles.divider} />
        <SwitchRow palette={palette} title="Quick panel" detail={Platform.OS === "android" ? "A discreet edge handle opens Detection, Clipboard, Scan and Attach. Detection listens here and sends to your PC cursor. Tap again to finish." : "Available in the Android build only."} value={preferences.floatingBubbleEnabled} onChange={(value) => { updatePreferences({ floatingBubbleEnabled: value }); if (Platform.OS !== "android") Alert.alert("Android only", "The quick panel is available in the Android build."); }} />
        <View style={styles.divider} />
        <FlowRow palette={palette} icon="download" title="Offline speech models" detail={installedLocales.length ? `${installedLocales.length} locale(s) installed for on-device recognition.` : "Opens Android's model download screen for the selected language."} onPress={async () => {
          if (Platform.OS !== "android") {
            Alert.alert("Android only", "Offline models are managed by the Android speech service.");
            return;
          }
          const locale = resolveRecognitionLocale(preferences.language, supportedLocales) ?? recognitionLocaleCandidatesForLanguage(preferences.language)[0];
          if (!locale) {
            Alert.alert("Language model unavailable", "This Android speech service did not report a model for the selected language.");
            return;
          }
          try {
            const { ExpoSpeechRecognitionModule } = await import("@/lib/voice-link/speech-recognition");
            const result = await ExpoSpeechRecognitionModule.androidTriggerOfflineModelDownload({ locale });
            Alert.alert("Offline model", result?.message ?? "Offline model request sent.");
          } catch {
            Alert.alert("Offline model could not open", "Open Android Settings, update the speech service, then download the model there. Speak may be unavailable in this minimal-open build — type and Send still work.");
          }
        }} />
      </FlowSheet>

      <FlowSheet visible={personalizationOpen} onClose={() => setPersonalizationOpen(false)} palette={palette} title="Voice personalization" subtitle="One set of preferences for Console dictation and Voice Keyboard.">
        <View style={styles.sheetIntro}>
          <MaterialIcons name="info-outline" size={18} color={palette.primary} />
          <Text style={styles.sheetIntroText}>Voice Keyboard inserts into the app you are using. Phone → PC text and file handoff remains a separate Console action, so nothing is redirected unexpectedly.</Text>
        </View>
        <View style={styles.rowStack}>
          <Text style={styles.rowTitle}>Output format</Text>
          <Text style={styles.rowDetail}>Natural is the default. Spoken punctuation is applied only when clearly dictated.</Text>
          <Segment
            palette={palette}
            value={preferences.formatStyle}
            onChange={(value) => updatePreferences({ formatStyle: value as typeof preferences.formatStyle })}
            options={[{ value: "natural", label: "Natural" }, { value: "paragraphs", label: "Paragraphs" }, { value: "bullets", label: "Bullets" }, { value: "email", label: "Email" }]}
          />
        </View>
        <View style={styles.divider} />
        <View style={styles.rowStack}>
          <Text style={styles.rowTitle}>Custom vocabulary</Text>
          <Text style={styles.rowDetail}>Up to 32 names, products, and technical terms. Separate terms with commas.</Text>
          <TextInput
            value={preferences.customVocabulary.join(", ")}
            onChangeText={(value) => updatePreferences({ customVocabulary: value.split(",").map((term) => term.trim()).filter(Boolean).slice(0, 32) })}
            placeholder="Cursor Flow, Qwen, llama.cpp"
            placeholderTextColor={palette.textMuted}
            autoCapitalize="none"
            style={[styles.vocabularyInput, { color: palette.text, borderColor: palette.border, backgroundColor: palette.panelSoft }]}
            accessibilityLabel="Custom vocabulary"
          />
          <FlowButton
            label={vocabularySyncBusy ? "Syncing vocabulary…" : "Pull & merge from account"}
            icon="sync"
            variant="secondary"
            onPress={() => void pullAndMergeVocabulary()}
            disabled={vocabularySyncBusy || vocabularyUpdate.isPending}
            palette={palette}
          />
          <Text style={styles.rowDetail}>{vocabularySyncMessage ?? (accountQuery.data ? "Merges this phone's terms with your account vocabulary. Existing terms are never silently deleted." : "Sign in to sync vocabulary across devices. Local terms remain available offline.")}</Text>
        </View>
        <View style={styles.divider} />
        <View style={styles.rowStack}>
          <Text style={styles.rowTitle}>Quick Start links</Text>
          <Text style={styles.rowDetail}>Say “my email”, “my Facebook”, or “my YouTube” in Action Mode. Only HTTPS/HTTP links are accepted, and the Windows Agent must confirm before opening.</Text>
          {preferences.quickStartShortcuts.map((shortcut) => (
            <View key={shortcut.id} style={styles.quickStartRow}>
              <Text style={styles.quickStartLabel}>{shortcut.label}</Text>
              <TextInput
                value={shortcut.phrase}
                onChangeText={(value) => updatePreferences({ quickStartShortcuts: preferences.quickStartShortcuts.map((item) => item.id === shortcut.id ? { ...item, phrase: value } : item) })}
                placeholder={`my ${shortcut.label.toLowerCase()}`}
                placeholderTextColor={palette.textMuted}
                style={[styles.vocabularyInput, styles.quickStartInput, { color: palette.text, borderColor: palette.border, backgroundColor: palette.panelSoft }]}
                accessibilityLabel={`${shortcut.label} Quick Start phrase`}
              />
              <TextInput
                value={shortcut.url}
                onChangeText={(value) => updatePreferences({ quickStartShortcuts: preferences.quickStartShortcuts.map((item) => item.id === shortcut.id ? { ...item, url: value } : item) })}
                placeholder="https://…"
                placeholderTextColor={palette.textMuted}
                autoCapitalize="none"
                keyboardType="url"
                style={[styles.vocabularyInput, styles.quickStartInput, { color: palette.text, borderColor: palette.border, backgroundColor: palette.panelSoft }]}
                accessibilityLabel={`${shortcut.label} Quick Start URL`}
              />
            </View>
          ))}
        </View>
      </FlowSheet>

      <FlowSheet visible={helpOpen} onClose={() => setHelpOpen(false)} palette={palette} title="Help & Support" subtitle={describeReadiness(probe ? { ...probe } : null)}>
        <FlowNotice tone="neutral" title="FAQs" detail="Pair over the same Wi-Fi, draft on Console or Voice Keyboard, then Send. Send files up to 2 GB with Attach. Pick Same Wi-Fi or Internet under Connection." palette={palette} />
        {diagnoseConnectionIssue({ probe: probe ? { ...probe } : null, sameSsidConfirmed: false }).map((diagnostic, index) => (
          <FlowRow key={diagnostic.kind} palette={palette} icon={index === 0 ? "laptop-windows" : "settings-ethernet"} title={diagnostic.title} detail={diagnostic.check} />
        ))}
        <FlowNotice tone="warn" title="A matching Wi-Fi name is not proof of a path" detail="Guest and IoT bands often block device-to-device traffic even with the same SSID. Do not turn your firewall off; allow Cursor Flow on the Private network profile instead." palette={palette} />
        <FlowButton label="Test this connection" icon="network-check" variant="secondary" palette={palette} onPress={async () => {
          const outcome = await testRelayConnection(relay);
          setTestResult({ tone: outcome.ok ? "good" : "bad", message: outcome.message });
          setHelpOpen(false);
        }} />
      </FlowSheet>

      <FlowSheet visible={languageOpen} onClose={() => setLanguageOpen(false)} palette={palette} title="Speaking language" subtitle="Your language is preserved. Nothing is translated automatically.">
        <TextInput
          value={languageQuery}
          onChangeText={setLanguageQuery}
          placeholder="Search languages"
          placeholderTextColor={palette.textMuted}
          autoCapitalize="none"
          style={[styles.vocabularyInput, { color: palette.text, borderColor: palette.border, backgroundColor: palette.panelSoft }]}
          accessibilityLabel="Search languages"
        />
        {speechLanguageRows(languageQuery).map(({ value: language, title, subtitle }) => {
          const unavailable = isAutoDetectLanguage(language) && !autoDetectSupported;
          return (
            <FlowRow
              key={language}
              palette={palette}
              title={title}
              detail={unavailable ? `Automatic detection needs Android ${AUTO_LISTENING_MIN_ANDROID_API} or newer on this speech service.` : subtitle}
              onPress={() => {
                if (unavailable) return;
                updatePreferences({ language });
                setLanguageQuery("");
                setLanguageOpen(false);
              }}
              trailing={preferences.language === language ? <MaterialIcons name="check" size={20} color={palette.primary} /> : undefined}
            />
          );
        })}
      </FlowSheet>

      <FlowSheet visible={privacyOpen} onClose={() => setPrivacyOpen(false)} palette={palette} title="Processing paths" subtitle="Three separate routes, stated plainly.">
        <FlowNotice tone="neutral" title="1. Microphone audio" detail={describeProcessingLocation(preferences.dataPolicy)} palette={palette} />
        <FlowNotice tone="neutral" title="2. Recognized text for cleanup" detail={smartAvailable ? "Only the finished text is sent to the Cursor Flow backend, and only after you allow cleanup. The prompt is a fixed instruction; your text is content, never an instruction to act." : "No approved cleanup provider is configured, so nothing is sent for cleanup and Smart stays off."} palette={palette} />
        <FlowNotice tone="neutral" title="3. Final text to Windows" detail="The exact reviewed text goes to the paired PC over your local network. Windows decides where it lands and reports back what it can prove." palette={palette} />
        <FlowNotice tone="warn" title="What is stored" detail="Drafts and delivery status are stored on this phone so a failed send can be recovered. The pairing token lives in Android's secure storage. Diagnostics never include draft text." palette={palette} />
        {smartAvailable ? (
          <View style={styles.promptCard}>
            <Text style={styles.promptTitle}>Cleanup instruction sent with every request</Text>
            <Text style={styles.promptBody}>{`${CLEANUP_INSTRUCTION_TEXT}\n\nLanguage hints for this request: ${languageHintsForPreference(preferences.language).join(", ")}`}</Text>
          </View>
        ) : null}
      </FlowSheet>

      <PcConnectionSheet
        visible={manageOpen}
        onClose={() => setManageOpen(false)}
        palette={palette}
        deviceName={device?.name ?? null}
        connection={connection}
        probe={probe}
        readiness={describeReadiness(probe ? { ...probe } : null)}
        diagnostics={diagnoseConnectionIssue({ probe: probe ? { ...probe } : null, sameSsidConfirmed: false })}
        suspended={relaySuspended}
        busy={false}
        testMessage={testResult?.message ?? null}
        testTone={testResult?.tone ?? "neutral"}
        pairedAtLabel={device?.pairedAt ? new Date(device.pairedAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : null}
        onTest={async () => {
          const outcome = await testRelayConnection(relay);
          setTestResult({ tone: outcome.ok ? "good" : "bad", message: outcome.message });
          void refresh();
        }}
        onReconnect={() => {
          setRelaySuspended(false);
          setTestResult({ tone: "warn", message: "Reconnecting…" });
          void refresh();
        }}
        onDisconnect={disconnect}
        onUnpair={unpair}
        onRescan={() => {
          setManageOpen(false);
          setPairingOpen(true);
        }}
      />

      {PairingSheet ? (
        <PairingSheet
          visible={pairingOpen}
          onClose={() => setPairingOpen(false)}
          palette={palette}
          onPaired={(input) => {
            pairDevice({ name: input.deviceName, relayConnection: input.relay });
            setRelaySuspended(false);
            setPairingOpen(false);
            setTestResult({ tone: input.test.ok ? "good" : "bad", message: input.test.message });
            void refresh();
          }}
        />
      ) : null}
    </ScreenContainer>
  );
}

function createStyles(palette: VoiceLinkPalette) {
  return StyleSheet.create({
    page: { flexGrow: 1, paddingTop: FLOW_SPACING.lg, paddingBottom: FLOW_SPACING.xl + FLOW_TOUCH.min, gap: FLOW_SPACING.sm },
    header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: FLOW_TOUCH.compact },
    headerButton: {
      width: FLOW_TOUCH.compact,
      height: FLOW_TOUCH.compact,
      borderRadius: FLOW_TOUCH.compact / 2,
      borderWidth: 1,
      borderColor: palette.border,
      backgroundColor: palette.panelSoft,
      alignItems: "center",
      justifyContent: "center",
    },
    sectionLabel: { color: palette.textMuted, fontSize: 11, fontWeight: "700", letterSpacing: 1.1, marginTop: FLOW_SPACING.md, marginBottom: 2 },
    card: { borderRadius: FLOW_RADIUS.card, borderWidth: 1, borderColor: palette.border, backgroundColor: palette.panel, paddingHorizontal: FLOW_SPACING.md, paddingVertical: 4 },
    sheetIntro: { flexDirection: "row", alignItems: "flex-start", gap: 8, padding: FLOW_SPACING.sm, borderRadius: FLOW_RADIUS.control, backgroundColor: palette.panelSoft, borderWidth: 1, borderColor: palette.border },
    sheetIntroText: { flex: 1, color: palette.textMuted, fontSize: FLOW_TYPE.meta, lineHeight: 18 },
    row: { minHeight: FLOW_TOUCH.min, flexDirection: "row", alignItems: "center", gap: FLOW_SPACING.sm, paddingVertical: 10 },
    rowStack: { paddingVertical: 10, gap: 4 },
    diagLine: { fontSize: 11, opacity: 0.7, marginBottom: 6 },
    offlineBar: { height: 4, borderRadius: 2, overflow: "hidden", marginBottom: 8 },
    offlineButton: { alignSelf: "flex-start", paddingHorizontal: 14, paddingVertical: 6, borderRadius: 14, borderWidth: 1, marginBottom: 8 },
    rowCopy: { flex: 1, gap: 2 },
    rowTitle: { color: palette.text, fontSize: FLOW_TYPE.secondary, fontWeight: "700" },
    rowDetail: { color: palette.textMuted, fontSize: FLOW_TYPE.meta, lineHeight: 18 },
    quotaTrack: { height: 8, borderRadius: 99, overflow: "hidden", backgroundColor: palette.panelSoft, borderWidth: 1, borderColor: palette.border, marginTop: 6 },
    quotaFill: { height: "100%", borderRadius: 99, backgroundColor: palette.primary },
    vocabularyInput: { minHeight: 46, borderWidth: 1, borderRadius: FLOW_RADIUS.control, paddingHorizontal: 12, paddingVertical: 10, fontSize: FLOW_TYPE.secondary },
    quickStartRow: { gap: 6, marginTop: 6 },
    quickStartLabel: { color: palette.textMuted, fontSize: FLOW_TYPE.meta, fontWeight: "700" },
    quickStartInput: { minHeight: 40 },
    divider: { height: StyleSheet.hairlineWidth, backgroundColor: palette.border, opacity: 0.85 },
    segment: { flexDirection: "row", gap: 4, padding: 4, borderRadius: FLOW_RADIUS.control, backgroundColor: palette.panelSoft, borderWidth: 1, borderColor: palette.border },
    segmentItem: { minHeight: 38, paddingHorizontal: 14, borderRadius: FLOW_RADIUS.control - 3, alignItems: "center", justifyContent: "center", flex: 1 },
    segmentItemActive: { backgroundColor: palette.primary },
    segmentItemDisabled: { opacity: 0.55 },
    segmentText: { color: palette.textMuted, fontSize: FLOW_TYPE.meta, fontWeight: "700" },
    segmentTextActive: { color: palette.onPrimary },
    promptCard: { padding: FLOW_SPACING.sm, borderRadius: FLOW_RADIUS.control, borderWidth: 1, borderColor: palette.border, backgroundColor: palette.panelSoft },
    promptTitle: { color: palette.text, fontSize: FLOW_TYPE.meta, fontWeight: "800" },
    promptBody: { color: palette.textMuted, fontSize: 12, lineHeight: 18, marginTop: 6 },
    buttonRow: { flexDirection: "row", flexWrap: "wrap", gap: FLOW_SPACING.xs, marginTop: 4 },
    versionPill: {
      minHeight: 26,
      paddingHorizontal: 10,
      borderRadius: FLOW_RADIUS.pill,
      borderWidth: 1,
      borderColor: palette.border,
      backgroundColor: palette.panelSoft,
      alignItems: "center",
      justifyContent: "center",
    },
    versionPillText: { color: palette.textMuted, fontSize: 11, fontWeight: "700" },
    logOutButton: {
      minHeight: FLOW_TOUCH.min,
      marginTop: FLOW_SPACING.md,
      borderRadius: FLOW_RADIUS.card,
      borderWidth: 1,
      borderColor: palette.border,
      backgroundColor: palette.panel,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
    },
    logOutPressed: { opacity: 0.85 },
    logOutText: { color: palette.text, fontSize: FLOW_TYPE.secondary, fontWeight: "700" },
  });
}
