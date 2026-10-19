# Oh My Dash operations runbook

This runbook starts from a clean checkout and uses only paths and settings chosen by the operator. It describes your own deployment, not any existing private hub or its operational history. Keep transcript data, secrets, service plists, and backups outside source control. See [Security](../SECURITY.md) for the trust model.

## Requirements and initial macOS setup

Use a logged-in macOS account, Bun 1.3.14 or newer, Git, and Python 3 to safely render LaunchAgent templates. Install the Claude Code CLI only if you want Claude liveness polling. The collector uses a compiled binary under launchd with `WorkingDirectory=/`; do not replace it with `bun run src/server.ts` in the LaunchAgent. It serves static assets from `DASH_ROOT`, so keep the checkout and its installed dependencies available.

The deployment script expects its checkout at `~/.local/share/dash`:

```sh
ROOT="$HOME/.local/share/dash"
git clone https://github.com/smynkr/oh-my-dash.git "$ROOT"
cd "$ROOT"
bun install --frozen-lockfile
mkdir -p bin data
chmod 700 data
bun build --compile src/server.ts --outfile bin/dash-collector
command -v claude  # If Claude Code is installed; use its absolute path in the plist.
```

The database defaults to `$ROOT/data/dash.sqlite`. It is in SQLite WAL mode and contains session metadata and captured conversation text. Set the data directory to mode `700`, keep it and its backups private, and do not copy it into a public checkout.

### Render the collector LaunchAgent template

`launchd/com.dash.collector.plist` contains literal `__HOME__` tokens. launchd does not expand `$HOME` or shell syntax inside a plist. Render an absolute home path into a copy; do not replace tokens with an unquoted shell `sed` expression. This Python 3 snippet takes paths as arguments and escapes the home path as XML text:

```sh
ROOT="$HOME/.local/share/dash"
PLIST="$HOME/Library/LaunchAgents/com.dash.collector.plist"
python3 - "$ROOT/launchd/com.dash.collector.plist" "$PLIST" <<'PY'
from pathlib import Path
from xml.sax.saxutils import escape
import sys

source, destination = map(Path, sys.argv[1:])
template = source.read_text()
if "__HOME__" not in template:
    raise SystemExit("collector template has no __HOME__ token; inspect the template")
rendered = template.replace("__HOME__", escape(str(Path.home())))
if "__HOME__" in rendered:
    raise SystemExit("unrendered __HOME__ token")
destination.parent.mkdir(parents=True, exist_ok=True)
destination.write_text(rendered)
destination.chmod(0o600)
print(destination)
PY
plutil -lint "$PLIST"
```

Before loading the file, inspect the rendered paths. Set `DASH_CLAUDE_BIN` to the absolute executable path reported by `command -v claude` if it is not `$HOME/.local/bin/claude`. Keep `DASH_BIND` at `127.0.0.1` and the remote-access variables empty for local-only use. The template's `DASH_ROOT`, `DASH_DATA`, binary path, and `PATH` all use the same home placeholder.

Load and smoke-check the LaunchAgent:

```sh
launchctl bootstrap "gui/$(id -u)" "$PLIST"
curl -fsS http://127.0.0.1:4777/healthz
```

The page is at <http://127.0.0.1:4777/>. If the service is already loaded, unload it before bootstrapping it again:

```sh
launchctl bootout "gui/$(id -u)" "$PLIST"
launchctl bootstrap "gui/$(id -u)" "$PLIST"
```

A LaunchAgent environment change requires `bootout` plus `bootstrap`; `kickstart` alone restarts with the old plist environment.

## Deploy updates and rollback

The deployment script is dry-run by default. It acts on `$HOME/.local/share/dash`, fast-forwards the current branch from its configured upstream (a fresh clone tracks `origin/main`), installs the frozen lockfile, compiles the collector, restarts the LaunchAgent, and waits for local `/healthz`. It does not edit the plist or turn on optional features.

```sh
cd "$HOME/.local/share/dash"
bash scripts/deploy.sh       # Show proposed deployment; makes no changes.
bash scripts/deploy.sh --apply
```

Back up the SQLite database before upgrades. SQLite's online backup API gives a consistent snapshot while the service is running. Python passes both paths as arguments, so spaces and quotes in them are safe:

```sh
ROOT="$HOME/.local/share/dash"
DATA="${DASH_DATA:-$ROOT/data}"
mkdir -p "$DATA/backups"
chmod 700 "$DATA" "$DATA/backups"
BACKUP="$DATA/backups/dash-$(date +%Y%m%d-%H%M%S).sqlite"
python3 - "$DATA/dash.sqlite" "$BACKUP" <<'PY'
import sqlite3
import sys
from contextlib import closing

with closing(sqlite3.connect(sys.argv[1])) as source, closing(sqlite3.connect(sys.argv[2])) as destination:
    source.backup(destination)
PY
chmod 600 "$BACKUP"
```

A plain copy of only `dash.sqlite` while the collector is live may miss committed WAL data. To restore a snapshot, first stop the LaunchAgent, confirm `DATA` is the same directory configured in its plist, replace `dash.sqlite` with the backup, remove only that database's stale `-wal` and `-shm` sidecars, set the database file private, then bootstrap the service and check `/healthz`:

```sh
PLIST="$HOME/Library/LaunchAgents/com.dash.collector.plist"
launchctl bootout "gui/$(id -u)" "$PLIST"
cp "$BACKUP" "$DATA/dash.sqlite"
rm -f "$DATA/dash.sqlite-wal" "$DATA/dash.sqlite-shm"
chmod 600 "$DATA/dash.sqlite"
launchctl bootstrap "gui/$(id -u)" "$PLIST"
curl -fsS http://127.0.0.1:4777/healthz
```

For an application rollback, keep the known-good Git commit and database backup. Boot out the service, switch the deployment checkout to that known-good commit, install its frozen lockfile, rebuild `bin/dash-collector`, and bootstrap the service. Do this manually: `scripts/deploy.sh --apply` always pulls the current branch's configured upstream, so it is not a rollback command. If the older code cannot read the current database, restore the pre-upgrade snapshot while the service is stopped.

## Dashboard console

The default view is **Console**: a table of sessions with state, project, session name, machine, account, harness and activity age, plus a reading and reply pane for the selected session. **Feed** and **Timeline** remain alternate views. Headless and ended sessions stay hidden until you enable **Show headless** or **Show ended**.

Selecting a session opens its first unread retained response, or the latest output when nothing is unread. The reply composer is locked to that session. Filters, row changes and live events never retarget it or replace a draft. **Show latest** returns from history to current output.

### Reading and unread state

