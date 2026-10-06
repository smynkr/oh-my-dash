#!/bin/bash
set -euo pipefail

ROOT="${HOME}/.local/share/dash"
PLIST="${HOME}/Library/LaunchAgents/com.dash.collector.plist"
URL="http://127.0.0.1:${DASH_PORT:-4777}/healthz"

if [[ "${1:-}" != "--apply" ]]; then
  cat <<EOF
Dry run. No deployment changes made.
Would pull --ff-only in: ${ROOT}
Would install locked dependencies and compile ${ROOT}/bin/dash-collector
Would bootstrap ${PLIST}, then wait up to 15 seconds for ${URL}
Run with --apply to perform these steps.
EOF
  exit 0
fi
if [[ "$#" -ne 1 ]]; then
  echo "Usage: $0 [--apply]" >&2
  exit 2
fi

export PATH="${HOME}/.local/bin:${HOME}/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export BUN_INSTALL_CACHE_DIR="${ROOT}/.bun-cache"
git -C "$ROOT" pull --ff-only
cd "$ROOT"
bun install --frozen-lockfile
mkdir -p bin data
chmod 700 data
bun build --compile src/server.ts --outfile bin/dash-collector
launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

start=$SECONDS
deadline=$((SECONDS + 14))
while (( SECONDS < deadline )); do
  if result="$(curl -fsS --max-time 1 "$URL" 2>/dev/null)"; then
    printf 'Dash deploy healthy after %s second(s): %s\n' "$((SECONDS - start))" "$result"
    exit 0
  fi
  if (( SECONDS >= deadline )); then break; fi
  sleep 1
done
echo "Dash deploy did not become healthy within 15 seconds at ${URL}" >&2
exit 1
