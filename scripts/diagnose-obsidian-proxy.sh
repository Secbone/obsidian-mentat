#!/usr/bin/env bash
# Diagnose why Obsidian can't reach api.deepseek.com (ERR_PROXY_CONNECTION_FAILED).
# Run THIS on the machine where Obsidian is launched.
set -uo pipefail
KEY="${1:-[REDACTED]}"   # optional: your DeepSeek api key

echo "=== [1] Obsidian process & its ACTUAL proxy env ==="
OBS_PID=""
for p in $(pgrep -f "obsidian|/Obsidian" 2>/dev/null); do
  name=$(ps -o comm= -p "$p" 2>/dev/null)
  if [ -n "$name" ]; then OBS_PID=$p; break; fi
done
if [ -n "$OBS_PID" ]; then
  echo "Obsidian PID: $OBS_PID ($(ps -o comm= -p $OBS_PID))"
  echo "--- proxy env seen by Obsidian ---"
  tr '\0' '\n' < /proc/$OBS_PID/environ 2>/dev/null | grep -iE "proxy|no_proxy" || echo "(no proxy env in Obsidian)"
else
  echo "(!) Could not find Obsidian process. Is it running? Try:  pgrep -fl obsidian"
  echo "--- fallback: current shell proxy ---"
  env | grep -iE "proxy" || echo "(no proxy env in shell)"
fi

echo
echo "=== [2] System proxy settings (Electron/Obsidian reads these) ==="
gsettings get org.gnome.system.proxy mode 2>/dev/null && echo "  ^ GNOME proxy mode (none/manual/auto)" || echo "  (no GNOME)"
for v in http https; do
  gsettings get org.gnome.system.proxy $v 2>/dev/null | sed "s/^/  $v: /" 
done

echo
echo "=== [3] Test DeepSeek via the discovered proxy vs direct ==="
URL="https://api.deepseek.com/v1/models"
# Which proxy to try? Use Obsidian's HTTPS_PROXY if present, else system, else none.
PROXY=$( [ -n "$OBS_PID" ] && tr '\0' '\n' < /proc/$OBS_PID/environ 2>/dev/null | sed -n 's/^https_proxy=//I p' | head -1 )
PROXY="${PROXY:-$HTTPS_PROXY}"
# Also try GNOME https proxy formatted, if manual.
if [ -z "$PROXY" ]; then
  mode=$(gsettings get org.gnome.system.proxy mode 2>/dev/null | tr -d "'")
  if [ "$mode" = "manual" ]; then
    h=$(gsettings get org.gnome.system.proxy https 2>/dev/null | tr -d "'")
    [ -n "$h" ] && [ "$h" != "@as []" ] && PROXY="http://$h"
  fi
fi

echo "Will test via proxy: ${PROXY:-<none>}"
if [ -n "$PROXY" ]; then
  echo "--- via proxy $PROXY ---"
  curl -sS -m 10 -x "$PROXY" -o /dev/null -w "  HTTP %{http_code}  (error=%{exitcode})\n" "$URL" -H "Authorization: Bearer $KEY" 2>&1 | tail -2
fi
echo "--- direct (no proxy) ---"
curl -sS -m 10 --noproxy '*' -o /dev/null -w "  HTTP %{http_code}\n" "$URL" -H "Authorization: Bearer $KEY" 2>&1 | tail -2

echo
echo "=== INTERPRET ==="
echo "  - If 'via proxy' fails/ERR but 'direct' returns 200 -> the proxy is the problem. Disable it."
echo "  - If both fail -> deeper network/env issue (check firewall, DNS, or Obsidian sandbox)."
