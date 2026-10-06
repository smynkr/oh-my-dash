#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 <ssh-target> <host-label> [--apply] [--uninstall]" >&2
}

if [[ $# -lt 2 ]]; then usage; exit 2; fi
TARGET=$1
HOST=$2
shift 2
APPLY=0
UNINSTALL=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --uninstall) UNINSTALL=1 ;;
    *) usage; exit 2 ;;
  esac
done

if [[ ! "$HOST" =~ ^[A-Za-z0-9_-]{1,64}$ ]]; then
  echo "Host label must match /^[A-Za-z0-9_-]{1,64}$/" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
quote() {
  local value=$1
  value=${value//\'/\'\\\'\'}
  printf "'%s'" "$value"
}

run_or_print() {
  if (( APPLY )); then "$@"; else printf 'Would run:'; printf ' %q' "$@"; printf '\n'; fi
}

if (( UNINSTALL )); then
  omp_uninstall="zsh -lc 'cd ~/.local/share/dash && bun run scripts/install-omp-extension.ts --uninstall'"
  omp_env_uninstall="zsh -lc 'cd ~/.local/share/dash && if [ -f scripts/configure-remote-omp-env.ts ]; then bun run scripts/configure-remote-omp-env.ts --uninstall; fi'"
  hook_uninstall="zsh -lc 'cd ~/.local/share/dash && bun run scripts/install-claude-hooks.ts --uninstall'"
  pusher_uninstall="zsh -lc 'cd ~/.local/share/dash && bun run scripts/install-liveness-pusher.ts --uninstall'"
  failed=0
  if ! run_or_print ssh "$TARGET" "$omp_uninstall"; then failed=1; fi
  if ! run_or_print ssh "$TARGET" "$omp_env_uninstall"; then failed=1; fi
  if ! run_or_print ssh "$TARGET" "$hook_uninstall"; then failed=1; fi
  if ! run_or_print ssh "$TARGET" "$pusher_uninstall"; then failed=1; fi
  exit "$failed"
fi
if [[ -z ${DASH_HUB:-} ]]; then
  echo "DASH_HUB is required to install; set it to the public hub host (for example, hub.example:4777)." >&2
  exit 2
fi
HUB=$DASH_HUB

if (( APPLY )); then
  git -C "$ROOT" archive --format=tar HEAD scripts package.json omp-extension | ssh "$TARGET" 'mkdir -p ~/.local/share/dash && tar -x -C ~/.local/share/dash'
else
  printf 'Would run: git -C %q archive --format=tar HEAD scripts package.json omp-extension | ssh %q %q\n' "$ROOT" "$TARGET" 'mkdir -p ~/.local/share/dash && tar -x -C ~/.local/share/dash'
fi

claude_url="https://$HUB/ingest/claude"
liveness_url="https://$HUB/ingest/liveness/claude"
omp_url="https://$HUB/ingest/omp"
claude_cmd="cd ~/.local/share/dash && bun run scripts/install-claude-hooks.ts --url $(quote "$claude_url") --reply-base $(quote "https://$HUB") --host $(quote "$HOST") && if [ -f ~/.claude/settings.canonical.json ]; then bun run scripts/install-claude-hooks.ts --settings ~/.claude/settings.canonical.json --url $(quote "$claude_url") --reply-base $(quote "https://$HUB") --host $(quote "$HOST"); fi"
liveness_cmd="cd ~/.local/share/dash && bun run scripts/install-liveness-pusher.ts --url $(quote "$liveness_url") --host $(quote "$HOST")"
omp_cmd="cd ~/.local/share/dash && bun run scripts/install-omp-extension.ts"
omp_env_cmd="cd ~/.local/share/dash && bun run scripts/configure-remote-omp-env.ts --url $(quote "$omp_url") --host $(quote "$HOST")"
remote_claude="zsh -lc $(quote "$claude_cmd")"
remote_liveness="zsh -lc $(quote "$liveness_cmd")"
remote_omp="zsh -lc $(quote "$omp_cmd")"
remote_omp_env="zsh -lc $(quote "$omp_env_cmd")"
failed=0
if ! run_or_print ssh "$TARGET" "$remote_omp"; then failed=1; fi
if ! run_or_print ssh "$TARGET" "$remote_omp_env"; then failed=1; fi
if ! run_or_print ssh "$TARGET" "$remote_claude"; then failed=1; fi
if ! run_or_print ssh "$TARGET" "$remote_liveness"; then failed=1; fi

health="code=\$(curl -s -m 10 -o /dev/null -w '%{http_code}' $(quote "https://$HUB/healthz")); printf '%s\\n' \"\$code\"; test \"\$code\" = 200"
if ! run_or_print ssh "$TARGET" "$health"; then failed=1; fi
if (( APPLY )); then
  printf '\n'
fi
exit "$failed"
