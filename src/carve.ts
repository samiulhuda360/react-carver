// Splits a page into section components and repeated-item components, with the data each one needs.
import { attr, canonicalize, size, textOf, type ElementNode, type HNode, type Placeholder } from "./ir.ts";
import { NameScope, camel, itemName, meaningfulClass, plural, sectionName } from "./names.ts";
import {
  bucketKey,
  build,
  findGroups,
  minRun,
  nameSlots,
  qualifies,
  rowData,
  runAt,
  type Group,
  type Slot,
  type TNode,
} from "./repeat.ts";

export interface Section {
  name: string;
  root: ElementNode;
  /** Index of the section this one sits in, or -1 when it sits directly in App. */
  parent: number;
}

export interface Bucket {
  name: string;
  template: TNode;
  scope: Slot[];
  sample: ElementNode;
}

export interface GroupUse {
  bucket: number;
  rowStart: number;
  rowCount: number;
  dataName: string;
  /** Slot whose value is used as the React `key`, or null to use the position. */
  keyProp: Slot | null;
  /** Section index that renders the group, or -1 for App. */
  owner: number;
  /** When another group has exactly the same data, its index; that group's array is reused. */
  sameDataAs: number;
  /** True when the blocks are separated by single spaces, which the output keeps. */
  separated: boolean;
  /** The element that held the run, and the first block of the run, as they were in the page. */
  parentEl: ElementNode;
  first: ElementNode;
}

export interface Carved {
  app: ElementNode;
  sections: Section[];
  buckets: Bucket[];
  groups: GroupUse[];
}

const TOP_LEVEL = new Set(["header", "nav", "main", "section", "footer", "aside", "article", "form"]);
const NESTED = new Set(["header", "nav", "main", "section", "aside", "footer", "form", "article"]);
/** Page landmarks become components even when small; other sections need some content. */
const LANDMARKS = new Set(["header", "nav", "footer", "aside"]);

/** Moves form starting values to the props React expects (`defaultValue` on select and textarea). */
function prepareForms(el: ElementNode): void {
  if (el.tag === "textarea" && el.ns === "html") {
    el.attrs.push(["__defaultValue", textOf(el)]);
    el.children = [];
    return;
  }
  if (el.tag === "select" && el.ns === "html") {
    const chosen: string[] = [];
    const visit = (n: HNode): void => {
      if (n.kind !== "element") return;
      if (n.tag === "option") {
        const i = n.attrs.findIndex(([a]) => a === "selected");
        if (i >= 0) {
          chosen.push(attr(n, "value") ?? textOf(n).replace(/\s+/g, " ").trim());
          n.attrs.splice(i, 1);
        }
      }
      n.children.forEach(visit);
    };
    el.children.forEach(visit);
    const multiple = el.attrs.some(([a]) => a === "multiple");
    if (multiple && chosen.length) el.attrs.push(["__defaultValueList", JSON.stringify(chosen)]);
    else if (chosen.length) el.attrs.push(["__defaultValue", chosen[chosen.length - 1]!]);
  }
  for (const c of el.children) if (c.kind === "element") prepareForms(c);
}

function sameShapeRuns(children: HNode[]): Set<HNode> {
  const inRuns = new Set<HNode>();
  for (let i = 0; i < children.length; i++) {
    const c = children[i]!;
    if (c.kind !== "element") continue;
    const run = runAt(children, i);
    if (run.items.length >= minRun(c) && qualifies(c)) {
      run.items.forEach((x) => inRuns.add(x));
      i += run.span - 1;
    }
  }
  return inRuns;
}

function splitSections(container: ElementNode, depth: number, parent: number, sections: Section[]): void {
  const repeated = sameShapeRuns(container.children);
  container.children = container.children.map((c): HNode => {
    if (c.kind !== "element" || repeated.has(c) || c.ns !== "html") return c;
    const n = size(c);
    const meaningful = Boolean(attr(c, "id") || meaningfulClass(c));
    const holdsLandmarks = c.children.some((k) => k.kind === "element" && TOP_LEVEL.has(k.tag));
    const isCandidate =
      (LANDMARKS.has(c.tag) && n >= 1) ||
      (depth === 0
        ? (TOP_LEVEL.has(c.tag) && n >= 4) || (c.tag === "div" && meaningful && n >= 8 && !holdsLandmarks)
        : NESTED.has(c.tag) && n >= 6);
    if (isCandidate) {
      sections.push({ name: sectionName(c), root: c, parent });
      const ref = sections.length - 1;
      if (depth < 2) splitSections(c, depth + 1, ref, sections);
      const ph: Placeholder = { kind: "use", ref };
      return ph;
    }
    if (depth === 0 && (c.tag === "div" || c.tag === "main") && n >= 10) splitSections(c, depth, parent, sections);
    return c;
  });
}

