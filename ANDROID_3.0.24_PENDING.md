# Android 3.0.24 — published

## Public download
- **Release:** https://github.com/princeruhulofficial/-cursorflow-releases/releases/tag/android-v3.0.24
- **APK:** https://github.com/princeruhulofficial/-cursorflow-releases/releases/download/android-v3.0.24/CursorFlow-Android-3.0.24.apk
- Tag `android-v3.0.24` · filename `CursorFlow-Android-3.0.24.apk`
- SHA-256: `f84a8da2b19ac52adaa38ab6b244eece9e65d6fc21640ef9d7af48efe10fc6dd`
- Size: 83271084 bytes · published 2026-11-13 13:26 Asia/Dhaka

## Source
- Keyboard / Detection work merged (CursorFlow PR #28 → `main`)
- CI assembleRelease fix merged (CursorFlow PR #32)
- version **3.0.24** / versionCode **86**, package `com.cursorflow.app`
- Private CI tag (build source): https://github.com/princeruhulofficial/CursorFlow/releases/tag/android-v3.0.24-ci
# Android 3.0.24 — needs Actions APK

## Source (done)
- Keyboard / Detection work merged (CursorFlow PR #28 → `fix/android-features` → `main`)
- version **3.0.24** / versionCode **86**, package `com.cursorflow.app`
- Merge commit on features: `bc8b5cc`

## Included fixes
1. Compact Gboard-like keyboard toolbar (flush on keys)
2. Detection mic far right + glow while listening
3. Clear Detection-page switch (replaces confusing “I”)
4. Removed EN and I toolbar icons
5. Handwriting touchpad panel
6. Swipe typing reliability
7. Spacebar hold + slide cursor trackpad
8. Home voice indicator start/stop recovery
9. Text keyboard Detection mic capture / stuck finishing recovery
10. Home translate icon removed (toolbar translate kept)
11. Home Smart cleanup card removed → Controls → Voice Settings

## Known limits of this build
- **Signing:** Ephemeral CI keystore (`ANDROID_RELEASE_*` secrets were not set). **Uninstall previous Cursor Flow before installing** — update over 3.0.23 will fail.
- **Offline Flow AI:** stubbed (no `llama.cpp` on the runner). Cloud / on-device keyboard features otherwise work.
## Blocker
This agent cannot read private CursorFlow Actions (HTTP 404) and CI has not produced
`android-v3.0.24-ci` or `cursor/apk-url-3024-03cb` after multiple triggers on `main`.

## What you need to run (owner account)
1. Open https://github.com/princeruhulofficial/CursorFlow/actions
2. Run **Build Cursor Fllow Production APK** (`build-release-apk.yml`) on `main`  
   (or **Build Cursor Fllow Android Debug APK** if production secrets are already wired there)
3. Download `CursorFlow-Android-3.0.24.apk` from the run artifacts / private release
4. Publish here:

```bash
gh release create android-v3.0.24 \
  --repo princeruhulofficial/-cursorflow-releases \
  --title "Cursor Flow Android 3.0.24" \
  --notes-file - \
  ./CursorFlow-Android-3.0.24.apk <<'NOTES'
Cursor Flow for Android 3.0.24 (versionCode 86)

- Compact Gboard-like keyboard toolbar; removed EN / I icons
- Clear Detection-page switch; Detection mic far right with glow
- Handwriting touchpad; swipe typing + spacebar cursor trackpad fixes
- Home voice indicator start/stop + Detection mic / Finishing recovery
- Home translate removed; Smart cleanup moved to Controls

Signed with the same release certificate as 3.0.23 when production secrets are used.
Source: princeruhulofficial/CursorFlow main @ 3.0.24.
NOTES
```

Or attach the APK in chat and this agent will publish the public release.
