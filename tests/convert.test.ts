import { describe, expect, it } from "vitest";
import { convertHtml } from "../src/convert.ts";
import { toMarkdown } from "../src/report.ts";
import { verify } from "../src/verify.ts";

const page = (body: string, head = ""): string => `<!doctype html><html lang="en"><head>${head}</head><body>${body}</body></html>`;

async function roundTrip(html: string) {
  const c = await convertHtml(html);
  const v = await verify(c.files, c.page.body);
  return { c, v };
}

describe("convert and verify", () => {
  it("keeps text with braces, angle brackets and entities intact", async () => {
    const { c, v } = await roundTrip(page(`<p>Use {name} &lt;here&gt; &amp; <code>a &gt; b</code></p><pre>{\n  "x": 1\n}</pre>`));
    expect(v.errors).toEqual([]);
    expect(v.pass).toBe(true);
    expect(c.files["src/App.tsx"]).toContain(`{"Use {name} <here> &"}`);
  });

  it("converts form starting values to defaultValue", async () => {
    const { c, v } = await roundTrip(
      page(`<form><textarea>hi</textarea><select><option>a</option><option selected>b</option></select><input type="checkbox" checked></form>`),
    );
    expect(v.pass).toBe(true);
    const form = Object.entries(c.files).find(([f]) => f.endsWith("Form.tsx"))![1];
    expect(form).toContain(`<textarea defaultValue="hi" />`);
    expect(form).toContain(`<select defaultValue="b">`);
    expect(form).toContain("defaultChecked");
  });

  it("turns inline styles into objects, including custom properties", async () => {
    const { c, v } = await roundTrip(page(`<div style="width: 40%; --bar: red; -webkit-user-select: none">x</div>`));
    expect(v.pass).toBe(true);
    expect(c.files["src/App.tsx"]).toContain(`style={{ width: "40%", "--bar": "red", WebkitUserSelect: "none" } as CSSProperties}`);
  });

  it("extracts repeated cards into a component, data and a map", async () => {
    const cards = ["Alpha", "Beta", "Gamma"].map((t, i) => `<article class="plan"><h3>${t}</h3><p class="price">$${i + 1}</p></article>`).join("");
    const { c, v } = await roundTrip(page(`<section id="plans"><h2>Plans</h2><div class="grid">${cards}</div></section>`));
    expect(v.pass).toBe(true);
    expect(c.files["src/components/Plan.tsx"]).toContain("export function Plan({ title, price }: PlanProps)");
    expect(c.files["src/components/Plans.tsx"]).toContain("{plans.map((plan) => (");
    expect(c.files["src/data.ts"]).toContain(`{ title: "Gamma", price: "$3" }`);
  });

  it("keeps spaces between inline repeated blocks", async () => {
    const thumbs = ["a", "b", "c"].map((x) => `<button type="button" class="thumb"><img src="${x}.png" alt=""></button>`).join("\n");
    const { c, v } = await roundTrip(page(`<div class="thumbs">\n${thumbs}\n</div>`));
    expect(v.pass).toBe(true);
    expect(Object.values(c.files).join("\n")).toContain(`{index > 0 && " "}`);
  });

  it("reports scripts and inline handlers and still matches the page", async () => {
    const { c, v } = await roundTrip(page(`<button onclick="go()">Go</button><script>go = () => 1</script>`));
    expect(v.pass).toBe(true);
    expect(c.report.issues.map((i) => i.kind)).toEqual(["event-handler", "script"]);
    expect(toMarkdown(c.report, v)).toContain("Re-create it as an `onClick`-style prop");
  });

  it("notices when the output does not match", async () => {
    const { c } = await roundTrip(page(`<p>one</p>`));
    const broken = { ...c.files, "src/App.tsx": c.files["src/App.tsx"]!.replace("one", "two") };
    const v = await verify(broken, c.page.body);
    expect(v.compiled).toBe(true);
    expect(v.textMatch).toBe(false);
    expect(v.firstDiff).toContain(`expected "one", got "two"`);
  });

  it("reports type errors", async () => {
    const { c } = await roundTrip(page(`<p>one</p>`));
    const broken = { ...c.files, "src/App.tsx": `export function App() { const n: number = "x"; return <p>{n}</p>; }\n` };
    const v = await verify(broken, c.page.body);
    expect(v.typechecked).toBe(false);
    expect(v.errors.join(" ")).toContain("not assignable to type 'number'");
  });
});
