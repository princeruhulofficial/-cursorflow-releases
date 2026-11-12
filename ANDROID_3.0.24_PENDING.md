# Android 3.0.24 — needs Actions APK

## Source (done)
- Keyboard / Detection work merged (CursorFlow PR #28 → `fix/android-features` → `main`)
- version **3.0.24** / versionCode **86**, package `com.cursorflow.app`

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
