// Command line: react-carver <page.html | https://...> [-o out] [--ai] [--no-verify] [--no-typecheck]
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_BASE_URL, DEFAULT_MODEL, type AiOptions } from "./ai.ts";
import { convertHtml } from "./convert.ts";
import { toMarkdown, toTerminal } from "./report.ts";
import { verify } from "./verify.ts";

const HELP = `Usage: npm run convert -- <page.html | URL> [options]

Options:
  -o, --out <dir>     Output folder (default: ./react-out)
      --ai            Ask a language model for better component and prop names (needs AI_API_KEY)
      --no-verify     Skip compiling, rendering and comparing the result
      --no-typecheck  Verify without the TypeScript type-check (faster)
  -h, --help          Show this help

Environment: AI_API_KEY, AI_BASE_URL (default Gemini), AI_MODEL (default ${DEFAULT_MODEL})`;

export function aiOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): AiOptions {
  return {
    apiKey: env.AI_API_KEY || undefined,
    baseUrl: env.AI_BASE_URL || DEFAULT_BASE_URL,
    model: env.AI_MODEL || DEFAULT_MODEL,
    cacheDir: resolve(env.AI_CACHE_DIR || ".cache/ai"),
  };
}

async function load(input: string): Promise<{ html: string; baseDir: string | null }> {
  if (/^https?:\/\//i.test(input)) {
    const res = await fetch(input, { signal: AbortSignal.timeout(20_000), headers: { "user-agent": "react-carver/1.0" } });
    if (!res.ok) throw new Error(`could not fetch ${input}: HTTP ${res.status}`);
    return { html: await res.text(), baseDir: null };
  }
  return { html: readFileSync(input, "utf8"), baseDir: dirname(resolve(input)) };
}

/** Copies local files the page uses (images, stylesheets) into the output's `public/` folder. */
function copyAssets(local: string[], baseDir: string, outDir: string): number {
  let n = 0;
  for (const rel of local) {
    const clean = rel.split(/[?#]/)[0]!.replace(/^\.?\//, "");
    const from = resolve(baseDir, clean);
    if (!from.startsWith(baseDir) || !existsSync(from)) continue;
    const to = join(outDir, "public", clean);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    n++;
  }
  return n;
}

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: "string", short: "o", default: "react-out" },
      ai: { type: "boolean", default: false },
      "no-verify": { type: "boolean", default: false },
      "no-typecheck": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help || positionals.length !== 1) {
    console.log(HELP);
    return values.help ? 0 : 2;
  }
  const input = positionals[0]!;
  const { html, baseDir } = await load(input);
  const conversion = await convertHtml(html, { source: input, ai: values.ai ? aiOptionsFromEnv() : null });
  const result = values["no-verify"]
    ? undefined
    : await verify(conversion.files, conversion.page.body, { typecheck: !values["no-typecheck"] });
  const outDir = resolve(values.out!);
  for (const [file, text] of Object.entries(conversion.files)) {
    const p = join(outDir, file);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  }
  writeFileSync(join(outDir, "report.md"), toMarkdown(conversion.report, result));
  const { markup: _markup, ...verification } = result ?? { markup: "" };
  writeFileSync(join(outDir, "report.json"), JSON.stringify({ ...conversion.report, verification: result ? verification : null }, null, 2));
  if (baseDir) copyAssets(conversion.report.assets.local, baseDir, outDir);
  console.log(toTerminal(conversion.report, result, values.out!));
  return result && !result.pass ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: Error) => {
      console.error(`react-carver: ${err.message}`);
      process.exit(1);
    },
  );
}
