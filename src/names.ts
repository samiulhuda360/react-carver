// Rule-based names for components and props. The optional AI step can replace them later.
import { attr, textOf, type ElementNode, type HNode } from "./ir.ts";

/** Class names that describe layout or styling rather than meaning. */
const UTILITY = /^(fa[srbld]?|fa-.*|fas|far|fab|bi|bi-.*|icon|btn|btn-.*|col|col-.*|row|text-.*|bg-.*|[mp][xytblr]?-\d+|d-.*|flex|flex-.*|grid|grid-.*|w-.*|h-.*|is-.*|has-.*|js-.*|clearfix|active|show|hidden|visible|container|container-.*|wrapper|inner|content|section|block|center|section-center|page|main|site|lg:.*|md:.*|sm:.*)$/;

const GENERIC_IDS = new Set(["home", "main", "content", "top", "root", "app", "wrapper", "page", "container", "site"]);

/** Names that would shadow browser or JavaScript globals, or clash with the generated files. */
const RESERVED = new Set([
  "App", "Array", "Audio", "Boolean", "Data", "Date", "Document", "Element", "Error", "Event", "Function", "Image",
  "Intl", "JSON", "Map", "Math", "Node", "Number", "Object", "Option", "Promise", "React", "Record", "Set", "String",
  "Symbol", "Text", "Window", "Fragment", "Component",
]);

const RESERVED_PROPS = new Set(["key", "ref", "children", "props"]);

const JS_KEYWORDS = new Set([
  "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do", "else", "enum",
  "export", "extends", "false", "finally", "for", "function", "if", "import", "in", "instanceof", "new", "null",
  "return", "super", "switch", "this", "throw", "true", "try", "typeof", "var", "void", "while", "with", "yield",
  "let", "static", "implements", "interface", "package", "private", "protected", "public", "await", "async", "of",
]);

