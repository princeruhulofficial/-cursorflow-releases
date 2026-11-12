#!/usr/bin/env bash
# Reassemble CI APK chunks (or downloadUrl) and publish android-v3.0.24.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="${ROOT}/.apk-build"
META="${OUT_DIR}/android-3.0.24.json"
APK="${OUT_DIR}/CursorFlow-Android-3.0.24.apk"
mkdir -p "$OUT_DIR"

if [[ ! -f "$META" ]]; then
  echo "Missing $META — fetch ci-drop/android-3.0.24.json first" >&2
  exit 1
fi

python3 - <<'PY'
import json, base64, hashlib
from pathlib import Path
out = Path(".apk-build")
meta = json.loads((out / "android-3.0.24.json").read_text())
apk_path = out / meta["filename"]
if meta.get("mode") == "chunks":
    parts = sorted((out / "parts").glob("part-*.b64"))
    assert len(parts) == meta["partCount"], (len(parts), meta["partCount"])
    data = b"".join(base64.b64decode(p.read_text().strip()) for p in parts)
    apk_path.write_bytes(data)
elif meta.get("downloadUrl"):
    import urllib.request
    urllib.request.urlretrieve(meta["downloadUrl"], apk_path)
else:
    raise SystemExit("No chunks or downloadUrl in metadata")
digest = hashlib.sha256(apk_path.read_bytes()).hexdigest()
assert digest == meta["sha256"], (digest, meta["sha256"])
print(f"OK {apk_path} sha256={digest} size={apk_path.stat().st_size} signing={meta.get('signing')}")
PY

NOTES="$(cat <<'EOF'
Cursor Flow for Android 3.0.24 (versionCode 86)

- Compact Gboard-like keyboard toolbar (flush on keys); removed EN / I icons
- Clear Detection-page switch; Detection mic far right with glow while listening
- Handwriting touchpad panel; swipe typing and spacebar cursor trackpad fixes
- Home voice indicator start/stop recovery; Detection mic / stuck Finishing recovery
- Home translate icon removed (toolbar translate kept)
- Home Smart cleanup moved to Controls → Voice Settings

Signed with the release certificate from CI secrets when available.
Source: princeruhulofficial/CursorFlow @ 3.0.24 / versionCode 86.
EOF
)"

gh release create android-v3.0.24 \
  --repo princeruhulofficial/-cursorflow-releases \
  --title "Cursor Flow Android 3.0.24" \
  --notes "$NOTES" \
  "$APK"
