#!/bin/bash
# Install toon-video-production into the Hermes tree on the Mac Mini:
#  - copies the skill to ~/.hermes/skills/content/toon-video-production/
#  - creates the dedicated venv at ~/.hermes/venvs/toon (explicit interpreter,
#    same pattern as the docs venv fix — never trust sys.executable)
#  - checks ffmpeg/ffprobe
# Safe to re-run; it syncs files and leaves caches/work dirs alone.

set -euo pipefail

HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
DEST_DIR="$HERMES_HOME/skills/content/toon-video-production"
VENV_DIR="$HERMES_HOME/venvs/toon"

echo "==> Installing skill to $DEST_DIR"
mkdir -p "$DEST_DIR"
if [ "$SRC_DIR" != "$DEST_DIR" ]; then
  rsync -a --delete \
    --exclude '__pycache__' --exclude '*.pyc' --exclude '.pytest_cache' \
    "$SRC_DIR/" "$DEST_DIR/"
fi

echo "==> Creating venv at $VENV_DIR"
if [ ! -x "$VENV_DIR/bin/python" ]; then
  python3 -m venv "$VENV_DIR"
fi
"$VENV_DIR/bin/pip" install --quiet --upgrade pip
"$VENV_DIR/bin/pip" install --quiet -r "$DEST_DIR/scripts/requirements.txt"

echo "==> Checking ffmpeg"
for bin in ffmpeg ffprobe; do
  if ! command -v "$bin" > /dev/null 2>&1; then
    echo "    MISSING: $bin — install with: brew install ffmpeg"
  fi
done

mkdir -p "$HERMES_HOME/work/toon-videos" \
         "$HERMES_HOME/cache/toon-characters" \
         "$HERMES_HOME/assets/music" \
         "$HERMES_HOME/logs"

echo "==> Smoke check"
cd "$DEST_DIR/scripts"
"$VENV_DIR/bin/python" -m toon_video --help > /dev/null && echo "    CLI OK"

cat <<EOF

Done. Next:
  1. Apply supabase/migrations/001_toon_video_schema.sql to project
     xzkiqxgslehsmaxnasfp (if not already applied).
  2. Ensure env vars are set (see SKILL.md "Environment").
  3. Drop licensed music into $HERMES_HOME/assets/music/.
  4. Register the skill in Hermes.
EOF
