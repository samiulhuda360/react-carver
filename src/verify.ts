// Proves a conversion: the generated files must compile, type-check, render without React warnings,
// and produce the same text and the same element tree as the original page.
import { createRequire } from "node:module";
import { dirname, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, type Plugin } from "esbuild";
import ts from "typescript";
import type { ComponentType } from "react";
import { BOOLEAN_ATTRS, parseStyle } from "./attrs.ts";
import { canonicalize, parseFragmentTree, textOf, type ElementNode, type HNode } from "./ir.ts";

const require = createRequire(import.meta.url);
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..").replace(/\\/g, "/");

export interface VerifyResult {
  compiled: boolean;
  typechecked: boolean | null;
  rendered: boolean;
  textMatch: boolean;
  domMatch: boolean;
  pass: boolean;
  errors: string[];
  warnings: string[];
  firstDiff: string;
  markup: string;
  ms: number;
}

function virtualPlugin(files: Record<string, string>): Plugin {
  return {
    name: "virtual-files",
    setup(b) {
      b.onResolve({ filter: /.*/ }, (args) => {
        if (/^react(-dom)?(\/|$)/.test(args.path)) return { path: args.path, external: true };
        const base = args.kind === "entry-point" ? "" : posix.dirname(args.importer);
        const p = posix.normalize(posix.join(base, args.path));
        for (const cand of [p, `${p}.tsx`, `${p}.ts`]) if (files[cand] !== undefined) return { path: cand, namespace: "v" };
        return { errors: [{ text: `cannot resolve ${args.path} from ${args.importer || "entry"}` }] };
      });
      b.onLoad({ filter: /.*/, namespace: "v" }, (args) => ({
        contents: files[args.path],
        loader: args.path.endsWith(".tsx") ? "tsx" : "ts",
      }));
    },
  };
}

/** Bundles `src/App.tsx` (React left external) into CommonJS code. */
export async function compile(files: Record<string, string>): Promise<{ code: string; errors: string[] }> {
  try {
    const out = await build({
      entryPoints: ["src/App.tsx"],
      bundle: true,
      write: false,
      format: "cjs",
      platform: "node",
      jsx: "automatic",
      logLevel: "silent",
      plugins: [virtualPlugin(files)],
    });
    return { code: out.outputFiles[0]!.text, errors: [] };
  } catch (err) {
    const e = err as { errors?: Array<{ text: string; location?: { file: string; line: number } | null }> };
    return { code: "", errors: (e.errors ?? [{ text: String(err) }]).map((x) => (x.location ? `${x.location.file}:${x.location.line} ${x.text}` : x.text)) };
  }
}

const libCache = new Map<string, ts.SourceFile>();
let typecheckRun = 0;

/** Type-checks the generated files with strict settings, as if they sat in a normal Vite + React project. */
export function typecheck(files: Record<string, string>): string[] {
  const root = `${PROJECT_ROOT}/.virtual/run${typecheckRun++}`;
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    noUnusedLocals: true,
    noUnusedParameters: true,
    isolatedModules: true,
    jsx: ts.JsxEmit.ReactJSX,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ES2022,
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
    types: [],
  };
  const virtual = new Map(Object.entries(files).filter(([f]) => /\.tsx?$/.test(f)).map(([f, c]) => [`${root}/${f}`, c]));
  const host = ts.createCompilerHost(options);
  const norm = (f: string): string => f.replace(/\\/g, "/");
  const baseGet = host.getSourceFile.bind(host);
  host.fileExists = ((orig) => (f: string) => virtual.has(norm(f)) || orig(f))(host.fileExists.bind(host));
  host.readFile = ((orig) => (f: string) => virtual.get(norm(f)) ?? orig(f))(host.readFile.bind(host));
  const dirs = new Set<string>();
  for (const f of virtual.keys()) for (let d = posix.dirname(f); d.length > root.length - 1; d = posix.dirname(d)) dirs.add(d);
  host.directoryExists = (d: string) => dirs.has(norm(d).replace(/\/$/, "")) || ts.sys.directoryExists(d);
  host.getSourceFile = (f, lang, onError, create) => {
    const v = virtual.get(norm(f));
    if (v !== undefined) return ts.createSourceFile(f, v, lang, true);
    const hit = libCache.get(f);
    if (hit) return hit;
    const sf = baseGet(f, lang, onError, create);
    if (sf) libCache.set(f, sf);
    return sf;
  };
  const program = ts.createProgram([...virtual.keys()], options, host);
  return ts.getPreEmitDiagnostics(program).map((d) => {
    const msg = ts.flattenDiagnosticMessageText(d.messageText, " ");
    if (!d.file || d.start === undefined) return msg;
    const { line } = d.file.getLineAndCharacterOfPosition(d.start);
    return `${norm(d.file.fileName).replace(`${root}/`, "")}:${line + 1} ${msg}`;
  });
}