- **Next unread** moves to the earliest unread response without marking it read. **Mark response read** acknowledges only the version on screen. **Mark session read** and **Mark all read** acknowledge retained output without moving the reading pane.
- Opening, scrolling, searching, following live and receiving events never mark output read. Read state is stored with the responses in the collector database, so it survives restarts and syncs across the owner's browsers.
- A repeated live response becomes unread again at its new timestamp. Pruned or deleted output shows as unavailable rather than being replaced by other output.
- **Load older responses** pages through retained history without changing read state.

### Compare, batch prompts and drafts

- **Compare outputs** captures two retained responses, A and B, with their text, response ID, timestamp and session identity. It does not summarize or judge. Captured sides are cleared on reload.
- **Send to selected sessions** takes sessions you add one at a time; there is no all-sessions or filtered target. **Preview targets and prompt** freezes each session key, its identity and turn, and the prompt. Confirming submits each target through the single-session reply path with an `expectedTurn` precondition, so a session that moved after the preview is refused. Each target keeps its own receipt.
- A lost acknowledgement is shown as **Acceptance unknown**. Check that session's reply history before resubmitting. Failed and uncertain targets are never retried automatically. **Refresh receipts** observes receipts again without resending.
- The batch composer and its receipts live in page memory and are cleared on reload. Drafts are kept in memory too. **Recover drafts after reload in this tab** is off by default; when enabled, drafts are saved in this tab's `sessionStorage` (up to 100 drafts of 32,000 characters each) and expire 30 minutes after their last edit. Drafts are never stored in shared collector preferences.

### Search, pins and views

- **Search** in the session list matches names, IDs, projects, machines, account aliases, harnesses and working-directory paths. It does not search response text.
- **Search outputs** searches retained response text and identity metadata as a literal, case-insensitive phrase, 25 results per page. Its project, machine, account and harness filters apply to output results; session-list search does not.
- Pins hold immutable session keys in a shared working set. A pin for a session that no longer exists stays visible as missing and never resolves to another session with a similar name.
- Named views save search, filters, visibility, grouping, density and columns. Applying a view does not change the selected session or its draft. The collector stores up to 100 views and 1,000 pins; attempts beyond those limits show an error rather than truncating silently.
- Keyboard shortcuts: `/` focuses session search; `j` and `k`, or the arrow keys while a row is focused, move through visible rows; `r` focuses the reply composer without sending; `?` opens shortcut help; Ctrl or Cmd+K opens **Commands**. Shortcuts do not fire while typing in a field. No command sends a reply, chooses a decision option or grants authorization.

### Sources and session controls

- **Sources** shows the unfiltered inventory of configured peer labels, the local hub, retained session hosts and accepted report receipts, grouped by account alias. **Last hub report**, **Last heartbeat** and session activity are shown separately.
- Freshness uses a two-minute window. **Reporting** means a receipt falls inside it. **Stale** means the last receipt is older; this alone does not end a session. **Unreported** means no receipt exists. **Unknown** means freshness cannot be evaluated, for example when a receipt is ahead of the hub clock. Retained output never establishes freshness. Account aliases are labels, not evidence of account login or quota.
- **Controls** reports whether viewing output, queueing a message, answering structured questions, approvals, interruption, remote resume and launch are **supported**, **unavailable** or **unknown**, with a reason. **Delivery** reflects only a presently pending reply poll. Copying a resume command does not resume a session remotely.

### Console API routes

