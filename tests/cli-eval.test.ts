import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { naiveConvert } from "../eval/naive.ts";
import { matches } from "../eval/run.ts";
import { main } from "../src/cli.ts";
import { parseFragmentTree, parsePage, type ElementNode } from "../src/ir.ts";
import { listSamples } from "../src/ui/server.ts";
import { verify } from "../src/verify.ts";

describe("command line", () => {
  it("writes the React project, the report and the page's local files", async () => {
    const out = mkdtempSync(join(tmpdir(), "rc-cli-"));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await main(["samples/ridgeway-tours/index.html", "-o", out, "--no-typecheck"]);
    log.mockRestore();
    expect(code).toBe(0);
    for (const f of ["index.html", "src/main.tsx", "src/App.tsx", "src/data.ts", "src/components/TourCard.tsx", "report.md", "report.json", "public/images/tour-1.svg", "public/css/styles.css"]) {
      expect(existsSync(join(out, f)), f).toBe(true);
    }
    const report = JSON.parse(readFileSync(join(out, "report.json"), "utf8"));
    expect(report.verification.pass).toBe(true);
    expect(report.repeated.map((r: { component: string }) => r.component)).toContain("TourCard");
  });

  it("prints help", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await main(["--help"])).toBe(0);
    expect(await main([])).toBe(2);
    log.mockRestore();
  });
});

describe("evaluation helpers", () => {
  it("matches simple selectors", () => {
    const el = parseFragmentTree(`<section id="about" class="section big"></section>`).children[0] as ElementNode;
    expect(matches(el, "section#about.big")).toBe(true);
    expect(matches(el, ".section")).toBe(true);
    expect(matches(el, "div")).toBe(false);
    expect(matches(el, "section.small")).toBe(false);
  });

  it("finds every sample page", () => {
    expect(listSamples()).toHaveLength(12);
  });

  it("shows why find-and-replace is not enough", async () => {
    const html = readFileSync("samples/docs-page.html", "utf8");
    const v = await verify(naiveConvert(html), parsePage(html).body, { typecheck: false });
    expect(v.pass).toBe(false);
  });
});
