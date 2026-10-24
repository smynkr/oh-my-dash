# Oh My Dash

Oh My Dash is a local session hub for [Claude Code](https://code.claude.com/) and [Oh My Pi](https://github.com/can1357/oh-my-pi). It collects agent session events on your own machine, shows a live feed and response timeline, and can optionally route alerts or owner replies through Telegram.

This public source snapshot is software documentation, not an operational history or a hosted service. It includes no access to any operator's live hub, transcript database, credentials, or private deployment state. Set up and operate your own instance.

## What it does

- Live session feed and timeline for Claude Code and OMP, with current status and recent assistant responses.
- Session filters for host, harness, **Repository** (host + working-directory identity, not Git-root/worktree detection; when no path is available the project label is used, and duplicate labels are disambiguated), and headless/ended visibility. They compose across Sessions and Timeline; Repository selection updates with live sessions and persists in this browser. Unchanged repository options remain in place during live updates. Cards support unread tracking and resume commands; browser notifications are optional.
- Optional first-match project path rules with a path preview. With Telegram topics enabled, project traffic stays in its bound group topic; unmatched projects and failed topic sends use bound General, never a private-chat fallback. Urgent alerts use Urgent or General. Commands, questions and answers stay in the group after initial private pairing.
- Optional Telegram alerts and replies. When replies are enabled, current-turn decision choices can appear as buttons; a ⭐ marks a recommended option when one is identified. Single-question buttons show the actual option labels, such as **Yes** / **No** when those choices were supplied, rather than bare A/B keys. Labels are redacted and shortened to fit; binary choices are never invented. Telegram cards have no generic “accept recommendation” button: tapping an option sends that choice, and multi-decision cards provide **Send picks**. The dashboard's **Authorize recommendation** opens a preview of the exact response and turn it would authorize, with a destructive-action warning; only **Authorize this scope** sends the authorization.
- In the dashboard, interactive OMP TUI `ask` questions appear with their original question and ordered option labels, including numbering gaps; supplied descriptions and expandable previews are shown too. A single-select recommended option is marked `(Recommended)`; multi-select options are not marked. For one single-select question, tapping an option sends it immediately. **Other (type your own)** accepts custom text; use **Send answer** for custom or multi-select answers. Multi-select supports several choices, custom text, or no selections; multiple questions are sent together with **Send answers**. Answers bind to the exact pending question, and stale answers are rejected without retry. If structured options are invalid, safely bound free text remains available. No extra feature flag is needed beyond `DASH_REPLIES=1`; reinstall the updated OMP extension and restart existing OMP sessions. Claude permission dialogs and OMP tool approvals remain terminal-only.
- Opt-in native Claude `AskUserQuestion` answers on macOS, using the original structured questions rather than inferred prose. Dashboard and Telegram choices bind to the exact invocation and preserve single/multi-select labels and custom text. Telegram question buttons share compact rows: one single-choice option or custom reply sends immediately, while multi-select and multiple questions retain **Send**. The bounded synchronous hook falls back to Claude's terminal without approving anything on timeout or failure; permission dialogs remain terminal-only. See [setup, verification and rollback](docs/runbook.md#optional-claude-question-answers-on-macos).
- A local SQLite feed database. By default, startup backfill scans recent Claude Code and OMP transcript files from the current account.
- Dense console, the default view. A session table shows state, project, session, machine, account, harness and activity age, with a reading and reply pane for the selected session alongside a consolidated chronological **Client output timeline** across all clients (available via **Timeline (all clients)** in the reading pane, in the **Client output timeline** section below the console table, and in the full-page **Timeline** tab, which persists `#view=timeline` across reloads). The collector tracks unread responses, so the reading position survives reloads and syncs across your browsers. See the [console section](docs/runbook.md#dashboard-console) of the runbook.
- Compare, search and organize. Compare two retained outputs side by side without generated summaries, search captured response text with repository-host and folder filters, pin sessions, save named views, and use keyboard shortcuts or the **Commands** palette. Output search keeps a selected repository filter even when no live session currently matches it. No palette action sends replies or grants authorization.
- Batch prompts with a preview. Send one ordinary prompt to sessions you add one at a time, after reviewing a frozen preview of targets and text. There is no all-sessions target, and each target gets its own receipt.
- Sources and session controls. **Sources** lists machines and accounts with the hub's own report times, shown as reporting, stale, unreported or unknown. Each session's **Controls** panel marks queueing, structured-question answers, approvals, interruption, resume and launch as supported, unavailable or unknown. Codex app-server-owned threads may support turn start, steer and interrupt; Dash does not grant Codex approvals, answer Codex user-input requests, attach to standalone sessions, remotely resume sessions or launch them. See the [Codex source adapter](docs/runbook.md#codex-source-adapter).
- Account aliases. Set a short, non-secret `DASH_ACCOUNT_ALIAS` when you launch a session to label its account. You can also rename a session or edit its alias in the dashboard. Aliases are display labels, not account identities.
- Ideas inbox. With replies enabled, save a message for later from Telegram (`/idea`, or the session picker) or from the dashboard's **Ideas** panel, then send it to a session when it is ready. Messages that expire before delivery are saved there too.
- Optional Codex source adapter runs a local `codex app-server` and ingests the thread metadata, recent turns and liveness it exposes. Limited turn controls apply only to app-server-owned threads; standalone CLI/Desktop sessions are not attachable, and approvals and user-input requests must be handled in Codex.

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

The default hook and OMP ingest URL is `http://127.0.0.1:4777`. Restart OMP sessions to load an updated extension. Default Claude event hooks are asynchronous; opt-in question hooks are synchronous and should be checked in a fresh Claude session after installation. To uninstall only these integrations, use the same settings/target paths:

```sh
bun run scripts/install-claude-hooks.ts --settings "$HOME/.claude/settings.json" --uninstall
bun run scripts/install-omp-extension.ts --target "$HOME/.omp/agent/extensions" --uninstall
```

Uninstalling integrations does not erase the collector database or the original Claude/OMP transcripts. If you installed hooks with replies enabled, use the installer's `--uninstall` to remove its Dash-marked entries; unrelated hooks and settings are preserved.

### Windows

Windows clients support both the OMP extension and native Claude Code hooks connecting to an already-running hub. The collector service, Keychain token storage, and LaunchAgent setup remain macOS-specific.

For Claude Code, use its supported native Windows platform (Windows 10 1809+ or Windows Server 2019+), Windows PowerShell 5.1, and a working, signed-in Claude CLI. From the repository root, preview the installation, then repeat without `-DryRun`:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-claude-windows.ps1 -HubUrl "https://your-hub.tailnet.ts.net:4777" -HostLabel "windows-peer" -DryRun
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-claude-windows.ps1 -HubUrl "https://your-hub.tailnet.ts.net:4777" -HostLabel "windows-peer"
```

Use the exact peer label authorized on your hub; remote URLs require HTTPS. The installer preserves unrelated Claude settings, backs up changed files, installs native event/reply helpers, and registers a per-user liveness task. Normal stopped turns can receive dashboard/Telegram replies when the hub enables `DASH_REPLIES=1`. On a hub with Claude question support, add `-Questions` to opt in to remote `AskUserQuestion` answers; `-QuestionWaitSeconds` sets the bounded remote-answer window (default 120, range 1–600 seconds). Reinstall without `-Questions` to disable it. Permission dialogs always remain terminal-only. This installer does not require Bun or install a Windows hub. See the [Windows client runbook](docs/runbook.md#windows-claude-code-client) for prerequisites, custom paths, verification, and uninstall.

From PowerShell in the repository root, install the extension and set the hub's Tailscale Serve URL and this device's exact allowlisted label:

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.omp\agent\extensions"
Copy-Item ".\omp-extension\dash.ts" "$env:USERPROFILE\.omp\agent\extensions\dash.ts"
setx DASH_URL "https://your-hub.tailnet.ts.net:4777/ingest/omp"
setx DASH_HOST "windows-peer"
```

Replace the example host/label with the values configured on your hub, open a new terminal so the environment is refreshed, and restart OMP. The OMP extension and Claude installer are separate client integrations; neither installs the hub on Windows.

## Optional Codex source adapter

Codex ingestion is opt-in: set `DASH_CODEX=1` on both the collector and source runner; it is off by default. On the source machine, the runner starts a local `codex app-server` and forwards its thread metadata, recent turns, turn-state updates and liveness to an existing Dash hub. `DASH_CODEX_IDENTITIES` can select up to 16 local profiles; each configured profile uses its own absolute `codeHome` and a distinct non-secret account alias when multiple profiles are used. See the [Codex source adapter runbook](docs/runbook.md#codex-source-adapter) for configuration and the control matrix.

For a single profile using the default Codex home:

```sh
DASH_CODEX=1 \
DASH_URL="http://127.0.0.1:4777" \
CODEX_HOME="$HOME/.codex" \
DASH_ACCOUNT_ALIAS="personal" \
bun run codex:source
```

Codex start, steer and interrupt controls require `DASH_REPLIES=1` on both the collector and source runner and are limited to app-server-owned threads whose local app-server supports the method. Dash does not answer Codex approval or user-input requests, remotely attach to or resume standalone CLI/Desktop sessions, or launch sessions. A Codex `ack_timeout` means the outcome is unknown: the request may or may not have been dispatched, and Dash will not retry it automatically. Check the Codex thread before resubmitting.

## Optional Telegram and replies

Telegram is opt-in and sends session content to Telegram. Bot chats are not end-to-end encrypted; by default alerts contain the full captured, redacted alert text. Use `DASH_TELEGRAM_SNIPPET_CHARS` to set a positive excerpt limit, or `0` to send labels without session text. The token is read from the logged-in macOS account's Keychain; do not put it in a plist, repository, or shell command history.

Enable `DASH_TELEGRAM=1` in the collector's environment, store a token for a dedicated Telegram bot in Keychain, and pair it from the local page using the displayed `/pair CODE`. Enable `DASH_REPLIES=1` separately to allow dashboard and Telegram replies and decision choices. Telegram provides `/status`, `/r N text`, `/to name text`, `/idea text`, `/ideas`, `/cancel`, `/mode input|turns|off`, `/mute`, and `/help`. With replies enabled, plain text in a direct message opens a picker of sessions to receive it, or saves it to Ideas. The full setup and rollback steps are in the [runbook](docs/runbook.md#optional-telegram); reply receipts and Ideas are described in [replies](docs/runbook.md#replies-and-receipts) and [new messages](docs/runbook.md#new-messages-and-ideas).

`DASH_JUDGE` is off by default and only runs when `DASH_REPLIES=1` is also set. A Codex canary has failed to establish MCP tool isolation. Do not enable it until you have checked the exact installed Codex invocation in the actual service environment and verified that no web-search or MCP tool calls are exposed. Leave it unset if isolation cannot be established; there is no automatic rollout. See the [runbook](docs/runbook.md#optional-decision-extraction).

## Optional per-session autopilot and Claude dialogs (AXI-241)

Per-session goals and blocking Claude `AskUserQuestion` handling are opt-in and off by default. Runtime autopilot requires `DASH_AUTOPILOT=1`, `DASH_REPLIES=1`, and the separately stored `settings.autopilot.enabled` switch, which starts off. A deterministic policy gate—not the judge alone—allows only fixed continue or verified-recommendation templates to be sent automatically; free-text suggestions and **Brief me** remain owner-only. Owner replies, stale state, budgets, loop/rate limits, and the master kill switch veto actions. An explicitly installed synchronous Claude `PreToolUse` deny-fence keeps a per-session cache; if the hub cannot confirm current goal state, it fails closed and blocks intercepted tools until a valid response arrives, even when the cache is empty or last said inactive.

Install the fence only by explicitly opting in with `--autopilot` (Windows: `-Autopilot`). Blocking dialog handling additionally requires `--autopilot-dialogs` (`-AutopilotDialogs` on Windows), and is mutually exclusive with the separate remote-question helper. Dialog handling also requires `DASH_DIALOGS=1` and owner-recorded E3/E4/E5 scratch-test evidence; incomplete or invalid gates release the question to Claude's native UI. OMP autopilot is unsupported on Windows until durable cache-directory flushing is available: the extension fails closed on OMP tool calls when an active goal is cached or hub state is unconfirmed, and defers autopilot replies. This export does not deploy, set flags or attestations, enable the stored master switch, install hooks, or perform live experiments. See the [autopilot and Claude dialog runbook](docs/runbook.md#per-session-autopilot-and-claude-dialogs).

## Dependency licenses

The project is MIT-licensed; see [LICENSE](LICENSE). Runtime dependencies are installed from `bun.lock` rather than vendored in this source tree. Their upstream license texts and notices are:

- [DOMPurify 3.4.16 — Apache 2.0](https://github.com/cure53/DOMPurify/blob/3.4.16/LICENSE) or [MPL 2.0](https://github.com/cure53/DOMPurify/blob/3.4.16/LICENSE-MPL).
- [Marked 16.4.2 — MIT plus Markdown attribution](https://github.com/markedjs/marked/blob/v16.4.2/LICENSE.md).
- [entities 8.1.0 — BSD 2-Clause](https://github.com/fb55/entities/blob/v8.1.0/LICENSE).

If redistributing a compiled application, retain the applicable third-party license text and upstream notices with that binary distribution.

## Contributing and security

See [Contributing](CONTRIBUTING.md) for local checks and privacy rules. Report vulnerabilities through [GitHub private vulnerability reporting](https://github.com/smynkr/oh-my-dash/security/advisories/new), not a public issue.