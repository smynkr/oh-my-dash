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
