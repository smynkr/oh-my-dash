import { Lexer, Marked, type Token as MarkedToken } from "marked";
import { decodeHTMLStrict } from "entities/decode";

type TagName = "b" | "i" | "s" | "code" | "pre" | "a";
type Tag = { name: TagName; href?: string };
type Tags = readonly Tag[];
type Atom = { char: string; tags: Tags };
type ListToken = Extract<MarkedToken, { type: "list" }>;
type ListItemToken = Extract<MarkedToken, { type: "list_item" }>;
type TableToken = Extract<MarkedToken, { type: "table" }>;

const DEFAULT_LIMIT = 3000;
const htmlEntities: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

const markdown = new Marked({ extensions: [{
  name: "boundedTable",
  level: "block",
  tokenizer(source) {
    const rules = Lexer.rules.block.gfm;
    const match = rules.table.exec(source);
    if (!match) return;
    // Block extensions run first; preserve the built-in precedence above tables.
    if (rules.code.test(source) || rules.fences.test(source) || rules.heading.test(source) ||
      rules.hr.test(source) || rules.blockquote.test(source) || rules.list.test(source) ||
      rules.html.test(source) || rules.def.test(source)) return;
    // Bound both Marked's padded cell allocation and our repeated labels before lexing.
    const delimiter = match[2]!.trim(), body = match[3] ?? "";
    let columns = 1, rows = body ? 1 : 0;
    for (const char of delimiter) if (char === "|") columns++;
    if (delimiter.startsWith("|")) columns--;
    if (delimiter.endsWith("|")) columns--;
    for (const char of body) if (char === "\n") rows++;
    if (body.endsWith("\n")) rows--;
    const labelLength = `Column ${columns}: `.length + 3;
    const expandedLength = match[0].length + rows * (match[1]!.length + columns * labelLength);
    if (expandedLength <= match[0].length * 3) return;
    return { type: "code", raw: match[0], text: match[0] };
  },
}] });

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, character => htmlEntities[character]!);
}

function addText(target: Atom[], text: string, tags: Tags): void {
  for (const char of text) target.push({ char, tags });
}
function appendAtoms(target: Atom[], source: readonly Atom[], start = 0, end = source.length): void {
  for (let index = start; index < end; index++) target.push(source[index]!);
}

function withTag(tags: Tags, tag: Tag): Tags {
  if (tag.name === "code" || tag.name === "pre") return tags.some(existing => existing.name === "a") ? tags : [tag];
  if (tags.some(existing => existing.name === "code" || existing.name === "pre")) return tags;
  if (tag.name === "a" && tags.some(existing => existing.name === "a")) return tags;
  if (tags.some(existing => existing.name === tag.name)) return tags;
  return [...tags, tag];
}

function sourceOf(token: MarkedToken): string {
  if ("raw" in token && typeof token.raw === "string") return token.raw;
  if ("text" in token && typeof token.text === "string") return token.text;
  return "";
}

function childrenOf(token: MarkedToken): readonly MarkedToken[] | undefined {
  if ("tokens" in token && Array.isArray(token.tokens)) return token.tokens;
  return undefined;
}

