import { describe, expect, it } from "vitest";
import { convertAttrs, parseStyle, propName, styleKey } from "../src/attrs.ts";
import type { ElementNode } from "../src/ir.ts";

const el = (tag: string, attrs: Array<[string, string]>, ns: ElementNode["ns"] = "html"): ElementNode => ({
  kind: "element",
  tag,
  ns,
  attrs,
  children: [],
});

describe("attribute names", () => {
  it("renames HTML attributes React spells differently", () => {
    const e = el("label", []);
    expect(propName(e, "class")).toBe("className");
    expect(propName(e, "for")).toBe("htmlFor");
    expect(propName(e, "tabindex")).toBe("tabIndex");
    expect(propName(e, "http-equiv")).toBe("httpEquiv");
  });

  it("keeps data- and aria- attributes and camelCases SVG ones", () => {
    expect(propName(el("div", []), "data-member-id")).toBe("data-member-id");
    expect(propName(el("div", []), "aria-label")).toBe("aria-label");
    expect(propName(el("path", [], "svg"), "stroke-width")).toBe("strokeWidth");
    expect(propName(el("use", [], "svg"), "xlink:href")).toBe("xlinkHref");
  });
});

describe("inline styles", () => {
  it("splits declarations without breaking on semicolons inside url() or quotes", () => {
    expect(parseStyle("background: url('a;b.png') no-repeat; color:red ;")).toEqual([
      ["background", "url('a;b.png') no-repeat"],
      ["color", "red"],
    ]);
  });

  it("turns CSS property names into React style keys", () => {
    expect(styleKey("margin-top")).toBe("marginTop");
    expect(styleKey("-webkit-transition")).toBe("WebkitTransition");
    expect(styleKey("-ms-transform")).toBe("msTransform");
    expect(styleKey("--accent")).toBe("--accent");
  });
});

describe("convertAttrs", () => {
  it("turns boolean and numeric attributes into true and numbers", () => {
    const { props } = convertAttrs(el("input", [["required", ""], ["maxlength", "80"], ["value", "x"]]));
    expect(props.map((p) => [p.name, p.value])).toEqual([
      ["required", { type: "true" }],
      ["maxLength", { type: "number", value: 80 }],
      ["defaultValue", { type: "string", value: "x" }],
    ]);
  });

  it("keeps value on submit buttons", () => {
    const { props } = convertAttrs(el("input", [["type", "submit"], ["value", "Send"]]));
    expect(props[1]!.name).toBe("value");
  });

  it("reports what React cannot take instead of converting it", () => {
    const { props, issues } = convertAttrs(
      el("a", [["onclick", "go()"], ["@click", "open = true"], ["href", "javascript:void(0)"], ["style", "color: red !important"]]),
    );
    expect(issues.map((i) => i.kind)).toEqual(["event-handler", "invalid-name", "javascript-url", "important-style"]);
    expect(props.map((p) => p.name)).toEqual(["style"]);
  });
});
