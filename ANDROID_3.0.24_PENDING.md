# Android 3.0.24 (APK build in progress)

Source: `princeruhulofficial/CursorFlow`  
Merged: PR #28 → `fix/android-features` @ `bc8b5cc`  
Build branch: `cursor/android-apk-m1-3024-03cb` (triggers Debug/M1 APK workflow)

## Version
- versionName: **3.0.24**
- versionCode: **86**

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

## Publish
When CI finishes, metadata lands on `cursor/apk-url-3024-03cb` → `ci-drop/android-3.0.24.json`.  
Then publish public tag `android-v3.0.24` with asset `CursorFlow-Android-3.0.24.apk` on this releases repo.
