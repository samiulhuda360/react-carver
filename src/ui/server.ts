// A small local web page for trying the converter: pick a sample, paste HTML or give a URL, then compare the
// original page with the React render, read the generated files and the report.
//   npm run ui   ->   http://localhost:5178
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { aiOptionsFromEnv } from "../cli.ts";
import { convertHtml } from "../convert.ts";
import { toMarkdown } from "../report.ts";
import { verify } from "../verify.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const SAMPLES = join(ROOT, "samples");
const PORT = Number(process.env.PORT ?? 5178);
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "text/javascript",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

interface Stored {
  original: string;
  react: string;
}
const results = new Map<string, Stored>();
let counter = 0;

/** Sample pages: top-level .html files and index.html inside sample folders. */
export function listSamples(): string[] {
  const out: string[] = [];
  for (const name of readdirSync(SAMPLES).sort()) {
    const p = join(SAMPLES, name);
    if (statSync(p).isDirectory() && existsSync(join(p, "index.html"))) out.push(`${name}/index.html`);
    else if (name.endsWith(".html")) out.push(name);
  }
  return out;
}

function withBase(html: string, base: string | null): string {
  if (!base) return html;
  const tag = `<base href="${base}">`;
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => `${m}${tag}`) : `${tag}${html}`;
}

function reactPage(indexHtml: string, markup: string, base: string | null): string {
  const page = indexHtml
    .replace(`<div id="root"></div>`, `<div id="root">${markup}</div>`)
    .replace(/\s*<script type="module" src="\/src\/main.tsx"><\/script>/, "");
  return withBase(page, base);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function send(res: ServerResponse, status: number, body: string | Buffer, type = "application/json"): void {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

async function convertRequest(body: { sample?: string; html?: string; url?: string; ai?: boolean }): Promise<unknown> {
  let html: string;
  let base: string | null = null;
  let source: string;
  if (body.sample) {
    if (!listSamples().includes(body.sample)) throw new Error("unknown sample");
    html = readFileSync(join(SAMPLES, body.sample), "utf8");
    base = `/samples/${body.sample.includes("/") ? body.sample.split("/")[0] + "/" : ""}`;
    source = `samples/${body.sample}`;
  } else if (body.url) {
    if (!/^https?:\/\//i.test(body.url)) throw new Error("URL must start with http:// or https://");
    const r = await fetch(body.url, { signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`fetch failed: HTTP ${r.status}`);
    html = await r.text();
    base = body.url;
    source = body.url;
  } else if (body.html) {
    html = body.html;
    source = "pasted HTML";
  } else throw new Error("nothing to convert");

  const conversion = await convertHtml(html, { source, ai: body.ai ? aiOptionsFromEnv() : null });
  const result = await verify(conversion.files, conversion.page.body);
  const id = String(++counter);
  results.set(id, { original: withBase(html, base), react: reactPage(conversion.files["index.html"]!, result.markup, base) });
  if (results.size > 20) results.delete(results.keys().next().value!);
  const { markup: _markup, ...verification } = result;
  return { id, files: conversion.files, report: conversion.report, verification, reportMd: toMarkdown(conversion.report, result) };
}

export const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  try {
    if (req.method === "GET" && url.pathname === "/") {
      return send(res, 200, readFileSync(join(import.meta.dirname, "index.html")), TYPES[".html"]);
    }
    if (req.method === "GET" && url.pathname === "/api/samples") return send(res, 200, JSON.stringify(listSamples()));
    if (req.method === "POST" && url.pathname === "/api/convert") {
      return send(res, 200, JSON.stringify(await convertRequest(JSON.parse(await readBody(req)))));
    }
    const preview = /^\/preview\/(\d+)\/(original|react)$/.exec(url.pathname);
    if (preview) {
      const stored = results.get(preview[1]!);
      return stored ? send(res, 200, stored[preview[2] as keyof Stored], TYPES[".html"]) : send(res, 404, "gone", "text/plain");
    }
    if (url.pathname.startsWith("/samples/")) {
      const file = normalize(join(SAMPLES, decodeURIComponent(url.pathname.slice("/samples/".length))));
      if (file.startsWith(SAMPLES) && existsSync(file) && statSync(file).isFile()) {
        return send(res, 200, readFileSync(file), TYPES[extname(file)] ?? "application/octet-stream");
      }
    }
    send(res, 404, "not found", "text/plain");
  } catch (err) {
    send(res, 400, JSON.stringify({ error: (err as Error).message }));
  }
});

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  server.listen(PORT, () => console.log(`react-carver UI on http://localhost:${PORT}`));
}
