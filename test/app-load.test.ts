import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Runs the whole dashboard script against a permissive stub DOM, so a helper that is out of scope for its
// caller (the AXI-448 port left the project-filter helpers inside loadSessions) fails here, not in the browser.
// Every stubbed property is another stub; fetch never settles, so only the synchronous init path runs.
function stub(): any {
  const target = function () {};
  return new Proxy(target, {
    get(_t, key) {
      if (key === Symbol.toPrimitive) return () => "";
      if (key === Symbol.iterator) return function* () {};
      if (key === "then") return undefined;
      if (key === "length" || key === "size") return 0;
      return stub();
    },
    set: () => true,
    apply: () => stub(),
    construct: () => stub(),
  });
}

test("app.js initialises without a synchronous error", () => {
  const script = readFileSync(join(import.meta.dir, "../public/app.js"), "utf8");
  const globals = ["document", "window", "localStorage", "sessionStorage", "navigator", "location", "history", "EventSource",
    "Notification", "Option", "marked", "DOMPurify", "matchMedia", "requestAnimationFrame", "setTimeout", "setInterval",
    "clearTimeout", "clearInterval", "addEventListener", "getComputedStyle", "ResizeObserver", "performance", "scrollTo",
    "innerHeight", "confirm", "alert"];
  const never = () => new Promise(() => {});
  const run = new Function(...globals, "fetch", script);
  expect(() => run(...globals.map(() => stub()), never)).not.toThrow();
});

test("readConsoleLocation and setViewUrl preserve timeline view hash without session pollution", () => {
  const script = readFileSync(join(import.meta.dir, "../public/app.js"), "utf8");
  const start = script.indexOf("  function readConsoleLocation()");
  const end = script.indexOf("  function setConsolePaneMode(");
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const urlStart = script.indexOf("  function setSessionUrl(");
  const slice = script.slice(start, script.indexOf("  const initialConsoleLocation")) + "\n" + script.slice(urlStart, end);
  const harness = new Function("location", "history", "state", "consoleState", `
    ${slice}
    return { readConsoleLocation, setSessionUrl, setViewUrl };
  `);
  const loc = { href: "http://127.0.0.1:4777/#session=mac%7Cclaude%7Cs1&response=3", hash: "#session=mac%7Cclaude%7Cs1&response=3" };
  const calls: [string, string][] = [];
  const hist = {
    pushState: (_s: unknown, _t: string, url: URL) => { loc.href = url.toString(); loc.hash = url.hash; calls.push(["push", url.hash]); },
    replaceState: (_s: unknown, _t: string, url: URL) => { loc.href = url.toString(); loc.hash = url.hash; calls.push(["replace", url.hash]); },
  };
  const state = { view: "timeline" };
  const consoleState = { selectedKey: "mac|claude|s1" };
  const api = harness(loc, hist, state, consoleState);

  api.setViewUrl("timeline", true);
  expect(loc.hash).toBe("#view=timeline");
  expect(api.readConsoleLocation()).toEqual({ key: "", response: null, view: "timeline" });

  // Automatic background session selection while in timeline view does not overwrite #view=timeline.
  api.setSessionUrl("mac|claude|s1", false, 3);
  expect(loc.hash).toBe("#view=timeline");

  // Returning to console restores the selected session hash.
  state.view = "console";
  api.setViewUrl("console", true);
  expect(loc.hash).toBe("#session=mac%7Cclaude%7Cs1");
  expect(api.readConsoleLocation()).toEqual({ key: "mac|claude|s1", response: null, view: "console" });
});
