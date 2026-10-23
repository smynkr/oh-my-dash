import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { extractDecisions } from "../src/decisions.ts";
import type { ResponseDTO, SessionDTO } from "../src/db.ts";
import {
  decisionSetHash, evaluateAutopilotPolicy, matchStopAndAsk, type AutopilotVerdict, type PolicyInput,
} from "../src/autopilot-policy.ts";

const decisionText = "Which database?\n**A (recommended):** Postgres\n**B:** SQLite";
const session: SessionDTO = {
  key: "host|claude|synthetic", host: "host", harness: "claude", sessionId: "synthetic", displayName: "synthetic",
  project: "project", status: "your_turn", backgroundPending: false, interactive: true, alive: true,
  createdAt: 0, lastActivity: 0, unreadCount: 0, lastResponses: [], turnSeq: 5,
};
const response: ResponseDTO = {
  id: 11, sessionKey: session.key, ts: 10, text: decisionText, seen: false, source: "hook", project: "project",
  decisions: extractDecisions(decisionText), decisionState: "parser", turnSeq: 5,
};
const verdict = (overrides: Partial<AutopilotVerdict> = {}): AutopilotVerdict => ({
  action: "continue", rationale: "bounded rationale", confidence: 0.9, risk_flags: [], ...overrides,
});
const input = (overrides: Partial<PolicyInput> = {}): PolicyInput => ({
  enabled: true, masterEnabled: true,
  goal: { id: 1, status: "active", maxTurns: 20, turnsUsed: 0, expiresAt: 100_000, lastResumedTurn: 0 },
  session, expectedTurn: 5, ownerReplyPending: false, latestTurnError: false, now: 1_000,
  response, verdict: verdict(), lastReplyAt: null, globalRepliesLastHour: 0, recentActions: [], customStopPhrases: [],
  ...overrides,
});