export function words(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

export function pascal(s: string): string {
  const out = words(s).map((w) => w[0]!.toUpperCase() + w.slice(1)).join("");
  return /^[0-9]/.test(out) ? `C${out}` : out;
}

export function camel(s: string): string {
  const p = pascal(s);
  return p ? p[0]!.toLowerCase() + p.slice(1) : p;
}

export function plural(s: string): string {
  if (/[^aeiou]y$/i.test(s)) return s.slice(0, -1) + "ies";
  if (/(s|x|z|ch|sh)$/i.test(s)) return s + "es";
  return s + "s";
}

export function isComponentName(s: string): boolean {
  return /^[A-Z][A-Za-z0-9]{0,47}$/.test(s) && !RESERVED.has(s);
}

export function isPropName(s: string): boolean {
  return /^[a-z][A-Za-z0-9]{0,39}$/.test(s) && !RESERVED_PROPS.has(s) && !JS_KEYWORDS.has(s);
}

/** Keeps names unique inside one scope by adding 2, 3, ... */
export class NameScope {
  private used = new Set<string>();
  constructor(reserved: Iterable<string> = []) {
    for (const r of reserved) this.used.add(r);
  }
  take(base: string): string {
    let name = base;
    for (let i = 2; this.used.has(name); i++) name = `${base}${i}`;
    this.used.add(name);
    return name;
  }
  has(name: string): boolean {
    return this.used.has(name);
  }
}

export function classes(el: ElementNode): string[] {
  return (attr(el, "class") ?? "").split(/\s+/).filter(Boolean);
}

/** The first class that says what the element is, if any. */
export function meaningfulClass(el: ElementNode): string | undefined {
  return classes(el).find((c) => !UTILITY.test(c) && /[a-z]/i.test(c));
}

function firstHeading(node: HNode): string | undefined {
  if (node.kind !== "element") return undefined;
  if (/^h[1-3]$/.test(node.tag)) return textOf(node).trim();
  for (const c of node.children) {
    const h = firstHeading(c);
    if (h) return h;
  }
  return undefined;
}

const LANDMARK_NAMES: Record<string, string> = { footer: "Footer" };

const STOP_WORDS = new Set(["a", "an", "the", "for", "of", "and", "to", "in", "on", "our", "your", "with", "by", "at", "is", "we", "you"]);

/** A component name for a carved-out page section. */
export function sectionName(el: ElementNode): string {
  const candidates: string[] = [];
  if (LANDMARK_NAMES[el.tag]) candidates.push(LANDMARK_NAMES[el.tag]!);
  if (el.tag === "nav") {
    const label = attr(el, "id") ?? meaningfulClass(el) ?? "";
    if (!label || /nav|menu/i.test(label)) candidates.push(/^(nav|navbar|menu|main-?nav)?$/i.test(label) ? "Navbar" : pascal(label));
  }
  const id = attr(el, "id");
  if (id && !GENERIC_IDS.has(id.toLowerCase())) candidates.push(pascal(id));
  const cls = meaningfulClass(el);
  if (cls) candidates.push(pascal(cls));
  const heading = firstHeading(el);
  if (heading) {
    const w = words(heading).filter((x) => !STOP_WORDS.has(x)).slice(0, 3).join(" ");
    if (w) candidates.push(pascal(w) + (el.tag === "form" ? "Form" : "Section"));
  }
  if (el.tag === "header") candidates.push("Header");
  if (el.tag === "aside") candidates.push("Sidebar");
  if (el.tag === "nav") candidates.push("Navbar");
  candidates.push(pascal(el.tag === "div" ? "block" : el.tag));
  for (const c of candidates) if (c && isComponentName(c)) return c;
  return `${pascal(el.tag)}Section`;
}

/**
 * Whether a rule-based section name is a guess. Names taken from a landmark tag, an id or a class are kept;
 * names built from a heading or a bare tag are weak, and the optional AI step may replace them.
 */
export function isWeakSectionName(el: ElementNode, name: string): boolean {
  const id = attr(el, "id");
  const cls = meaningfulClass(el);
  const strong = new Set(["Footer", "Navbar"]);
  if (id) strong.add(pascal(id));
  if (cls) strong.add(pascal(cls));
  return !strong.has(name.replace(/\d+$/, ""));
}

/** Whether a rule-based item name is a guess (built from the parent's name rather than the item's class). */
export function isWeakItemName(root: ElementNode, name: string): boolean {
  const cls = meaningfulClass(root);
  return !cls || pascal(cls) !== name.replace(/\d+$/, "");
}

/** A component name for one item of a repeated group. */
export function itemName(root: ElementNode, parentComponent: string): string {
  const cls = meaningfulClass(root);
  if (cls) {
    const n = pascal(cls);
    if (isComponentName(n)) return n;
  }
  const suffix = root.tag === "tr" ? "Row" : root.tag === "li" ? "Item" : "Card";
  return `${parentComponent}${suffix}`;
}

const TAG_TEXT_HINT: Record<string, string> = {
  h1: "title", h2: "title", h3: "title", h4: "title", h5: "title", h6: "title", p: "text", span: "label",
  a: "label", button: "label", li: "item", td: "cell", th: "heading", strong: "highlight", b: "highlight",
  time: "date", figcaption: "caption", small: "note", label: "label", dt: "term", dd: "detail",
  blockquote: "quote", cite: "author", code: "code", em: "emphasis", summary: "summary", option: "option",
  caption: "caption", q: "quote", i: "label",
};

/** The last word of the element's meaningful class, e.g. `tour-date` gives `date`. */
function classWord(el: ElementNode): string | undefined {
  const cls = meaningfulClass(el);
  if (!cls) return undefined;
  const parts = words(cls);
  return parts[parts.length - 1];
}

/** A prop name hint for text that differs between repeated items. */
export function textHint(parent: ElementNode): string {
  return classWord(parent) ?? TAG_TEXT_HINT[parent.tag] ?? "text";
}

/** A prop name hint for an attribute value that differs between repeated items. */
export function attrHint(el: ElementNode, name: string): string {
  const n = name.toLowerCase();
  if (n === "src") return el.tag === "img" ? "image" : "src";
  if (n === "class") {
    const iconish = el.tag === "i" || classes(el).some((c) => /^(fa|bi|icon)/.test(c) || /icon/.test(c));
    return iconish ? "icon" : "variant";
  }
  if (n === "title") return "tooltip";
  if (n === "datetime") return "dateTime";
  if (n.startsWith("data-")) return camel(n.slice(5)) || "data";
  if (n.startsWith("aria-")) return camel(n);
  return camel(n) || "value";
}

/** A prop name hint for a list inside a repeated item, e.g. the features of a pricing plan. */
export function listHint(itemRoot: ElementNode): string {
  return classWord(itemRoot) ?? TAG_TEXT_HINT[itemRoot.tag] ?? (itemRoot.tag === "li" ? "item" : "entry");
}

export function safeProp(hint: string): string {
  const c = camel(hint);
  if (!c) return "value";
  if (isPropName(c)) return c;
  return `${c}Value`.replace(/^[^a-z]/, "v");
}
