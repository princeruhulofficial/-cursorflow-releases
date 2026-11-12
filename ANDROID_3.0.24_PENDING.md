# Android 3.0.24 (pending signed APK)

Source branch: `princeruhulofficial/CursorFlow` → `cursor/android-keyboard-detection-03cb`  
Base: `fix/android-features` @ 3.0.23 (`c70fcfe`)  
Compare: https://github.com/princeruhulofficial/CursorFlow/compare/fix/android-features...cursor/android-keyboard-detection-03cb

## Version
- versionName: **3.0.24**
- versionCode: **86**

## Included fixes (user task list)
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

## Build
Merge the branch into `fix/android-features`, then run workflow **Build Cursor Fllow Production APK** (`build-release-apk.yml`) or the usual signed path, and publish tag `android-v3.0.24` here.