describe("autopilot deterministic policy", () => {
  test("allows only fixed continue or verified recommended choices", () => {
    expect(evaluateAutopilotPolicy(input())).toEqual({ kind: "send", template: "T_CONTINUE" });
    expect(evaluateAutopilotPolicy(input({ verdict: verdict({ action: "choose_option", option_indices: [0] }) })))
      .toEqual({ kind: "send", template: "T_CHOOSE_SINGLE" });
    expect(evaluateAutopilotPolicy(input({ verdict: verdict({ action: "choose_option", option_indices: [1] }) })))
      .toEqual({ kind: "escalate", reason: "near_tie" });
  });

  test("rejects empty, incomplete, and unbound choice evidence", () => {
    const noDecisions = { ...response, decisions: { decisions: [], source: "parser" as const } };
    expect(evaluateAutopilotPolicy(input({ response: noDecisions, verdict: verdict({ action: "choose_option", option_indices: [0] }) })))
      .toEqual({ kind: "escalate", reason: "near_tie" });
    expect(evaluateAutopilotPolicy(input({ verdict: verdict({ action: "choose_option", option_indices: [] }) })))
      .toEqual({ kind: "escalate", reason: "near_tie" });
    const invalid = { ...response, decisions: { ...response.decisions!, decisions: response.decisions!.decisions.map(d => ({ ...d, recQuote: "SQLite is recommended" })) } };
    expect(evaluateAutopilotPolicy(input({ response: invalid, verdict: verdict({ action: "choose_option", option_indices: [0] }) })))
      .toEqual({ kind: "escalate", reason: "near_tie" });
  });

  test("fails closed for switches, stale turns, errors, budget, and expiry", () => {
    expect(evaluateAutopilotPolicy(input({ enabled: false }))).toMatchObject({ kind: "drop", reason: "disabled" });
    expect(evaluateAutopilotPolicy(input({ masterEnabled: false }))).toMatchObject({ kind: "drop", reason: "disabled" });
    expect(evaluateAutopilotPolicy(input({ expectedTurn: 6 }))).toMatchObject({ kind: "drop", reason: "stale" });
    expect(evaluateAutopilotPolicy(input({ ownerReplyPending: true }))).toMatchObject({ kind: "drop", reason: "stale" });
    expect(evaluateAutopilotPolicy(input({ latestTurnError: true }))).toMatchObject({ kind: "escalate", reason: "session_error" });
    expect(evaluateAutopilotPolicy(input({ goal: { ...input().goal, turnsUsed: 20 } }))).toMatchObject({ kind: "escalate", reason: "budget" });
    expect(evaluateAutopilotPolicy(input({ goal: { ...input().goal, expiresAt: 999 } }))).toMatchObject({ kind: "escalate", reason: "budget" });
  });

  test("defers the per-session cooldown and escalates the global cap", () => {
    expect(evaluateAutopilotPolicy(input({ lastReplyAt: 950, now: 1_000 }))).toEqual({ kind: "defer", reason: "cooldown", until: 120_950 });
    expect(evaluateAutopilotPolicy(input({ globalRepliesLastHour: 30 }))).toEqual({ kind: "escalate", reason: "rate" });
  });

  test("escalates stop-and-ask matches, low confidence, risk flags, free text, and judge escalation", () => {
    const samples: Array<[string, string]> = [
      ["git push --force origin main", "force_push"], ["git push origin +main", "force_push"],
      ["git reset --hard HEAD~1", "history_rewrite"], ["rm -rf ./tmp", "rm_rf"],
      ["DROP TABLE users", "drop_truncate"], ["gh secret set API_KEY", "secrets_iam"],
      ["brew install jq", "system_install"], ["git config --global user.name x", "global_config"],
      ["send email to alice@example.test", "email"], ["place a payment", "payment_money"],
      ["accept the terms of service", "accept_terms"], ["POST /api/autopilot/switch", "dash_control"],
      ["git branch --force --delete old", "branch_delete"],
      ["git branch --delete --force old", "branch_delete"],
    ];
    for (const [text, expected] of samples) expect(matchStopAndAsk(text)).toBe(expected);
    expect(matchStopAndAsk("continue safely", ["sensitive phrase"])).toBeUndefined();
    expect(matchStopAndAsk("SENSITIVE PHRASE", ["sensitive phrase"])).toBe("custom_phrase");
    expect(evaluateAutopilotPolicy(input({ response: { ...response, text: "git push --force" } })))
      .toEqual({ kind: "escalate", reason: "stop_ask:force_push" });
    expect(evaluateAutopilotPolicy(input({ verdict: verdict({ confidence: 0.69 }) }))).toEqual({ kind: "escalate", reason: "judge" });
    expect(evaluateAutopilotPolicy(input({ verdict: verdict({ risk_flags: ["risk"] }) }))).toEqual({ kind: "escalate", reason: "judge" });
    expect(evaluateAutopilotPolicy(input({ verdict: verdict({ action: "reply", reply_text: "suggested" }) })))
      .toEqual({ kind: "escalate", reason: "free_text", suggestion: "suggested" });
    expect(evaluateAutopilotPolicy(input({ verdict: verdict({ action: "escalate" }) }))).toEqual({ kind: "escalate", reason: "judge" });
  });
  test("escalates destructive long-form deletes without matching benign prose", () => {
    for (const text of [
      "rm --recursive --force ./tmp", "rm --force --recursive ./tmp", "rm --recursive -f ./tmp",
      "rm --force -r ./tmp", "rm -r -f ./tmp", "rm -f -r ./tmp", "git clean -fdx",
    ]) expect(matchStopAndAsk(text)).toBe("rm_rf");
    expect(matchStopAndAsk("ｒｍ　－ｒｆ ./tmp")).toBe("rm_rf");
    expect(matchStopAndAsk("Proceed in order to validate the response.")).toBeUndefined();
    expect(matchStopAndAsk("Pay attention to the order of these steps.")).toBeUndefined();
    expect(matchStopAndAsk("Drop the result into the output directory.")).toBeUndefined();
  });

  test("escalates recursive deletion through Windows shells", () => {
    for (const text of [
      "powershell.exe -Command Remove-Item -Recurse -Force C:\\synthetic\\target",
      "powershell -NoProfile -Command \"Remove-Item -Force -Recurse C:\\synthetic\\target\"",
      "Remove-Item -Recurse -Force C:\\synthetic\\target",
      "powershell -Command \"echo start; Remove-Item -Recurse -Force C:\\synthetic\\target\"",
      "powershell -Command ri -Recurse -Force C:\\synthetic\\target",
      "powershell -Command Remove-Item -r -fo C:\\synthetic\\target",
      "powershell -Command \"Remove-Item -Recurse -Confirm:$false -Force C:\\synthetic\\target\"",
      "rd -Recurse -Force C:\\synthetic\\target",
      "rd -Force -Recurse C:\\synthetic\\target",
      "del -Recurse -Force C:\\synthetic\\target",
      "del -Force -Recurse C:\\synthetic\\target",
      "erase -Recurse -Force C:\\synthetic\\target",
      "rmdir -Recurse -Force C:\\synthetic\\target",
      "rm -Recurse -Force C:\\synthetic\\target",
      "cmd /c del /s /q C:\\synthetic\\target\\*",
      "cmd.exe /c del /q /s C:\\synthetic\\target\\*",
      "cmd /c rd /s /q C:\\synthetic\\target",
    ]) expect(matchStopAndAsk(text)).toBe("rm_rf");
    for (const text of [
      "del",
      "rd",
      "The words del and rd are mentioned in this sentence.",
      "The path C:\\synthetic\\del\\rd should remain untouched.",
    ]) expect(matchStopAndAsk(text)).toBeUndefined();
  });

  test("matches configured stop phrases by Unicode code point count", () => {
    const phrase = "😀".repeat(100);
    expect(matchStopAndAsk(`before ${phrase} after`, [phrase])).toBe("custom_phrase");
  });


  test("breaks repeated templates and repeated decision sets after a choice", () => {
    const responseHash = createHash("sha1").update(decisionText).digest("hex");
    const repeat = {
      ...input(),
      recentActions: [
        { template: "T_CONTINUE" as const, responseHash, decisionSetHash: "a", status: "sent" },
        { template: "T_CONTINUE" as const, responseHash: "older", decisionSetHash: "b", status: "sent" },
      ],
    };
    expect(evaluateAutopilotPolicy(repeat)).toEqual({ kind: "escalate", reason: "loop" });
    const choseLast = {
      ...input({ verdict: verdict({ action: "continue" }) }),
      recentActions: [{ template: "T_CHOOSE_SINGLE" as const, responseHash: "old", decisionSetHash: "same", status: "sent" }],
    };
    const currentHash = decisionSetHash(response.decisions);
    expect(evaluateAutopilotPolicy({ ...choseLast, recentActions: [{ ...choseLast.recentActions[0]!, decisionSetHash: currentHash }] }))
      .toEqual({ kind: "escalate", reason: "loop" });
  });

  test("returns an owner-only done outcome", () => {
    expect(evaluateAutopilotPolicy(input({ verdict: verdict({ action: "done" }) }))).toEqual({ kind: "done" });
  });
});
