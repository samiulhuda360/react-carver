// Prints the carved page as TypeScript React files.
import { NUMERIC_ATTRS, convertAttrs, parseStyle, styleKey, type Prop } from "./attrs.ts";
import type { Bucket, Carved, GroupUse } from "./carve.ts";
import type { ElementNode, HNode, HeadInfo } from "./ir.ts";
import { camel } from "./names.ts";
import type { Slot, TNode } from "./repeat.ts";

const RAW = new Set(["pre", "textarea", "style", "listing", "xmp"]);
const WIDTH = 100;

type JProp = { name: string; code: string };
type JNode =
  | { t: "el"; tag: string; props: JProp[]; children: JNode[]; raw: boolean }
  | { t: "text"; value: string; raw: boolean }
  | { t: "expr"; lines: string[] };

interface FileCtx {
  carved: Carved;
  components: Set<string>;
  data: Set<string>;
  cssType: boolean;
  fragment: boolean;
}

const IDENT = /^[A-Za-z_$][\w$]*$/;

function strCode(v: string): string {
  return /["\\&\n\r\t{}]/.test(v) ? `{${JSON.stringify(v)}}` : `"${v}"`;
}

function styleObject(entries: Array<[string, string]>, ctx: FileCtx): string {
  const body = entries.map(([k, v]) => `${IDENT.test(k) ? k : JSON.stringify(k)}: ${JSON.stringify(v)}`).join(", ");
  const custom = entries.some(([k]) => k.startsWith("--"));
  if (custom) ctx.cssType = true;
  return custom ? `{ ${body} } as CSSProperties` : `{ ${body} }`;
}

function propsOf(el: ElementNode, ctx: FileCtx, slotCode?: (attrName: string) => string | undefined): JProp[] {
  const out: JProp[] = [];
  const special = el.attrs.filter(([n]) => n.startsWith("__"));
  const plain: ElementNode = { ...el, attrs: el.attrs.filter(([n]) => !n.startsWith("__")) };
  const { props } = convertAttrs(plain);
  for (const p of props as Prop[]) {
    const fromSlot = slotCode?.(p.source);
    if (fromSlot) {
      out.push({ name: p.name, code: `{${fromSlot}}` });
      continue;
    }
    if (p.value.type === "true") out.push({ name: p.name, code: "" });
    else if (p.value.type === "string") out.push({ name: p.name, code: strCode(p.value.value) });
    else if (p.value.type === "number") out.push({ name: p.name, code: `{${p.value.value}}` });
    else out.push({ name: p.name, code: `{${styleObject(p.value.entries, ctx)}}` });
  }
  for (const [n, v] of special) {
    const fromSlot = slotCode?.(n);
    if (n === "__defaultValue") out.push({ name: "defaultValue", code: fromSlot ? `{${fromSlot}}` : strCode(v) });
    if (n === "__defaultValueList") out.push({ name: "defaultValue", code: `{${v}}` });
  }
  return out;
}

function repeatLines(group: GroupUse, bucket: Bucket, ctx: FileCtx): string[] {
  ctx.components.add(bucket.name);
  ctx.data.add(group.dataName);
  const item = camel(bucket.name) === group.dataName ? "item" : camel(bucket.name);
  const key = group.keyProp ? `${item}.${group.keyProp.name}` : "index";
  if (group.separated) {
    // Inline blocks separated by spaces: keep one space between neighbours, as in the original page.
    ctx.fragment = true;
    return [
      `{${group.dataName}.map((${item}, index) => (`,
      `  <Fragment key={${key}}>`,
      `    {index > 0 && " "}`,
      `    <${bucket.name} {...${item}} />`,
      `  </Fragment>`,
      `))}`,
    ];
  }
  const params = group.keyProp ? `(${item})` : `(${item}, index)`;
  return [`{${group.dataName}.map(${params} => (`, `  <${bucket.name} key={${key}} {...${item}} />`, `))}`];
}

function fromTree(node: HNode, ctx: FileCtx, raw = false): JNode {
  if (node.kind === "text") return { t: "text", value: node.value, raw };
  if (node.kind === "comment") return { t: "expr", lines: [`{/* ${node.value.replace(/\*\//g, "* /").trim()} */}`] };
  if (node.kind === "use") {
    const name = ctx.carved.sections[node.ref]!.name;
    ctx.components.add(name);
    return { t: "el", tag: name, props: [], children: [], raw: false };
  }
  if (node.kind === "repeat") {
    const g = ctx.carved.groups[node.ref]!;
    return { t: "expr", lines: repeatLines(g, ctx.carved.buckets[g.bucket]!, ctx) };
  }
  const isRaw = raw || RAW.has(node.tag);
  return {
    t: "el",
    tag: node.tag,
    props: propsOf(node, ctx),
    children: node.children.map((c) => fromTree(c, ctx, isRaw)),
    raw: isRaw,
  };
}

const INDEX_VARS = ["i", "j", "k", "m", "n"];

function fromTemplate(t: TNode, ctx: FileCtx, expr: (s: Slot) => string, depth: number, raw = false): JNode {
  if (t.k === "text") return { t: "text", value: t.value, raw };
  if (t.k === "slot") {
    const lines = [`{${expr(t.slot)}}`];
    if (t.lead) lines.unshift(`{" "}`);
    if (t.trail) lines.push(`{" "}`);
    return { t: "expr", lines };
  }
  if (t.k === "el") {
    const isRaw = raw || RAW.has(t.el.tag);
    const slotCode = (a: string): string | undefined => {
      const s = t.attrSlots.get(a);
      return s ? expr(s) : undefined;
    };
    return {
      t: "el",
      tag: t.el.tag,
      props: propsOf(t.el, ctx, slotCode),
      children: t.children.map((c) => fromTemplate(c, ctx, expr, depth, isRaw)),
      raw: isRaw,
    };
  }
  const list = t.slot.list!;
  const idx = INDEX_VARS[depth] ?? `i${depth}`;
  const rowVar = list.rowVar;
  const innerExpr = (s: Slot): string => (list.slots.length === 1 ? rowVar : `${rowVar}.${s.name}`);
  const inner = fromTemplate(list.template, ctx, innerExpr, depth + 1, raw);
  if (inner.t === "el") inner.props.unshift({ name: "key", code: `{${idx}}` });
  const body = print(inner, 2);
  const head =
    t.slot.kind === "count"
      ? `{Array.from({ length: ${expr(t.slot)} }, (_, ${idx}) => (`
      : `{${expr(t.slot)}.map((${rowVar}, ${idx}) => (`;
  return { t: "expr", lines: [head, ...body, "))}"] };
}

// ---------------------------------------------------------------------------------------------------------------
// Printing

function wrapWords(text: string, width: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const w of text.split(" ")) {
    if (line && line.length + 1 + w.length > width) {
      out.push(line);
      line = w;
    } else line = line ? `${line} ${w}` : w;
  }
  if (line) out.push(line);
  return out;
}