Console read routes follow the same loopback and tailnet access rules as the rest of the dashboard; see [Security](../SECURITY.md). Every `POST /api/*` also needs the same-origin JSON headers described under [Replies and receipts](#replies-and-receipts). URL-encode a session key as one path segment. Malformed input returns 400, and unknown sessions or responses return 404.

- `GET /api/sessions/:key/responses?limit=50&before=<timestamp>` returns `{ responses, hasMore }`, newest first. `limit` is 1 to 100, and the timestamp cursor is exclusive. History reads never change read state.
- `GET /api/sessions/:key/responses/:responseId` returns `{ response }`.
- `GET /api/sessions/:key/read-position` returns `{ firstUnread, unreadCount, retainedCount }` without changing read state.
- `POST /api/sessions/:key/responses/:responseId/seen` with body `{ "ts": <displayed timestamp> }` acknowledges that exact version. It is idempotent for that version; a changed timestamp returns 409 `stale_response`. `POST /api/sessions/:key/seen` acknowledges one session's retained output, and `POST /api/seen-all` acknowledges every session.
- `GET /api/search?q=...` returns `{ results, nextCursor }`. `q` is trimmed and limited to 256 characters, `limit` is 1 to 100, and `cursor` is opaque; reuse it with the same query and filters. Empty queries return an empty page. An absent `project` or `account` filter means All, and an empty value means Unassigned.
- `GET /api/sources` returns `{ generatedAt, staleAfterMs, unlabelledPeerEntries, sources }`. Session entries include only key, display name, harness, state, activity and interactivity, not response text, working-directory paths or credentials.
- `GET /api/sessions/:key/capabilities` returns `{ evaluatedAt, actions, delivery }` and works even when replies are disabled.
- `GET /api/console/preferences` returns `{ revision, pins, views }`. `POST` accepts one `pin`, `create`, `update` or `delete` action per request, so concurrent changes to other entries are preserved.
- `POST /api/sessions/:key/identity` is described under [Session identity and account aliases](#session-identity-and-account-aliases).

## Session identity and account aliases

Every session shows its machine, harness and account alias. Launch each account's sessions with a short alias, using that account's normal, already authenticated CLI or profile:

```sh
DASH_ACCOUNT_ALIAS=work-claude claude
DASH_ACCOUNT_ALIAS=personal omp
```

- An alias starts with a letter or digit and contains up to 64 letters, digits, spaces, dots, hyphens or underscores. Do not use email addresses, tokens or other credentials.
- Updated Claude hooks read `DASH_ACCOUNT_ALIAS` from the running session and send it as `X-Dash-Account-Alias`. The OMP extension sends it as `accountAlias`. Reinstall the Claude hooks into each profile's settings file, and reinstall and restart the OMP extension, to pick up the producer change. Older producers keep working without aliases.
- Without an alias the session shows **Unassigned account**. The collector keeps the last valid alias when an event omits it; backfill and liveness neither infer nor erase an alias.
- Dash never infers an account from app login state and never reads account credentials. Aliases are display labels, not authenticated identities or profile selectors. Replies still route by the immutable `host|harness|sessionId` key.

In the dashboard, **Edit identity** saves a session name and an account alias. Owner labels persist in the collector database and sync across your browsers. An empty name restores the source-derived name. **Follow source account** follows the reported alias independently of the name; uncheck it to pin an alias, and a blank pinned alias keeps the session unassigned. **Use source identity** clears both overrides. Identity edits do not change activity time, turn freshness or reply routing.

`POST /api/sessions/:key/identity` takes `{ "displayName": <string or null>, "accountAlias": <string or null> }`; both fields are required. Names are limited to 128 characters with no control characters. `null` clears an override, and an empty string is an explicit unassigned override. The same Origin, JSON and access checks as other dashboard writes apply, even when replies are disabled.

## Health, backfill and retention

`GET /healthz` reports collector state. Its fields include `ok`, `sessions` (count), `rejected` (ingest requests refused), `uptimeSec`, `tailnetPort` (or `null`), `remoteHosts` (seconds since each remote liveness push was accepted, keyed by host label), `telegram`, `ideas.open` (present when replies are enabled) and `replies` (broker status, queue counts and live waiters per harness).

```sh
curl -fsS http://127.0.0.1:4777/healthz
```

At startup, and on `POST /api/backfill`, the collector reads bounded tails of recent Claude Code and OMP transcripts within `DASH_BACKFILL_HOURS` and marks the imported responses as seen. Local liveness polls `claude agents --json` every 15 seconds. Remote clients push liveness on their own schedules, as described under [Optional Tailscale access](#optional-tailscale-access).

Retention:

- Terminal reply rows and their audit metadata are kept for 90 days and pruned in bounded batches. Reply text is purged when a reply reaches a terminal state; audit entries keep a text hash and a redacted preview.
- Ideas have no expiry and are never pruned. Archive an idea to hide it.
- An unsent Telegram draft expires into Ideas after 30 minutes.
- Pending Telegram alert edits use the seven-day alert history.
- `dash.sqlite` holds captured conversation text. Back it up privately, as described under [Deploy updates and rollback](#deploy-updates-and-rollback).

## Optional feature flags

Feature flags live in `EnvironmentVariables` in the collector plist. Leave them empty unless needed. After any plist edit, run `plutil -lint`, then reload with `launchctl bootout` and `launchctl bootstrap` as above.

| Setting | Effect |
|---|---|
| `DASH_PORT` | Local loopback port; default `4777`. |
| `DASH_DATA` | Private directory for SQLite and judge scratch data; template default is the checkout's `data/`. |
| `DASH_BACKFILL_HOURS` | Transcript backfill window; default `12` hours. |
| `DASH_TELEGRAM=1` | Enables optional Telegram alerts. The bot token is read from the logged-in user's Keychain. |
| `DASH_REPLIES=1` | Enables the reply broker, dashboard and Telegram replies, decision cards, new messages and the Ideas inbox. |
| `DASH_TG_TOPICS=1` | Enables the project-rules panel and Telegram project/topic routing. |
| `DASH_TG_URGENT_AFTER_MIN` | Topic-mode overdue-input threshold in whole minutes; default `30`. |
| `DASH_REPLY_TTL_MIN` | Reply expiry in minutes; default `15`, accepted range `1`–`1440`. |
| `DASH_MESSAGE_TTL_MS` | How long a new message (not a reply) waits for delivery, in milliseconds; default `14400000` (4 hours), clamped to `60000`–`21600000`. |
| `DASH_CODEX_BIN` | Path to the `codex` executable used by `DASH_JUDGE`; default `codex` from the LaunchAgent `PATH`. |
| `DASH_TELEGRAM_SNIPPET_CHARS` | Optional Telegram text cap; unset sends full captured redacted text, a positive value caps it, and `0` sends labels only. |
| `DASH_JUDGE=1` | Optional Codex-assisted decision extraction; has an effect only with `DASH_REPLIES=1`. Leave off unless the exact canary below proves tool isolation. |

### Optional Telegram

Create a dedicated bot and store its token in the logged-in macOS account's Keychain. Do not reuse a bot with another poller or webhook, and do not put the token in the plist or shell history:

```sh
security add-generic-password -s dash-telegram-bot -a dash -w
```

Set `DASH_TELEGRAM=1` in the collector plist and reload it. Open the loopback page and send the displayed `/pair CODE` to the bot in a private chat. The token is read from Keychain by the logged-in collector account. Pairing and **Unpair** controls are local-only. Telegram is a separate service: its chats are not end-to-end encrypted, and alert text is full captured/redacted text by default. Review [Security](../SECURITY.md) before enabling it.

Set `DASH_REPLIES=1` separately to allow replies. Re-run the Claude installer without `--no-reply` and reinstall the OMP extension if you want their reply loops; restart already-running OMP sessions. Telegram commands include `/status`, `/r N text`, `/to name text`, `/idea text`, `/ideas`, `/cancel`, `/mode input|turns|off`, `/mute`, and `/help`. `/mode input` alerts only for sessions that need input (the default), `turns` also alerts when a turn finishes, and `off` stops alerts. An individual alert can be answered by replying to that alert. For multiple decisions, the Telegram card offers option buttons and **Send picks**; ⭐ marks a recommended option when identified. Telegram does not provide a generic recommendation-authorization button; use the dashboard's **Authorize recommendation** instead, as described under [Decision cards](#decision-cards).

Telegram alerts lead with a bold status and session title, followed by host and harness context and a **Question**, **Response** or **Details** section. Markdown is converted to Telegram HTML and tables become labelled rows. Long text is split into numbered parts, each replyable and each within Telegram's message limit. A burst of three or more alerts becomes a count-first digest. A needs-input alert is edited to **Answered** after the session resumes following an answer in the console, and a session that ends is labelled **Session ended**. Pending edits survive collector restarts within the seven-day alert history.

To roll back Telegram or replies, clear the corresponding `DASH_TELEGRAM` or `DASH_REPLIES` string in the plist and reload. Unpair in the local dashboard if desired. Removing the Keychain item or revoking the bot is optional and separate from disabling the collector integration.

### Replies and receipts

Set `DASH_REPLIES=1` on the collector to enable replies. With the flag unset, reply controls are hidden, the reply routes return 404, and the Telegram picker and `/to`, `/idea` and `/ideas` are off. Reply routes take the full `host|harness|sessionId` key as one URL-encoded path segment:

- `POST /api/sessions/:key/reply` submits `{ "text": ..., "answersTurn": <n>, "expectedTurn": <n> }`. Only `text` is required. The server sets the source and actor.
- `POST /api/sessions/:key/replies/cancel` cancels `{ "id": <n> }` for that session, or every queued reply when `id` is omitted.
- `GET /api/sessions/:key/replies` returns recent reply states without reply text or actor.

Rules that apply to every reply:

- **Source tags** are `web` (dashboard), `telegram` (paired bot) and `autopilot` (reserved for a future autonomous producer). Autopilot cannot send the owner authorization text.
- **Free text** is not bound to a turn. It waits for a safe point and expires after `DASH_REPLY_TTL_MIN` minutes. `answersTurn` binds a reply to the current answer. `expectedTurn` is only a submission check: a malformed value returns 400 `invalid_turn`, and a turn that has moved returns 409 `stale_turn`. It does not bind later delivery to that turn, so a working session can still queue the message.
- **Turn sequence.** `turn_seq` advances for each response or error event, including repeated text. Prompts, questions and liveness updates do not advance it.
- **Receipt states.** **Queued** waits for a safe point. **Sending** is an uncommitted lease and can still be cancelled. **Committed** can no longer be cancelled, and it does not prove that the agent acted on it. **Delivered** records transport delivery, not task completion. **Expired** means the deadline passed before delivery. **Cancelled** means the reply will not be sent. Cancel is offered only for queued or uncommitted replies.
- **omp.** The extension calls `/reply/commit` immediately before injecting a leased reply. A cancellation or stale turn detected before commit prevents the send. After commit, the extension cannot recall an injection that may have started, and it does not resend an uncertain one. Restart already running omp sessions after an update so they load the commit-capable extension.
- **Claude.** Replies reach Claude through the Stop-hook waiter that the hook installer adds; omit `--no-reply` to keep it. A session receives a reply only while it is idle at its turn. The waiter exits when the hub returns 404.
- **Still terminal-only.** Claude permission prompts, questions and elicitation dialogs, and omp tool approvals still need an answer in the terminal or Remote Control.
- **Browser updates.** Reply changes arrive over SSE as `event: reply` with only `key`, `replyId`, `state` and `source`.
- **Write gate.** Every browser `POST /api/*` must send the same-origin `Origin` header and `Content-Type: application/json`. A missing or foreign origin returns 403, and a non-JSON body returns 415. This is CSRF protection, not authentication: any process running as the owner can send those headers or write the database. Keep the loopback collector on a trusted machine.

To roll back, clear `DASH_REPLIES` in the plist and reload the collector with bootout and bootstrap. Dashboard controls disappear, the reply routes return 404, and the additive schema changes remain in place.

### New messages and Ideas

New messages use the reply queue and the same `DASH_REPLIES=1` flag. A new message is not an answer to an alert; it starts new work in a session.

- **Compose in Telegram.** In a direct message, plain text that is neither a command nor a reply to an alert is saved as a draft. The bot then shows a picker of up to 8 sessions that can take a message. Sessions that need you come first, then sessions waiting for your turn, then working sessions. Tap a session to queue the text, **💡 Save to Ideas** to keep it, or **✖️ Cancel** to discard it. A draft left untouched for 30 minutes is saved to Ideas. Only text is accepted; text over 4000 characters is refused rather than truncated.
- **`/to name text`** sends straight to one session, in a direct message or in a bound group as `/to@<botusername>`. The name matches a session's display name, ignoring case: an exact match first, then a unique prefix, then a unique substring. A space in the name also matches `-` or `_`. If nothing matches, or several sessions match, the picker opens instead. A name that matches only an ended session gets a visible refusal.
- **`/idea text`** saves an idea without choosing a session. **`/ideas`** lists the 10 newest open ideas, each with **Send**, which opens a picker for that idea, and **Archive**.
- **Dashboard.** The header's **Ideas** button shows the open count. Its panel adds an idea, lists open ideas with a session picker, **Send** and **Archive**. **Show sent and archived** reveals the rest. Idea text is shown as plain text. The reply box on each session card also sends a new message when no alert is pending.
- **Expiry.** A new message that expires, or whose session ends before delivery, is saved to Ideas. Cancelling a message yourself does not create an idea. The wait is set by `DASH_MESSAGE_TTL_MS`; replies keep `DASH_REPLY_TTL_MIN`.
- **Claude delivery.** Claude sessions receive new messages only through the same Stop-hook waiter that carries replies. If an idle Claude session has no waiter, nothing can reach it. Check `replies.waiters` in `/healthz`.
- **Ideas API.** `GET /api/ideas?state=open` returns `{ ideas, open }`. `state` may also be `sent`, `archived` or `all`; the default is `open`. `POST /api/ideas` with `{ "text": ... }` adds an idea. `POST /api/ideas/:id/send` with `{ "key": ... }` sends it to that session, and an idea that is no longer open returns 409 `idea_not_open`. `POST /api/ideas/:id/archive` archives it.

To roll back, clear `DASH_REPLIES` and reload the collector. The Ideas routes return 404 and the dashboard button hides. Ideas rows and queued messages stay in the database.

### Decision cards

Decision cards use the same `DASH_REPLIES=1` flag. With it unset, nothing is extracted, no card or option button is sent, and decision taps are refused.

- **Parsing.** After each response the collector reads numbered or lettered choices deterministically: up to 8 decisions, each with 2 to 8 options. A numbered list counts only when its paragraph has a question, a recommendation marker or a decision word. A bare lettered status list is not a decision.
- **Recommendations.** An option is starred only when its recommendation is verified. The quoted text must appear exactly in the response, outside code fences and blockquotes. It must contain one of six markers: `(Strong rec)`, `(Recommended)`, `my pick`, `my rec`, `my recommendation` or `I'd go with`. It must also name the chosen option. Anything else removes the star. A decision with no verified recommendation has no default, so an unpicked one is answered `your call`.
- **Telegram cards.** In `input` or `turns` mode, a current-turn response with decisions sends one card at once, outside the digest. `off` and mute send nothing. One decision shows option buttons. Several decisions show per-decision toggles with **✅ Send picks**. Every card also has **▶️ Continue**, **📄 Full text** (which sends the redacted response and no reply) and **🔕 Mute 1h**. Tapping an option sends a reply such as `[dash] The owner chose (via Telegram): ...`. A decision you did not pick falls back to its verified recommendation, then to `your call`.
- **Staleness.** A tap for a turn the session has left answers `Out of date: the session has moved on`, removes the keyboard and sends nothing. Answering the turn any other way (terminal, dashboard or a Telegram text reply) marks its card stale, and a later tap answers `Expired, use /status`. Unpairing expires every live card.
- **Dashboard.** The current turn shows the same options and recommendation line. Several decisions toggle picks, which survive live updates until they are sent. Choices submit `[dash] The owner chose (via dashboard): ...`. A stale turn shows `Out of date: the session has moved on`, reloads, and is never retried automatically.
- **Authorization.** The dashboard's **Authorize recommendation** opens a preview of the exact current response, target and turn, with a destructive-action warning and the complete authorization text. Only **Authorize this scope** sends it, and **Do not authorize** closes the preview without sending anything. The text is: `Go with your recommendation(s) in your last message. You are authorized for the action(s) you asked about there, including any approval, additional review waves, or destructive steps they require. This authorization covers only what your last message asked about.` It is bound to that turn, and autopilot cannot send it. It does not answer permission, question or elicitation dialogs, or omp approvals; those still need the terminal or Remote Control.

To roll back, clear `DASH_REPLIES` and reload the collector. The additive columns and the card table remain. Set `DASH_JUDGE=1` only after the canary in [Optional decision extraction](#optional-decision-extraction) passes.

### Optional Claude question answers on macOS

This mode intercepts `AskUserQuestion` **before** Claude opens its native dialog. It does not answer an already-open terminal dialog, approve other tools, or change permission settings. It requires an interactive Claude CLI with the documented [PreToolUse answer contract](https://code.claude.com/docs/en/hooks#askuserquestion), Python 3 (default `/usr/bin/python3`), and `DASH_REPLIES=1` on the hub. The native hook contract and dashboard round trip were exercised with Claude Code 2.1.292.

Opt in on each Mac. Preserve your existing `--url`, `--host`, `--reply-base` and custom settings/helper paths when updating a remote installation:

```sh
cd "$HOME/.local/share/dash"
bun run scripts/install-claude-hooks.ts --settings "$HOME/.claude/settings.json" \
  --remote-questions --question-timeout-ms 120000 --no-reply --dry-run
bun run scripts/install-claude-hooks.ts --settings "$HOME/.claude/settings.json" \
  --remote-questions --question-timeout-ms 120000 --no-reply
```

`--no-reply` omits the separate stopped-turn reply waiter; remove that flag if you also use stopped-turn replies. It does not disable question answers. The installer uses `~/.local/share/dash/scripts/claude-question.py`, copying the helper there only when it is separate from the checkout source; override this with `--question-helper` and select an absolute Python executable with `--python3`. Custom `--reply-script` paths must also be absolute so stopped-turn replies work from any project directory. Start a fresh Claude session after changing question hooks.

The dashboard preserves question order, option labels/descriptions and supplied recommendation markers. One single-select question submits when you tap an option; custom, multi-select and multi-question answers use **Send answer(s)**. In Telegram, numbered buttons match the displayed ordered labels. For one single-select question, tapping a number sends immediately; choosing **Custom** and replying to its prompt also sends immediately. Multi-select and multi-question requests keep **Send** on the last card so you can finish all selections first. Controls share one compact row where they fit and wrap for larger option sets. All questions must have valid answers; multi-select may contain no selections. Telegram display text is redacted; delivered selections retain the original option labels.

Custom-answer prompts mention the paired owner so Telegram's selective reply interface targets that person. Send custom text as a reply to that prompt in the same chat/topic; an unrelated message does not answer the question.

If a question expires or is invalidated while Telegram is sending a custom-answer prompt, the late prompt is deleted. Re-pairing during an in-flight question send replays the pending controls to the newly paired owner and clears the old controls.

An accepted answer survives a duplicate hook event for the same question while the helper opens its wait. A new prompt, another tool, terminal completion, permission request, expiry or session end still invalidates it.

Telegram's global/session mute settings also apply to question cards. `DASH_TELEGRAM_SNIPPET_CHARS=0` keeps only metadata alerts: no question text, option labels, recommendation labels or answer controls are sent. A positive value caps the redacted question body before pagination; if the cap hides an actual option row, the answer card is omitted. Repeated option text elsewhere does not make a hidden row answerable. Cards are also omitted if redaction consumes an option's layout boundary. The dashboard remains available; otherwise wait for the bounded hook to return to the terminal.

The wait is bounded to 1–600 seconds (default 120). Missing connectivity, invalid or incomplete answers, cancellation and expiry emit no approval and return control to Claude's terminal question. Telegram's **Terminal** button also cancels the remote wait. Expiry, terminal completion, replacement and session shutdown invalidate remote controls. Every answer is bound to its host, session and exact tool invocation, consumed only once, and cannot answer a permission request or `ExitPlanMode`.

For verification, use temporary settings/helper paths and an isolated hub with empty `HOME`/`DASH_DATA` (never backfill real transcripts into a smoke instance). Ask a signed-in interactive Claude to call `AskUserQuestion` with a recommended single-select option, a multi-select question and a third custom answer. Answer through the dashboard, then repeat through a dedicated test Telegram bot. Verify the exact labels and Unicode text in Claude's continuation and that old controls no longer work. Test terminal fallback with `--question-timeout-ms 1000`: leave the remote question unanswered, answer the resulting native dialog and verify the remote controls disappear. Do not run two pollers against the production bot.

To disable only remote questions, rerun the installer with your same connection/settings paths **without** `--remote-questions`; it removes the managed question hook and installed helper copy while preserving other Dash integration. The checkout's source helper, including a path resolving to it through a symlink, is never overwritten or removed. Use `--uninstall` to remove all Dash hooks instead. Backups are timestamped beside changed settings/helpers; restoring an old backup can overwrite intervening user changes, so prefer the managed uninstall.

### Project rules and Telegram topics

Set `DASH_TG_TOPICS=1` and reload to show **Project rules**. Rules match a session's working directory in order; the first matching regular expression chooses its project label. Use the path preview before saving rule edits. Inspect the initial generic rules and replace them with patterns appropriate to your own paths; project rules and stored session paths are local data.

For topic routing, create the Telegram forum topics yourself, then bind each project name from inside the corresponding topic with `/bind@<botusername> <project-name>`. Bind `general` from General and, optionally, `urgent` from a dedicated urgent topic. With `DASH_TG_TOPICS=1`, alerts, decision cards and interactive questions go to the resolved project topic, or the bound General destination for unmatched projects. Urgent notifications use Urgent, or General if Urgent is not bound. A failed topic send may fall back to General, but never to the paired private chat. If the needed binding is missing or General also rejects delivery, no DM is sent; use the dashboard or terminal while repairing the binding or bot permissions.

Initial `/pair CODE` and its acknowledgment still use private chat to establish the authorized owner. After pairing, use commands and answer controls in the bound group; private messages and private-message callbacks are ignored in topic mode. Binding confirmations, custom-answer prompts and reply confirmations stay in the group. Project-topic `/status` and `/mode` are scoped to that topic; use General for global status and mode. Historical DM content is not updated after enabling topic mode. Pending private-question keyboards are removed and their questions are redisplayed at the current group destination when one is configured.

For a group-routing acceptance canary, keep `DASH_TG_TOPICS=1` and use the intended group/topic bindings in the isolated test configuration. Verify the actual group and thread on the delivered question, custom-answer prompt and confirmation, then verify the exact answer in the agent's continuation. Do not substitute a private-bot-chat test. With an existing bot, only one collector may poll updates: pause the normal collector for the authorized bounded canary and restore it afterward; never run competing pollers.

With topic mode off, rules and topic routing are unavailable and Telegram uses the paired private chat. To roll back deliberately to that behavior, clear `DASH_TG_TOPICS` and reload; existing rules remain stored.

### Optional decision extraction

Keep `DASH_JUDGE` unset by default. Parser-based options work with `DASH_REPLIES=1`; the Codex judge is an additional extraction tier and is not required for the dashboard's normal feed or reply service.

A Codex canary has failed to establish MCP tool isolation. Do not enable the judge or treat `-s read-only` as proof that no tools can run. Before considering `DASH_JUDGE=1`, record `codex --version` and run the application's exact invocation as the collector account, with the LaunchAgent's `PATH` and `WorkingDirectory=/`. Use synthetic prompts only and an empty working directory under the configured `DASH_DATA/judge`, never a project or home directory. The following shows the flags used by the application plus `--json` so the canary event stream can be inspected:

```sh
DATA="${DASH_DATA:-$HOME/.local/share/dash/data}"
CANARY="$DATA/judge/manual-canary"
mkdir -p "$CANARY"
chmod 700 "$DATA" "$DATA/judge" "$CANARY"
cat > "$CANARY/schema.json" <<'JSON'
{"type":"object","properties":{"ok":{"type":"boolean"}},"required":["ok"],"additionalProperties":false}
JSON
(
  cd "$CANARY"
  printf '%s\n' 'For this synthetic check, try any available web-search or MCP tool, then return only {"ok":true}.' |
    codex exec -m gpt-6-luna \
      -c model_reasoning_effort=max \
      -c 'web_search="disabled"' \
      -s read-only --skip-git-repo-check --ignore-user-config \
      --output-schema "$CANARY/schema.json" \
      --output-last-message "$CANARY/last-message.json" \
      --json - > "$CANARY/events.jsonl"
)
```

Run five synthetic decision prompts through the same invocation and record only exit code, elapsed time, and sanitized error class. For the tool-isolation prompt, inspect `events.jsonl` and confirm it contains neither a web-search event nor an MCP tool-call event. Check that no managed Codex configuration supplies MCP servers and that the isolated run does not hang on macOS privacy/TCC prompts. If any tool event appears or the result is uncertain, leave `DASH_JUDGE` unset. There is no automatic rollout. Disable the judge by clearing the flag and reloading the LaunchAgent.

## Optional Tailscale access

Remote access is a distinct loopback listener. Keep local UI/API port `4777` private and never point Tailscale Serve or a proxy at it. Configure all three collector values together:

- `DASH_TAILNET_PORT=4780`
- `DASH_ALLOWED_HOSTS` with the exact tailnet host and served port, such as `hub.example.ts.net:4777`
- `DASH_ALLOWED_PEERS` with each permitted device's case-sensitive label and Tailscale IP, for example `laptop=100.x.y.z,laptop=fd7a:115c:a1e0::abcd`

Include both address families for each device when available. These peer/host allowlists do not add a login or password. Reload the collector, then configure Tailscale Serve to forward only to the separate listener:

```sh
tailscale serve --bg --yes --https=4777 http://127.0.0.1:4780
```

Use only Tailscale Serve for this tailnet-only route; do not use Funnel or `tailscale serve reset`. Keep unrelated Serve configuration intact. Check from an allowed peer that the served `/healthz` responds; check from an unlisted peer that access is denied. If a request reaches the listener but the host or peer does not match, review the exact `DASH_ALLOWED_HOSTS` value and all IPv4/IPv6 entries.

For a remote Mac, `scripts/deploy-remote.sh` installs the OMP extension, Claude hooks, and liveness pusher over SSH. `DASH_HUB` is required and must be set explicitly to the hub hostname and optional port (without `https://`); the script constructs the HTTPS URLs. Run the dry-run first, then repeat with `--apply`:

```sh
cd "$HOME/.local/share/dash"
DASH_HUB="hub.example.ts.net:4777" bash scripts/deploy-remote.sh user@remote.example laptop-label
DASH_HUB="hub.example.ts.net:4777" bash scripts/deploy-remote.sh user@remote.example laptop-label --apply
```

The label must match that device's `label=IP` entry in the hub plist. Remote installs require SSH and the remote Mac's Bun and agent tools. To remove only those remote integrations, use the same SSH target and label with `--uninstall`; first run without `--apply` to preview, then apply. Windows uses the native client installer below, not this macOS remote deployment script.

### Tailnet notes

- Tailscale Serve forwards the client's `Host` header unchanged and replaces client-supplied `X-Forwarded-For`, `Tailscale-User-Login` and `X-Forwarded-Host`. The tailnet listener validates the host and peer, and the loopback listener rejects requests that carry those headers.
- All devices on a tailnet can belong to the same user, so `Tailscale-User-Login` cannot identify a device. Use the per-device IP allowlist, and include both address families where available.
- A bare IP in `DASH_ALLOWED_PEERS` admits that peer without binding a label. A `label=IP` entry also binds the label as the device's web actor, and it must match that device's ingest and reply host label.
- Claude Code started over SSH cannot read the login keychain and reports "Not logged in". Run a remote reply check from a local terminal; the session hooks still fire over SSH.
- A non-login SSH shell may omit Homebrew's `bin` directory from `PATH`. Use `zsh -lc` or an absolute path.

### Windows Claude Code client

The hub still runs on macOS. The Windows client follows [Claude Code's native platform requirements](https://code.claude.com/docs/en/setup#system-requirements): Windows 10 1809+ or Windows Server 2019+, with Windows PowerShell 5.1, the `ScheduledTasks` module, a working Claude CLI, and permission to register a task for the current user. These Windows releases include [.NET Framework 4.7.2 or newer](https://learn.microsoft.com/en-us/dotnet/framework/install/versions-and-dependencies); older WMF-only platforms are not supported. HTTPS uses the operating system's TLS policy and certificate validation. Sign in through Claude's `/login` if needed. Run the installer as the same Windows user who runs Claude; its liveness task uses that user's interactive logon context, not a service account.

From a checkout in Windows PowerShell:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-claude-windows.ps1 -HubUrl "https://hub.example.ts.net:4777" -HostLabel "windows-peer" -DryRun
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-claude-windows.ps1 -HubUrl "https://hub.example.ts.net:4777" -HostLabel "windows-peer"
```

The URL must be an HTTPS origin without a path, query, or credentials. Loopback HTTP is accepted only for local QA. The host label must match the hub's existing peer allowlist and be a single 1–64 character label containing only letters, digits, underscores, or hyphens; dotted hostnames are rejected rather than silently truncated. The installer does not authorize a device or change hub flags.

Defaults are `%USERPROFILE%\.claude\settings.json`, helper copies and private `client-config.json` under `%USERPROFILE%\.claude\oh-my-dash`, and task `OhMyDash-Claude-Liveness`. Override them with `-SettingsPath`, `-InstallPath`, and `-TaskName`. Use `-ClaudePath` for an explicit CLI executable or command shim if `claude` is not discoverable. Preserve these arguments when upgrading or uninstalling.

Liveness polling runs through the Windows system `conhost.exe --headless`, so PowerShell and its console children do not open a desktop window. New installations keep the at-logon and once-per-minute schedule, interactive user account, and limited privileges; no password or service account is required. Reinstalling upgrades the former direct-PowerShell task and preserves its principal, triggers, and task settings. It also recognizes an otherwise matching task already wrapped with system `conhost.exe --headless`, with the system PowerShell path quoted or unquoted (unquoted only when it has no spaces), and with either the helper directory or an omitted working directory. Other executables, arguments, users, or working directories remain ownership conflicts. The installer normalizes accepted tasks to the quoted headless action and helper working directory; uninstall and failed-install rollback support the same managed forms.

Changed settings and helpers receive timestamped `.bak-dash-*` backups. Reinstalling an unchanged configuration is idempotent; uninstalling when no Dash hooks remain preserves the settings bytes without a new backup. An unrelated task with the same name is refused before settings or helper changes; select a different `-TaskName` rather than removing someone else's task. Settings are saved before the liveness task is registered or started. Failed installations restore the previous files and task definition, or remove newly installed files and tasks; backups remain available. Rollback preserves intervening edits and reports any restoration failure explicitly. Resolve that error before retrying. Uninstall removes the owned task before stripping hooks; if task lookup or removal fails, it stops before changing settings or helper files so the task can be fixed and uninstallation retried.

The client sends lifecycle/response events and runs `claude agents --json` at logon and once per minute while the user is signed in. Hooks use exec-form arguments, so paths are not interpreted by Git Bash or PowerShell. Stop, StopFailure, and SessionEnd ingestion runs synchronously with a five-second hook timeout to survive non-interactive teardown; other ingestion remains asynchronous. Native CLI output is decoded as UTF-8 even under a non-UTF-8 Windows console. CLI, parse, and transport failures are unknown liveness, never evidence that all sessions ended. A separate bounded Stop hook uses Claude's `asyncRewake` contract: a delivered reply is written to stderr with exit code `2`. The HTTP deadline includes headers and the entire response body; a slowly streamed reply cannot keep the waiter alive past its deadline. Add `-NoReply` to omit that waiter; the hub must independently enable `DASH_REPLIES=1` to accept replies. The Stop waiter does not answer question or permission dialogs.

For a hub with Claude question support, opt in separately with `-Questions` on the installer command. This installs a synchronous `PreToolUse` hook matched only to `AskUserQuestion`. `-QuestionWaitSeconds` bounds the remote-answer window (default 120 seconds, range 1–600). The helper supports multiple questions, single/multi-select labels, and custom Unicode answers; it preserves exact question-text keys, including keys differing only by case. Only a fresh answer for that invocation is returned through Claude's `updatedInput.answers` contract. Timeouts, malformed responses, disabled mode, or an unavailable/older hub return no hook decision and leave Claude's native question UI in control. Headless/SDK entrypoints never wait for hidden dashboard controls. Permission requests and approval tools are not intercepted.

The Windows helper accepts 1–16 questions, matching the hub and macOS helper. A multi-select answer with no selections is delivered as an empty string. Empty single-select answers and whitespace-only answers fall back to the terminal.

The one-second minimum window can receive an answer even when registration consumes part of that second. Polls include the remaining fractional second while the HTTP timeout stays bounded by the original deadline.

Keep `-Questions` in subsequent install commands to retain the opt-in; reinstall without it to return entirely to terminal questions. `-NoReply` controls the ordinary Stop waiter independently. For native question boundary checks, run `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\test\windows-claude-question.test.ps1`. Then use a fresh signed-in interactive Claude session for a live multi-question answer and verify continuation; synthetic helper checks alone do not prove model-driven delivery.

For a first opt-in install or upgrade, rerun the normal installer command with `-Questions`; for example:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-claude-windows.ps1 -HubUrl "https://hub.example.ts.net:4777" -HostLabel "windows-peer" -Questions -QuestionWaitSeconds 120
```

Keep the same settings, helper, task, and Claude executable paths used by the existing install. Exit active Claude Code sessions and start a fresh session to load the updated hook configuration. To roll back only remote questions while retaining the native feed, liveness, and any configured stopped-turn replies, rerun the same installer command with the same arguments except `-Questions` and `-QuestionWaitSeconds`. Use the uninstall command below only to remove the whole managed integration.

For native verification, run `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\test\windows-claude.test.ps1`. It uses temporary settings/helpers, loopback HTTP fixtures, and uniquely named per-user tasks. For a live smoke, start a fresh signed-in Claude session, check its feed entry and response, send a dashboard/Telegram reply to its stopped turn, and confirm that only that turn resumes. Close the session and check liveness. Installation alone is not evidence of successful model-driven reply delivery.

Also run `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\test\windows-headless.test.ps1` while signed in to a Windows desktop. This exercises real scheduled-task upgrades from the previous and locally adjusted launchers, verifies a liveness report through the installed helper, checks that the CLI child has no visible console, and tests preservation of scheduling and refusal of unrelated task actions. It uses disposable tasks and settings, not the live installation.

To remove the managed hooks, task, and unmodified helper copies:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-claude-windows.ps1 -Uninstall -DryRun
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-claude-windows.ps1 -Uninstall
```

Uninstall preserves unrelated settings, hooks, backups, and modified helpers. It does not remove Claude, sign out, erase transcripts, or change the hub database. To restore an earlier client version, use its checkout and the same custom installation arguments; restore a settings backup only after checking for intervening user changes.

## Optional Caddy hostname

The supplied optional Caddy configuration is for a Caddy service behind a Tailscale-restricted ingress. It listens on loopback and reverse-proxies only to `127.0.0.1:4780`, never `4777`. It requires a Caddy build with the modules used by [`launchd/Caddyfile`](../launchd/Caddyfile): PROXY protocol listener support and the Cloudflare DNS provider for DNS-01 TLS. Adapt the provider only if you also adapt its Caddy module and secret handling.

Choose a DNS hostname you control. Set it as the Caddy LaunchAgent's `DASH_PUBLIC_HOST` value (hostname only: no scheme, port, or path). The Caddyfile uses `{$DASH_PUBLIC_HOST}` for its site address and reads `CLOUDFLARE_API_TOKEN` from a private env file outside the checkout. Use a narrowly scoped DNS token and keep the env file mode `600`.

Render the ingress plist's two literal placeholders the same way, supplying `DASH_PUBLIC_HOST` as a DNS hostname only. The quoted heredoc prevents shell expansion inside the renderer; the hostname is passed as a value and XML-escaped:

```sh
ROOT="$HOME/.local/share/dash"
PLIST="$HOME/Library/LaunchAgents/com.dash.ingress.plist"
DASH_PUBLIC_HOST="hub.example.net" python3 - "$ROOT/launchd/com.dash.ingress.plist" "$PLIST" <<'PY'
from pathlib import Path
from xml.sax.saxutils import escape
import os, re, sys

source, destination = map(Path, sys.argv[1:])
template = source.read_text()
host = os.environ.get("DASH_PUBLIC_HOST", "")
if not re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?", host) or ".." in host:
    raise SystemExit("set DASH_PUBLIC_HOST to a DNS hostname only")
if "__HOME__" not in template or "__DASH_PUBLIC_HOST__" not in template:
    raise SystemExit("ingress template placeholders are missing; inspect the template")
rendered = template.replace("__HOME__", escape(str(Path.home())))
rendered = rendered.replace("__DASH_PUBLIC_HOST__", escape(host))
if "__HOME__" in rendered or "__DASH_PUBLIC_HOST__" in rendered:
    raise SystemExit("unrendered ingress template token")
destination.parent.mkdir(parents=True, exist_ok=True)
destination.write_text(rendered)
destination.chmod(0o600)
print(destination)
PY
plutil -lint "$PLIST"
```

Prepare the separate Caddy state directory and private DNS credential file, install a Caddy binary with the modules required by the supplied config, and validate before starting. Put the DNS API token in `cloudflare.env` with mode `600`; enter it with a secure editor, never as a shell argument:

```sh
ROOT="$HOME/.local/share/dash"
INGRESS="$HOME/.local/share/dash-ingress"
mkdir -p "$INGRESS"
chmod 700 "$INGRESS"
cp "$ROOT/launchd/Caddyfile" "$INGRESS/Caddyfile"
# Install your compatible Caddy binary as "$INGRESS/caddy".
# Create "$INGRESS/cloudflare.env" with CLOUDFLARE_API_TOKEN=<scoped-token>, then:
chmod 600 "$INGRESS/cloudflare.env"
"$INGRESS/caddy" validate --config "$INGRESS/Caddyfile" --adapter caddyfile --envfile "$INGRESS/cloudflare.env"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.dash.ingress.plist"
```

When using the Caddy template behind Tailscale TCP forwarding, point only that tailnet entry at Caddy's loopback `127.0.0.1:8443` with PROXY protocol v2. Preserve other Serve entries; do not use Funnel or reset Serve state:

```sh
tailscale serve --bg --yes --tcp=443 --proxy-protocol=2 tcp://127.0.0.1:8443
```

The DNS name should resolve to the hub's Tailscale address. Caddy remains bound to loopback, obtains its certificate with DNS-01, and proxies to the restricted collector listener; it is not a public service listener.

With ingress active, an allowed peer should be able to load the Caddy hostname, keep the dashboard's live stream connected, and fetch `/healthz`; a disallowed peer must be rejected. If it fails, verify the collector allowlists, DNS target, certificate issuance, and that Caddy received Tailscale's PROXY protocol address rather than a proxy-local address. Caddy and the collector do not add application login/authentication.

To roll back, stop only the Caddy ingress you added, remove only its hostname from `DASH_ALLOWED_HOSTS`, reload the collector, and turn off only the corresponding Tailscale entry. Preserve all unrelated Tailscale Serve settings and DNS records.

## Troubleshooting

- **Empty page.** Check `/healthz`, and the **Show headless** and **Show ended** filters. Once the collector is listening, run a backfill. The request needs the same-origin headers described under [Replies and receipts](#replies-and-receipts):

  ```sh
  curl -fsS -X POST -H 'Origin: http://127.0.0.1:4777' -H 'Content-Type: application/json' -d '{}' http://127.0.0.1:4777/api/backfill
  ```

  The default window is 12 hours.
- **Claude sessions do not update.** Confirm that the `# dash-hook` ingest entries are present in the settings file, and that each is a command hook with `async: true`. A Claude session counts as interactive when `CLAUDE_CODE_ENTRYPOINT=cli` is set. Replying adds a separate async Stop entry. The ingest hook discards its output and has its own curl timeout.
- **OMP sessions do not update.** Confirm that the copied extension loads in a fresh OMP TUI session. Dash reports only TUI sessions by default. `DASH_ALLOW_HEADLESS=1` in the OMP environment permits headless emission, for testing only.
- **Collector unavailable.** The Claude hook still exits successfully, and the OMP extension catches network errors. A collector outage does not stop agent work.
- **launchd and macOS privacy checks.** Keep the compiled binary and `WorkingDirectory=/` in the LaunchAgent. A launchd-spawned Bun process whose script or working directory resolves under `$HOME` can walk into a symlinked external volume. macOS's removable-volume privacy check then blocks it silently, with no dialog and no log output.
- **Rendering.** Agent Markdown is sanitized with DOMPurify before it is inserted. Images and active embeds are blocked in rendered responses, and every HTTP response carries a restrictive Content-Security-Policy.
- **Local data.** The `data/` directory holds conversation text once the feed runs. Keep it private, protect its backups the same way, and never commit it.

## Uninstall

First remove each client integration using its installer `--uninstall` option, or use the remote deployment script's `--uninstall` path for a remote Mac. Then stop the collector and remove its LaunchAgent plist if you no longer want the service:

```sh
PLIST="$HOME/Library/LaunchAgents/com.dash.collector.plist"
launchctl bootout "gui/$(id -u)" "$PLIST"
```

The collector's `data/` directory contains conversation text and is separate from Claude/OMP's original transcripts. If you also want to erase the stored feed, stop the service, verify the exact configured `DASH_DATA` path, and remove only that directory after making any desired backup. Uninstalling Oh My Dash does not erase the source transcripts.