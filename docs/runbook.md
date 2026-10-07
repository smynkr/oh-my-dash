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

## Optional feature flags

Feature flags live in `EnvironmentVariables` in the collector plist. Leave them empty unless needed. After any plist edit, run `plutil -lint`, then reload with `launchctl bootout` and `launchctl bootstrap` as above.

| Setting | Effect |
|---|---|
| `DASH_PORT` | Local loopback port; default `4777`. |
| `DASH_DATA` | Private directory for SQLite and judge scratch data; template default is the checkout's `data/`. |
| `DASH_BACKFILL_HOURS` | Transcript backfill window; default `12` hours. |
| `DASH_TELEGRAM=1` | Enables optional Telegram alerts. The bot token is read from the logged-in user's Keychain. |
| `DASH_REPLIES=1` | Enables the reply broker, dashboard/Telegram replies, and parser decision controls. |
| `DASH_TG_TOPICS=1` | Enables the project-rules panel and Telegram project/topic routing. |
| `DASH_TG_URGENT_AFTER_MIN` | Topic-mode overdue-input threshold in whole minutes; default `30`. |
| `DASH_REPLY_TTL_MIN` | Reply expiry in minutes; default `15`, accepted range `1`–`1440`. |
| `DASH_TELEGRAM_SNIPPET_CHARS` | Optional Telegram text cap; unset sends full captured redacted text, a positive value caps it, and `0` sends labels only. |
| `DASH_JUDGE=1` | Optional Codex-assisted decision extraction; has an effect only with `DASH_REPLIES=1`. Leave off unless the exact canary below proves tool isolation. |

### Optional Telegram

Create a dedicated bot and store its token in the logged-in macOS account's Keychain. Do not reuse a bot with another poller or webhook, and do not put the token in the plist or shell history:

```sh
security add-generic-password -s dash-telegram-bot -a dash -w
```

Set `DASH_TELEGRAM=1` in the collector plist and reload it. Open the loopback page and send the displayed `/pair CODE` to the bot in a private chat. The token is read from Keychain by the logged-in collector account. Pairing and **Unpair** controls are local-only. Telegram is a separate service: its chats are not end-to-end encrypted, and alert text is full captured/redacted text by default. Review [Security](../SECURITY.md) before enabling it.

Set `DASH_REPLIES=1` separately to allow replies. Re-run the Claude installer without `--no-reply` and reinstall the OMP extension if you want their reply loops; restart already-running OMP sessions. Telegram commands include `/status`, `/r N text`, `/cancel`, `/mode input|turns|off`, `/mute`, and `/help`. An individual alert can be answered by replying to that alert. For multiple decisions, the Telegram card offers option buttons and **Send picks**; ⭐ marks a recommended option when identified. Telegram does not provide a generic recommendation-authorization button.

To roll back Telegram or replies, clear the corresponding `DASH_TELEGRAM` or `DASH_REPLIES` string in the plist and reload. Unpair in the local dashboard if desired. Removing the Keychain item or revoking the bot is optional and separate from disabling the collector integration.

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

`--no-reply` omits the separate stopped-turn reply waiter; remove that flag if you also use stopped-turn replies. It does not disable question answers. The installer copies the helper to `~/.local/share/dash/scripts/claude-question.py`; override this with `--question-helper` and select an absolute Python executable with `--python3`. Start a fresh Claude session after changing question hooks.

The dashboard preserves question order, option labels/descriptions and supplied recommendation markers. One single-select question submits when you tap an option; custom, multi-select and multi-question answers use **Send answer(s)**. In Telegram, select the numbers corresponding to the displayed ordered labels, use **Custom answer** and reply to its prompt for free text, then **Submit answers**. All questions must have valid answers; multi-select may contain no selections. Telegram display text is redacted; delivered selections retain the original option labels.

