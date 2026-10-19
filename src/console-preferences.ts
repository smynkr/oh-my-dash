import { randomUUID } from "node:crypto";

export interface ConsoleViewConfig {
  search: string;
  host: string;
  project: string | null;
  account: string | null;
  harness: "" | "claude" | "omp";
  status: "" | "needs_input" | "your_turn" | "working" | "ended" | "unread" | "unknown";
  headless: boolean;
  ended: boolean;
  group: "" | "project" | "host" | "account" | "harness";
  density: "compact" | "comfortable";
  columns: Array<"project" | "host" | "account" | "harness" | "age">;
}

export interface ConsoleView {
  id: string;
  name: string;
  config: ConsoleViewConfig;
}

export interface ConsolePreferences {
  revision: number;
  pins: string[];
  views: ConsoleView[];
}

export interface ConsolePreferencesStore {
  getSetting(key: string): string | undefined;
  setSetting(key: string, value: string): void;
}

export type ConsolePreferencesActionResult =
  | { ok: true; changed: boolean; preferences: ConsolePreferences }
  | { ok: false; status: 400 | 404 | 409; error: string };

const SETTING_KEY = "console.preferences";
const CONFIG_FIELDS = ["search", "host", "project", "account", "harness", "status", "headless", "ended", "group", "density", "columns"] as const;
const STATUSES = ["", "needs_input", "your_turn", "working", "ended", "unread", "unknown"] as const;
const COLUMNS = ["project", "host", "account", "harness", "age"] as const;
const GROUPS = ["", "project", "host", "account", "harness"] as const;
const HARNESS = ["", "claude", "omp"] as const;
const DENSITIES = ["compact", "comfortable"] as const;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const hasOnlyKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).every(key => keys.includes(key));
const failure = (error: string, status: 400 | 404 | 409 = 400): ConsolePreferencesActionResult => ({ ok: false, status, error });

function parseName(value: unknown): string | undefined {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f-\u009f]/.test(value)) return undefined;
  const name = value.trim();
  if (!name || name.length > 80) return undefined;
  return name;
}

function parseConfig(value: unknown): ConsoleViewConfig | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, CONFIG_FIELDS) || CONFIG_FIELDS.some(field => !Object.hasOwn(value, field))) return undefined;
  if (typeof value.search !== "string" || value.search.length > 1024 ||
    typeof value.host !== "string" || value.host.length > 1024 ||
    !(value.project === null || (typeof value.project === "string" && value.project.length <= 1024)) ||
    !(value.account === null || (typeof value.account === "string" && value.account.length <= 1024)) ||
    !(HARNESS as readonly unknown[]).includes(value.harness) ||
    !(STATUSES as readonly unknown[]).includes(value.status) ||
    typeof value.headless !== "boolean" || typeof value.ended !== "boolean" ||
    !(GROUPS as readonly unknown[]).includes(value.group) ||
    !(DENSITIES as readonly unknown[]).includes(value.density) ||
    !Array.isArray(value.columns) || value.columns.some(column => !(COLUMNS as readonly unknown[]).includes(column)) ||
    new Set(value.columns).size !== value.columns.length || (value.status === "ended" && value.ended !== true)) return undefined;
  return {
    search: value.search,
    host: value.host,
    project: value.project as string | null,
    account: value.account as string | null,
    harness: value.harness as ConsoleViewConfig["harness"],
    status: value.status as ConsoleViewConfig["status"],
    headless: value.headless,
    ended: value.ended,
    group: value.group as ConsoleViewConfig["group"],
    density: value.density as ConsoleViewConfig["density"],
    columns: [...value.columns] as ConsoleViewConfig["columns"],
  };
}

function parseStoredPreferences(serialized: string | undefined): ConsolePreferences {
  if (serialized === undefined) return { revision: 0, pins: [], views: [] };
  let stored: unknown;
  try { stored = JSON.parse(serialized); }
  catch { throw new Error("Saved console preferences are not valid JSON"); }
  if (!isRecord(stored) || !hasOnlyKeys(stored, ["revision", "pins", "views"]) ||
    !Object.hasOwn(stored, "revision") || !Object.hasOwn(stored, "pins") || !Object.hasOwn(stored, "views") ||
    !Number.isSafeInteger(stored.revision) || Number(stored.revision) < 0 ||
    !Array.isArray(stored.pins) || stored.pins.length > 1000 ||
    stored.pins.some(key => typeof key !== "string" || key.length === 0 || key.length > 2048) || new Set(stored.pins).size !== stored.pins.length ||
    !Array.isArray(stored.views) || stored.views.length > 100) {
    throw new Error("Saved console preferences have an invalid shape");
  }
  const views: ConsoleView[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const item of stored.views) {
    if (!isRecord(item) || !hasOnlyKeys(item, ["id", "name", "config"]) ||
      !Object.hasOwn(item, "id") || !Object.hasOwn(item, "name") || !Object.hasOwn(item, "config") ||
      typeof item.id !== "string" || !item.id || ids.has(item.id)) {
      throw new Error("Saved console preferences contain an invalid view");
    }
    const name = parseName(item.name), config = parseConfig(item.config);
    if (name === undefined || name !== item.name || names.has(name) || !config) {
      throw new Error("Saved console preferences contain an invalid view");
    }
    ids.add(item.id);
    names.add(name);
    views.push({ id: item.id, name, config });
  }
  return { revision: Number(stored.revision), pins: [...stored.pins] as string[], views };
}

