#!/bin/sh

base=$1
host=$2
python3=${3:-python3}
body=$(cat)
sid=$(printf '%s' "$body" | "$python3" -c 'import json,sys; value=json.load(sys.stdin).get("session_id",""); isinstance(value,str) or sys.exit(1); sys.stdout.write(value)' 2>/dev/null) || exit 0
case "$sid" in
  ''|*[!A-Za-z0-9_-]*) exit 0 ;;
esac

waiter=$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')
case "$waiter" in
  ????????????????) ;;
  *) exit 0 ;;
esac
started=$(date +%s)
wait_seconds=${DASH_REPLY_WAIT_S:-21000}
case "$wait_seconds" in
  ''|*[!0-9]*) wait_seconds=21000 ;;
esac
deadline=$((started + wait_seconds))
tmp=$(mktemp "${TMPDIR:-/tmp}/dash-reply.XXXXXX") || exit 0
text_tmp="${tmp}.text"
trap 'rm -f "$tmp" "$text_tmp"' 0
trap 'exit 0' HUP INT TERM
fails=0

while [ "$(date +%s)" -lt "$deadline" ]; do
  code=$(curl -s -m 60 -o "$tmp" -w '%{http_code}' -H "X-Dash-Host: $host" "$base/reply/wait/claude?session=$sid&waiter=$waiter&started=$started&wait=50")
  case "$code" in
    200)
      kind=$("$python3" -c 'import json,sys; value=json.load(sys.stdin).get("kind",""); isinstance(value,str) or sys.exit(1); sys.stdout.write(value)' < "$tmp" 2>/dev/null) || kind=
      if [ "$kind" = dash.autopilot.reply.v1 ]; then
        source=$("$python3" -c 'import json,sys; value=json.load(sys.stdin).get("source",""); isinstance(value,str) or sys.exit(1); sys.stdout.write(value)' < "$tmp" 2>/dev/null) || exit 0
        [ "$source" = autopilot ] || exit 0
        autopilot=$("$python3" -c 'import json,sys; json.dump(json.load(sys.stdin).get("autopilot"),sys.stdout,separators=(",",":"))' < "$tmp" 2>/dev/null) || exit 0
        "$python3" -c 'import json,sys; value=json.load(sys.stdin).get("text"); isinstance(value,str) or sys.exit(1); sys.stdout.write(value)' < "$tmp" > "$text_tmp" 2>/dev/null || exit 0
        script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P) || exit 0
        printf '%s' "$autopilot" | "$python3" "$script_dir/autopilot_fence_cache.py" --seed "$host" "$sid" 2>/dev/null || {
          printf '%s\n' 'dash autopilot fence cache unavailable; reply withheld' >&2
          exit 0
        }
        cat "$text_tmp" >&2
      else
        cat "$tmp" >&2
      fi
      exit 2
      ;;
    204)
      fails=0
      ;;
    400|403|404|409|410)
      exit 0
      ;;
    *)
      fails=$((fails + 1))
      delay=$((fails * 5))
      [ "$delay" -le 30 ] || delay=30
      remaining=$((deadline - $(date +%s)))
      [ "$delay" -le "$remaining" ] || delay=$remaining
      [ "$delay" -gt 0 ] || exit 0
      sleep "$delay"
      ;;
  esac
done
exit 0
