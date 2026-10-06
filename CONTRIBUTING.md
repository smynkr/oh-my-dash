# Contributing

Thanks for helping improve Oh My Dash. Keep changes focused, follow the existing Bun/TypeScript patterns, and explain user-visible behavior and any privacy impact in the pull request. Do not assume a particular maintainer response time or automated CI policy.

## Local checks

From a fresh checkout, use the lockfile and run the current test suite:

```sh
bun install --frozen-lockfile
bun test --timeout 60000
```

For a manual UI/runtime smoke, run `bun start` only from a disposable account or with isolated `HOME` and `DASH_DATA` directories. Startup backfill reads recent Claude Code and OMP transcript files from the account's standard locations, and the collector stores captured conversation text in SQLite. Keep the listener on loopback; see the [runbook](docs/runbook.md) for a local setup.

Do not run hook or extension installers against a real agent profile as part of a change check. Use temporary settings/extension directories and the installers' `--dry-run` options where applicable.

## Privacy and security

- Use synthetic examples and fixtures. Never commit real prompts, transcripts, session IDs, hostnames, filesystem paths, Telegram messages, SQLite databases, credentials, settings files, or service logs.
- Do not add private deployment details, personal defaults, private operational history, or internal tracker/review records to public code or documentation.
- Keep network listeners loopback-only by default. Do not add a public listener or make the local port `4777` a reverse-proxy target.
- Treat replies as instructions delivered to a running agent. Preserve explicit user control and turn checks when changing reply or decision behavior.
- Keep the optional Codex judge disabled by default. Do not claim tool isolation without a successful canary of the exact invocation; see [Security](SECURITY.md).

Report vulnerabilities using the private reporting link in [SECURITY.md](SECURITY.md), rather than publishing exploit details in an issue.

Oh My Dash is MIT-licensed; see [LICENSE](LICENSE).