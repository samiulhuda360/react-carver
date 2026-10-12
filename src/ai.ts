// Optional AI step: asks a language model for better component and prop names.
// It talks to any OpenAI-compatible chat endpoint (Gemini by default), caches every answer on disk,
// spaces calls at least 2.5 s apart, and returns nothing (so the rule-based names stay) when there is
// no key, the call fails, or the answer is not usable.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { isComponentName, isPropName } from "./names.ts";

export const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";
export const DEFAULT_MODEL = "gemini-flash-lite-latest";
const MIN_GAP_MS = 2500;

export interface NamingItem {
  id: string;
  kind: "section" | "repeated";
  current: string;
  html: string;
  props: Array<{ current: string; samples: string[] }>;
}

export interface NamingSuggestion {
  id: string;
  name?: string;
  props?: Record<string, string>;
}

export type NamingSource = "none" | "cache" | "model";

export interface NamingResult {
  suggestions: NamingSuggestion[];
  source: NamingSource;
  note: string;
}

export interface AiOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  cacheDir?: string;
  /** Read answers from the cache but never call the model. */
  cacheOnly?: boolean;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

let lastCall = 0;

const SYSTEM = `You review names in React code that was generated from a static HTML page.
The user sends JSON: {"components":[...]}. Each component has an id, a kind ("section" = one part of the page,
"repeated" = one item of a list of similar blocks such as cards or table rows), its current name, a short HTML
sample, and for repeated items its props with sample values.

Keep a name when it already says what the thing is. Change it only when it is generic or misleading,
for example Section2, BlockSection, PageCard, SidebarItem, or props such as text2, cell3, label, item, variant.
Component names are PascalCase, 1-3 English words. Prop names are camelCase. Never use key, ref or children.

Answer with JSON only, exactly in this shape (props maps the current prop name to the new one; include only
the props you change, and use {} when you change none):
{"components":[{"id":"r0","name":"TeamMember","props":{"text2":"role","cell":"sku"}},{"id":"s0","name":"Hero","props":{}}]}`;

function cachePath(dir: string, model: string, prompt: string): string {
  const h = createHash("sha256").update(`${model}\n${SYSTEM}\n${prompt}`).digest("hex").slice(0, 24);
  return join(dir, `${h}.json`);
}

/** Pulls the first JSON object out of a model answer and keeps only valid, known suggestions. */
export function parseSuggestions(text: string, items: NamingItem[]): NamingSuggestion[] {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  let data: unknown;
  try {
    data = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  const list = (data as { components?: unknown }).components;
  if (!Array.isArray(list)) return [];
  const known = new Map(items.map((i) => [i.id, i]));
  const out: NamingSuggestion[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as { id?: unknown; name?: unknown; props?: unknown };
    const item = typeof r.id === "string" ? known.get(r.id) : undefined;
    if (!item) continue;
    const s: NamingSuggestion = { id: item.id };
    if (typeof r.name === "string" && isComponentName(r.name)) s.name = r.name;
    if (r.props && typeof r.props === "object") {
      const props: Record<string, string> = {};
      const currentProps = new Set(item.props.map((p) => p.current));
      for (const [k, v] of Object.entries(r.props as Record<string, unknown>)) {
        if (currentProps.has(k) && typeof v === "string" && isPropName(v)) props[k] = v;
      }
      if (Object.keys(props).length) s.props = props;
    }
    out.push(s);
  }
  return out;
}

/** Asks the model for names. Never throws: failures come back as an empty suggestion list with a note. */
export async function suggestNames(items: NamingItem[], opts: AiOptions = {}): Promise<NamingResult> {
  if (!items.length) return { suggestions: [], source: "none", note: "nothing to name" };
  const model = opts.model ?? DEFAULT_MODEL;
  const prompt = JSON.stringify({ components: items });
  const file = opts.cacheDir ? cachePath(opts.cacheDir, model, prompt) : "";
  if (file && existsSync(file)) {
    try {
      const cached = JSON.parse(readFileSync(file, "utf8")) as { answer: string };
      return { suggestions: parseSuggestions(cached.answer, items), source: "cache", note: `${model} (cached)` };
    } catch {
      // A broken cache file is ignored and replaced below.
    }
  }
  if (!opts.apiKey || opts.cacheOnly) {
    return { suggestions: [], source: "none", note: opts.apiKey ? "cache only, no cached answer" : "no AI_API_KEY set" };
  }
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const doFetch = opts.fetchImpl ?? fetch;
  const url = `${(opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "")}/chat/completions`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const wait = lastCall + MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    try {
      const res = await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
        body: JSON.stringify({
          model,
          temperature: 0,
          messages: [
            { role: "system", content: SYSTEM },
            { role: "user", content: prompt },
          ],
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 429 && attempt === 0) {
        await sleep(10_000);
        continue;
      }
      if (!res.ok) return { suggestions: [], source: "none", note: `model call failed (HTTP ${res.status})` };
      const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const answer = body.choices?.[0]?.message?.content ?? "";
      if (file) {
        mkdirSync(opts.cacheDir!, { recursive: true });
        writeFileSync(file, JSON.stringify({ model, answer }, null, 2));
      }
      return { suggestions: parseSuggestions(answer, items), source: "model", note: model };
    } catch (err) {
      return { suggestions: [], source: "none", note: `model call failed (${(err as Error).name})` };
    }
  }
  return { suggestions: [], source: "none", note: "model rate-limited" };
}
