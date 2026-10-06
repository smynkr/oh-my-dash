#!/bin/sh

base=$1
host=$2
body=$(cat)
sid=$(printf '%s' "$body" | /usr/bin/plutil -extract session_id raw -o - - 2>/dev/null) || exit 0
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
trap 'rm -f "$tmp"' 0
trap 'exit 0' HUP INT TERM
fails=0

while [ "$(date +%s)" -lt "$deadline" ]; do
  code=$(curl -s -m 60 -o "$tmp" -w '%{http_code}' -H "X-Dash-Host: $host" "$base/reply/wait/claude?session=$sid&waiter=$waiter&started=$started&wait=50")
  case "$code" in
    200)
      cat "$tmp" >&2
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
