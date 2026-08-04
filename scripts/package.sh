#!/usr/bin/env bash
# Builds a Chrome Web Store–ready zip in dist/, containing only what the
# extension ships (manifest + src + popup + icons). Tests, scripts, and docs
# stay out of the package.
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v zip >/dev/null 2>&1; then
  echo "error: 'zip' is required (apt install zip / brew install zip)" >&2
  exit 1
fi

VERSION=$(node -p "JSON.parse(require('fs').readFileSync('manifest.json','utf8')).version")
OUT="dist/embolden-${VERSION}.zip"

FILES=(
  manifest.json
  src/core.js src/content.js src/content.css src/background.js
  popup/popup.html popup/popup.css popup/popup.js
  icons/icon16.png icons/icon32.png icons/icon48.png icons/icon128.png
)

# zip exits 0 even when some listed files don't exist — fail loudly instead
# of shipping a broken package.
for f in "${FILES[@]}"; do
  [[ -f "$f" ]] || { echo "error: missing $f" >&2; exit 1; }
done

mkdir -p dist
rm -f "$OUT"

zip -r -X "$OUT" "${FILES[@]}"

echo
echo "Packaged $OUT"
unzip -l "$OUT"
