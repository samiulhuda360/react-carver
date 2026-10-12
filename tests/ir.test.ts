import { describe, expect, it } from "vitest";
import { canonicalize, parseFragmentTree, parsePage, textOf, type ElementNode, type HNode } from "../src/ir.ts";

const body = (html: string): ElementNode => canonicalize(parseFragmentTree(html));
const texts = (n: HNode): string[] =>
  n.kind === "text" ? [n.value] : n.kind === "element" ? n.children.flatMap(texts) : [];

describe("parsePage", () => {
  it("collects head information and the body", () => {
    const page = parsePage(
      `<!doctype html><html lang="en"><head><title> Hi </title><link rel="stylesheet" href="a.css"><script src="x.js"></script></head><body class="b"><p>x</p></body></html>`,
    );
    expect(page.head.title).toBe("Hi");
    expect(page.head.lang).toBe("en");
    expect(page.head.links).toHaveLength(1);
    expect(page.head.scripts[0]!.src).toBe("x.js");
    expect(page.bodyAttrs).toEqual([["class", "b"]]);
  });
});

describe("canonicalize", () => {
  it("drops whitespace at block edges and keeps one space between inline nodes", () => {
    const t = body(`<div>\n  <p>\n   Hello   <b>big</b>  <i>world</i>\n  </p>\n</div>`);
    expect(texts(t)).toEqual(["Hello ", "big", " ", "world"]);
  });

  it("removes comments, scripts, noscript and inline handlers", () => {
    const t = body(`<p onclick="x()">a<!-- c -->b</p><script>1</script><noscript>n</noscript>`);
    const p = t.children[0] as ElementNode;
    expect(p.attrs).toEqual([]);
    expect(textOf(t)).toBe("ab");
  });

  it("keeps non-breaking spaces and the exact text inside <pre>", () => {
    expect(texts(body(`<p>a&nbsp;+&nbsp;b</p>`))).toEqual(["a + b"]);
    expect(texts(body(`<pre>  x {\n    y\n  }</pre>`))).toEqual(["  x {\n    y\n  }"]);
  });

  it("ignores whitespace inside SVG containers", () => {
    const t = body(`<svg viewBox="0 0 1 1">\n  <path d="M0 0"></path>\n</svg>`);
    const svg = t.children[0] as ElementNode;
    expect(svg.children).toHaveLength(1);
  });
});
