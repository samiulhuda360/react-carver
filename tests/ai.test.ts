import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseSuggestions, suggestNames, type NamingItem } from "../src/ai.ts";
import { applyNames, convertHtml } from "../src/convert.ts";

const items: NamingItem[] = [
  { id: "s0", kind: "section", current: "BlockSection", html: "<div>...</div>", props: [] },
  { id: "r0", kind: "repeated", current: "StockRow", html: "<tr>...</tr>", props: [{ current: "cell", samples: ["HX-1"] }] },
];

const answer = (content: string): Response =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200, headers: { "content-type": "application/json" } });

describe("parseSuggestions", () => {
  it("keeps valid names for known ids only", () => {
    const text = 'Sure! ```json {"components":[{"id":"s0","name":"Summary"},{"id":"r0","name":"bad name","props":{"cell":"sku","nope":"x"}},{"id":"zz","name":"Ghost"}]} ```';
    expect(parseSuggestions(text, items)).toEqual([
      { id: "s0", name: "Summary" },
      { id: "r0", props: { cell: "sku" } },
    ]);
  });

  it("rejects reserved and invalid names", () => {
    const text = '{"components":[{"id":"s0","name":"Map"},{"id":"r0","props":{"cell":"key"}}]}';
    expect(parseSuggestions(text, items)).toEqual([{ id: "s0" }, { id: "r0" }]);
    expect(parseSuggestions("not json", items)).toEqual([]);
  });
});

describe("suggestNames", () => {
  it("does nothing without a key", async () => {
    const fetchImpl = vi.fn();
    const r = await suggestNames(items, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r.source).toBe("none");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("calls the model once, caches the answer and reuses it without a key", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "rc-ai-"));
    const fetchImpl = vi.fn(async () => answer('{"components":[{"id":"r0","name":"StockItem","props":{"cell":"sku"}}]}'));
    const first = await suggestNames(items, { apiKey: "test-key-not-real", cacheDir, fetchImpl, sleep: async () => {} });
    expect(first.source).toBe("model");
    expect(first.suggestions).toEqual([{ id: "r0", name: "StockItem", props: { cell: "sku" } }]);
    const call = (fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>)[0]!;
    expect(call[0]).toBe("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
    expect(JSON.parse(call[1].body as string).model).toBe("gemini-flash-lite-latest");

    const files = readdirSync(cacheDir);
    expect(files).toHaveLength(1);
    expect(readFileSync(join(cacheDir, files[0]!), "utf8")).not.toContain("test-key-not-real");

    const second = await suggestNames(items, { cacheDir, fetchImpl });
    expect(second.source).toBe("cache");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("waits at least 2.5 s between calls", async () => {
    const waits: number[] = [];
    const fetchImpl = vi.fn(async () => answer('{"components":[]}'));
    const opts = { apiKey: "test-key-not-real", fetchImpl, sleep: async (ms: number) => void waits.push(ms) };
    await suggestNames(items, opts);
    await suggestNames([items[0]!], opts);
    expect(waits.some((w) => w > 2000 && w <= 2500)).toBe(true);
  });

  it("falls back quietly when the call fails", async () => {
    const fetchImpl = vi.fn(async () => new Response("no", { status: 500 }));
    const r = await suggestNames(items, { apiKey: "test-key-not-real", fetchImpl, sleep: async () => {} });
    expect(r).toMatchObject({ source: "none", suggestions: [] });
    expect(r.note).toContain("HTTP 500");
  });
});

describe("applyNames", () => {
  const html = `<!doctype html><html><head></head><body><section class="section"><h2>Opening times</h2>
    <table><tr><td>Mon</td><td>9</td></tr><tr><td>Tue</td><td>10</td></tr><tr><td>Wed</td><td>11</td></tr></table></section>
    <section id="about"><h2>About</h2><p>Some words about us here.</p><p>More words.</p></section></body></html>`;

  it("renames weak component names and props, but keeps names taken from ids and classes", async () => {
    const c = await convertHtml(html);
    expect(c.carved.sections.map((s) => s.name)).toEqual(["OpeningTimesSection", "About"]);
    const renamed = applyNames(c.carved, [
      { id: "s0", name: "OpeningHours" },
      { id: "s1", name: "AboutUs" },
      { id: "r0", name: "DayRow", props: { cell: "day", cell2: "opens" } },
    ]);
    expect(c.carved.sections.map((s) => s.name)).toEqual(["OpeningHours", "About"]);
    expect(c.carved.buckets[0]!.name).toBe("DayRow");
    expect(c.carved.buckets[0]!.scope.map((s) => s.name)).toEqual(["day", "opens"]);
    expect(c.carved.groups[0]!.dataName).toBe("dayRows");
    expect(renamed).toBe(4);
  });

  it("lets the AI rename every component in 'all' mode", async () => {
    const c = await convertHtml(html);
    applyNames(c.carved, [{ id: "s1", name: "AboutUs" }], "all");
    expect(c.carved.sections[1]!.name).toBe("AboutUs");
  });
});
