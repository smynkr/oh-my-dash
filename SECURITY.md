# Security

Oh My Dash is a personal session hub, not an authenticated multi-user service. Read the [README](README.md) and [runbook](docs/runbook.md) before enabling integrations or remote access.

## Trust and data

- The collector defaults to `http://127.0.0.1:4777` and has no login or password. Loopback access is not authentication: trust the machine and its local users and processes as able to read the feed and submit dashboard actions. The HTTP `Origin` check on writes is a CSRF gate, not an identity check.
- Session and response text, session metadata, and reply state are stored in SQLite under `data/` by default, or under `DASH_DATA` if configured. Backups contain private conversation data. Protect the database, backups, and host account accordingly.
- Claude hooks and the OMP extension send session events and captured text to the collector at their configured `DASH_URL`. Do not point them at an untrusted hub. Optional Telegram alerts send redacted session text to Telegram; the default is the full captured text, and Telegram chats are not end-to-end encrypted. Set `DASH_TELEGRAM_SNIPPET_CHARS` to a positive cap or `0` for labels only if you enable Telegram and need less text sent.
- `DASH_REPLIES=1` lets dashboard and paired Telegram replies reach agent sessions. Review each reply before sending. The dashboard's **⭐ Rec · auth'd** action is an explicit owner authorization for the action asked about in the current response; it can include consequential or destructive work.

## Network exposure

- `DASH_BIND` accepts loopback addresses only. Do not bind the collector to a LAN or public interface, and do not expose or reverse-proxy the local UI/API listener on port `4777`.
- Optional remote access uses the separate loopback listener configured with `DASH_TAILNET_PORT` (commonly `4780`), plus `DASH_ALLOWED_HOSTS` and `DASH_ALLOWED_PEERS`. Those host/IP allowlists are not user authentication. If using Tailscale Serve, proxy it only to the separate listener, maintain the peer allowlist, and do not use Funnel.
- Do not place tokens, transcript data, SQLite files, rendered LaunchAgent files, or machine-specific settings in commits or issue attachments. Keep a Telegram bot token in the logged-in account's Keychain, not in shell history or a plist.

## Optional Codex judge

`DASH_JUDGE` is off unless explicitly set, and has an effect only with `DASH_REPLIES=1`. A Codex canary has failed to establish MCP tool isolation. Do not enable the judge or treat its sandbox as proof of isolation until the exact installed Codex invocation has been canaried in the actual service environment and its event stream confirms that no web-search or MCP tools are exposed. If isolation cannot be confirmed, leave `DASH_JUDGE` unset. There is no automatic rollout.

## Reporting a vulnerability

Please report security issues through [GitHub private vulnerability reporting](https://github.com/smynkr/oh-my-dash/security/advisories/new), not a public issue. Include the affected version/commit, impact, and a minimal reproduction without real transcripts, credentials, or personal machine data.