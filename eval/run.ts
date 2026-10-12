// Evaluation over the labelled sample pages.
//
//   npm run eval                      rule-based names, plus AI names when a key or cached answers exist
//   npm run eval -- --min-pass 1      exit 1 if the pass rate is below the given fraction (used in CI)
//
// For every page it measures: compiles, type-checks, renders without warnings, same text, same element tree
// (all five = pass); section recall; repeated-block precision and recall; and naming accuracy against the
// labelled names, with and without the AI step. A naive find-and-replace conversion is measured as a baseline.
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { aiOptionsFromEnv } from "../src/cli.ts";
import { convertHtml, type Conversion } from "../src/convert.ts";
import { attr, parsePage, type ElementNode } from "../src/ir.ts";
import { verify, type VerifyResult } from "../src/verify.ts";
import { naiveConvert } from "./naive.ts";

interface SectionLabel {
  select: string;
  names: string[];
}
interface RepeatLabel {
  parent: string;
  item: string;
  count: number;
  names: string[];
}
interface Labels {
  pages: Record<string, { sections: SectionLabel[]; repeated: RepeatLabel[] }>;
}

const ROOT = resolve(import.meta.dirname, "..");

/** Matches simple selectors such as `section#about`, `.plan`, `li.slot` or `tbody`. */
export function matches(el: ElementNode, selector: string): boolean {
  const m = /^([a-z0-9-]*)((?:[#.][\w-]+)*)$/i.exec(selector.trim());
  if (!m) return false;
  if (m[1] && el.tag !== m[1]) return false;
  const cls = (attr(el, "class") ?? "").split(/\s+/);
  for (const part of m[2]!.match(/[#.][\w-]+/g) ?? []) {
    if (part[0] === "#" && attr(el, "id") !== part.slice(1)) return false;
    if (part[0] === "." && !cls.includes(part.slice(1))) return false;
  }
  return true;
}

interface PageScore {
  page: string;
  verify: VerifyResult;
  naive: VerifyResult;
  sections: { found: number; total: number; namedRules: number; namedAi: number; namedAiAll: number };
  repeated: { detected: number; matched: number; total: number; namedRules: number; namedAi: number; namedAiAll: number };
  components: number;
  aiSource: string;
  props: { total: number; genericRules: number; genericAi: number };
}

/** Prop names that say nothing about the value: text, text2, cell3, label, item, variant, value... */
const GENERIC_PROP = /^(text|cell|label|item|items|value|variant|highlight|heading|entry|entries|data|src)\d*$/;

function genericProps(c: Conversion): { total: number; generic: number } {
  const names = c.carved.buckets.flatMap((b) => b.scope.map((s) => s.name));
  return { total: names.length, generic: names.filter((n) => GENERIC_PROP.test(n)).length };
}

function sectionHits(c: Conversion, labels: SectionLabel[]): Array<{ label: SectionLabel; name: string | null }> {
  return labels.map((label) => {
    const s = c.carved.sections.find((x) => matches(x.root, label.select));
    return { label, name: s ? s.name : null };
  });
}

function repeatHits(c: Conversion, labels: RepeatLabel[]): Array<{ label: RepeatLabel; name: string | null }> {
  return labels.map((label) => {
    const g = c.carved.groups.find((x) => matches(x.parentEl, label.parent) && matches(x.first, label.item) && x.rowCount === label.count);
    return { label, name: g ? c.carved.buckets[g.bucket]!.name : null };
  });
}

function pct(n: number, d: number): string {
  return d ? `${((100 * n) / d).toFixed(1)}%` : "n/a";
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { "min-pass": { type: "string" }, out: { type: "string", default: "eval/results" } } });
  const labels = JSON.parse(readFileSync(join(ROOT, "eval/labels.json"), "utf8")) as Labels;
  const ai = { ...aiOptionsFromEnv(), cacheDir: join(ROOT, "eval/ai-cache") };
  const scores: PageScore[] = [];
  for (const [page, label] of Object.entries(labels.pages)) {
    const html = readFileSync(join(ROOT, "samples", page), "utf8");
    const rules = await convertHtml(html, { source: page });
    const v = await verify(rules.files, rules.page.body);
    const naive = await verify(naiveConvert(html), parsePage(html).body);
    const withAi = await convertHtml(html, { source: page, ai });
    const aiAll = await convertHtml(html, { source: page, ai, aiNames: "all" });
    const sRules = sectionHits(rules, label.sections);
    const sAi = sectionHits(withAi, label.sections);
    const rRules = repeatHits(rules, label.repeated);
    const rAi = repeatHits(withAi, label.repeated);
    const sAll = sectionHits(aiAll, label.sections);
    const rAll = repeatHits(aiAll, label.repeated);
    const matchedGroups = rules.carved.groups.filter((g) =>
      label.repeated.some((l) => matches(g.parentEl, l.parent) && matches(g.first, l.item) && g.rowCount === l.count),
    ).length;
    scores.push({
      page,
      verify: v,
      naive,
      sections: {
        found: sRules.filter((h) => h.name).length,
        total: label.sections.length,
        namedRules: sRules.filter((h) => h.name && h.label.names.includes(h.name)).length,
        namedAi: sAi.filter((h) => h.name && h.label.names.includes(h.name)).length,
        namedAiAll: sAll.filter((h) => h.name && h.label.names.includes(h.name)).length,
      },
      repeated: {
        detected: rules.carved.groups.length,
        matched: matchedGroups,
        total: label.repeated.length,
        namedRules: rRules.filter((h) => h.name && h.label.names.includes(h.name)).length,
        namedAi: rAi.filter((h) => h.name && h.label.names.includes(h.name)).length,
        namedAiAll: rAll.filter((h) => h.name && h.label.names.includes(h.name)).length,
      },
      components: rules.report.components.length,
      aiSource: withAi.report.naming.source,
      props: { total: genericProps(rules).total, genericRules: genericProps(rules).generic, genericAi: genericProps(withAi).generic },
    });
    const mark = (b: boolean | null): string => (b ? "ok" : "--");
    console.log(
      `${page.padEnd(28)} compile ${mark(v.compiled)} types ${mark(v.typechecked)} render ${mark(v.rendered && !v.warnings.length)} ` +
        `text ${mark(v.textMatch)} dom ${mark(v.domMatch)}  ${v.pass ? "PASS" : "FAIL"}   naive ${naive.pass ? "PASS" : "FAIL"}` +
        (v.pass ? "" : `\n    ${v.firstDiff || v.errors[0] || v.warnings[0]}`),
    );
  }

  const sum = (f: (s: PageScore) => number): number => scores.reduce((n, s) => n + f(s), 0);
  const n = scores.length;
  const aiUsed = scores.some((s) => s.aiSource !== "rules");
  const labelledNames = sum((s) => s.sections.total + s.repeated.total);
  const rows: Array<[string, string, string]> = [
    ["Pages that pass all five checks", `${sum((s) => +s.verify.pass)}/${n} (${pct(sum((s) => +s.verify.pass), n)})`, `${sum((s) => +s.naive.pass)}/${n} (${pct(sum((s) => +s.naive.pass), n)})`],
    ["Compiles (esbuild)", `${sum((s) => +s.verify.compiled)}/${n}`, `${sum((s) => +s.naive.compiled)}/${n}`],
    ["Type-checks (TypeScript strict)", `${sum((s) => +(s.verify.typechecked === true))}/${n}`, `${sum((s) => +(s.naive.typechecked === true))}/${n}`],
    ["Renders with no React warnings", `${sum((s) => +(s.verify.rendered && !s.verify.warnings.length))}/${n}`, `${sum((s) => +(s.naive.rendered && !s.naive.warnings.length))}/${n}`],
    ["Same text as the original", `${sum((s) => +s.verify.textMatch)}/${n}`, `${sum((s) => +s.naive.textMatch)}/${n}`],
    ["Same element tree as the original", `${sum((s) => +s.verify.domMatch)}/${n}`, `${sum((s) => +s.naive.domMatch)}/${n}`],
  ];
  const structure: Array<[string, string]> = [
    ["Labelled sections found", `${sum((s) => s.sections.found)}/${sum((s) => s.sections.total)} (${pct(sum((s) => s.sections.found), sum((s) => s.sections.total))})`],
    ["Repeated blocks: recall (labelled runs found)", `${sum((s) => s.repeated.matched)}/${sum((s) => s.repeated.total)} (${pct(sum((s) => s.repeated.matched), sum((s) => s.repeated.total))})`],
    ["Repeated blocks: precision (found runs that were labelled)", `${sum((s) => s.repeated.matched)}/${sum((s) => s.repeated.detected)} (${pct(sum((s) => s.repeated.matched), sum((s) => s.repeated.detected))})`],
    ["Component names a reviewer accepts, rules only", `${sum((s) => s.sections.namedRules + s.repeated.namedRules)}/${labelledNames} (${pct(sum((s) => s.sections.namedRules + s.repeated.namedRules), labelledNames)})`],
    [
      "Component names a reviewer accepts, AI renames every component",
      aiUsed ? `${sum((s) => s.sections.namedAiAll + s.repeated.namedAiAll)}/${labelledNames} (${pct(sum((s) => s.sections.namedAiAll + s.repeated.namedAiAll), labelledNames)})` : "not run (no key, no cached answers)",
    ],
    [
      "Component names a reviewer accepts, AI renames only weak names (default)",
      aiUsed ? `${sum((s) => s.sections.namedAi + s.repeated.namedAi)}/${labelledNames} (${pct(sum((s) => s.sections.namedAi + s.repeated.namedAi), labelledNames)})` : "not run (no key, no cached answers)",
    ],
  ];
  const props = sum((s) => s.props.total);
  structure.push(
    ["Props with a generic name (text2, cell3, label...), rules only", `${sum((s) => s.props.genericRules)}/${props} (${pct(sum((s) => s.props.genericRules), props)})`],
    ["Props with a generic name, rules + AI", aiUsed ? `${sum((s) => s.props.genericAi)}/${props} (${pct(sum((s) => s.props.genericAi), props)})` : "not run"],
  );
  const md = [
    "# Evaluation results",
    "",
    `${n} labelled sample pages in \`samples/\`, labels in \`eval/labels.json\`. Run with \`npm run eval\`.`,
    "",
    "## Output correctness: react-carver vs naive find-and-replace",
    "",
    "| Check | react-carver | Naive find-and-replace |",
    "| --- | --- | --- |",
    ...rows.map((r) => `| ${r.join(" | ")} |`),
    "",
    "## Structure and naming",
    "",
    "| Measure | Result |",
    "| --- | --- |",
    ...structure.map((r) => `| ${r.join(" | ")} |`),
    "",
    "## Per page",
    "",
    "| Page | Pass | Components | Sections found | Repeated runs (matched/labelled/found) | Time |",
    "| --- | --- | --- | --- | --- | --- |",
    ...scores.map(
      (s) =>
        `| ${s.page} | ${s.verify.pass ? "yes" : "no"} | ${s.components} | ${s.sections.found}/${s.sections.total} | ${s.repeated.matched}/${s.repeated.total}/${s.repeated.detected} | ${s.verify.ms} ms |`,
    ),
    "",
  ].join("\n");
  writeFileSync(join(ROOT, `${values.out}.md`), md);
  writeFileSync(
    join(ROOT, `${values.out}.json`),
    JSON.stringify(scores.map((s) => ({ ...s, verify: { ...s.verify, markup: undefined }, naive: { ...s.naive, markup: undefined } })), null, 2),
  );
  console.log(`\n${rows.map((r) => `${r[0].padEnd(40)} ${r[1].padEnd(16)} naive ${r[2]}`).join("\n")}`);
  console.log(structure.map((r) => `${r[0].padEnd(58)} ${r[1]}`).join("\n"));
  const passRate = sum((s) => +s.verify.pass) / n;
  if (values["min-pass"] && passRate < Number(values["min-pass"])) {
    console.error(`pass rate ${passRate.toFixed(3)} is below ${values["min-pass"]}`);
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) await main();