The wait is bounded to 1–600 seconds (default 120). Missing connectivity, invalid or incomplete answers, cancellation and expiry emit no approval and return control to Claude's terminal question. Telegram's **Use terminal instead** also cancels the remote wait. Expiry, terminal completion, replacement and session shutdown invalidate remote controls. Every answer is bound to its host, session and exact tool invocation, consumed only once, and cannot answer a permission request or `ExitPlanMode`.

For verification, use temporary settings/helper paths and an isolated hub with empty `HOME`/`DASH_DATA` (never backfill real transcripts into a smoke instance). Ask a signed-in interactive Claude to call `AskUserQuestion` with a recommended single-select option, a multi-select question and a third custom answer. Answer through the dashboard, then repeat through a dedicated test Telegram bot. Verify the exact labels and Unicode text in Claude's continuation and that old controls no longer work. Test terminal fallback with `--question-timeout-ms 1000`: leave the remote question unanswered, answer the resulting native dialog and verify the remote controls disappear. Do not run two pollers against the production bot.

To disable only remote questions, rerun the installer with your same connection/settings paths **without** `--remote-questions`; it removes the managed question hook and helper while preserving other Dash integration. Use `--uninstall` to remove all Dash hooks instead. Backups are timestamped beside changed settings/helpers; restoring an old backup can overwrite intervening user changes, so prefer the managed uninstall.

### Project rules and Telegram topics

Set `DASH_TG_TOPICS=1` and reload to show **Project rules**. Rules match a session's working directory in order; the first matching regular expression chooses its project label. Use the path preview before saving rule edits. Inspect the initial generic rules and replace them with patterns appropriate to your own paths; project rules and stored session paths are local data.

For topic routing, create the Telegram forum topics yourself, then bind each project name from inside the corresponding topic with `/bind@<botusername> <project-name>`. Bind `general` from General. The bot routes matching project alerts to configured topics; projects without a topic use the paired private chat. With topic mode off, rules and topic routing are unavailable. To roll back, clear `DASH_TG_TOPICS` and reload; existing rules remain stored.

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

### Windows Claude Code client

