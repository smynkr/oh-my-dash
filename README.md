# Oh My Dash

Oh My Dash is a local session hub for [Claude Code](https://code.claude.com/) and [Oh My Pi](https://github.com/can1357/oh-my-pi). It collects agent session events on your own machine, shows a live feed and response timeline, and can optionally route alerts or owner replies through Telegram.

This public source snapshot is software documentation, not an operational history or a hosted service. It includes no access to any operator's live hub, transcript database, credentials, or private deployment state. Set up and operate your own instance.

## What it does

- Live session feed and timeline for Claude Code and OMP, with current status and recent assistant responses.
- Session filters for host, harness, **Repository** (host + working-directory identity, not Git-root/worktree detection; when no path is available the project label is used, and duplicate labels are disambiguated), and headless/ended visibility. They compose across Sessions and Timeline; Repository selection updates with live sessions and persists in this browser. Unchanged repository options remain in place during live updates. Cards support unread tracking and resume commands; browser notifications are optional.
- Optional first-match project path rules with a path preview; with Telegram topics enabled, resolved projects can route alerts to bound topics.
- Optional Telegram alerts and replies. When replies are enabled, current-turn decision choices can appear as buttons; a ⭐ marks a recommended option when one is identified. Single-question buttons show the actual option labels, such as **Yes** / **No** when those choices were supplied, rather than bare A/B keys. Labels are redacted and shortened to fit; binary choices are never invented. Telegram cards have no generic “accept recommendation” button: tapping an option sends that choice, and multi-decision cards provide **Send picks**. The dashboard has its own quick actions, including **⭐ Rec · auth'd**, which explicitly authorizes the action asked about in the current response.
- Interactive OMP TUI `ask` questions appear with their original question and ordered option labels, including numbering gaps; supplied descriptions and expandable previews are shown too. A single-select recommended option is marked `(Recommended)`; multi-select options are not marked. For one single-select question, tapping an option sends it immediately. **Other (type your own)** accepts custom text; use **Send answer** for custom or multi-select answers. Multi-select supports several choices, custom text, or no selections; multiple questions are sent together with **Send answers**. Answers bind to the exact pending question, and stale answers are rejected without retry. If structured options are invalid, safely bound free text remains available. No extra feature flag is needed beyond `DASH_REPLIES=1`; reinstall the updated OMP extension and restart existing OMP sessions. Claude dialogs and OMP tool approvals remain terminal-only.
- A local SQLite feed database. By default, startup backfill scans recent Claude Code and OMP transcript files from the current account.

## Requirements and local quick start

macOS is the supported hub platform: its optional LaunchAgent template and Keychain-backed Telegram token are macOS-specific. Native Windows clients can connect to an existing hub. Install [Bun 1.3.14 or newer](https://bun.sh/), then clone and start the project:

```sh
git clone https://github.com/smynkr/oh-my-dash.git
cd oh-my-dash
bun install --frozen-lockfile
bun test --timeout 60000
bun start
```

Open <http://127.0.0.1:4777/>. Stop the server with `Ctrl-C`. The server binds to loopback only; it has no login or password. Do not expose this address or reverse-proxy port `4777` to a network. See [Security](SECURITY.md) and the [macOS runbook](docs/runbook.md) before configuring a background service or remote access.

The default SQLite database is `data/dash.sqlite`; set `DASH_DATA` to use a different private data directory. Backups contain captured conversation text. `DASH_PORT` changes the local port, but `DASH_BIND` only accepts loopback addresses. The default transcript backfill window is 12 hours and can be changed with `DASH_BACKFILL_HOURS`.

## Install agent integrations

The Claude Code hook installer merges only Dash-marked hooks into an existing settings file and saves a timestamped backup before a changed write. The OMP installer copies `omp-extension/dash.ts` to the OMP extension directory; it overwrites an existing `dash.ts` without backing it up, so save any existing extension yourself first. Dry-run reports the planned operation without writing; it is not a full settings diff. Review the target settings/extension, then apply:

```sh
# Run from the cloned repository. Create an empty settings file only if you do not have one.
mkdir -p "$HOME/.claude"
if [ ! -e "$HOME/.claude/settings.json" ]; then printf '{}\n' > "$HOME/.claude/settings.json"; fi
# The applying installer makes its own timestamped backup before a changed write.
bun run scripts/install-claude-hooks.ts --settings "$HOME/.claude/settings.json" --dry-run --no-reply
bun run scripts/install-claude-hooks.ts --settings "$HOME/.claude/settings.json" --no-reply

# Back up an existing extension before the installer overwrites it.
if [ -f "$HOME/.omp/agent/extensions/dash.ts" ]; then
  cp -p "$HOME/.omp/agent/extensions/dash.ts" "$HOME/.omp/agent/extensions/dash.ts.pre-oh-my-dash"
fi
bun run scripts/install-omp-extension.ts --target "$HOME/.omp/agent/extensions" --dry-run
bun run scripts/install-omp-extension.ts --target "$HOME/.omp/agent/extensions"
```

The default hook and OMP ingest URL is `http://127.0.0.1:4777`. Restart OMP sessions to load an updated extension. Claude hooks are added asynchronously and do not require a Claude Code restart. To uninstall only these integrations, use the same settings/target paths:

```sh
bun run scripts/install-claude-hooks.ts --settings "$HOME/.claude/settings.json" --uninstall
bun run scripts/install-omp-extension.ts --target "$HOME/.omp/agent/extensions" --uninstall
```

Uninstalling integrations does not erase the collector database or the original Claude/OMP transcripts. If you installed hooks with replies enabled, use the installer's `--uninstall` to remove its Dash-marked entries; unrelated hooks and settings are preserved.

### Windows

Windows clients support both the OMP extension and native Claude Code hooks connecting to an already-running hub. The collector service, Keychain token storage, and LaunchAgent setup remain macOS-specific.

For Claude Code, use Windows PowerShell 5.1 and a working, signed-in Claude CLI. From the repository root, preview the installation, then repeat without `-DryRun`:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-claude-windows.ps1 -HubUrl "https://your-hub.tailnet.ts.net:4777" -HostLabel "windows-peer" -DryRun
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-claude-windows.ps1 -HubUrl "https://your-hub.tailnet.ts.net:4777" -HostLabel "windows-peer"
```

Use the exact peer label authorized on your hub; remote URLs require HTTPS. The installer preserves unrelated Claude settings, backs up changed files, installs native event/reply helpers, and registers a per-user liveness task. Normal stopped turns can receive dashboard/Telegram replies when the hub enables `DASH_REPLIES=1`; question and permission dialogs remain terminal-only in this client mode. This installer does not require Bun or install a Windows hub. See the [Windows client runbook](docs/runbook.md#windows-claude-code-client) for prerequisites, custom paths, verification, and uninstall.

From PowerShell in the repository root, install the extension and set the hub's Tailscale Serve URL and this device's exact allowlisted label:

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.omp\agent\extensions"
Copy-Item ".\omp-extension\dash.ts" "$env:USERPROFILE\.omp\agent\extensions\dash.ts"
setx DASH_URL "https://your-hub.tailnet.ts.net:4777/ingest/omp"
setx DASH_HOST "windows-peer"
```

Replace the example host/label with the values configured on your hub, open a new terminal so the environment is refreshed, and restart OMP. The OMP extension and Claude installer are separate client integrations; neither installs the hub on Windows.

## Optional Telegram and replies

Telegram is opt-in and sends session content to Telegram. Bot chats are not end-to-end encrypted; by default alerts contain the full captured, redacted alert text. Use `DASH_TELEGRAM_SNIPPET_CHARS` to set a positive excerpt limit, or `0` to send labels without session text. The token is read from the logged-in macOS account's Keychain; do not put it in a plist, repository, or shell command history.

Enable `DASH_TELEGRAM=1` in the collector's environment, store a token for a dedicated Telegram bot in Keychain, and pair it from the local page using the displayed `/pair CODE`. Enable `DASH_REPLIES=1` separately to allow dashboard and Telegram replies and decision choices. Telegram provides `/status`, `/r N text`, `/mode input|turns|off`, `/mute`, and `/help`. The full setup and rollback steps are in the [runbook](docs/runbook.md#optional-telegram).

`DASH_JUDGE` is off by default and only runs when `DASH_REPLIES=1` is also set. A Codex canary has failed to establish MCP tool isolation. Do not enable it until you have checked the exact installed Codex invocation in the actual service environment and verified that no web-search or MCP tool calls are exposed. Leave it unset if isolation cannot be established; there is no automatic rollout. See the [runbook](docs/runbook.md#optional-decision-extraction).

## Dependency licenses

The project is MIT-licensed; see [LICENSE](LICENSE). Runtime dependencies are installed from `bun.lock` rather than vendored in this source tree. Their upstream license texts and notices are:

- [DOMPurify 3.4.16 — Apache 2.0](https://github.com/cure53/DOMPurify/blob/3.4.16/LICENSE) or [MPL 2.0](https://github.com/cure53/DOMPurify/blob/3.4.16/LICENSE-MPL).
- [Marked 16.4.2 — MIT plus Markdown attribution](https://github.com/markedjs/marked/blob/v16.4.2/LICENSE.md).
- [entities 8.1.0 — BSD 2-Clause](https://github.com/fb55/entities/blob/v8.1.0/LICENSE).

If redistributing a compiled application, retain the applicable third-party license text and upstream notices with that binary distribution.

## Contributing and security

See [Contributing](CONTRIBUTING.md) for local checks and privacy rules. Report vulnerabilities through [GitHub private vulnerability reporting](https://github.com/smynkr/oh-my-dash/security/advisories/new), not a public issue.