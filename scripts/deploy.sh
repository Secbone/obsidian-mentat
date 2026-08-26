#!/usr/bin/env bash
# Deploy built Mentat plugin to an Obsidian vault's plugin directory.
# Usage: bash scripts/deploy.sh /path/to/vault/.obsidian/plugins/mentat
#
# Copies dist/main.js, dist/styles.css, manifest.json and skills/ to the
# target. NEVER overwrites data.json (user config: providers, keys).

set -euo pipefail

TARGET="${1:?Usage: deploy.sh <vault-plugin-dir>}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"

if [ ! -d "$HERE/dist" ]; then
  echo "✗ dist/ missing — run 'npm run build' first" >&2
  exit 1
fi

echo "→ Deploying Mentat to: $TARGET"
mkdir -p "$TARGET"

# Core build artifacts (main.js / styles.css / manifest.json).
cp -f "$HERE/dist/main.js" "$TARGET/main.js"
cp -f "$HERE/dist/styles.css" "$TARGET/styles.css"
cp -f "$HERE/manifest.json" "$TARGET/manifest.json"

# Skills: copy in but do NOT delete user-added skills on the vault side
# (differs from the repo's source skills). data.json is never touched.
if [ -d "$HERE/skills" ]; then
  cp -rn "$HERE"/skills/* "$TARGET/skills/" 2>/dev/null || true
fi

echo "✓ Deployed main.js/styles.css/manifest.json + skills (data.json preserved)"
echo "  Note: run 'Reload app without saving' (Ctrl/Cmd+P) in Obsidian to load."
