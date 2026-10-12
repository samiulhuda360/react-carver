// Finds runs of sibling blocks with the same shape (cards, rows, list items) and turns them into one template
// plus data. Values that differ between the blocks become props; nested lists of different lengths become arrays.
import { attr, size, type ElementNode, type HNode } from "./ir.ts";
import { NameScope, attrHint, listHint, plural, safeProp, textHint } from "./names.ts";

export type SlotKind = "text" | "attr" | "style" | "list" | "count";

export interface Slot {
  kind: SlotKind;
  /** Rule-based name suggestion, before uniqueness is applied. */
  hint: string;
  /** Final prop name, unique inside its scope. */
  name: string;
  /** For text, attr and style slots: one value per row. */
  values: string[];
  /** For attr and style slots: the HTML attribute this slot fills. */
  attrName?: string;
  /** For list and count slots: the repeated inner block. */
  list?: ListInfo;
}

export interface ListInfo {
  template: TNode;
  /** Slots of the inner block, one value per inner row. */
  slots: Slot[];
  /** For each inner row, the outer row it belongs to. */
  owner: number[];
  /** Variable name used for one inner row inside `.map(...)`. */
  rowVar: string;
}

export type TNode =
  | { k: "text"; value: string }
  | { k: "slot"; slot: Slot; lead: boolean; trail: boolean }
  | { k: "el"; el: ElementNode; attrSlots: Map<string, Slot>; children: TNode[] }
  | { k: "list"; slot: Slot };

/** Elements that are never treated as a repeated "item": text-level tags, paragraphs and headings. */
const NOT_ITEMS = new Set([
  "p", "h1", "h2", "h3", "h4", "h5", "h6", "span", "strong", "em", "b", "i", "small", "br", "hr", "img", "input",
  "label", "code", "option", "source", "track", "meta", "link", "td", "th", "col", "colgroup", "wbr", "abbr",
  "time", "sup", "sub", "mark", "s", "u", "q", "cite", "path", "circle", "rect", "line", "polyline", "polygon",
  "optgroup",
]);

/** List rows need a run of three to be worth a component; cards and other blocks need two. */
const LIST_ROWS = new Set(["li", "tr", "dt", "dd"]);

export function signature(node: HNode): string {
  if (node.kind === "text") return "#";
  if (node.kind === "comment") return "!";
  if (node.kind !== "element") return `@${node.kind}${node.ref}`;
  const names = node.attrs.map(([n]) => n).sort().join(",");
  return `${node.ns}:${node.tag}[${names}](${collapsed(node.children).join(" ")})`;
}

function collapsed(children: HNode[]): string[] {
  const out: string[] = [];
  for (const c of children) {
    const s = signature(c);
    if (out[out.length - 1] !== s) out.push(s);
  }
  return out;
}

/** Children grouped into runs of consecutive nodes with the same signature. */
function runs(children: HNode[]): HNode[][] {
  const out: HNode[][] = [];
  let last = "";
  for (const c of children) {
    const s = signature(c);
    if (out.length && s === last) out[out.length - 1]!.push(c);
    else out.push([c]);
    last = s;
  }
  return out;
}

function allEqual(values: string[]): boolean {
  return values.every((v) => v === values[0]);
}

/**
 * Builds one template over aligned rows (nodes with the same signature). Slots are appended to `scope`.
 */
export function build(rows: HNode[], scope: Slot[], parent: ElementNode | null): TNode {
  const first = rows[0]!;
  if (first.kind === "text") {
    const values = rows.map((r) => (r.kind === "text" ? r.value : ""));
    if (allEqual(values)) return { k: "text", value: values[0]! };
    // A space every value shares at the start or end belongs to the template, not the data.
    const lead = values.every((v) => v.length > 1 && v.startsWith(" "));
    const trail = values.every((v) => v.length > 1 && v.endsWith(" "));
    const trimmed = values.map((v) => v.slice(lead ? 1 : 0, trail ? -1 : undefined));
    const slot: Slot = { kind: "text", hint: parent ? textHint(parent) : "text", name: "", values: trimmed };
    scope.push(slot);
    return { k: "slot", slot, lead, trail };
  }
  if (first.kind !== "element") throw new Error(`cannot template a ${first.kind} node`);
  const els = rows as ElementNode[];
  const attrSlots = new Map<string, Slot>();
  for (const [name] of first.attrs) {
    const values = els.map((e) => attr(e, name) ?? "");
    if (allEqual(values)) continue;
    const slot: Slot = {
      kind: name === "style" ? "style" : "attr",
      hint: name === "style" ? "style" : attrHint(first, name),
      name: "",
      values,
      attrName: name,
    };
    scope.push(slot);
    attrSlots.set(name, slot);
  }
  const perRow = els.map((e) => runs(e.children));
  const children: TNode[] = [];
  perRow[0]!.forEach((_, j) => {
    const groups = perRow.map((r) => r[j]!);
    const len = groups[0]!.length;
    if (groups.every((g) => g.length === len)) {
      // Same number of blocks in every row: line them up position by position.
      for (let p = 0; p < len; p++) children.push(build(groups.map((g) => g[p]!), scope, first));
      return;
    }
    const inner: HNode[] = [];
    const owner: number[] = [];
    groups.forEach((g, rowIndex) => {
      for (const n of g) {
        inner.push(n);
        owner.push(rowIndex);
      }
    });
    const innerScope: Slot[] = [];
    const template = build(inner, innerScope, first);
    const innerRoot = inner[0]!;
    const base = innerRoot.kind === "element" ? listHint(innerRoot) : "line";
    const slot: Slot = {
      kind: innerScope.length ? "list" : "count",
      hint: innerScope.length ? plural(base) : `${base}Count`,
      name: "",
      values: [],
      list: { template, slots: innerScope, owner, rowVar: base },
    };
    scope.push(slot);
    children.push({ k: "list", slot });
  });
  return { k: "el", el: first, attrSlots, children };
}

