# Android 3.0.24 — APK publish status

## Source (done)
- Merged PR #28 → `fix/android-features` → `main` (version **3.0.24** / versionCode **86**)
- Package: `com.cursorflow.app` (matches live 3.0.23)

## CI build (in progress)
Build branch: `cursor/android-apk-m1-3024b-03cb`

When the job finishes it will:
1. Upload Actions artifact `cursor-fllow-m1-apk-v1.9.8`
2. Create private tag/release `android-v3.0.24-ci` on CursorFlow with `CursorFlow-Android-3.0.24.apk`
3. Push metadata to `cursor/apk-url-3024-03cb` → `ci-drop/android-3.0.24.json`

## Public release (this repo)
Publish tag `android-v3.0.24` with asset `CursorFlow-Android-3.0.24.apk` after the CI APK is available.

Do **not** merge further `cursor/android-apk-m1-*` CI helper branches into `main` until the APK is published — each merge restarts / races the build.
