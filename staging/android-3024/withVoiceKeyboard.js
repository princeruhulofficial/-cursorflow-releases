const { withAndroidManifest, withAppBuildGradle, withDangerousMod, withMainApplication, withSettingsGradle } = require("@expo/config-plugins");
const { copyFileSync, mkdirSync, writeFileSync } = require("node:fs");
const { dirname, join, resolve } = require("node:path");

const androidPackage = "com.voicelink.mobile";
const sourceDirectory = resolve(process.cwd(), "plugins", "voice-keyboard", "native");

module.exports = function withVoiceKeyboard(config) {
  config = withAndroidManifest(config, (mod) => {
    const manifest = mod.modResults.manifest;
    manifest.application = manifest.application || [{}];
    const application = manifest.application[0];
    application.service = application.service || [];
    const existing = application.service.find((item) => item.$?.["android:name"] === ".VoiceKeyboardService");
    if (!existing) {
      application.service.push({
        $: {
          "android:name": ".VoiceKeyboardService",
          "android:exported": "true",
          "android:label": "Cursor Flow Voice Keyboard",
          "android:permission": "android.permission.BIND_INPUT_METHOD",
        },
        "intent-filter": [{ action: [{ $: { "android:name": "android.view.InputMethod" } }] }],
        "meta-data": [{ $: { "android:name": "android.view.im", "android:resource": "@xml/voice_keyboard_method" } }],
      });
    } else if (existing.$) {
      existing.$["android:label"] = "Cursor Flow Voice Keyboard";
    }
    application.service = application.service.filter((item) => item.$?.["android:name"] !== ".SmartContextAccessibilityService");
    if (!application.service.some((item) => [".FlowLlmService", `${androidPackage}.FlowLlmService`].includes(item.$?.["android:name"]))) {
      application.service.push({ $: { "android:name": `${androidPackage}.FlowLlmService`, "android:exported": "false", "android:process": ":llm" } });
    }
    if (!application.service.some((item) => [".PcLinkService", `${androidPackage}.PcLinkService`].includes(item.$?.["android:name"]))) {
      application.service.push({ $: { "android:name": `${androidPackage}.PcLinkService`, "android:exported": "false", "android:foregroundServiceType": "mediaPlayback|dataSync" } });
    }
    manifest["uses-permission"] = manifest["uses-permission"] || [];
    for (const name of ["android.permission.FOREGROUND_SERVICE", "android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK", "android.permission.FOREGROUND_SERVICE_DATA_SYNC"]) {
      if (!manifest["uses-permission"].some((item) => item.$?.["android:name"] === name)) manifest["uses-permission"].push({ $: { "android:name": name } });
    }
    return mod;
  });

  config = withSettingsGradle(config, (mod) => {
    if (!mod.modResults.contents.includes("include ':flowllm'")) {
      mod.modResults.contents = mod.modResults.contents.replace("include ':app'", "include ':app'\ninclude ':flowllm'");
    }
    return mod;
  });

  config = withAppBuildGradle(config, (mod) => {
    const line = '    implementation(project(":flowllm"))';
    if (!mod.modResults.contents.includes(line)) {
      mod.modResults.contents = mod.modResults.contents.replace('    implementation("com.facebook.react:react-android")', `    implementation("com.facebook.react:react-android")\n${line}`);
    }
    return mod;
  });

  config = withMainApplication(config, (mod) => {
    const importLine = "import com.voicelink.mobile.VoiceKeyboardPackage";
    const packageLine = "              add(VoiceKeyboardPackage())";
    if (!mod.modResults.contents.includes(importLine)) {
      mod.modResults.contents = mod.modResults.contents.replace(
        "import expo.modules.ApplicationLifecycleDispatcher",
        `${importLine}\nimport expo.modules.ApplicationLifecycleDispatcher`,
      );
    }
    if (!mod.modResults.contents.includes(packageLine)) {
      mod.modResults.contents = mod.modResults.contents.replace(
        "              // Packages that cannot be autolinked yet can be added manually here, for example:",
        `${packageLine}\n              // Packages that cannot be autolinked yet can be added manually here, for example:`,
      );
    }
    return mod;
  });

  return withDangerousMod(config, ["android", async (mod) => {
    const androidRoot = mod.modRequest.platformProjectRoot;
    const packageDirectory = join(androidRoot, "app", "src", "main", "java", ...androidPackage.split("."));
    const resourceDirectory = join(androidRoot, "app", "src", "main", "res", "xml");
    mkdirSync(packageDirectory, { recursive: true });
    mkdirSync(resourceDirectory, { recursive: true });
    for (const fileName of [
      "CloudKeyboardTranscriber.kt", "KeyboardSession.kt", "KeyboardTranscriptGate.kt", "RealtimeStt.kt", "LiveEdit.kt", "Snippets.kt",
      "CursorFlowKeyboardView.kt", "InputContextResolver.kt", "LibWhisper.kt", "LocalCleanupHandoff.kt", "OfflineDictationQueue.kt",
      "DictationHistoryStore.kt", "TypingKeyboardView.kt", "TypingLayouts.kt", "SuggestEngine.kt", "AvroPhonetic.kt", "HindiPhonetic.kt",
      "GlideDecoder.kt", "SpeechFinishResolver.kt", "DictationSpan.kt", "ClipboardHistoryStore.kt", "VoiceInputTargetPolicy.kt",
      "VoiceKeyboardModule.kt", "VoiceKeyboardPackage.kt", "VoiceKeyboardService.kt", "VoiceKeyboardSecureStore.kt", "FlowLanguages.kt",
      "FlowLlm.kt", "FlowLlmNative.kt", "FlowLlmService.kt", "FlowRulePass.kt", "FlowSplitPill.kt", "PhoneInbox.kt",
      "FastTransfer.kt", "FastTransferCore.kt", "PcLink.kt", "HandwritingPadView.kt", "StopTiming.kt",
    ]) {
      copyFileSync(join(sourceDirectory, "java", ...androidPackage.split("."), fileName), join(packageDirectory, fileName));
    }
    const moduleMain = join(androidRoot, "flowllm", "src", "main");
    const cppDirectory = join(moduleMain, "cpp");
    mkdirSync(cppDirectory, { recursive: true });
    copyFileSync(join(sourceDirectory, "flowllm-module", "build.gradle"), join(androidRoot, "flowllm", "build.gradle"));
    copyFileSync(join(sourceDirectory, "flowllm-module", "AndroidManifest.xml"), join(moduleMain, "AndroidManifest.xml"));
    for (const fileName of ["CMakeLists.txt", "flowllm.cpp"]) {
      copyFileSync(join(sourceDirectory, "cpp", fileName), join(cppDirectory, fileName));
    }
    copyFileSync(join(sourceDirectory, "res", "xml", "voice_keyboard_method.xml"), join(resourceDirectory, "voice_keyboard_method.xml"));
    const { readdirSync, existsSync } = require("node:fs");
    const dictSrc = join(sourceDirectory, "assets", "dicts");
    const dictDst = join(androidRoot, "app", "src", "main", "assets", "dicts");
    mkdirSync(dictDst, { recursive: true });
    if (existsSync(dictSrc)) {
      for (const name of readdirSync(dictSrc)) {
        copyFileSync(join(dictSrc, name), join(dictDst, name));
      }
    }
    const valuesDirectory = join(androidRoot, "app", "src", "main", "res", "values");
    mkdirSync(valuesDirectory, { recursive: true });
    writeFileSync(join(valuesDirectory, "cursorflow_voice_keyboard_strings.xml"), `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <string name="cursorflow_voice_keyboard_label">Cursor Flow Voice Keyboard</string>\n    <string name="cursorflow_voice_keyboard_subtitle">Voice to text • cursor control • 20+ languages</string>\n</resources>\n`);
    return mod;
  }]);
};