/** Runs the bundle and renders `<App />` to static HTML, collecting React's warnings. */
export function render(code: string): { markup: string; warnings: string[]; error: string } {
  const warnings: string[] = [];
  const origError = console.error;
  const origWarn = console.warn;
  console.error = (...a: unknown[]) => warnings.push(a.map(String).join(" ").slice(0, 300));
  console.warn = console.error;
  try {
    const mod: { exports: Record<string, unknown> } = { exports: {} };
    new Function("require", "module", "exports", code)(require, mod, mod.exports);
    const React = require("react") as typeof import("react");
    const server = require("react-dom/server") as typeof import("react-dom/server");
    const App = mod.exports.App as ComponentType;
    const markup = server.renderToStaticMarkup(React.createElement(App));
    return { markup, warnings, error: "" };
  } catch (err) {
    return { markup: "", warnings, error: (err as Error).message };
  } finally {
    console.error = origError;
    console.warn = origWarn;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Comparison

function normAttrs(el: ElementNode): string[] {
  return el.attrs
    .map(([n, v]) => {
      const name = el.ns === "html" ? n.toLowerCase() : n;
      if (name === "class") return `class=${v.trim().split(/\s+/).join(" ")}`;
      if (name === "style") return `style=${parseStyle(v).map(([k, x]) => `${k.startsWith("--") ? k : k.toLowerCase()}:${x}`).join(";")}`;
      if (el.ns === "html" && BOOLEAN_ATTRS.has(name)) return name;
      return `${name}=${v}`;
    })
    .filter((a) => a !== "style=")
    .sort();
}

function label(n: HNode | undefined): string {
  if (!n) return "nothing";
  if (n.kind === "text") return `text "${n.value.slice(0, 40)}"`;
  if (n.kind === "element") return `<${n.tag}>`;
  return n.kind;
}

/**
 * React 19 adds `<link rel="preload" as="image">` hints for images when rendering on the server. They are
 * resource hints, not page content, so the comparison leaves them out.
 */
export function withoutPreloads(el: ElementNode): ElementNode {
  const isHint = (n: HNode): boolean =>
    n.kind === "element" && n.tag === "link" && n.attrs.some(([a, v]) => a === "rel" && v === "preload");
  return { ...el, children: el.children.filter((c) => !isHint(c)) };
}

/** Returns "" when the trees match, otherwise a description of the first difference. */
export function diffTrees(a: ElementNode, b: ElementNode, path = "body"): string {
  const ac = a.children;
  const bc = b.children;
  for (let i = 0; i < Math.max(ac.length, bc.length); i++) {
    const x = ac[i];
    const y = bc[i];
    const here = `${path} > ${x?.kind === "element" ? x.tag : "#text"}[${i}]`;
    if (!x || !y || x.kind !== y.kind) return `${here}: expected ${label(x)}, got ${label(y)}`;
    if (x.kind === "text" && y.kind === "text") {
      if (x.value !== y.value) return `${here}: expected "${x.value.slice(0, 60)}", got "${y.value.slice(0, 60)}"`;
      continue;
    }
    if (x.kind === "element" && y.kind === "element") {
      if (x.tag !== y.tag) return `${here}: expected <${x.tag}>, got <${y.tag}>`;
      const xa = normAttrs(x).join(" | ");
      const ya = normAttrs(y).join(" | ");
      if (xa !== ya) return `${here}: attributes differ: [${xa}] vs [${ya}]`;
      const d = diffTrees(x, y, here);
      if (d) return d;
    }
  }
  return "";
}

/** Verifies one conversion against the original page body. */
export async function verify(
  files: Record<string, string>,
  originalBody: ElementNode,
  opts: { typecheck?: boolean } = {},
): Promise<VerifyResult> {
  const t0 = performance.now();
  const errors: string[] = [];
  const { code, errors: compileErrors } = await compile(files);
  errors.push(...compileErrors);
  const compiled = compileErrors.length === 0;
  let typechecked: boolean | null = null;
  if (opts.typecheck !== false) {
    const typeErrors = typecheck(files);
    errors.push(...typeErrors);
    typechecked = typeErrors.length === 0;
  }
  let markup = "";
  let warnings: string[] = [];
  let rendered = false;
  let textMatch = false;
  let domMatch = false;
  let firstDiff = "not rendered";
  if (compiled) {
    const r = render(code);
    markup = r.markup;
    warnings = r.warnings;
    if (r.error) errors.push(`render: ${r.error}`);
    else {
      rendered = true;
      const want = canonicalize(originalBody);
      const got = withoutPreloads(canonicalize(parseFragmentTree(markup)));
      textMatch = textOf(want) === textOf(got);
      firstDiff = diffTrees(want, got);
      domMatch = firstDiff === "";
    }
  }
  const pass = compiled && typechecked !== false && rendered && warnings.length === 0 && textMatch && domMatch;
  return { compiled, typechecked, rendered, textMatch, domMatch, pass, errors, warnings, firstDiff, markup, ms: Math.round(performance.now() - t0) };
}
