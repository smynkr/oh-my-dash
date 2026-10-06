export type DecisionOption = { key: string; label: string };
export type Decision = { title: string; options: DecisionOption[]; recIndex: number | null; recQuote: string | null };
export type DecisionSet = { decisions: Decision[]; source: "parser" | "luna" };
export type Recommendation = { quote: string; start: number; end: number; kind: "labeled" | "sentence" | "tag" };

// R1 binding markers: exactly these six. extractRecommendation (display only) uses a superset.
export const REC_MARKERS = /\((?:strong rec|recommended)\)|(?<![A-Za-z0-9_])(?:my pick|my rec|my recommendation|I['’]d go with)(?![A-Za-z0-9_])/i;
const SAY_MARKERS = /\((?:strong rec|recommended)\)|(?<![A-Za-z0-9_])(?:my pick|my rec|my recommendation|I['’]d go with|I recommend|I['’]d recommend)(?![A-Za-z0-9_])/gi;
const TAG = /\((?:strong rec|recommended|my pick|my rec|my recommendation|I['’]d go with)\)/i;
const MARKER_TAG = /[ \t]*\((?:strong rec|recommended|my pick|my rec|my recommendation|I['’]d go with)\)[ \t]*$/i;
const LABELED = /^[ \t]*(?:[-*+][ \t]+)?(?:#{1,6}[ \t]+)?(?:\*\*|__)?(?:my[ \t]+)?recommendation(?:\*\*|__)?[ \t]*:(?:\*\*|__)?[ \t]*/i;
const NEGATION = /(?<![A-Za-z0-9])(?:not|don['’]t|never|against)(?![A-Za-z0-9])/i;
const DECISION_WORD = /\b(?:decid\w*|decision\w*|choose|choice\w*|option\w*|pick|prefer\w*)\b/i;
const QUESTION_END = /\?(?=[\s*_)\]"'’”]|$)/;
const OPTION = /^[ \t]*(?:[-*+][ \t]+)?(?:\*\*)?(?:\(([A-Za-z])\)|([A-Za-z])(?:[ \t]*\(([^()\n]{1,40})\))?[ \t]*[.):·])(?:\*\*)?[ \t]+(\S.*)$/d;
const NUMBERED = /^[ \t]*(?:\*\*)?(\d{1,2})[.)](?:\*\*)?[ \t]+(\S.*)$/d;
const BOLD_HEAD = /^[ \t]*(?:#{1,6}[ \t]+)?\*\*([^*\n]{1,120}?):\*\*[ \t]*(.*)$/d;
const BOLD_TITLE = /\*\*([^*\n]{1,120}?):\*\*[ \t]*(.*)$/d;
const INDENTED_LETTER = /^[ \t]+(?:[-*+][ \t]+)?(?:\(([A-Za-z])\)|[A-Za-z][.)])[ \t]+\S/;
const MAX_CP = 20_000, MAX_DECISIONS = 8, MAX_OPTIONS = 8, QUOTE_CP = 400;
export const TITLE_CP = 120, LABEL_CP = 160;

type Span = [number, number];
type Opt = { key: string; label: string; evidence: Span | null };
type Draft = { title: Span | null; regions: Span[]; options: Opt[]; rest: Span | null; heading: boolean; numbered: boolean; indent: number; apart: boolean };
type Row = { start: number; end: number; text: string; blank: boolean };
type Obj = Record<string, unknown>;

const empty = (source: DecisionSet["source"] = "parser"): DecisionSet => ({ decisions: [], source });
const isObj = (value: unknown): value is Obj => !!value && typeof value === "object" && !Array.isArray(value);
const head = (text: string, max: number): string => {
  if (text.length <= max) return text;
  let i = 0;
  for (let n = 0; n < max && i < text.length; n++) i += text.codePointAt(i)! > 0xffff ? 2 : 1;
  return text.slice(0, i);
};
const clean = (text: string) => text.replace(/\*\*|__/g, "").replace(/\s+/g, " ").trim();
const norm = (text: string) => text.replace(/[*_`]/g, "").replace(/\s+/g, " ").trim();
const indent = (text: string) => /^[ \t]*/.exec(text)![0].length;
// A marker endorses unless negated in the same text; an exact parenthesized tag always endorses.
const endorses = (text: string) => TAG.test(text) || (REC_MARKERS.test(text) && !NEGATION.test(text));

// Blank fenced code and blockquote lines in place so every offset still indexes the original.
function stripNonLive(text: string, fill = " "): string {
  let fence: string | null = null;
  return text.split("\n").map(line => {
    const mark = line.match(/^[ \t]*(`{3,}|~{3,})/)?.[1];
    let hide = fence !== null || /^[ \t]*>/.test(line);
    if (fence !== null) { if (mark && mark[0] === fence[0] && mark.length >= fence.length) fence = null; }
    else if (mark) { fence = mark; hide = true; }
    return hide ? fill.repeat(line.length) : line;
  }).join("\n");
}

function rows(live: string): Row[] {
  const out: Row[] = [];
  let start = 0;
  for (const text of live.split("\n")) {
    out.push({ start, end: start + text.length, text, blank: !text.trim() });
    start += text.length + 1;
  }
  return out;
}

function trimSpan(src: string, start: number, end: number): Span {
  while (start < end && /\s/.test(src[start]!)) start++;
  while (end > start && /\s/.test(src[end - 1]!)) end--;
  return [start, end];
}

function sentences(src: string, start: number, end: number): Span[] {
  const out: Span[] = [];
  const re = /[.!?]+(?=\s|$)/g;
  re.lastIndex = start;
  let from = start;
  for (let m: RegExpExecArray | null; (m = re.exec(src)) && m.index < end;) {
    const to = Math.min(end, m.index + m[0].length);
    out.push(trimSpan(src, from, to));
    from = to;
  }
  out.push(trimSpan(src, from, end));
  return out.filter(([s, e]) => e > s);
}

function finalParagraph(lines: Row[]): number {
  let i = lines.length - 1;
  while (i >= 0 && lines[i]!.blank) i--;
  while (i > 0 && !lines[i - 1]!.blank) i--;
  return i >= 0 ? lines[i]!.start : 0;
}

function keyToken(text: string, key: string): boolean {
  if (/^\d+$/.test(key)) return new RegExp(`(?<![0-9A-Za-z.])${key}(?![0-9]|\\.[0-9])`).test(text);
  const lower = key.toLowerCase();
  return new RegExp(`(?<![A-Za-z0-9'’])${key}(?![A-Za-z0-9'’])`).test(text) ||
    new RegExp(`(?<![A-Za-z0-9])\\(${lower}\\)|(?<![A-Za-z0-9(])${lower}\\)|\\boption\\s+${lower}\\b`, "i").test(text);
}
const labelNamed = (text: string, option: DecisionOption) =>
  norm(option.label).length >= 3 && norm(text).toLowerCase().includes(norm(option.label).toLowerCase());
const names = (text: string, option: DecisionOption) => keyToken(text, option.key) || labelNamed(text, option);

function canonKey(key: string): string | null {
  const m = /^\(?([A-Za-z]|\d{1,2})[.):]?\)?$/.exec(key.trim());
  if (!m) return null;
  return /\d/.test(m[1]!) ? String(Number(m[1])) : m[1]!.toUpperCase();
}

function heading(lines: Row[], i: number): { title: Span; rest: Span | null; numbered: boolean; whole: Span } | null {
  const { text, start } = lines[i]!;
  const at = (m: RegExpExecArray, g: number): Span => [start + m.indices![g]![0], start + m.indices![g]![1]];
  const bold = BOLD_HEAD.exec(text);
  if (bold) return { title: at(bold, 1), rest: bold[2]!.trim() ? at(bold, 2) : null, numbered: false, whole: [start, start + text.length] };
  const num = NUMBERED.exec(text);
  if (!num) return null;
  const body = at(num, 2), inner = BOLD_TITLE.exec(num[2]!);
  if (inner) {
    const shift = body[0] - start;
    const span = (g: number): Span => [start + shift + inner.indices![g]![0], start + shift + inner.indices![g]![1]];
    return { title: span(1), rest: inner[2]!.trim() ? span(2) : null, numbered: true, whole: body };
  }
  let next = i + 1;
  while (next < lines.length && lines[next]!.blank) next++;
  if (/[:?](?:\*\*|__)?[ \t]*$/.test(num[2]!) || (next < lines.length && INDENTED_LETTER.test(lines[next]!.text)))
    return { title: body, rest: null, numbered: true, whole: body };
  return null;
}

function option(row: Row): Opt | null {
  const m = OPTION.exec(row.text) ?? NUMBERED.exec(row.text);
  if (!m) return null;
  const numbered = m.length === 3;
  const key = numbered ? String(Number(m[1])) : (m[1] ?? m[2])!.toUpperCase();
  const line = trimSpan(row.text, 0, row.text.length).map(n => n + row.start) as Span;
  return { key, label: clean((numbered ? m[2]! : m[4]!).replace(MARKER_TAG, "")), evidence: endorses(row.text) ? line : null };
}

// The remainder up to its first top-level sentence end; later sentences are never alternatives.
function firstSentence(src: string, [start, end]: Span): Span {
  let depth = 0;
  for (let i = start; i < end; i++) {
    const c = src[i]!;
    if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (!depth && /[.!?]/.test(c) && (i + 1 >= end || /\s/.test(src[i + 1]!))) return [start, i + 1];
  }
  return [start, end];
}

// Top-level `,`/`;` split (never inside parentheses), else exactly one top-level ` or `.
function alternatives(src: string, [start, end]: Span): Opt[] {
  const cuts: Span[] = [];
  let depth = 0, from = start;
  for (let i = start; i < end; i++) {
    const c = src[i];
    if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (!depth && (c === "," || c === ";")) { cuts.push([from, i]); from = i + 1; }
  }
  cuts.push([from, end]);
  if (cuts.length === 1) {
    const ors: number[] = [];
    depth = 0;
    for (let i = start; i < end; i++) {
      const c = src[i];
      if (c === "(") depth++;
      else if (c === ")") depth = Math.max(0, depth - 1);
      else if (!depth && /^ or /i.test(src.slice(i, i + 4))) ors.push(i);
    }
    if (ors.length !== 1) return [];
    cuts.splice(0, 1, [start, ors[0]!], [ors[0]! + 4, end]);
  } else {
    const last = cuts[cuts.length - 1]!, lead = /^\s*or\s+/i.exec(src.slice(last[0], last[1]));
    if (lead) last[0] += lead[0].length;
  }
  const out: Opt[] = [];
  for (const cut of cuts) {
    let [s, e] = trimSpan(src, cut[0], cut[1]);
    while (e > s && /[.!?]/.test(src[e - 1]!)) e--;
    if (e <= s) return [];
    const text = src.slice(s, e), label = clean(text.replace(MARKER_TAG, ""));
    if (!label) return [];
    out.push({ key: String.fromCharCode(65 + out.length), label, evidence: endorses(text) ? [s, e] : null });
  }
  return out.length >= 2 ? out : [];
}

function titleOf(src: string, [start, end]: Span, implicit: boolean): string {
  let span: Span = [start, end];
  if (implicit) span = sentences(src, start, end).filter(([s, e]) => QUESTION_END.test(src.slice(s, e).replace(/(?:\*\*|__)+$/, "") + " ")).pop() ?? span;
  return clean(src.slice(...span).replace(/^\s*(?:#{1,6}\s+|[-*+]\s+)/, "")).replace(/:$/, "").trim();
}

function finish(src: string, original: string, draft: Draft): Decision | null {
  if (!draft.title) return null;
  const title = titleOf(src, draft.title, !draft.heading);
  let options = draft.options;
  const regions = [draft.title, ...draft.regions, ...(draft.rest ? [draft.rest] : [])];
  const asks = (r: Span) => QUESTION_END.test(src.slice(...r) + " ");
  if (!options.length && draft.rest) {
    // Prose alternatives need the title or their own sentence to ask/mark, or a later marker naming exactly one.
    const lead = firstSentence(src, draft.rest), alts = alternatives(src, lead);
    const pointed = regions.some(r => sentences(src, ...r).some(s => {
      const text = src.slice(...s);
      return endorses(text) && alts.filter(o => names(text, o)).length === 1;
    }));
    if (asks(draft.title) || asks(lead) || REC_MARKERS.test(src.slice(...lead)) || pointed) options = alts;
  }
  if (options.length < 2 || !title) return null;
  // R1: a numbered list or prose is a decision only with a question, marker or decision word within its own paragraph
  // (a flat title across a blank line does not count). A lettered list may take its question from the nearest preceding
  // prose even across a blank line; only a decision heading's lettered options are choice-shaped by themselves.
  const letters = draft.options.length > 0 && options.every(o => /[A-Z]/.test(o.key)), lettered = draft.heading && letters;
  const own = draft.apart && !letters ? regions.filter(r => r !== draft.title) : regions;
  const asked = own.some(asks);
  const marked = own.some(r => REC_MARKERS.test(src.slice(...r))) || options.some(o => o.evidence);
  if (!lettered && !marked && !asked && !own.some(r => DECISION_WORD.test(src.slice(...r)))) return null;
  const evidence = new Map<number, Span>();
  options.forEach((o, i) => { if (o.evidence) evidence.set(i, o.evidence); });
  for (const region of regions) for (const sentence of sentences(src, ...region)) {
    const text = src.slice(...sentence);
    if (!endorses(text)) continue;
    const named = options.flatMap((o, i) => names(text, o) ? [i] : []);
    if (named.length === 1 && !evidence.has(named[0]!)) evidence.set(named[0]!, sentence);
  }
  const only = evidence.size === 1 ? [...evidence][0]! : null;
  const quote = only ? original.slice(only[1][0], only[1][0] + head(original.slice(...only[1]), QUOTE_CP).length) : null;
  return { title, options: options.map(o => ({ key: o.key, label: o.label })), recIndex: only ? only[0] : null, recQuote: quote };
}

function parse(original: string): Decision[] {
  const src = stripNonLive(original), lines = rows(src), drafts: Draft[] = [];
  // trail: the line just after an option list, held as evidence for that list until it proves to open the next one.
  let cur: Draft | null = null, lastProse: Span | null = null, gap = false, trail: [Draft, Span] | null = null;
  const close = () => { if (cur) drafts.push(cur); cur = null; lastProse = null; };
  for (let i = 0; i < lines.length; i++) {
    const row = lines[i]!;
    if (row.blank) { gap = true; continue; }
    const found = OPTION.test(row.text) ? null : heading(lines, i);
    if (found) {
      close();
      trail = null;
      cur = { title: found.title, regions: found.rest ? [] : [found.whole], options: [], rest: found.rest, heading: true, numbered: found.numbered, indent: indent(row.text), apart: false };
    } else {
      const opt = cur?.numbered && NUMBERED.test(row.text) && !OPTION.test(row.text) && indent(row.text) <= cur.indent ? null : option(row);
      const span = trimSpan(src, row.start, row.end);
      if (opt) {
        if (!cur && trail) trail[0].regions.splice(trail[0].regions.indexOf(trail[1]), 1);
        if (!cur) trail = null;
        cur ??= { title: lastProse, regions: [], options: [], rest: null, heading: false, numbered: false, indent: 0, apart: gap };
        cur.options.push(opt);
      } else if (cur && cur.options.length && /^[ \t]{2,}/.test(row.text) && !gap) cur.regions.push(span);
      else if (cur && (cur.options.length || gap)) {
        trail = cur.options.length ? [cur, span] : null;
        if (trail) cur.regions.push(span);
        close();
        lastProse = span;
      } else if (cur) cur.regions.push(span);
      else {
        if (gap) trail = null;
        lastProse = span;
      }
    }
    gap = false;
  }
  close();
  return drafts.map(d => finish(src, original, d)).filter((d): d is Decision => !!d);
}

// The key printed immediately before a label: `A — x`, `A) x`, `(a) x`, `A · x`, `A: x`, `A. x`, `Option A - x`, `1. x`.
const KEY_BEFORE = /(?:^|[\s(\[])(?:option\s+)?(?:\(([A-Za-z]|\d{1,2})\)|([A-Za-z]|\d{1,2})(?:[.):]|\s*[·—–]|\s+-))\s*$/i;
// Luna keys are model output: a key counts only where the response prints it beside that label on one line.
function pairing(key: string, label: string, lines: string[]): "traced" | "contradicted" | "untraced" {
  const target = norm(label);
  let other = false;
  for (const line of lines) for (let at = line.indexOf(target); at >= 0 && target; at = line.indexOf(target, at + 1)) {
    const m = KEY_BEFORE.exec(line.slice(0, at)), found = m ? canonKey(m[1] ?? m[2]!) : null;
    if (found === key) return "traced";
    if (found) other = true;
  }
  return other ? "contradicted" : "untraced";
}

type Live = { live: string; lines: string[] | null; exact: string | null };
function validDecision(raw: unknown, original: string, { live, lines, exact }: Live): Decision | null {
  if (!isObj(raw) || typeof raw.title !== "string" || !Array.isArray(raw.options)) return null;
  // Luna text that keeps a `*` or `_` must carry it where the response does (inline-code backticks aside), not just
  // match once emphasis is stripped.
  const traceable = (text: string) => !!norm(text) && live.includes(norm(text)) &&
    (exact === null || !/[*_]/.test(text) || exact.includes(clean(text).replace(/`/g, "")));
  const title = head(clean(raw.title), TITLE_CP).trim();
  if (!title || !traceable(title)) return null;
  const options: DecisionOption[] = [], keep = new Map<number, number>(), keys = new Set<string>(), labels = new Set<string>();
  const untraced = new Set<number>();
  raw.options.slice(0, 64).forEach((o, i) => {
    if (options.length >= MAX_OPTIONS || !isObj(o) || typeof o.key !== "string" || typeof o.label !== "string") return;
    const key = canonKey(o.key), label = head(clean(o.label), LABEL_CP).trim();
    if (!key || !label || keys.has(key) || labels.has(norm(label).toLowerCase()) || !traceable(label)) return;
    // A Luna option whose label the response prints under a different key is dropped.
    const bound = lines ? pairing(key, label, lines) : "traced";
    if (bound === "contradicted") return;
    if (bound === "untraced") untraced.add(options.length);
    keys.add(key);
    labels.add(norm(label).toLowerCase());
    keep.set(i, options.length);
    options.push({ key, label });
  });
  if (options.length < 2) return null;
  const index = typeof raw.recIndex === "number" && Number.isInteger(raw.recIndex) ? keep.get(raw.recIndex) ?? null : null;
  const decision: Decision = { title, options, recIndex: index, recQuote: typeof raw.recQuote === "string" ? raw.recQuote : null };
  // A Luna recommendation stands on an untraced key only when its quote also carries the chosen label's own text.
  const unbound = index !== null && untraced.has(index) && !(typeof decision.recQuote === "string" && labelNamed(decision.recQuote, options[index]!));
  if (unbound || !verifiedRecommendation(decision, original)) { decision.recIndex = null; decision.recQuote = null; }
  return decision;
}

export function validateDecisionSet(raw: unknown, original: string, source: DecisionSet["source"]): DecisionSet {
  try {
    const kind = source === "luna" ? "luna" : "parser";
    if (!isObj(raw) || !Array.isArray(raw.decisions) || typeof original !== "string") return empty(kind);
    const stripped = stripNonLive(head(original, MAX_CP)), decisions: Decision[] = [];
    // Luna text is model output: hidden code and quote lines keep a separator, so no title or label is joined across them.
    const sealed = kind === "luna" ? stripNonLive(head(original, MAX_CP), "\0") : null;
    const live: Live = sealed === null ? { live: norm(stripped), lines: null, exact: null }
      : { live: norm(sealed), lines: stripped.split("\n").map(norm), exact: clean(sealed).replace(/`/g, "") };
    for (const d of raw.decisions.slice(0, 64)) {
      const valid = validDecision(d, original, live);
      if (valid) decisions.push(valid);
      if (decisions.length >= MAX_DECISIONS) break;
    }
    return { decisions, source: kind };
  } catch { return empty(); }
}

export function verifiedRecommendation(decision: Decision, original: string): boolean {
  try {
    const { options, recIndex, recQuote } = decision;
    if (typeof recIndex !== "number" || !Number.isInteger(recIndex) || recIndex < 0 || recIndex >= options.length) return false;
    if (typeof recQuote !== "string" || !recQuote.trim() || head(recQuote, QUOTE_CP).length !== recQuote.length) return false;
    const chosen = options[recIndex];
    if (!isObj(chosen) || typeof chosen.key !== "string" || typeof chosen.label !== "string") return false;
    if (!stripNonLive(head(original, MAX_CP)).includes(recQuote) || !endorses(recQuote) || !names(recQuote, chosen)) return false;
    // The quote must single out the chosen option, unless it is that option's own line.
    const named = options.filter(o => isObj(o) && typeof o.key === "string" && typeof o.label === "string" && names(recQuote, o));
    return named.length === 1 || option({ start: 0, end: recQuote.length, text: recQuote, blank: false })?.key === chosen.key;
  } catch { return false; }
}

export function extractDecisions(text: string): DecisionSet {
  try {
    if (typeof text !== "string" || !text.trim()) return empty();
    const original = head(text, MAX_CP);
    return validateDecisionSet({ decisions: parse(original) }, original, "parser");
  } catch { return empty(); }
}

// A heading followed by two option lines.
function headed(lines: Row[]): boolean {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.blank || OPTION.test(lines[i]!.text) || !heading(lines, i)) continue;
    let seen = 0;
    for (let j = i + 1; j < lines.length && seen < 2; j++) {
      if (lines[j]!.blank) continue;
      if (!option(lines[j]!)) break;
      seen++;
    }
    if (seen === 2) return true;
  }
  return false;
}

export function looksDecisionLike(text: string): boolean {
  try {
    if (typeof text !== "string") return false;
    const live = stripNonLive(head(text, MAX_CP));
    if (REC_MARKERS.test(live)) return true;
    if (QUESTION_END.test(live) && /\b(?:option|choose|pick|recommend\w*|decision|or)\b/i.test(live)) return true;
    if (headed(rows(live))) return true;
    return extractDecisions(text).decisions.length > 0;
  } catch { return false; }
}

// A2: the live final paragraph asks a question, or the response looks like a decision.
export function looksLikeAsk(text: string): boolean {
  try {
    if (typeof text !== "string") return false;
    const live = stripNonLive(head(text, MAX_CP));
    return QUESTION_END.test(live.slice(finalParagraph(rows(live)))) || looksDecisionLike(text);
  } catch { return false; }
}

// A3: display-only. Never feeds recIndex, recQuote, reply text or a judge prompt.
export function extractRecommendation(text: string): Recommendation | null {
  try {
    if (typeof text !== "string" || !text.trim()) return null;
    const original = head(text, MAX_CP), live = stripNonLive(original), lines = rows(live);
    const found: Array<{ at: number; span: Span; kind: Recommendation["kind"] }> = [], labels: Span[] = [];
    lines.forEach((row, i) => {
      const m = LABELED.exec(row.text);
      if (!m) return;
      let last = i;
      while (last + 1 < lines.length && !lines[last + 1]!.blank) last++;
      labels.push([row.start, row.start + m[0].length]);
      const span = trimSpan(live, row.start + m[0].length, lines[last]!.end), first = sentences(live, ...span)[0];
      // A3 rejects negation in the same sentence for every kind, so "Recommendation: I do not recommend X" is no rec.
      if (first && NEGATION.test(live.slice(...first))) return;
      found.push({ at: row.start, span, kind: "labeled" });
    });
    // Matches arrive in order, so walk rows and sentences forward and test each sentence for negation once.
    let row = 0, split = -1, parts: Span[] = [], part = 0, negated = new Map<number, boolean>();
    for (const m of live.matchAll(SAY_MARKERS)) {
      if (labels.some(([s, e]) => m.index >= s && m.index < e)) continue;
      while (lines[row]!.end <= m.index) row++;
      const { start, end } = lines[row]!;
      if (split !== row) { split = row; parts = sentences(live, start, end); part = 0; negated = new Map(); }
      while (part < parts.length && parts[part]![1] <= m.index) part++;
      const sentence = parts[part];
      if (!sentence || m.index < sentence[0]) continue;
      if (!negated.has(part)) negated.set(part, NEGATION.test(live.slice(...sentence)));
      if (negated.get(part)) continue;
      found.push(m[0].startsWith("(") ? { at: m.index, span: trimSpan(live, start, end), kind: "tag" } : { at: m.index, span: sentence, kind: "sentence" });
    }
    const usable = found.filter(f => f.span[1] > f.span[0]).sort((a, b) => a.at - b.at);
    const tail = finalParagraph(lines), labeled = usable.filter(f => f.kind === "labeled" && f.at >= tail);
    const best = (labeled.length ? labeled : usable).pop();
    if (!best) return null;
    const [start] = best.span, end = start + head(original.slice(...best.span), QUOTE_CP).length;
    return { quote: original.slice(start, end), start, end, kind: best.kind };
  } catch { return null; }
}