/** Turns a parsed body into App, section components and repeated-item components. */
export function carve(body: ElementNode): Carved {
  const app = canonicalize(body);
  prepareForms(app);
  const sections: Section[] = [];
  splitSections(app, 0, -1, sections);

  const names = new NameScope(["App"]);
  for (const s of sections) s.name = names.take(s.name);

  const owners: Array<{ root: ElementNode; owner: number }> = [
    { root: app, owner: -1 },
    ...sections.map((s, i) => ({ root: s.root, owner: i })),
  ];
  const found: Array<Group & { owner: number }> = [];
  for (const o of owners) for (const g of findGroups(o.root)) found.push({ ...g, owner: o.owner });

  const byKey = new Map<string, Array<Group & { owner: number }>>();
  for (const g of found) {
    const k = bucketKey(g);
    byKey.set(k, [...(byKey.get(k) ?? []), g]);
  }

  const buckets: Bucket[] = [];
  const groups: GroupUse[] = [];
  const dataNames = new NameScope();
  const replacements: Array<{ g: Group; ref: number }> = [];
  for (const members of byKey.values()) {
    const rows = members.flatMap((m) => m.items);
    const scope: Slot[] = [];
    const template = build(rows, scope, null);
    if (!scope.length) continue;
    nameSlots(scope);
    const ownerName = members[0]!.owner >= 0 ? sections[members[0]!.owner]!.name : "Page";
    const bucket: Bucket = { name: names.take(itemName(rows[0]!, ownerName)), template, scope, sample: rows[0]! };
    buckets.push(bucket);
    let offset = 0;
    const seen: Array<{ json: string; group: number }> = [];
    for (const m of members) {
      const rowStart = offset;
      offset += m.items.length;
      const data = m.items.map((_, i) => rowData(scope, rowStart + i));
      const json = JSON.stringify(data);
      const twin = seen.find((s) => s.json === json);
      const unique = (sl: Slot): boolean => {
        const vals = sl.values.slice(rowStart, rowStart + m.items.length);
        return vals.every((v) => v !== "") && new Set(vals).size === vals.length;
      };
      const keyProp =
        scope.find((sl) => sl.kind === "text" && /^(title|name|heading)/.test(sl.name) && unique(sl)) ??
        scope.find((sl) => sl.kind === "text" && unique(sl)) ??
        scope.find((sl) => sl.kind === "attr" && sl.attrName !== "class" && unique(sl)) ??
        null;
      groups.push({
        bucket: buckets.length - 1,
        rowStart,
        rowCount: m.items.length,
        dataName: twin ? groups[twin.group]!.dataName : dataNames.take(camel(plural(bucket.name))),
        keyProp,
        owner: m.owner,
        sameDataAs: twin ? twin.group : -1,
        separated: m.separated,
        parentEl: m.parent,
        first: m.items[0]!,
      });
      if (!twin) seen.push({ json, group: groups.length - 1 });
      replacements.push({ g: m, ref: groups.length - 1 });
    }
  }
  // Replace each run with one placeholder, last run first so earlier indexes stay valid.
  replacements.sort((a, b) => b.g.start - a.g.start);
  for (const { g, ref } of replacements) {
    const ph: Placeholder = { kind: "repeat", ref };
    g.parent.children.splice(g.start, g.span, ph);
  }
  return { app, sections, buckets, groups };
}

/** Recomputes data names after component renames, keeping shared arrays shared. */
export function renameData(c: Carved): void {
  const dataNames = new NameScope();
  c.groups.forEach((g) => {
    g.dataName = g.sameDataAs >= 0 ? c.groups[g.sameDataAs]!.dataName : dataNames.take(camel(plural(c.buckets[g.bucket]!.name)));
  });
}