function textLines(n: { value: string; raw: boolean }, width: number): string[] {
  if (n.raw) return [`{${JSON.stringify(n.value)}}`];
  const out: string[] = [];
  let v = n.value;
  // Only plain spaces are trimmed; non-breaking spaces are content.
  const lead = v.startsWith(" ");
  const trail = v.endsWith(" ") && v.length > 1;
  v = v.replace(/^ +| +$/g, "");
  if (lead) out.push(`{" "}`);
  if (v) {
    if (/[{}<>&\u00a0]/.test(v) || /\s{2,}/.test(v)) out.push(`{${JSON.stringify(v)}}`);
    else out.push(...wrapWords(v, Math.max(40, width)));
  }
  if (trail) out.push(`{" "}`);
  return out;
}

function propText(p: JProp): string {
  if (p.name === "") return p.code;
  return p.code === "" ? p.name : `${p.name}=${p.code}`;
}

export function print(n: JNode, indent: number): string[] {
  const pad = " ".repeat(indent);
  if (n.t === "text") return textLines(n, WIDTH - indent).map((l) => pad + l);
  if (n.t === "expr") return n.lines.map((l) => pad + l);
  const props = n.props.map(propText);
  const oneLineProps = props.length ? " " + props.join(" ") : "";
  const multiProps = pad.length + n.tag.length + oneLineProps.length + 3 > WIDTH;
  const openLines = multiProps
    ? [`${pad}<${n.tag}`, ...props.map((p) => `${pad}  ${p}`)]
    : [`${pad}<${n.tag}${oneLineProps}`];
  const closeOpen = (suffix: string): string[] =>
    multiProps ? [...openLines, `${pad}${suffix}`] : [`${openLines[0]}${suffix === "/>" ? " />" : suffix}`];
  if (!n.children.length) return closeOpen("/>");
  const kids = n.children.flatMap((c) => print(c, indent + 2));
  if (!multiProps && kids.length === 1 && (n.children[0]!.t !== "el")) {
    const line = `${openLines[0]}>${kids[0]!.trim()}</${n.tag}>`;
    if (line.length <= WIDTH) return [line];
  }
  return [...closeOpen(">"), ...kids, `${pad}</${n.tag}>`];
}

