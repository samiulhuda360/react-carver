// A small, plain tree for HTML, built from parse5. Both the converter and the checker work on this tree,
// after `canonicalize` has applied the same whitespace and "ignored node" rules to it.
import { parse, parseFragment, type DefaultTreeAdapterMap } from "parse5";

type P5Node = DefaultTreeAdapterMap["childNode"];
type P5Parent = DefaultTreeAdapterMap["parentNode"];

export type Namespace = "html" | "svg" | "math";

export interface ElementNode {
  kind: "element";
  tag: string;
  ns: Namespace;
  attrs: Array<[string, string]>;
  children: HNode[];
}

export interface TextNode {
  kind: "text";
  value: string;
}

export interface CommentNode {
  kind: "comment";
  value: string;
}

/** Stands in for a carved-out component (`use`) or a group of repeated blocks (`repeat`) inside a tree. */
export type Placeholder = { kind: "use"; ref: number } | { kind: "repeat"; ref: number };

export type HNode = ElementNode | TextNode | CommentNode | Placeholder;

export interface HeadInfo {
  title: string;
  lang: string;
  meta: Array<Array<[string, string]>>;
  links: Array<Array<[string, string]>>;
  styles: string[];
  scripts: Array<{ src: string; inline: string }>;
}

export interface ParsedPage {
  head: HeadInfo;
  bodyAttrs: Array<[string, string]>;
  body: ElementNode;
}

const NS: Record<string, Namespace> = {
  "http://www.w3.org/2000/svg": "svg",
  "http://www.w3.org/1998/Math/MathML": "math",
};

function convert(node: P5Node): HNode | null {
  if (node.nodeName === "#text") return { kind: "text", value: (node as DefaultTreeAdapterMap["textNode"]).value };
  if (node.nodeName === "#comment") return { kind: "comment", value: (node as DefaultTreeAdapterMap["commentNode"]).data };
  if (!("tagName" in node)) return null;
  const el = node as DefaultTreeAdapterMap["element"];
  const source: P5Parent = el.tagName === "template" ? (el as DefaultTreeAdapterMap["template"]).content : el;
  return {
    kind: "element",
    tag: el.tagName,
    ns: NS[el.namespaceURI] ?? "html",
    attrs: el.attrs.map((a) => [a.prefix ? `${a.prefix}:${a.name}` : a.name, a.value]),
    children: convertChildren(source),
  };
}

function convertChildren(parent: P5Parent): HNode[] {
  const out: HNode[] = [];
  for (const child of parent.childNodes) {
    const c = convert(child as P5Node);
    if (c) out.push(c);
  }
  return out;
}

function findChild(parent: ElementNode, tag: string): ElementNode | undefined {
  return parent.children.find((c): c is ElementNode => c.kind === "element" && c.tag === tag);
}

export function attr(el: ElementNode, name: string): string | undefined {
  return el.attrs.find(([n]) => n === name)?.[1];
}

export function textOf(node: HNode): string {
  if (node.kind === "text") return node.value;
  if (node.kind !== "element") return "";
  return node.children.map(textOf).join("");
}

/** Parses a whole HTML document into its head information and body tree. */
export function parsePage(html: string): ParsedPage {
  const doc = parse(html);
  const htmlEl = doc.childNodes.map((c) => convert(c as P5Node)).find(
    (c): c is ElementNode => c?.kind === "element" && c.tag === "html",
  );
  if (!htmlEl) throw new Error("no <html> element found");
  const headEl = findChild(htmlEl, "head");
  const body = findChild(htmlEl, "body") ?? { kind: "element", tag: "body", ns: "html", attrs: [], children: [] };
  const head: HeadInfo = { title: "", lang: attr(htmlEl, "lang") ?? "", meta: [], links: [], styles: [], scripts: [] };
  for (const c of headEl?.children ?? []) {
    if (c.kind !== "element") continue;
    if (c.tag === "title") head.title = textOf(c).trim();
    else if (c.tag === "meta") head.meta.push(c.attrs);
    else if (c.tag === "link") head.links.push(c.attrs);
    else if (c.tag === "style") head.styles.push(textOf(c));
    else if (c.tag === "script") head.scripts.push({ src: attr(c, "src") ?? "", inline: textOf(c) });
  }
  return { head, bodyAttrs: body.attrs, body };
}

/** Parses an HTML fragment (for example, React's rendered markup) into a body-like element. */
export function parseFragmentTree(html: string): ElementNode {
  const frag = parseFragment(html);
  return { kind: "element", tag: "body", ns: "html", attrs: [], children: convertChildren(frag) };
}

// ---------------------------------------------------------------------------------------------------------------
// Canonical form

