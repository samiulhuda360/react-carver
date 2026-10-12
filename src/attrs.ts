// HTML attribute names and values turned into React (JSX) props.
import type { ElementNode } from "./ir.ts";

/** HTML attribute names whose React prop name is spelled differently. */
const RENAMED: Record<string, string> = {
  class: "className",
  for: "htmlFor",
  "accept-charset": "acceptCharset",
  accesskey: "accessKey",
  allowfullscreen: "allowFullScreen",
  autocapitalize: "autoCapitalize",
  autocomplete: "autoComplete",
  autofocus: "autoFocus",
  autoplay: "autoPlay",
  cellpadding: "cellPadding",
  cellspacing: "cellSpacing",
  charset: "charSet",
  colspan: "colSpan",
  contenteditable: "contentEditable",
  crossorigin: "crossOrigin",
  datetime: "dateTime",
  enctype: "encType",
  enterkeyhint: "enterKeyHint",
  fetchpriority: "fetchPriority",
  formaction: "formAction",
  formnovalidate: "formNoValidate",
  frameborder: "frameBorder",
  hreflang: "hrefLang",
  "http-equiv": "httpEquiv",
  inputmode: "inputMode",
  itemprop: "itemProp",
  itemscope: "itemScope",
  itemtype: "itemType",
  marginheight: "marginHeight",
  marginwidth: "marginWidth",
  maxlength: "maxLength",
  minlength: "minLength",
  nomodule: "noModule",
  novalidate: "noValidate",
  playsinline: "playsInline",
  readonly: "readOnly",
  referrerpolicy: "referrerPolicy",
  rowspan: "rowSpan",
  spellcheck: "spellCheck",
  srcdoc: "srcDoc",
  srclang: "srcLang",
  srcset: "srcSet",
  tabindex: "tabIndex",
  usemap: "useMap",
  "xlink:href": "xlinkHref",
  "xml:lang": "xmlLang",
  "xml:space": "xmlSpace",
  "xmlns:xlink": "xmlnsXlink",
};

/** Attributes whose mere presence means "on". React wants these as `true`. */
export const BOOLEAN_ATTRS = new Set([
  "allowfullscreen", "async", "autofocus", "autoplay", "checked", "controls", "default", "defer", "disabled",
  "formnovalidate", "hidden", "inert", "itemscope", "loop", "multiple", "muted", "nomodule", "novalidate", "open",
  "playsinline", "readonly", "required", "reversed", "selected",
]);

/** React's preferred prop for a form field's starting value, so the field stays editable. */
const UNCONTROLLED: Record<string, Record<string, string>> = {
  input: { value: "defaultValue", checked: "defaultChecked" },
};

/** Attributes React types as numbers, e.g. `maxLength={80}`. */
export const NUMERIC_ATTRS = new Set(["maxlength", "minlength", "tabindex", "rows", "cols", "colspan", "rowspan", "size", "span", "start"]);

export function isNumericAttr(el: ElementNode, name: string): boolean {
  return el.ns === "html" && NUMERIC_ATTRS.has(name.toLowerCase());
}

export type PropValue =
  | { type: "string"; value: string }
  | { type: "number"; value: number }
  | { type: "true" }
  | { type: "style"; entries: Array<[string, string]> };

export interface Prop {
  name: string;
  /** The original HTML attribute name, used for reporting and for slot naming. */
  source: string;
  value: PropValue;
}

export interface AttrIssue {
  kind: "event-handler" | "invalid-name" | "javascript-url" | "important-style";
  attr: string;
  value: string;
}

const JSX_NAME = /^[A-Za-z_][\w-]*(?::[\w-]+)?$/;

function camel(name: string): string {
  return name.replace(/[-:]([a-z])/g, (_, ch: string) => ch.toUpperCase());
}

/** The React prop name for one attribute on one element. */
export function propName(el: ElementNode, name: string): string {
  const lower = el.ns === "html" ? name.toLowerCase() : name;
  if (RENAMED[lower]) return RENAMED[lower];
  if (lower.startsWith("data-") || lower.startsWith("aria-")) return lower;
  if (el.ns === "svg" && name.includes("-")) return camel(name);
  return lower;
}

/** Splits a `style="..."` string into declarations, respecting quotes and brackets. */
export function parseStyle(style: string): Array<[string, string]> {
  const decls: string[] = [];
  let depth = 0;
  let quote = "";
  let cur = "";
  for (const ch of style) {
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === ";" && depth === 0) {
      decls.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  decls.push(cur);
  const out: Array<[string, string]> = [];
  for (const d of decls) {
    const i = d.indexOf(":");
    if (i < 0) continue;
    const prop = d.slice(0, i).trim();
    const value = d.slice(i + 1).trim().replace(/\s+/g, " ");
    if (prop && value) out.push([prop, value]);
  }
  return out;
}

/** CSS property name to the key React expects in a style object. */
export function styleKey(prop: string): string {
  if (prop.startsWith("--")) return prop;
  const p = prop.toLowerCase();
  if (p.startsWith("-ms-")) return camel(p.slice(1));
  if (p.startsWith("-")) {
    const c = camel(p.slice(1));
    return c.charAt(0).toUpperCase() + c.slice(1);
  }
  return camel(p);
}

/** Converts every attribute of an element. Problems that need a person are returned as issues. */
export function convertAttrs(el: ElementNode): { props: Prop[]; issues: AttrIssue[] } {
  const props: Prop[] = [];
  const issues: AttrIssue[] = [];
  for (const [rawName, value] of el.attrs) {
    if (/^on[a-z]+$/i.test(rawName)) {
      issues.push({ kind: "event-handler", attr: rawName, value });
      continue;
    }
    if (!JSX_NAME.test(rawName)) {
      issues.push({ kind: "invalid-name", attr: rawName, value });
      continue;
    }
    const lower = el.ns === "html" ? rawName.toLowerCase() : rawName;
    if ((lower === "href" || lower === "src" || lower === "action") && /^\s*javascript:/i.test(value)) {
      issues.push({ kind: "javascript-url", attr: rawName, value });
      continue;
    }
    if (lower === "style") {
      const entries = parseStyle(value).map(([k, v]): [string, string] => [styleKey(k), v]);
      if (entries.some(([, v]) => /!important/i.test(v))) issues.push({ kind: "important-style", attr: rawName, value });
      if (entries.length) props.push({ name: "style", source: rawName, value: { type: "style", entries } });
      continue;
    }
    let name = propName(el, rawName);
    const swap = UNCONTROLLED[el.tag]?.[lower];
    if (swap && !(el.tag === "input" && lower === "value" && ["submit", "button", "reset"].includes(el.attrs.find(([n]) => n === "type")?.[1] ?? ""))) {
      name = swap;
    }
    if (el.ns === "html" && BOOLEAN_ATTRS.has(lower)) props.push({ name, source: rawName, value: { type: "true" } });
    else if (isNumericAttr(el, rawName) && /^-?\d+$/.test(value.trim())) {
      props.push({ name, source: rawName, value: { type: "number", value: Number(value) } });
    }
    else props.push({ name, source: rawName, value: { type: "string", value } });
  }
  return { props, issues };
}