function parseAction(value: unknown):
  | { action: "pin"; key: string; pinned: boolean }
  | { action: "create"; name: string; config: ConsoleViewConfig }
  | { action: "update"; id: string; name?: string; config?: ConsoleViewConfig }
  | { action: "delete"; id: string }
  | { error: string } {
  if (!isRecord(value) || typeof value.action !== "string") return { error: "body must contain a valid action" };
  if (value.action === "pin") {
    if (!hasOnlyKeys(value, ["action", "key", "pinned"]) || !Object.hasOwn(value, "key") || !Object.hasOwn(value, "pinned") ||
      typeof value.key !== "string" || value.key.length === 0 || value.key.length > 2048 || typeof value.pinned !== "boolean") {
      return { error: "pin action requires a session key up to 2048 characters and a boolean pinned value" };
    }
    return { action: "pin", key: value.key, pinned: value.pinned };
  }
  if (value.action === "create") {
    const name = Object.hasOwn(value, "name") ? parseName(value.name) : undefined;
    const config = Object.hasOwn(value, "config") ? parseConfig(value.config) : undefined;
    if (!hasOnlyKeys(value, ["action", "name", "config"])) return { error: "create action does not allow unknown fields" };
    if (name === undefined) return { error: "view name must be nonempty, trimmed, at most 80 characters, and contain no control characters" };
    if (!config) return { error: "config must contain every supported field with valid values, no extra fields, and ended=true when status is ended" };
    return { action: "create", name, config };
  }
  if (value.action === "update") {
    if (!hasOnlyKeys(value, ["action", "id", "name", "config"]) || !Object.hasOwn(value, "id") ||
      typeof value.id !== "string" || !value.id || (!Object.hasOwn(value, "name") && !Object.hasOwn(value, "config"))) {
      return { error: "update action requires an id, at least one of name or config, and no unknown fields" };
    }
    const name = Object.hasOwn(value, "name") ? parseName(value.name) : undefined;
    if (Object.hasOwn(value, "name") && name === undefined) {
      return { error: "view name must be nonempty, trimmed, at most 80 characters, and contain no control characters" };
    }
    const config = Object.hasOwn(value, "config") ? parseConfig(value.config) : undefined;
    if (Object.hasOwn(value, "config") && !config) {
      return { error: "config must contain every supported field with valid values, no extra fields, and ended=true when status is ended" };
    }
    return { action: "update", id: value.id, ...(name === undefined ? {} : { name }), ...(config === undefined ? {} : { config }) };
  }
  if (value.action === "delete") {
    if (!hasOnlyKeys(value, ["action", "id"]) || !Object.hasOwn(value, "id") || typeof value.id !== "string" || !value.id) {
      return { error: "delete action requires an id" };
    }
    return { action: "delete", id: value.id };
  }
  return { error: "unsupported console preferences action" };
}

export function getConsolePreferences(store: ConsolePreferencesStore): ConsolePreferences {
  return parseStoredPreferences(store.getSetting(SETTING_KEY));
}

export function applyConsolePreferencesAction(
  store: ConsolePreferencesStore,
  hasSession: (key: string) => boolean,
  input: unknown,
): ConsolePreferencesActionResult {
  const action = parseAction(input);
  if ("error" in action) return failure(action.error);

  // Settings access is synchronous: this read/modify/store sequence has no await,
  // so concurrent requests cannot overwrite changes from a stale client snapshot.
  const preferences = parseStoredPreferences(store.getSetting(SETTING_KEY));
  let changed = false;
  if (action.action === "pin") {
    const index = preferences.pins.indexOf(action.key);
    if (action.pinned) {
      if (!hasSession(action.key)) return failure("session not found", 404);
      if (index < 0) {
        if (preferences.pins.length >= 1000) return failure("at most 1000 sessions can be pinned");
        preferences.pins.push(action.key);
        changed = true;
      }
    } else if (index >= 0) {
      preferences.pins.splice(index, 1);
      changed = true;
    }
  } else if (action.action === "create") {
    if (preferences.views.some(view => view.name === action.name)) return failure("a view with that name already exists", 409);
    if (preferences.views.length >= 100) return failure("at most 100 views can be saved");
    let id = randomUUID();
    while (preferences.views.some(view => view.id === id)) id = randomUUID();
    preferences.views.push({ id, name: action.name, config: action.config });
    changed = true;
  } else if (action.action === "update") {
    const view = preferences.views.find(candidate => candidate.id === action.id);
    if (!view) return failure("view not found", 404);
    const name = action.name ?? view.name;
    if (preferences.views.some(candidate => candidate.id !== view.id && candidate.name === name)) {
      return failure("a view with that name already exists", 409);
    }
    if (action.name !== undefined && action.name !== view.name) { view.name = action.name; changed = true; }
    if (action.config !== undefined && JSON.stringify(action.config) !== JSON.stringify(view.config)) {
      view.config = action.config;
      changed = true;
    }
  } else {
    const index = preferences.views.findIndex(view => view.id === action.id);
    if (index < 0) return failure("view not found", 404);
    preferences.views.splice(index, 1);
    changed = true;
  }

  if (changed) {
    if (preferences.revision >= Number.MAX_SAFE_INTEGER) return failure("console preferences revision limit reached", 409);
    preferences.revision++;
    store.setSetting(SETTING_KEY, JSON.stringify(preferences));
  }
  return { ok: true, changed, preferences };
}
