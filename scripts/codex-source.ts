import { createCodexAdapter, codexHostFromEnv, codexIdentitiesFromEnv } from "../src/codex.ts";

if (process.env.DASH_CODEX !== "1") throw new Error("Set DASH_CODEX=1 to run the Codex source adapter");
const hubUrl = process.env.DASH_URL?.trim();
if (!hubUrl) throw new Error("DASH_URL must point to the existing Dash hub from this source machine");

const adapter = createCodexAdapter({
  host: codexHostFromEnv(),
  identities: codexIdentitiesFromEnv(),
  hubUrl,
  forwardEvents: true,
  repliesEnabled: process.env.DASH_REPLIES === "1",
  onEvent: () => {},
  onLiveness: () => {},
  onError: (area, code) => console.error(`[dash-codex] ${area}: ${code}`),
}).start();

const close = () => adapter.close();
process.once("SIGINT", close);
process.once("SIGTERM", close);
void adapter.waitForReady().catch(() => {
  console.error("[dash-codex] no identity reached ready state");
  adapter.close();
  process.exitCode = 1;
});