The hub still runs on macOS. The Windows client follows [Claude Code's native platform requirements](https://code.claude.com/docs/en/setup#system-requirements): Windows 10 1809+ or Windows Server 2019+, with Windows PowerShell 5.1, the `ScheduledTasks` module, a working Claude CLI, and permission to register a task for the current user. These Windows releases include [.NET Framework 4.7.2 or newer](https://learn.microsoft.com/en-us/dotnet/framework/install/versions-and-dependencies); older WMF-only platforms are not supported. HTTPS uses the operating system's TLS policy and certificate validation. Sign in through Claude's `/login` if needed. Run the installer as the same Windows user who runs Claude; its liveness task uses that user's interactive logon context, not a service account.

From a checkout in Windows PowerShell:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-claude-windows.ps1 -HubUrl "https://hub.example.ts.net:4777" -HostLabel "windows-peer" -DryRun
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-claude-windows.ps1 -HubUrl "https://hub.example.ts.net:4777" -HostLabel "windows-peer"
```

The URL must be an HTTPS origin without a path, query, or credentials. Loopback HTTP is accepted only for local QA. The host label must match the hub's existing peer allowlist; the installer does not authorize a device or change hub flags.

Defaults are `%USERPROFILE%\.claude\settings.json`, helper copies and private `client-config.json` under `%USERPROFILE%\.claude\oh-my-dash`, and task `OhMyDash-Claude-Liveness`. Override them with `-SettingsPath`, `-InstallPath`, and `-TaskName`. Use `-ClaudePath` for an explicit CLI executable or command shim if `claude` is not discoverable. Preserve these arguments when upgrading or uninstalling.

Changed settings and helpers receive timestamped `.bak-dash-*` backups. Reinstalling an unchanged configuration is idempotent; uninstalling when no Dash hooks remain preserves the settings bytes without a new backup. An unrelated task with the same name is refused before settings or helper changes; select a different `-TaskName` rather than removing someone else's task. Settings are saved before the liveness task is registered or started. Failed installations restore the previous files and task definition, or remove newly installed files and tasks; backups remain available. Rollback preserves intervening edits and reports any restoration failure explicitly. Resolve that error before retrying. Uninstall removes the owned task before stripping hooks.

The client sends lifecycle/response events and runs `claude agents --json` at logon and once per minute while the user is signed in. Hooks use exec-form arguments, so paths are not interpreted by Git Bash or PowerShell. Stop, StopFailure, and SessionEnd ingestion runs synchronously with a five-second hook timeout to survive non-interactive teardown; other ingestion remains asynchronous. Native CLI output is decoded as UTF-8 even under a non-UTF-8 Windows console. CLI, parse, and transport failures are unknown liveness, never evidence that all sessions ended. A separate bounded Stop hook uses Claude's `asyncRewake` contract: a delivered reply is written to stderr with exit code `2`. The HTTP deadline includes headers and the entire response body; a slowly streamed reply cannot keep the waiter alive past its deadline. Add `-NoReply` to omit that waiter; the hub must independently enable `DASH_REPLIES=1` to accept replies. The Stop waiter does not answer question or permission dialogs.

For a hub with Claude question support, opt in separately with `-Questions` on the installer command. This installs a synchronous `PreToolUse` hook matched only to `AskUserQuestion`. `-QuestionWaitSeconds` bounds the remote-answer window (default 120 seconds, range 1–600). The helper supports multiple questions, single/multi-select labels, and custom Unicode answers; it preserves exact question-text keys, including keys differing only by case. Only a fresh answer for that invocation is returned through Claude's `updatedInput.answers` contract. Timeouts, malformed responses, disabled mode, or an unavailable/older hub return no hook decision and leave Claude's native question UI in control. Headless/SDK entrypoints never wait for hidden dashboard controls. Permission requests and approval tools are not intercepted.

Keep `-Questions` in subsequent install commands to retain the opt-in; reinstall without it to return entirely to terminal questions. `-NoReply` controls the ordinary Stop waiter independently. For native question boundary checks, run `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\test\windows-claude-question.test.ps1`. Then use a fresh signed-in interactive Claude session for a live multi-question answer and verify continuation; synthetic helper checks alone do not prove model-driven delivery.

For a first opt-in install or upgrade, rerun the normal installer command with `-Questions`; for example:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-claude-windows.ps1 -HubUrl "https://hub.example.ts.net:4777" -HostLabel "windows-peer" -Questions -QuestionWaitSeconds 120
```

Keep the same settings, helper, task, and Claude executable paths used by the existing install. Exit active Claude Code sessions and start a fresh session to load the updated hook configuration. To roll back only remote questions while retaining the native feed, liveness, and any configured stopped-turn replies, rerun the same installer command with the same arguments except `-Questions` and `-QuestionWaitSeconds`. Use the uninstall command below only to remove the whole managed integration.

For native verification, run `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\test\windows-claude.test.ps1`. It uses temporary settings/helpers, loopback HTTP fixtures, and uniquely named per-user tasks. For a live smoke, start a fresh signed-in Claude session, check its feed entry and response, send a dashboard/Telegram reply to its stopped turn, and confirm that only that turn resumes. Close the session and check liveness. Installation alone is not evidence of successful model-driven reply delivery.

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

## Uninstall

First remove each client integration using its installer `--uninstall` option, or use the remote deployment script's `--uninstall` path for a remote Mac. Then stop the collector and remove its LaunchAgent plist if you no longer want the service:

```sh
PLIST="$HOME/Library/LaunchAgents/com.dash.collector.plist"
launchctl bootout "gui/$(id -u)" "$PLIST"
```

The collector's `data/` directory contains conversation text and is separate from Claude/OMP's original transcripts. If you also want to erase the stored feed, stop the service, verify the exact configured `DASH_DATA` path, and remove only that directory after making any desired backup. Uninstalling Oh My Dash does not erase the source transcripts.