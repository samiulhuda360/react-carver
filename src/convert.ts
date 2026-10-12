// The whole conversion: HTML in, React files and a report out.
import { BOOLEAN_ATTRS, convertAttrs, parseStyle } from "./attrs.ts";
import { suggestNames, type AiOptions, type NamingItem } from "./ai.ts";
import { carve, renameData, type Carved } from "./carve.ts";
import { emitFiles } from "./emit.ts";
import { attr, canonicalize, describe, parsePage, textOf, toHtml, type ElementNode, type HNode, type ParsedPage } from "./ir.ts";
import { NameScope, isWeakItemName, isWeakSectionName } from "./names.ts";
import { nameSlots, type Slot } from "./repeat.ts";

export interface Issue {
  kind: "script" | "noscript" | "template" | "event-handler" | "invalid-attribute" | "javascript-url" | "important-style";
  element: string;
  detail: string;
}

export interface ComponentInfo {
  name: string;
  kind: "app" | "section" | "repeated";
  file: string;
  element: string;
  lines: number;
}

export interface RepeatInfo {
  component: string;
  data: string;
  items: number;
  props: string[];
  inside: string;
}

export interface ConversionReport {
  source: string;
  title: string;
  components: ComponentInfo[];
  repeated: RepeatInfo[];
  conversions: Record<string, number>;
  issues: Issue[];
  assets: { stylesheets: string[]; scripts: string[]; local: string[] };
  naming: { source: "rules" | "cache" | "model"; note: string; renamed: number };
}

export interface Conversion {
  files: Record<string, string>;
  report: ConversionReport;
  page: ParsedPage;
  carved: Carved;
}

export interface ConvertOptions {
  source?: string;
  /** Options for the AI naming step; omit to use only the rule-based names. */
  ai?: AiOptions | null;
  /** Which component names the AI may change (props are always open to it). */
  aiNames?: AiNameMode;
}

function short(s: string, n = 80): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

/** Collects everything a person has to look at: scripts, inline handlers, attributes React cannot take. */
export function scanIssues(body: ElementNode): Issue[] {
  const issues: Issue[] = [];
  const visit = (el: ElementNode): void => {
    if (el.ns === "html" && (el.tag === "script" || el.tag === "noscript" || el.tag === "template")) {
      const src = attr(el, "src");
      issues.push({
        kind: el.tag as Issue["kind"],
        element: describe(el),
        detail: src ? `src=${src}` : short(textOf(el) || toHtml(el)),
      });
      return;
    }
    for (const i of convertAttrs(el).issues) {
      const kind = i.kind === "invalid-name" ? "invalid-attribute" : i.kind;
      issues.push({ kind, element: describe(el), detail: `${i.attr}="${short(i.value, 60)}"` });
    }
    for (const c of el.children) if (c.kind === "element") visit(c);
  };
  for (const c of body.children) if (c.kind === "element") visit(c);
  return issues;
}

/** Counts how many of each HTML-to-React change the page needed. */
export function countConversions(body: ElementNode): Record<string, number> {
  const counts: Record<string, number> = {};
  const add = (k: string): void => {
    counts[k] = (counts[k] ?? 0) + 1;
  };
  const visit = (n: HNode): void => {
    if (n.kind !== "element") return;
    if (["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"].includes(n.tag)) {
      add("empty tag self-closed (<img />)");
    }
    for (const [name, value] of n.attrs) {
      const lower = name.toLowerCase();
      if (lower === "class") add("class → className");
      else if (lower === "for") add("for → htmlFor");
      else if (lower === "style" && parseStyle(value).length) add("style string → style object");
      else if (n.ns === "html" && BOOLEAN_ATTRS.has(lower)) add("boolean attribute");
      else if (n.ns === "svg" && name.includes("-")) add("SVG attribute camelCased");
    }
    for (const p of convertAttrs({ ...n, attrs: n.attrs.filter(([a]) => !["class", "for", "style"].includes(a.toLowerCase())) }).props) {
      if (p.name !== p.source && !p.source.includes("-") && n.ns === "html" && !BOOLEAN_ATTRS.has(p.source.toLowerCase())) {
        add(`${p.source} → ${p.name}`);
      }
    }
    if (n.tag === "textarea" || n.tag === "select") add(`${n.tag} value → defaultValue`);
    n.children.forEach(visit);
  };
  body.children.forEach(visit);
  return counts;
}

