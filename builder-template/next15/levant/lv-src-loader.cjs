/* LevantDeploy Builder — dev-only webpack pre-loader (never used by `next build`).
 * Adds data-lv-src="relpath:line:col" right after the tag name of every JSX element whose name is a plain
 * identifier (host elements like <div> and components like <Button>; components that spread their props pass the
 * usage-site attribute down to their DOM node, overriding their own). Skips fragments, <Fragment>, member
 * expressions (<Dialog.Root>) and elements that already carry the attribute. Line/col are 1-based.
 */
const path = require("node:path");
const { parse } = require("@babel/parser");

const SKIP = new Set(["Fragment", "Suspense", "StrictMode", "Profiler", "Script", "Head", "Html", "Main", "NextScript"]);

function walk(node, visit) {
  if (!node || typeof node.type !== "string") return;
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "start" || key === "end" || key === "extra" || key === "leadingComments" || key === "trailingComments") continue;
    const v = node[key];
    if (Array.isArray(v)) for (const c of v) walk(c, visit);
    else if (v && typeof v === "object" && typeof v.type === "string") walk(v, visit);
  }
}

module.exports = function lvSrcLoader(source) {
  const opts = (this.getOptions && this.getOptions()) || {};
  const root = opts.root || process.cwd();
  const file = this.resourcePath;
  if (!file || file.includes("node_modules")) return source;
  const rel = path.relative(root, file).split(path.sep).join("/");
  if (rel.startsWith("..")) return source;
  let ast;
  try {
    ast = parse(source, { sourceType: "module", plugins: ["jsx", "typescript"], errorRecovery: true });
  } catch {
    return source; // let SWC report the syntax error
  }
  const inserts = [];
  walk(ast.program, (n) => {
    if (n.type !== "JSXOpeningElement" || n.name.type !== "JSXIdentifier") return;
    const name = n.name.name;
    if (SKIP.has(name)) return;
    if (n.attributes.some((a) => a.type === "JSXAttribute" && a.name && a.name.name === "data-lv-src")) return;
    const { line, column } = n.loc.start;
    inserts.push({ at: n.name.end, text: ` data-lv-src="${rel}:${line}:${column + 1}"` });
  });
  if (!inserts.length) return source;
  inserts.sort((a, b) => b.at - a.at);
  let out = source;
  for (const i of inserts) out = out.slice(0, i.at) + i.text + out.slice(i.at);
  return out;
};
