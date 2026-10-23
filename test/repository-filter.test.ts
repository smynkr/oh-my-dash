import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The dashboard's pure repository-filter helpers, taken verbatim from app.js (same slice approach as server-replies.test.ts).
const helpers = (() => {
  const script = readFileSync(join(import.meta.dir, "../public/app.js"), "utf8");
  const at = (marker: string) => { const i = script.indexOf(marker); if (i < 0) throw new Error(`app.js marker missing: ${marker}`); return i; };
  const byId = script.slice(at("  const byId"), at("  const esc"));
  const block = script.slice(at("  // repository-filter helpers ("), at("  // repository-filter helpers end"));
  return new Function(`${byId}${block}; return { projectFilterIdentity, repositoryFilterMatches, repositoryFilterChoices, repositorySearchFilter };`)() as {
    projectFilterIdentity(s: unknown): string;
    repositoryFilterMatches(s: unknown, selected: string): boolean;
    repositoryFilterChoices(rows: unknown[], selected: string): [string, string][];
    repositorySearchFilter(selected: string): Record<string, string> | null;
  };
})();

const a = { host: "mac", cwd: "/work/dash", project: "dash" };
const b = { host: "win", cwd: "C:/work/dash", project: "dash" };
const c = { host: "mac", cwd: "/other/dash/", project: "dash" };
const noCwd = { host: "mac", project: "invest" };

test("same project label on different host or folder yields distinct options with disambiguated labels", () => {
  const choices = helpers.repositoryFilterChoices([a, b, c, { ...a }], "");
  expect(choices.length).toBe(3);
  expect(new Set(choices.map(([v]) => v)).size).toBe(3);
  expect(new Set(choices.map(([, l]) => l)).size).toBe(3);
  expect(choices.map(([, l]) => l)).toContain("dash — /work/dash");
  expect(choices.map(([, l]) => l)).toContain("dash — /other/dash");
  expect(helpers.repositoryFilterMatches(a, helpers.projectFilterIdentity(a))).toBe(true);
  expect(helpers.repositoryFilterMatches(b, helpers.projectFilterIdentity(a))).toBe(false);
  expect(helpers.repositoryFilterMatches(c, helpers.projectFilterIdentity(a))).toBe(false);
});

test("a session without cwd falls back to its project label", () => {
  const choices = helpers.repositoryFilterChoices([noCwd, a], "");
  expect(choices).toContainEqual([JSON.stringify(["mac", "project", "invest"]), "invest"]);
  expect(choices).toContainEqual([helpers.projectFilterIdentity(a), "dash"]);
});

test("a legacy plain project-name value still filters every repository with that label", () => {
  const legacy = JSON.stringify("dash");
  expect([a, b, c, noCwd].filter(s => helpers.repositoryFilterMatches(s, legacy))).toEqual([a, b, c]);
  const choices = helpers.repositoryFilterChoices([a, noCwd], legacy);
  expect(choices.at(-1)).toEqual([legacy, "dash (all folders)"]);
  expect(helpers.repositoryFilterMatches(a, "")).toBe(true);
});


test("output search keeps repository identity for folders without a live matching session", () => {
  const selectedFolder = helpers.projectFilterIdentity(a);
  expect(helpers.repositorySearchFilter(selectedFolder)).toEqual({ repositoryHost: "mac", cwd: "/work/dash" });

  const noLongerLive = JSON.stringify(["offline-host", "cwd", "/work/archived"]);
  expect(helpers.repositorySearchFilter(noLongerLive)).toEqual({ repositoryHost: "offline-host", cwd: "/work/archived" });
  expect(helpers.repositorySearchFilter(helpers.projectFilterIdentity(noCwd))).toEqual({
    repositoryHost: "mac", project: "invest",
  });
  expect(helpers.repositorySearchFilter(helpers.projectFilterIdentity({ host: "mac" }))).toEqual({
    repositoryHost: "mac", cwd: "",
  });
});
test("choices are deterministic so unchanged options are not rebuilt on live updates", () => {
  const first = JSON.stringify(helpers.repositoryFilterChoices([a, b, noCwd], ""));
  // Reordered rows and a repeated session do not change the option signature the select compares.
  expect(JSON.stringify(helpers.repositoryFilterChoices([noCwd, b, a, { ...b }], ""))).toBe(first);
  const stale = JSON.stringify(["gone", "cwd", "/x"]);
  expect(helpers.repositoryFilterChoices([a], stale).at(-1)).toEqual([stale, "Saved repository filter (not currently available)"]);
});