function localAssets(page: ParsedPage): string[] {
  const out = new Set<string>();
  const isLocal = (u: string): boolean => Boolean(u) && !/^(?:[a-z]+:|\/\/|#|data:)/i.test(u);
  for (const l of page.head.links) {
    const href = l.find(([n]) => n === "href")?.[1] ?? "";
    if (isLocal(href)) out.add(href);
  }
  const visit = (n: HNode): void => {
    if (n.kind !== "element") return;
    for (const [name, value] of n.attrs) {
      if (["src", "poster"].includes(name) && isLocal(value)) out.add(value);
      if (name === "srcset") for (const part of value.split(",")) {
        const u = part.trim().split(/\s+/)[0] ?? "";
        if (isLocal(u)) out.add(u);
      }
      if (name === "href" && n.tag === "link" && isLocal(value)) out.add(value);
    }
    n.children.forEach(visit);
  };
  visit(page.body);
  return [...out].sort();
}

function namingItems(c: Carved): NamingItem[] {
  const label = (ph: { kind: string; ref: number }): string =>
    ph.kind === "use" ? `<${c.sections[ph.ref]!.name} />` : `<${c.buckets[c.groups[ph.ref]!.bucket]!.name} ... />`;
  const items: NamingItem[] = c.sections.map((s, i) => ({
    id: `s${i}`,
    kind: "section",
    current: s.name,
    html: short(toHtml(s.root, label), 600),
    props: [],
  }));
  c.buckets.forEach((b, i) => {
    items.push({
      id: `r${i}`,
      kind: "repeated",
      current: b.name,
      html: short(toHtml(b.sample, label), 600),
      props: b.scope.map((s) => ({ current: s.name, samples: sampleValues(s) })),
    });
  });
  return items;
}

function sampleValues(s: Slot): string[] {
  if (s.list) return [`list of ${s.list.slots.length ? s.list.slots.map((x) => x.name).join("/") : "repeated blocks"}`];
  return [...new Set(s.values)].slice(0, 3).map((v) => short(v, 40));
}

/** Applies the AI suggestions that are valid and do not clash. Returns how many names changed. */
/**
 * `weak` (the default) lets the AI rename only components whose rule-based name is a guess, and all props.
 * `all` lets it rename every component.
 */
export type AiNameMode = "weak" | "all";

export function applyNames(
  c: Carved,
  suggestions: Array<{ id: string; name?: string; props?: Record<string, string> }>,
  mode: AiNameMode = "weak",
): number {
  let renamed = 0;
  const byId = new Map(suggestions.map((s) => [s.id, s]));
  const names = new NameScope(["App"]);
  const pick = (current: string, wanted: string | undefined): string => {
    if (wanted && wanted !== current && !names.has(wanted)) {
      renamed++;
      return names.take(wanted);
    }
    return names.take(current);
  };
  c.sections.forEach((s, i) => {
    const allowed = mode === "all" || isWeakSectionName(s.root, s.name);
    s.name = pick(s.name, allowed ? byId.get(`s${i}`)?.name : undefined);
  });
  c.buckets.forEach((b, i) => {
    const sug = byId.get(`r${i}`);
    const allowed = mode === "all" || isWeakItemName(b.sample, b.name);
    b.name = pick(b.name, allowed ? sug?.name : undefined);
    if (sug?.props) {
      for (const slot of b.scope) {
        const wanted = sug.props[slot.name] ?? slot.name;
        if (wanted !== slot.name) renamed++;
        slot.hint = wanted;
        slot.name = "";
      }
      nameSlots(b.scope);
    }
  });
  renameData(c);
  return renamed;
}

/** Converts one HTML document into React files and a report. */
export async function convertHtml(html: string, opts: ConvertOptions = {}): Promise<Conversion> {
  const page = parsePage(html);
  const carved = carve(page.body);
  let naming: ConversionReport["naming"] = { source: "rules", note: "rule-based names", renamed: 0 };
  if (opts.ai) {
    const result = await suggestNames(namingItems(carved), opts.ai);
    if (result.source !== "none") {
      naming = { source: result.source, note: result.note, renamed: applyNames(carved, result.suggestions, opts.aiNames) };
    } else naming = { source: "rules", note: `rule-based names (${result.note})`, renamed: 0 };
  }
  const files = emitFiles(carved, page.head, page.bodyAttrs);
  const lines = (f: string): number => files[f]?.split("\n").length ?? 0;
  const components: ComponentInfo[] = [
    { name: "App", kind: "app", file: "src/App.tsx", element: "body", lines: lines("src/App.tsx") },
    ...carved.sections.map((s): ComponentInfo => {
      const file = `src/components/${s.name}.tsx`;
      return { name: s.name, kind: "section", file, element: describe(s.root), lines: lines(file) };
    }),
    ...carved.buckets.map((b): ComponentInfo => {
      const file = `src/components/${b.name}.tsx`;
      return { name: b.name, kind: "repeated", file, element: describe(b.sample), lines: lines(file) };
    }),
  ];
  const repeated: RepeatInfo[] = carved.groups.map((g) => {
    const b = carved.buckets[g.bucket]!;
    return {
      component: b.name,
      data: g.dataName,
      items: g.rowCount,
      props: b.scope.map((s) => s.name),
      inside: g.owner >= 0 ? carved.sections[g.owner]!.name : "App",
    };
  });
  const issues = scanIssues(page.body);
  const handlers = issues.filter((i) => i.kind === "event-handler").length;
  const report: ConversionReport = {
    source: opts.source ?? "input.html",
    title: page.head.title,
    components,
    repeated,
    conversions: countConversions(canonicalize(page.body)),
    issues,
    assets: {
      stylesheets: page.head.links.filter((l) => l.some(([n, v]) => n === "rel" && /stylesheet/i.test(v))).map((l) => l.find(([n]) => n === "href")?.[1] ?? ""),
      scripts: page.head.scripts.map((s) => s.src || "inline script"),
      local: localAssets(page),
    },
    naming,
  };
  if (handlers) report.conversions["inline event handler removed"] = handlers;
  return { files, report, page, carved };
}