/** Elements that flow inline with text. Whitespace between two of these is visible, elsewhere it is not. */
export const INLINE = new Set([
  "a", "abbr", "audio", "b", "bdi", "bdo", "br", "button", "canvas", "cite", "code", "data", "del", "dfn", "em",
  "i", "iframe", "img", "input", "ins", "kbd", "label", "mark", "meter", "object", "output", "picture", "progress",
  "q", "s", "samp", "select", "small", "span", "strong", "sub", "sup", "svg", "textarea", "time", "u", "var",
  "video", "wbr", "math",
]);

/** Elements whose text is kept exactly as written. */
const RAW_TEXT = new Set(["pre", "textarea", "script", "style", "listing", "xmp"]);

/** Nodes that a React component cannot or should not carry. The converter reports them, the checker skips them. */
export const DROPPED_TAGS = new Set(["script", "noscript", "template"]);

export function isEventAttr(name: string): boolean {
  return /^on[a-z]+$/i.test(name);
}

const WS = /[ \t\n\f\r]+/g;

function isInline(node: HNode | undefined): boolean {
  if (!node) return false;
  if (node.kind === "text") return true;
  return node.kind === "element" && (node.ns !== "html" ? node.tag === "svg" || node.tag === "math" : INLINE.has(node.tag));
}

/**
 * Applies the rules both sides of a comparison share:
 * - comments, scripts, `<noscript>` and `<template>` are removed, and so are inline event handler attributes;
 * - adjacent text is merged and whitespace runs collapse to one space (except inside `<pre>`-like elements);
 * - whitespace next to a block boundary is removed, and whitespace between two inline nodes becomes one space.
 * This is the meaning a browser gives the markup, so two trees that are equal here look the same on screen.
 */
export function canonicalize(el: ElementNode, insideRaw = false): ElementNode {
  const raw = insideRaw || RAW_TEXT.has(el.tag);
  const kept: HNode[] = [];
  for (const c of el.children) {
    if (c.kind === "comment") continue;
    if (c.kind === "element") {
      if (DROPPED_TAGS.has(c.tag) && c.ns === "html") continue;
      kept.push(canonicalize(c, raw));
      continue;
    }
    if (c.kind !== "text") {
      kept.push(c);
      continue;
    }
    const last = kept[kept.length - 1];
    if (last?.kind === "text") last.value += c.value;
    else kept.push({ kind: "text", value: c.value });
  }
  const attrs = el.attrs.filter(([n]) => !isEventAttr(n));
  if (raw) return { ...el, attrs, children: kept.filter((c) => c.kind !== "text" || c.value !== "") };

  const out: HNode[] = [];
  const parentInline = isInline(el) && el.tag !== "svg";
  // SVG and MathML containers do not render whitespace text at all.
  const foreign = el.ns !== "html";
  for (let i = 0; i < kept.length; i++) {
    const c = kept[i]!;
    if (c.kind !== "text") {
      out.push(c);
      continue;
    }
    if (foreign && !["text", "tspan", "title", "desc", "mi", "mn", "mo", "mtext", "ms"].includes(el.tag)) {
      if (c.value.trim() === "") continue;
    }
    let v = c.value.replace(WS, " ");
    const prev = kept[i - 1];
    const next = kept[i + 1];
    const startsBlock = prev ? !isInline(prev) : !parentInline;
    const endsBlock = next ? !isInline(next) : !parentInline;
    if (startsBlock) v = v.replace(/^ /, "");
    if (endsBlock) v = v.replace(/ $/, "");
    if (v === "") continue;
    out.push({ kind: "text", value: v });
  }
  return { ...el, attrs, children: out };
}

/** Counts the elements and text nodes under a node, not counting the node itself. */
export function size(node: HNode): number {
  if (node.kind !== "element") return 0;
  return node.children.reduce((n, c) => n + 1 + size(c), 0);
}

const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);

/** Short HTML for a tree, with placeholders written as `<Name />` through `label`. */
export function toHtml(node: HNode, label: (p: Placeholder) => string = (p) => `<${p.kind}-${p.ref} />`): string {
  if (node.kind === "text") return node.value.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  if (node.kind === "comment") return `<!--${node.value}-->`;
  if (node.kind !== "element") return label(node);
  const attrs = node.attrs
    .filter(([n]) => !n.startsWith("__"))
    .map(([n, v]) => (v === "" ? ` ${n}` : ` ${n}="${v.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`))
    .join("");
  if (VOID_TAGS.has(node.tag)) return `<${node.tag}${attrs}>`;
  return `<${node.tag}${attrs}>${node.children.map((c) => toHtml(c, label)).join("")}</${node.tag}>`;
}

/** A short CSS-like description of an element, e.g. `button#menu.nav-toggle`. */
export function describe(el: ElementNode): string {
  const id = attr(el, "id");
  const cls = (attr(el, "class") ?? "").split(/\s+/).filter(Boolean).slice(0, 2);
  return `${el.tag}${id ? `#${id}` : ""}${cls.map((c) => `.${c}`).join("")}`;
}