function isSafeHttpUrl(href: string): boolean {
  if (/[\u0000-\u001f\u007f]/u.test(href)) return false;
  try {
    const protocol = new URL(href).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function renderInlineToken(token: MarkedToken, tags: Tags, target: Atom[]): void {
  switch (token.type) {
    case "strong":
      renderInlineTokens(token.tokens, withTag(tags, { name: "b" }), target);
      return;
    case "em":
      renderInlineTokens(token.tokens, withTag(tags, { name: "i" }), target);
      return;
    case "del":
      renderInlineTokens(token.tokens, withTag(tags, { name: "s" }), target);
      return;
    case "codespan":
      addText(target, token.text, withTag(tags, { name: "code" }));
      return;
    case "link": {
      const href = decodeHTMLStrict(token.href);
      if (!isSafeHttpUrl(href)) {
        addText(target, sourceOf(token), tags);
        return;
      }
      renderInlineTokens(token.tokens, withTag(tags, { name: "a", href }), target);
      return;
    }
    case "br":
      addText(target, "\n", tags);
      return;
    case "escape":
      addText(target, token.text, tags);
      return;
    case "html":
      addText(target, token.text, tags);
      return;
    case "text": {
      const children = childrenOf(token);
      if (children?.length) renderInlineTokens(children, tags, target);
      else addText(target, "escaped" in token && token.escaped === true ? token.text : decodeHTMLStrict(token.text), tags);
      return;
    }
    default:
      addText(target, sourceOf(token), tags);
  }
}

function renderInlineTokens(tokens: readonly MarkedToken[], tags: Tags, target: Atom[]): void {
  for (const token of tokens) renderInlineToken(token, tags, target);
}



function reflowProse(atoms: Atom[]): Atom[] {
  if (atoms.some(atom => atom.tags.some(tag => tag.name === "code" || tag.name === "pre"))) return atoms;

  const boundaries: { start: number; end: number }[] = [];
  for (let index = 0; index < atoms.length; index++) {
    if (!/[.!?…]/u.test(atoms[index]!.char) || index + 1 >= atoms.length || !/^\s$/u.test(atoms[index + 1]!.char)) continue;
    let end = index + 1;
    while (end < atoms.length && /^\s$/u.test(atoms[end]!.char)) end++;
    boundaries.push({ start: index + 1, end });
    index = end - 1;
  }

  const selected: { start: number; end: number }[] = [];
  let start = 0;
  for (;;) {
    let cursor = start;
    let units = 0;
    let fallback: { boundary: { start: number; end: number }; units: number } | undefined;
    let boundary: { start: number; end: number } | undefined;
    for (const candidate of boundaries) {
      if (candidate.end <= start) continue;
      while (cursor < candidate.end) units += atoms[cursor++]!.char.length;
      if (units >= 500) {
        boundary = fallback && Math.abs(fallback.units - 600) < Math.abs(units - 600) ? fallback.boundary : candidate;
        break;
      }
      if (units >= 350) fallback = { boundary: candidate, units };
    }
    if (!boundary || boundary.end >= atoms.length) break;
    selected.push(boundary);
    start = boundary.end;
  }
  if (!selected.length) return atoms;

  const output: Atom[] = [];
  let cursor = 0;
  for (const boundary of selected) {
    appendAtoms(output, atoms, cursor, boundary.start);
    addText(output, "\n\n", atoms[boundary.start]?.tags ?? []);
    cursor = boundary.end;
  }
  appendAtoms(output, atoms, cursor);
  return output;
}

function inlineContent(token: MarkedToken, tags: Tags, reflow: boolean): Atom[] {
  const output: Atom[] = [];
  const children = childrenOf(token);
  renderInlineTokens(children ?? [token], tags, output);
  return reflow ? reflowProse(output) : output;
}

function ensureNewlines(target: Atom[], count: number): void {
  let trailing = 0;
  for (let index = target.length - 1; index >= 0 && target[index]!.char === "\n"; index--) trailing++;
  while (trailing++ < count) addText(target, "\n", []);
}

function appendBlock(target: Atom[], block: readonly Atom[]): void {
  if (!block.length) return;
  if (target.length) ensureNewlines(target, 2);
  appendAtoms(target, block);
}

function renderListItem(item: ListItemToken, tags: Tags, depth: number, prefix: string): Atom[] {
  const output: Atom[] = [];
  addText(output, `${"  ".repeat(depth)}${prefix}`, tags);
  const children = item.tokens;
  let hasContent = false;
  for (const child of children) {
    if (child.type === "text" || child.type === "paragraph") {
      const content = inlineContent(child, tags, false);
      if (content.length) {
        if (hasContent) addText(output, "\n", []);
        appendAtoms(output, content);
        hasContent = true;
      }
      continue;
    }
    if (child.type === "list") {
      if (hasContent) addText(output, "\n", []);
      appendAtoms(output, renderList(child, tags, depth + 1));
      hasContent = true;
      continue;
    }
    const content = renderBlockToken(child, tags);
    if (!content.length) continue;
    if (hasContent) addText(output, "\n", []);
    appendAtoms(output, content);
    hasContent = true;
  }
  return output;
}

function renderList(token: ListToken, tags: Tags, depth: number): Atom[] {
  const output: Atom[] = [];
  const first = typeof token.start === "number" ? token.start : 1;
  token.items.forEach((item, index) => {
    if (index) addText(output, "\n", []);
    const bullet = token.ordered ? `${first + index}. ` : "• ";
    const checkbox = item.task ? (item.checked ? "☑ " : "☐ ") : "";
    appendAtoms(output, renderListItem(item, tags, depth, `${bullet}${checkbox}`));
  });
  return output;
}

function renderTable(token: TableToken, tags: Tags): Atom[] {
  const headers = token.header.map(cell => {
    const rendered: Atom[] = [];
    renderInlineTokens(cell.tokens, withTag(tags, { name: "b" }), rendered);
    return rendered;
  });
  const rows = token.rows;
  const output: Atom[] = [];
  const repeatHeaders = headers.every(header => header.length <= 80);
  if (!rows.length || !repeatHeaders) {
    headers.forEach((header, index) => {
      if (index) addText(output, " | ", tags);
      if (rows.length) addText(output, `Column ${index + 1}: `, tags);
      appendAtoms(output, header);
    });
    if (!rows.length) return output;
    addText(output, "\n\n", []);
  }
  rows.forEach((row, rowIndex) => {
    if (rowIndex) addText(output, "\n", []);
    row.forEach((cell, cellIndex) => {
      if (cellIndex) addText(output, " | ", tags);
      const header = headers[cellIndex];
      if (repeatHeaders && header?.length) {
        appendAtoms(output, header);
        addText(output, ": ", tags);
      } else {
        addText(output, `Column ${cellIndex + 1}: `, tags);
      }
      renderInlineTokens(cell.tokens, tags, output);
    });
  });
  return output;
}

function renderBlockToken(token: MarkedToken, tags: Tags): Atom[] {
  switch (token.type) {
    case "heading": {
      const output: Atom[] = [];
      renderInlineTokens(token.tokens, withTag(tags, { name: "b" }), output);
      return output;
    }
    case "paragraph":
    case "text":
      return inlineContent(token, tags, true);
    case "code": {
      const output: Atom[] = [];
      addText(output, token.text, [{ name: "pre" }]);
      return output;
    }
    case "blockquote":
      return renderBlocks(token.tokens, tags);
    case "list":
      return renderList(token, tags, 0);
    case "table":
      return renderTable(token, tags);
    case "html": {
      const output: Atom[] = [];
      addText(output, token.text, tags);
      return output;
    }
    case "space":
      return [];
    default: {
      const output: Atom[] = [];
      addText(output, sourceOf(token), tags);
      return output;
    }
  }
}

function renderBlocks(tokens: readonly MarkedToken[], tags: Tags): Atom[] {
  const output: Atom[] = [];
  for (const token of tokens) appendBlock(output, renderBlockToken(token, tags));
  return output;
}


function renderPage(atoms: readonly Atom[]): string {
  let html = "";
  for (let start = 0; start < atoms.length;) {
    let end = start + 1;
    while (end < atoms.length && atoms[start]!.tags.length === atoms[end]!.tags.length &&
      atoms[start]!.tags.every((tag, tagIndex) =>
        tag.name === atoms[end]!.tags[tagIndex]!.name && tag.href === atoms[end]!.tags[tagIndex]!.href)) end++;
    const tags = atoms[start]!.tags;
    for (const tag of tags) {
      html += tag.name === "a" ? `<a href="${escapeHtml(tag.href ?? "")}">` : `<${tag.name}>`;
    }
    for (let index = start; index < end; index++) html += escapeHtml(atoms[index]!.char);
    for (let index = tags.length - 1; index >= 0; index--) html += `</${tags[index]!.name}>`;
    start = end;
  }
  return html;
}

function paginate(atoms: readonly Atom[], limit: number): Atom[][] {
  if (!atoms.length) return [[]];
  const pages: Atom[][] = [];
  let start = 0;
  while (start < atoms.length) {
    let index = start, units = 0;
    let paragraph = 0, newline = 0, whitespace = 0;
    while (index < atoms.length && units + atoms[index]!.char.length <= limit) {
      const char = atoms[index]!.char;
      units += char.length;
      index++;
      if (units < limit / 2) continue;
      if (/^\s$/u.test(char)) whitespace = index;
      if (char === "\n") {
        newline = index;
        if (index > start + 1 && atoms[index - 2]!.char === "\n") paragraph = index;
      }
    }
    const end = index === atoms.length ? index : paragraph || newline || whitespace || index;
    pages.push(atoms.slice(start, end));
    start = end;
  }
  return pages;
}

/** Render Markdown to Telegram-supported HTML, splitting by visible UTF-16 units. */
export function formatTelegramContent(text: string, limit = DEFAULT_LIMIT): string[] {
  if (!Number.isFinite(limit) || limit < 2) throw new RangeError("Telegram page limit must fit a Unicode codepoint");
  const pageLimit = Math.floor(limit);
  const atoms = renderBlocks(markdown.lexer(text), []);
  return paginate(atoms, pageLimit).map(renderPage);
}