// ---------------------------------------------------------------------------------------------------------------
// Files

function newCtx(carved: Carved): FileCtx {
  return { carved, components: new Set(), data: new Set(), cssType: false, fragment: false };
}

function header(ctx: FileCtx, self: string, dataPath: string, compPath: (n: string) => string): string[] {
  const lines: string[] = [];
  if (ctx.fragment && ctx.cssType) lines.push(`import { Fragment, type CSSProperties } from "react";`);
  else if (ctx.fragment) lines.push(`import { Fragment } from "react";`);
  else if (ctx.cssType) lines.push(`import type { CSSProperties } from "react";`);
  for (const c of [...ctx.components].filter((c) => c !== self).sort()) lines.push(`import { ${c} } from "${compPath(c)}";`);
  if (ctx.data.size) lines.push(`import { ${[...ctx.data].sort().join(", ")} } from "${dataPath}";`);
  return lines.length ? [...lines, ""] : [];
}

function jsxBody(nodes: JNode[]): string[] {
  if (nodes.length === 1 && nodes[0]!.t === "el") return ["  return (", ...print(nodes[0]!, 4), "  );"];
  return ["  return (", "    <>", ...nodes.flatMap((n) => print(n, 6)), "    </>", "  );"];
}

function numericSlot(s: Slot): boolean {
  return s.kind === "attr" && NUMERIC_ATTRS.has((s.attrName ?? "").toLowerCase()) && s.values.every((v) => /^-?\d+$/.test(v.trim()));
}

function slotType(s: Slot, ctx: FileCtx): string {
  if (numericSlot(s)) return "number";
  if (s.kind === "text" || s.kind === "attr") return "string";
  if (s.kind === "style") {
    ctx.cssType = true;
    return "CSSProperties";
  }
  if (s.kind === "count") return "number";
  const inner = s.list!.slots;
  if (inner.length === 1) {
    const t = slotType(inner[0]!, ctx);
    return /^\w+$/.test(t) ? `${t}[]` : `Array<${t}>`;
  }
  return `Array<{ ${inner.map((i) => `${i.name}: ${slotType(i, ctx)}`).join("; ")} }>`;
}

function itemFile(b: Bucket, carved: Carved): string {
  const ctx = newCtx(carved);
  const node = fromTemplate(b.template, ctx, (s) => s.name, 0);
  const fields = b.scope.map((s) => `  ${s.name}: ${slotType(s, ctx)};`);
  const names = b.scope.map((s) => s.name);
  const destructure =
    names.join(", ").length > 60 ? [`export function ${b.name}({`, ...names.map((n) => `  ${n},`), `}: ${b.name}Props) {`]
      : [`export function ${b.name}({ ${names.join(", ")} }: ${b.name}Props) {`];
  return [
    ...header(ctx, b.name, "../data", (c) => `./${c}`),
    `export interface ${b.name}Props {`,
    ...fields,
    "}",
    "",
    ...destructure,
    ...jsxBody([node]),
    "}",
    "",
  ].join("\n");
}

function sectionFile(i: number, carved: Carved): string {
  const s = carved.sections[i]!;
  const ctx = newCtx(carved);
  const node = fromTree(s.root, ctx);
  const body = jsxBody([node]);
  return [...header(ctx, s.name, "../data", (c) => `./${c}`), `export function ${s.name}() {`, ...body, "}", ""].join("\n");
}

function appFile(carved: Carved): string {
  const ctx = newCtx(carved);
  const nodes = carved.app.children.map((c) => fromTree(c, ctx));
  const body = nodes.length ? jsxBody(nodes) : ["  return null;"];
  return [...header(ctx, "App", "./data", (c) => `./components/${c}`), "export function App() {", ...body, "}", ""].join("\n");
}

