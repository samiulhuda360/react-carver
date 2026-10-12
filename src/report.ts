// Turns a conversion report (and its verification) into Markdown and terminal text.
import type { ConversionReport } from "./convert.ts";
import type { VerifyResult } from "./verify.ts";

const ISSUE_HELP: Record<string, string> = {
  script: "Script removed. Rebuild its behaviour with React state and effects.",
  noscript: "`<noscript>` removed. React pages need JavaScript anyway.",
  template: "`<template>` removed. Render the content from a component instead.",
  "event-handler": "Inline handler removed. Re-create it as an `onClick`-style prop with a function.",
  "invalid-attribute": "Attribute name is not valid in JSX (often from a framework like Alpine or Vue). Removed.",
  "javascript-url": "`javascript:` URL removed. React blocks these; use an event handler.",
  "important-style": "`!important` does not work in React style objects. Move this rule to the stylesheet.",
};

function check(v: boolean | null): string {
  return v === null ? "skipped" : v ? "yes" : "no";
}

export function toMarkdown(r: ConversionReport, v?: VerifyResult): string {
  const out: string[] = [`# Conversion report: ${r.title || r.source}`, "", `Source: \`${r.source}\``, ""];
  if (v) {
    out.push(
      "## Verification",
      "",
      "| Check | Result |",
      "| --- | --- |",
      `| Compiles (esbuild) | ${check(v.compiled)} |`,
      `| Type-checks (TypeScript strict) | ${check(v.typechecked)} |`,
      `| Renders with no React warnings | ${check(v.rendered && v.warnings.length === 0)} |`,
      `| Same text as the original | ${check(v.textMatch)} |`,
      `| Same element tree as the original | ${check(v.domMatch)} |`,
      `| **Overall** | **${v.pass ? "pass" : "fail"}** |`,
      "",
    );
    if (v.firstDiff && !v.domMatch) out.push(`First difference: \`${v.firstDiff}\``, "");
    for (const e of [...v.errors, ...v.warnings].slice(0, 10)) out.push(`- ${e}`);
    if (v.errors.length || v.warnings.length) out.push("");
  }
  out.push("## Components", "", "| Component | Kind | Made from | File | Lines |", "| --- | --- | --- | --- | --- |");
  for (const c of r.components) out.push(`| ${c.name} | ${c.kind} | \`${c.element}\` | \`${c.file}\` | ${c.lines} |`);
  out.push("");
  if (r.repeated.length) {
    out.push("## Repeated blocks", "", "| Component | Data array | Items | Props | Used in |", "| --- | --- | --- | --- | --- |");
    for (const g of r.repeated) out.push(`| ${g.component} | \`${g.data}\` | ${g.items} | ${g.props.join(", ")} | ${g.inside} |`);
    out.push("");
  }
  out.push("## Attribute changes", "", "| Change | Count |", "| --- | --- |");
  for (const [k, n] of Object.entries(r.conversions).sort((a, b) => b[1] - a[1])) out.push(`| ${k} | ${n} |`);
  out.push("", "## Needs a person", "");
  if (!r.issues.length) out.push("Nothing. The page had no scripts, inline handlers or unsupported attributes.");
  else {
    out.push("| What | Where | Detail | What to do |", "| --- | --- | --- | --- |");
    for (const i of r.issues) out.push(`| ${i.kind} | \`${i.element}\` | \`${i.detail.replace(/\|/g, "\\|")}\` | ${ISSUE_HELP[i.kind]} |`);
  }
  out.push("", "## Assets", "");
  out.push(`- Stylesheets linked in \`index.html\`: ${r.assets.stylesheets.length ? r.assets.stylesheets.map((s) => `\`${s}\``).join(", ") : "none"}`);
  out.push(`- Local files the page uses: ${r.assets.local.length ? r.assets.local.map((s) => `\`${s}\``).join(", ") : "none"}`);
  out.push("", `Naming: ${r.naming.note}${r.naming.renamed ? `, ${r.naming.renamed} names improved by AI` : ""}.`, "");
  return out.join("\n");
}

export function toTerminal(r: ConversionReport, v: VerifyResult | undefined, outDir: string): string {
  const sections = r.components.filter((c) => c.kind === "section");
  const items = r.components.filter((c) => c.kind === "repeated");
  const lines = [
    `react-carver: ${r.source}${r.title ? ` ("${r.title}")` : ""}`,
    "",
    `  sections   ${sections.map((c) => c.name).join(", ") || "none"}`,
    `  repeated   ${r.repeated.map((g) => `${g.component} x${g.items}`).join(", ") || "none"}`,
    `  props      ${items.map((c) => `${c.name}(${r.repeated.find((g) => g.component === c.name)?.props.join(", ") ?? ""})`).join("  ") || "none"}`,
    `  changes    ${Object.entries(r.conversions).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, n]) => `${k} x${n}`).join(", ")}`,
    `  attention  ${r.issues.length ? `${r.issues.length} item(s), see report.md` : "none"}`,
    `  naming     ${r.naming.note}${r.naming.renamed ? ` (${r.naming.renamed} renamed)` : ""}`,
  ];
  if (v) {
    const mark = (b: boolean | null): string => (b === null ? "-" : b ? "ok" : "FAIL");
    lines.push(
      "",
      `  verify     compile ${mark(v.compiled)} | types ${mark(v.typechecked)} | render ${mark(v.rendered && !v.warnings.length)} | text ${mark(v.textMatch)} | DOM ${mark(v.domMatch)}  =>  ${v.pass ? "PASS" : "FAIL"} (${v.ms} ms)`,
    );
    if (!v.pass && v.firstDiff) lines.push(`  first diff ${v.firstDiff}`);
  }
  lines.push("", `  wrote ${outDir}`);
  return lines.join("\n");
}
