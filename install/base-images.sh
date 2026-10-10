#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# LevantBase upstream images (pinned in control/src/lib/base/versions.ts → DEFAULT_VERSIONS).
#
#   install/base-images.sh list          print the image references (BASE_IMAGE_MIRROR prefix applied)
#   install/base-images.sh pull          docker pull them (so the first backend starts fast)
#   install/base-images.sh fingerprint   sha256 of the pinned list (update.sh uses it to detect version bumps)
#
# Reads BASE_IMAGE_MIRROR from the environment or from <install dir>/.env.
# ─────────────────────────────────────────────────────────────────────────────
set -Eeuo pipefail
INSTALL_DIR="${LEVANT_INSTALL_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
VERSIONS="$INSTALL_DIR/control/src/lib/base/versions.ts"
[ -f "$VERSIONS" ] || { echo "base-images: $VERSIONS not found" >&2; exit 1; }
if [ -z "${BASE_IMAGE_MIRROR+x}" ] && [ -f "$INSTALL_DIR/.env" ]; then
  BASE_IMAGE_MIRROR="$({ grep -E '^BASE_IMAGE_MIRROR=' "$INSTALL_DIR/.env" || true; } | tail -n1 | cut -d= -f2-)"
fi
MIRROR="${BASE_IMAGE_MIRROR:-}"
MIRROR="${MIRROR%/}"

pinned() { # the quoted image refs inside the DEFAULT_VERSIONS = { … } block
  awk '/DEFAULT_VERSIONS *= *\{/{f=1;next} f&&/^\}/{exit} f' "$VERSIONS" \
    | grep -oE '"[a-z0-9][a-z0-9._/-]*:[A-Za-z0-9._-]+"' | tr -d '"'
}
with_mirror() { # same rule as imageRef() in versions.ts
  local img="$1" first
  if [ -z "$MIRROR" ]; then echo "$img"; return; fi
  first="${img%%/*}"
  if [[ "$img" == */* ]] && { [[ "$first" == *.* ]] || [[ "$first" == *:* ]] || [ "$first" = localhost ]; }; then echo "$img"; return; fi
  if [[ "$img" == */* ]]; then echo "$MIRROR/$img"; else echo "$MIRROR/library/$img"; fi
}

case "${1:-list}" in
  list) pinned | while read -r i; do with_mirror "$i"; done ;;
  fingerprint) pinned | sha256sum | cut -d' ' -f1 ;;
  pull)
    fail=0
    while read -r i; do
      img="$(with_mirror "$i")"
      if docker image inspect "$img" >/dev/null 2>&1; then echo "  ✓ $img (present)"; continue; fi
      if docker pull -q "$img" >/dev/null; then echo "  ✓ $img"; else echo "  ! $img (pull failed — it is pulled on first use)" >&2; fail=1; fi
    done < <(pinned)
    exit "$fail"
    ;;
  *) echo "usage: base-images.sh list|pull|fingerprint" >&2; exit 1 ;;
esac