function valueCode(s: Slot, row: number, indent: number, ctx: FileCtx): string {
  if (numericSlot(s)) return String(Number(s.values[row]));
  if (s.kind === "text" || s.kind === "attr") return JSON.stringify(s.values[row]);
  if (s.kind === "style") {
    const entries = parseStyle(s.values[row]!).map(([k, v]): [string, string] => [styleKey(k), v]);
    return styleObject(entries, ctx);
  }
  const list = s.list!;
  const mine = list.owner.flatMap((o, i) => (o === row ? [i] : []));
  if (s.kind === "count") return String(mine.length);
  if (list.slots.length === 1) {
    const items = mine.map((r) => valueCode(list.slots[0]!, r, indent + 2, ctx));
    const flat = `[${items.join(", ")}]`;
    if (flat.length + indent < WIDTH) return flat;
    return `[\n${items.map((v) => `${" ".repeat(indent + 2)}${v},`).join("\n")}\n${" ".repeat(indent)}]`;
  }
  return `[\n${mine.map((r) => `${" ".repeat(indent + 2)}${objectCode(list.slots, r, indent + 2, ctx)},`).join("\n")}\n${" ".repeat(indent)}]`;
}

function objectCode(scope: Slot[], row: number, indent: number, ctx: FileCtx): string {
  const fields = scope.map((s) => `${s.name}: ${valueCode(s, row, indent + 2, ctx)}`);
  const flat = `{ ${fields.join(", ")} }`;
  if (flat.length + indent < WIDTH && !flat.includes("\n")) return flat;
  return `{\n${fields.map((f) => `${" ".repeat(indent + 2)}${f},`).join("\n")}\n${" ".repeat(indent)}}`;
}

function dataFile(carved: Carved): string {
  const ctx = newCtx(carved);
  const blocks: string[] = [];
  const types = new Set<string>();
  for (const g of carved.groups) {
    if (g.sameDataAs >= 0) continue;
    const b = carved.buckets[g.bucket]!;
    types.add(b.name);
    const rows = Array.from({ length: g.rowCount }, (_, i) => `  ${objectCode(b.scope, g.rowStart + i, 2, ctx)},`);
    blocks.push(`export const ${g.dataName}: ${b.name}Props[] = [`, ...rows, "];", "");
  }
  const imports = [...types].sort().map((t) => `import type { ${t}Props } from "./components/${t}";`);
  if (ctx.cssType) imports.unshift(`import type { CSSProperties } from "react";`);
  return [...imports, "", ...blocks].join("\n");
}

const MAIN = `import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
`;

function escAttr(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function tagWith(tag: string, attrs: Array<[string, string]>): string {
  return `<${tag}${attrs.map(([n, v]) => (v === "" ? ` ${n}` : ` ${n}="${escAttr(v)}"`)).join("")}>`;
}

export function indexHtml(head: HeadInfo, bodyAttrs: Array<[string, string]>): string {
  const lines = ["<!doctype html>", `<html lang="${escAttr(head.lang || "en")}">`, "  <head>"];
  for (const m of head.meta) lines.push(`    ${tagWith("meta", m)}`);
  if (head.title) lines.push(`    <title>${head.title.replace(/</g, "&lt;")}</title>`);
  for (const l of head.links) lines.push(`    ${tagWith("link", l)}`);
  for (const s of head.styles) lines.push(`    <style>${s}</style>`);
  for (const s of head.scripts) if (s.src) lines.push(`    <script src="${escAttr(s.src)}"></script>`);
  lines.push("  </head>", `  ${tagWith("body", bodyAttrs.filter(([n]) => !/^on/i.test(n)))}`);
  lines.push(`    <div id="root"></div>`, `    <script type="module" src="/src/main.tsx"></script>`, "  </body>", "</html>", "");
  return lines.join("\n");
}

/** All generated files, keyed by path relative to the output folder. */
export function emitFiles(carved: Carved, head: HeadInfo, bodyAttrs: Array<[string, string]>): Record<string, string> {
  const files: Record<string, string> = {};
  files["index.html"] = indexHtml(head, bodyAttrs);
  files["src/main.tsx"] = MAIN;
  files["src/App.tsx"] = appFile(carved);
  carved.sections.forEach((s, i) => (files[`src/components/${s.name}.tsx`] = sectionFile(i, carved)));
  for (const b of carved.buckets) files[`src/components/${b.name}.tsx`] = itemFile(b, carved);
  if (carved.groups.length) files["src/data.ts"] = dataFile(carved);
  return files;
}
