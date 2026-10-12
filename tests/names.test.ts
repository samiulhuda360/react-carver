import { describe, expect, it } from "vitest";
import { parseFragmentTree, type ElementNode } from "../src/ir.ts";
import { NameScope, camel, isPropName, isWeakSectionName, itemName, pascal, plural, safeProp, sectionName } from "../src/names.ts";

const first = (html: string): ElementNode => parseFragmentTree(html).children[0] as ElementNode;

describe("case helpers", () => {
  it("builds identifiers from any text", () => {
    expect(pascal("tour-card")).toBe("TourCard");
    expect(pascal("3 columns")).toBe("C3Columns");
    expect(camel("Team Member")).toBe("teamMember");
    expect(plural("category")).toBe("categories");
    expect(plural("box")).toBe("boxes");
  });

  it("keeps prop names valid", () => {
    expect(isPropName("key")).toBe(false);
    expect(isPropName("default")).toBe(false);
    expect(safeProp("default")).toBe("defaultValue");
  });

  it("makes names unique in a scope", () => {
    const s = new NameScope(["App"]);
    expect(s.take("Hero")).toBe("Hero");
    expect(s.take("Hero")).toBe("Hero2");
    expect(s.take("App")).toBe("App2");
  });
});

describe("section names", () => {
  it("prefers id and class, then headings, then the tag", () => {
    expect(sectionName(first(`<section id="about" class="section"><h2>Hi</h2></section>`))).toBe("About");
    expect(sectionName(first(`<header class="hero" id="home"></header>`))).toBe("Hero");
    expect(sectionName(first(`<section class="section"><h2>Our opening hours</h2></section>`))).toBe("OpeningHoursSection");
    expect(sectionName(first(`<footer class="x-footer"></footer>`))).toBe("Footer");
    expect(sectionName(first(`<nav class="toc"></nav>`))).toBe("Toc");
    expect(sectionName(first(`<nav class="navbar"></nav>`))).toBe("Navbar");
  });

  it("marks guessed names as weak", () => {
    const s = first(`<section class="section"><h2>Our opening hours</h2></section>`);
    expect(isWeakSectionName(s, sectionName(s))).toBe(true);
    const a = first(`<section id="about"></section>`);
    expect(isWeakSectionName(a, sectionName(a))).toBe(false);
  });

  it("names repeated items from their class or their parent", () => {
    expect(itemName(first(`<article class="tour-card"></article>`), "Tours")).toBe("TourCard");
    expect(itemName(first(`<table><tr><td>1</td></tr></table>`).children[0] as ElementNode, "Stock")).toBe("StockCard");
  });
});
