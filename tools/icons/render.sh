#!/usr/bin/env bash
# Regenerates every favicon / app icon from the two SVG sources.
# Usage (from the project root): bash tools/icons/render.sh
# Needs: google-chrome (headless), python3 + Pillow.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

render() { # <svg> <size> <out.png>
  cat > "$tmp/wrap.html" <<HTML
<!doctype html><html><body style="margin:0;background:transparent">
<img src="file://$1" width="$2" height="$2" style="display:block"></body></html>
HTML
  google-chrome --headless=new --disable-gpu --hide-scrollbars --default-background-color=00000000 \
    --window-size="$2,$2" --screenshot="$3" "file://$tmp/wrap.html" >/dev/null 2>&1
}

for s in 16 32 48 64; do render "$here/mark-small.svg" $s "$tmp/small-$s.png"; done
render "$here/mark-large.svg" 180 "$root/apple-touch-icon.png"
render "$here/mark-large.svg" 192 "$root/icon-192.png"
render "$here/mark-large.svg" 512 "$root/icon-512.png"
cp "$here/mark-small.svg" "$root/favicon.svg"

python3 - "$tmp" "$root" <<'PY'
import sys
from PIL import Image
tmp, root = sys.argv[1], sys.argv[2]
imgs = [Image.open(f"{tmp}/small-{s}.png").convert("RGBA") for s in (16, 32, 48)]
imgs[2].save(f"{root}/favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)], append_images=imgs[:2])
Image.open(f"{tmp}/small-64.png").save(f"{tmp}/preview-64.png")
PY
echo "Icons written to $root"
