import { describe, expect, test } from "bun:test";
import { escapeHtml, formatTelegramContent } from "../src/telegram-format.ts";

function visible(html: string): string {
  return html.replace(/<\/?(?:b|i|s|code|pre|a)(?:\s[^>]*)?>/g, "").replace(/&(?:amp|lt|gt|quot|#39);/g, entity => {
    switch (entity) {
      case "&amp;": return "&";
      case "&lt;": return "<";
      case "&gt;": return ">";
      case "&quot;": return '"';
      default: return "'";
    }
  });
}

function expectBalancedSupportedHtml(page: string): void {
  const stack: string[] = [];
  for (const match of page.matchAll(/<(\/?)((?:b|i|s|code|pre|a))(?:\s[^<>]*)?>/g)) {
    const closing = match[1] === "/";
    const name = match[2]!;
    if (closing) expect(stack.pop()).toBe(name);
    else {
      if (name === "code" || name === "pre") expect(stack).toHaveLength(0);
      if (name === "a") expect(stack).not.toContain("a");
      stack.push(name);
    }
  }
  expect(stack).toHaveLength(0);
  expect(page).not.toMatch(/<(?!\/?(?:b|i|s|code|pre|a)\b)[A-Za-z]/);
}

describe("Telegram Markdown formatting", () => {
  test("escapes raw HTML and only creates safe, attribute-escaped HTTP links", () => {
    const pages = formatTelegramContent(
      '<img src=x onerror="alert(1)">\n\n[bad](javascript:alert(1)) [safe](https://example.test/?a=1&b=2)',
    );
    const html = pages.join("");

    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).toContain("[bad](javascript:alert(1))");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).toContain('<a href="https://example.test/?a=1&amp;b=2">safe</a>');
    for (const page of pages) expectBalancedSupportedHtml(page);
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });

  test("keeps headings, list items, and table values legible on mobile", () => {
    const html = formatTelegramContent(
      "## Heading\n\n- first item\n- second item\n\n| Name | City |\n| --- | --- |\n| Ada | Paris |\n| Lin | Taipei |",
    ).join("");
    const text = visible(html);

    expect(html).toContain("<b>Heading</b>");
    expect(text).toContain("• first item\n• second item");
    expect(text).toContain("Name: Ada");
    expect(text).toContain("City: Paris");
    expect(text).toContain("Name: Lin");
    expect(text).toContain("City: Taipei");
    expect(html).not.toMatch(/<(?:table|tr|td|th)\b/i);
  });

  test("balances fenced and inline code across pages without splitting codepoints", () => {
    const fencedBody = Array.from({ length: 18 }, (_, index) => `  block ${index}\n\tvalue 😀`).join("\n");
    const fencedPages = formatTelegramContent(["```text", fencedBody, "```"].join("\n"), 24);
    const inlineBody = `part${"😀x".repeat(36)}end`;
    const inlinePages = formatTelegramContent(`\`${inlineBody}\``, 13);

    expect(fencedPages.length).toBeGreaterThan(1);
    expect(inlinePages.length).toBeGreaterThan(1);
    for (const page of [...fencedPages, ...inlinePages]) expectBalancedSupportedHtml(page);
    expect(fencedPages.every(page => page.includes("<pre>") && page.includes("</pre>"))).toBe(true);
    expect(inlinePages.every(page => page.includes("<code>") && page.includes("</code>"))).toBe(true);
    expect(visible(inlinePages.join(""))).toBe(inlineBody);
    expect(visible(fencedPages.join(""))).toContain("  block 0\n\tvalue 😀\n  block 1");
  });

  test("counts escaped text by visible UTF-16 length and preserves complete text", () => {
    const source = `&<>"' 😀 ${"safe & sound 😀 ".repeat(8)}`;
    const pages = formatTelegramContent(source, 11);

    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) {
      expectBalancedSupportedHtml(page);
      expect(visible(page).length).toBeLessThanOrEqual(11);
    }
    expect(visible(pages.join(""))).toBe(source);
    expect(formatTelegramContent("")).toEqual([""]);
    expect(() => formatTelegramContent("😀x", 1)).toThrow(RangeError);
  });

  test("reflows long prose at sentence boundaries without rewriting it", () => {
    const first = `First ${"alpha ".repeat(90)}ends here.`;
    const second = `Second ${"beta ".repeat(90)}ends here.`;
    const rendered = visible(formatTelegramContent(`${first} ${second}`).join(""));

    expect(rendered).toContain("here.\n\nSecond");
    expect(rendered.replace(/\n/g, " ")).toContain(first);
    expect(rendered.replace(/\n/g, " ")).toContain(second);
  });

  test("preserves a full captured code block without overflowing argument limits", () => {
    const source = `${"  code & data\n".repeat(8_000)}FINAL`;
    const pages = formatTelegramContent(`\`\`\`text\n${source}\n\`\`\``);
    expect(visible(pages.join(""))).toBe(source);
    for (const page of pages) {
      expectBalancedSupportedHtml(page);
      expect(visible(page).length).toBeLessThanOrEqual(3000);
    }
  });

  test("separates successive paragraphs inside a loose list item", () => {
    const text = visible(formatTelegramContent("- First paragraph.\n\n  Second paragraph.\n\n- Next item.").join(""));
    expect(text).toMatch(/First paragraph\.\n+Second paragraph\./);
    expect(text).toContain("• Next item.");
  });

  test("release review: bounds repeated table headers while preserving header and row values", () => {
    const header = `${"Long header ".repeat(160)}HEADER_END`;
    const values = Array.from({ length: 200 }, (_, index) => `Row${index}`);
    const source = `| ${header} |\n| --- |\n${values.map(value => `| ${value} |`).join("\n")}`;
    const text = visible(formatTelegramContent(source).join(""));
    expect(text.length).toBeLessThanOrEqual(source.length * 3);
    expect(text).toContain(header);
    for (const value of values) expect(text).toContain(value);
  });

  test("bounds wide table padding before expanding rows", () => {
    const headers = Array.from({ length: 1_000 }, (_, index) => `H${index}`.padEnd(80, "h"));
    const source = `| ${headers.join(" | ")} |\n| ${headers.map(() => "---").join(" | ")} |\n${"| x |\n".repeat(2_000)}`;
    const text = visible(formatTelegramContent(source).join(""));
    expect(text).toBe(source);
  });

  test("preserves entity text inside inline literal HTML code", () => {
    const source = "Text <code>&amp;</code> end";
    expect(visible(formatTelegramContent(source).join(""))).toBe(source);
  });

  test("keeps table-like fenced code separate from a following link", () => {
    const body = ["| --- |", ...Array.from({ length: 40 }, () => "| x |")].join("\n");
    const html = formatTelegramContent(`\`\`\`text\n${body}\n\`\`\`\n\n[Continue](https://example.test/next)`).join("");
    expect(html).toContain(`<pre>${body}</pre>`);
    expect(html).toContain('href="https://example.test/next"');
    expect(visible(html)).not.toContain("```");
  });

  test("release review: keeps the destination of a code-labelled link", () => {
    const html = formatTelegramContent("[`src/file.ts`](https://example.test/src/file.ts)").join("");
    expect(html).toContain('href="https://example.test/src/file.ts"');
    expect(visible(html)).toBe("src/file.ts");
    expectBalancedSupportedHtml(html);
  });

  test("release review: decodes prose and URL entities without decoding literal code or HTML blocks", () => {
    const html = formatTelegramContent("Tom &amp; Jerry &copy;\n\n[open](https://example.test/?a=1&amp;b=2)\n\n`&amp;`\n\n<div>&amp;</div>").join("");
    expect(visible(html)).toContain("Tom & Jerry ©");
    expect(html).toContain('href="https://example.test/?a=1&amp;b=2"');
    expect(html).toContain("<code>&amp;amp;</code>");
    expect(html).toContain("&lt;div&gt;&amp;amp;&lt;/div&gt;");
    const unsafe = formatTelegramContent("[bad](jav&#x61;script:alert(1))").join("");
    expect(unsafe).not.toContain("<a ");
  });
});