/** Gives every slot in a scope (and nested scopes) a unique, valid prop name. */
export function nameSlots(scope: Slot[], taken: Iterable<string> = []): void {
  const names = new NameScope(taken);
  for (const s of scope) {
    s.name = names.take(safeProp(s.name || s.hint));
    if (s.list) {
      const inner = new NameScope([...scopeNames(scope), s.name]);
      s.list.rowVar = inner.take(safeProp(s.list.rowVar));
      nameSlots(s.list.slots);
    }
  }
}

function scopeNames(scope: Slot[]): string[] {
  return scope.map((s) => s.name).filter(Boolean);
}

export type DataValue = string | number | Array<[string, string]> | DataValue[] | { [k: string]: DataValue };

function slotValue(slot: Slot, row: number): DataValue {
  if (slot.kind === "text" || slot.kind === "attr") return slot.values[row]!;
  if (slot.kind === "style") return slot.values[row]!;
  const list = slot.list!;
  const mine = list.owner.flatMap((o, i) => (o === row ? [i] : []));
  if (slot.kind === "count") return mine.length;
  if (list.slots.length === 1) return mine.map((i) => slotValue(list.slots[0]!, i));
  return mine.map((i) => rowData(list.slots, i));
}

/** The data object for one row of a template: prop name to value. */
export function rowData(scope: Slot[], row: number): { [k: string]: DataValue } {
  const out: { [k: string]: DataValue } = {};
  for (const s of scope) out[s.name] = slotValue(s, row);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Detection

export interface Group {
  /** The element whose children hold the run. */
  parent: ElementNode;
  start: number;
  items: ElementNode[];
  /** Number of children the run covers, including single-space separators. */
  span: number;
  /** True when the blocks are inline and separated by one space each, which must be kept. */
  separated: boolean;
}

/** Whether a block can be the item of a repeated run: not text-level, and with more than plain text inside. */
export function qualifies(el: ElementNode): boolean {
  if (el.ns !== "html" || NOT_ITEMS.has(el.tag)) return false;
  return size(el) >= 2 || el.children.some((c) => c.kind === "element");
}

/** The shortest run of same-shaped blocks that is extracted. */
export function minRun(el: ElementNode): number {
  return LIST_ROWS.has(el.tag) ? 3 : 2;
}

const isSpace = (n: HNode | undefined): boolean => n?.kind === "text" && n.value === " ";

/** The run of same-shaped siblings starting at `i`: back to back, or separated by single spaces. */
export function runAt(kids: HNode[], i: number): { items: ElementNode[]; span: number; separated: boolean } {
  const c = kids[i] as ElementNode;
  const sig = signature(c);
  const same = (n: HNode | undefined): boolean => n?.kind === "element" && signature(n) === sig;
  const separated = !same(kids[i + 1]) && isSpace(kids[i + 1]) && same(kids[i + 2]);
  const step = separated ? 2 : 1;
  const items = [c];
  let j = i;
  while (same(kids[j + step]) && (!separated || isSpace(kids[j + 1]))) {
    j += step;
    items.push(kids[j] as ElementNode);
  }
  return { items, span: j - i + 1, separated };
}

/** Finds maximal runs of same-shaped sibling blocks, without looking inside the runs found. */
export function findGroups(root: ElementNode, out: Group[] = []): Group[] {
  const kids = root.children;
  let i = 0;
  while (i < kids.length) {
    const c = kids[i]!;
    if (c.kind !== "element") {
      i++;
      continue;
    }
    const run = runAt(kids, i);
    if (run.items.length >= minRun(c) && qualifies(c)) {
      out.push({ parent: root, start: i, ...run });
      i += run.span;
      continue;
    }
    findGroups(c, out);
    i++;
  }
  return out;
}

function classTokens(n: HNode, out: Set<string>): Set<string> {
  if (n.kind !== "element") return out;
  for (const c of (attr(n, "class") ?? "").split(/\s+/)) if (c) out.add(c);
  n.children.forEach((c) => classTokens(c, out));
  return out;
}

/**
 * Groups share one component when they have the same shape and the same classes in common. Links in a navbar
 * (`nav-link`) and in a footer (`footer-link`) stay separate; the same card used in two places is shared.
 */
export function bucketKey(g: Group): string {
  const sets = g.items.map((i) => classTokens(i, new Set()));
  const common = [...sets[0]!].filter((c) => sets.every((s) => s.has(c))).sort();
  return `${signature(g.items[0]!)}|${common.join(" ")}`;
}
