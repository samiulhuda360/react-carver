// Baseline for comparison: the usual "find and replace" conversion. It pastes the page body into one component
// and fixes the common differences with regular expressions (class, for, void tags, comments).
export function naiveConvert(html: string): Record<string, string> {
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  const jsx = body
    .replace(/<!--([\s\S]*?)-->/g, "{/*$1*/}")
    .replace(/\sclass=/g, " className=")
    .replace(/\sfor=/g, " htmlFor=")
    .replace(/<(area|base|br|col|embed|hr|img|input|link|meta|source|track|wbr)\b([^>]*?)\s*\/?>/gi, "<$1$2 />");
  return {
    "src/App.tsx": `export function App() {\n  return (\n    <>\n${jsx}\n    </>\n  );\n}\n`,
  };
}
