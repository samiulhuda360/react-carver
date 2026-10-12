import { describe, expect, it } from "vitest";
import { canonicalize, parseFragmentTree, type ElementNode } from "../src/ir.ts";
import { bucketKey, build, findGroups, nameSlots, rowData, signature, type Slot } from "../src/repeat.ts";

const tree = (html: string): ElementNode => canonicalize(parseFragmentTree(html));

describe("signature", () => {
  it("ignores text and attribute values but not structure", () => {
    const t = tree(`<li><a href="/a">A</a></li><li><a href="/b">B</a></li><li><a>C</a></li>`);
    const [a, b, c] = t.children;
    expect(signature(a!)).toBe(signature(b!));
    expect(signature(a!)).not.toBe(signature(c!));
  });

  it("treats lists of different length as the same shape", () => {
    const t = tree(`<ul><li>a</li></ul><ul><li>a</li><li>b</li><li>c</li></ul>`);
    expect(signature(t.children[0]!)).toBe(signature(t.children[1]!));
  });
});

describe("findGroups", () => {
  it("needs three list rows but only two cards", () => {
    expect(findGroups(tree(`<ul><li><a>a</a></li><li><a>b</a></li></ul>`))).toHaveLength(0);
    expect(findGroups(tree(`<ul><li><a>a</a></li><li><a>b</a></li><li><a>c</a></li></ul>`))).toHaveLength(1);
    expect(findGroups(tree(`<div><article><h3>a</h3><p>x</p></article><article><h3>b</h3><p>y</p></article></div>`))).toHaveLength(1);
  });

  it("does not treat paragraphs or plain-text list items as blocks", () => {
    expect(findGroups(tree(`<div><p>a <b>x</b></p><p>b <b>y</b></p></div><ul><li>1</li><li>2</li><li>3</li></ul>`))).toHaveLength(0);
  });

  it("finds inline blocks separated by single spaces", () => {
    const groups = findGroups(tree(`<div>\n<button><img src="a.png"></button>\n<button><img src="b.png"></button>\n</div>`));
    expect(groups).toHaveLength(1);
    expect(groups[0]!.separated).toBe(true);
    expect(groups[0]!.span).toBe(3);
  });

  it("keeps navbar and footer links apart when their classes differ", () => {
    const html = (cls: string): string => `<ul>${["a", "b", "c"].map((x) => `<li><a class="${cls}" href="#${x}">${x}</a></li>`).join("")}</ul>`;
    const [nav, foot] = findGroups(tree(`<nav>${html("nav-link")}</nav><footer><p>x</p>${html("footer-link")}</footer>`));
    expect(bucketKey(nav!)).not.toBe(bucketKey(foot!));
  });
});

describe("build", () => {
  it("turns differing values into props, nested lists into arrays and icon runs into counts", () => {
    const t = tree(`
      <div class="r"><p class="stars"><span>*</span><span>*</span></p><h3 class="review-title">Good</h3><ul><li>x</li></ul></div>
      <div class="r"><p class="stars"><span>*</span></p><h3 class="review-title">Fine</h3><ul><li>y</li><li>z</li></ul></div>`);
    const scope: Slot[] = [];
    build(t.children as ElementNode[], scope, null);
    nameSlots(scope);
    expect(scope.map((s) => [s.kind, s.name])).toEqual([
      ["count", "labelCount"],
      ["text", "title"],
      ["list", "items"],
    ]);
    expect(rowData(scope, 0)).toEqual({ labelCount: 2, title: "Good", items: ["x"] });
    expect(rowData(scope, 1)).toEqual({ labelCount: 1, title: "Fine", items: ["y", "z"] });
  });

  it("moves a space every value shares into the template", () => {
    const t = tree(`<div><p><b>$9 </b><small>/mo</small></p></div><div><p><b>$29 </b><small>/mo</small></p></div>`);
    const scope: Slot[] = [];
    build(t.children as ElementNode[], scope, null);
    expect(scope[0]!.values).toEqual(["$9", "$29"]);
  });
});
