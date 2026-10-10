/**
 * Minimal .gitignore / .levantignore matcher for the browser folder upload (the CLI uses the `ignore` package).
 * Supports: comments, blank lines, negation (!), anchored (/x), directory-only (x/), *, ?, ** globs.
 */
type Rule = { re: RegExp; negate: boolean; dirOnly: boolean };

function globToRe(glob: string, anchored: boolean): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        const slash = glob[i + 2] === "/";
        re += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${anchored ? "^" : "(?:^|/)"}${re}(?:/.*)?$`);
}

export function parseIgnore(text: string): Rule[] {
  const rules: Rule[] = [];
  for (let line of text.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith("#")) continue;
    line = line.replace(/\s+$/, "");
    let negate = false;
    if (line.startsWith("!")) {
      negate = true;
      line = line.slice(1);
    }
    const dirOnly = line.endsWith("/");
    if (dirOnly) line = line.slice(0, -1);
    const anchored = line.startsWith("/") || line.slice(0, -1).includes("/");
    line = line.replace(/^\//, "");
    if (!line) continue;
    rules.push({ re: globToRe(line, anchored), negate, dirOnly });
  }
  return rules;
}

/** True when `rel` (file path, forward slashes) is ignored. Directory-only rules match files below that directory. */
export function isIgnored(rules: Rule[], rel: string): boolean {
  let ignored = false;
  for (const r of rules) {
    const hit = r.dirOnly ? r.re.test(rel) && rel.split("/").length > 1 && dirMatch(r.re, rel) : r.re.test(rel);
    if (hit) ignored = !r.negate;
  }
  return ignored;
}

function dirMatch(re: RegExp, rel: string): boolean {
  // a dir-only rule must match a directory prefix, not the file itself
  const parts = rel.split("/");
  for (let i = 1; i < parts.length; i++) if (re.test(parts.slice(0, i).join("/")) && !re.test("")) return true;
  return false;
}
