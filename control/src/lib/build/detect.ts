import fs from "node:fs";
import path from "node:path";
import {
  FRAMEWORK_PRESETS,
  presetById,
  type BuildSettings,
  type Detection,
  type Language,
  type PackageManager,
} from "./types";

/**
 * Framework detection: looks at the files of the build context (repo root + rootDirectory) and returns what the
 * build will do. Project build settings override everything.
 *
 *   const d = detect("/work/abc/src/apps/web", project.buildSettings);
 *   // → { framework: "nextjs", kind: "WEB", strategy: "generated", packageManager: "pnpm", port: 3000, … }
 */

export const DEFAULT_NODE_VERSION = "22";
export const DEFAULT_PYTHON_VERSION = "3.12";
export const COMPOSE_FILES = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"];

// ───────────────────────────── fs helpers ─────────────────────────────

class Probe {
  constructor(public dir: string, public repoDir: string = dir) {}
  p(rel: string) {
    return path.join(this.dir, rel);
  }
  has(rel: string) {
    try {
      fs.accessSync(this.p(rel));
      return true;
    } catch {
      return false;
    }
  }
  isDir(rel: string) {
    try {
      return fs.statSync(this.p(rel)).isDirectory();
    } catch {
      return false;
    }
  }
  read(rel: string, max = 512 * 1024): string | null {
    try {
      const st = fs.statSync(this.p(rel));
      if (!st.isFile() || st.size > max) return null;
      return fs.readFileSync(this.p(rel), "utf8");
    } catch {
      return null;
    }
  }
  json<T = Record<string, unknown>>(rel: string): T | null {
    const s = this.read(rel);
    if (s == null) return null;
    try {
      return JSON.parse(stripJsonComments(s)) as T;
    } catch {
      return null;
    }
  }
  list(rel = "."): string[] {
    try {
      return fs.readdirSync(this.p(rel));
    } catch {
      return [];
    }
  }
  /** first existing file of the list */
  first(...rels: string[]) {
    return rels.find((r) => this.has(r)) ?? null;
  }
  /** walk (max depth, skipping heavy dirs) and return relative file paths matching the predicate */
  find(pred: (rel: string) => boolean, maxDepth = 3, limit = 50): string[] {
    const out: string[] = [];
    const walk = (rel: string, depth: number) => {
      if (out.length >= limit || depth > maxDepth) return;
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(this.p(rel), { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (SKIP_DIRS.has(e.name)) continue;
        const r = rel === "." ? e.name : `${rel}/${e.name}`;
        if (e.isDirectory()) walk(r, depth + 1);
        else if (pred(r)) out.push(r);
        if (out.length >= limit) return;
      }
    };
    walk(".", 0);
    return out;
  }
}

const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build", "target", "vendor", ".venv", "venv", "__pycache__", "bin", "obj", "_build", "deps", ".output", ".svelte-kit"]);

export function stripJsonComments(s: string): string {
  // strip // and /* */ comments outside strings + trailing commas (tsconfig / deno.jsonc style)
  let out = "";
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (inStr) {
      out += c;
      if (c === "\\") out += s[++i] ?? "";
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
    } else if (c === "/" && s[i + 1] === "/") {
      while (i < s.length && s[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && s[i + 1] === "*") {
      i += 2;
      while (i < s.length && !(s[i] === "*" && s[i + 1] === "/")) i++;
      i++;
    } else out += c;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

type Pkg = {
  name?: string;
  main?: string;
  module?: string;
  type?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  engines?: { node?: string; bun?: string };
  packageManager?: string;
  workspaces?: unknown;
};

const depsOf = (pkg: Pkg | null) => ({ ...(pkg?.devDependencies ?? {}), ...(pkg?.dependencies ?? {}) });

/** "^15.0.3" → "15.0.3" ; "latest" → null */
export function cleanVersion(range?: string | null): string | null {
  if (!range) return null;
  const m = range.match(/(\d+)(\.\d+)?(\.\d+)?/);
  return m ? m[0] : null;
}

/** Node major from engines / .nvmrc (">=18 <21" → "20"? we pick the highest major allowed among LTS lines). */
export function resolveNodeVersion(spec: string | null | undefined): string | null {
  if (!spec) return null;
  const s = spec.trim().replace(/^v/, "");
  if (/^lts/i.test(s) || s === "node" || s === "stable") return DEFAULT_NODE_VERSION;
  if (/^\d+(\.\d+){0,2}$/.test(s)) return s.split(".")[0]!;
  // prefer the default LTS when the range allows it, else the highest allowed major
  const candidates = [Number(DEFAULT_NODE_VERSION), 24, 20, 18].filter((v, i, a) => a.indexOf(v) === i);
  const majors = [...s.matchAll(/(>=|<=|>|<|\^|~|=)?\s*v?(\d+)/g)].map((m) => ({ op: m[1] ?? "=", n: Number(m[2]) }));
  if (!majors.length) return null;
  for (const c of candidates) {
    // "||" ranges: accept when any alternative matches
    const alts = s.split("||").map((alt) => [...alt.matchAll(/(>=|<=|>|<|\^|~|=)?\s*v?(\d+)/g)].map((m) => ({ op: m[1] ?? "=", n: Number(m[2]) })));
    const ok = alts.some((conds) =>
      conds.every(({ op, n }) => {
        switch (op) {
          case ">=":
            return c >= n;
          case ">":
            return c > n;
          case "<=":
            return c <= n;
          case "<":
            return c < n;
          case "^":
          case "~":
          case "=":
            return c === n;
          default:
            return true;
        }
      }),
    );
    if (ok) return String(c);
  }
  return String(majors[0]!.n);
}

/** "python-3.11.4" | "3.11" | ">=3.10,<3.13" → "3.11" / "3.12" */
export function resolvePythonVersion(spec: string | null | undefined): string | null {
  if (!spec) return null;
  const s = spec.trim().replace(/^python-?/i, "");
  const exact = s.match(/^(3\.\d+)(\.\d+)?$/);
  if (exact) return exact[1]!;
  const candidates = ["3.13", "3.12", "3.11", "3.10", "3.9"];
  const conds = [...s.matchAll(/(>=|<=|>|<|==|~=|\^|!=)?\s*(3\.\d+)/g)].map((m) => ({ op: m[1] ?? "==", v: Number(m[2]!.split(".")[1]) }));
  if (!conds.length) return null;
  // prefer the default when allowed (well-supported wheels), else the highest allowed
  const ordered = [DEFAULT_PYTHON_VERSION, ...candidates.filter((c) => c !== DEFAULT_PYTHON_VERSION)];
  for (const c of ordered) {
    const minor = Number(c.split(".")[1]);
    const ok = conds.every(({ op, v }) => {
      switch (op) {
        case ">=":
        case "~=":
        case "^":
          return minor >= v;
        case ">":
          return minor > v;
        case "<=":
          return minor <= v;
        case "<":
          return minor < v;
        case "!=":
          return minor !== v;
        default:
          return minor === v;
      }
    });
    if (ok) return c;
  }
  return null;
}

// ───────────────────────────── package manager ─────────────────────────────

export function detectPackageManager(probe: Probe, pkg: Pkg | null): { pm: PackageManager; lockfile: string | null; version?: string } {
  const fromField = pkg?.packageManager?.match(/^(npm|pnpm|yarn|bun)@([\w.+-]+)/);
  // walk up to the repo root to support workspaces (lockfile at the monorepo root)
  const dirs: string[] = [];
  let d = probe.dir;
  for (let i = 0; i < 6; i++) {
    dirs.push(d);
    if (path.resolve(d) === path.resolve(probe.repoDir)) break;
    const parent = path.dirname(d);
    if (parent === d) break;
    d = parent;
  }
  for (const dir of dirs) {
    const rel = path.relative(probe.dir, dir) || ".";
    const j = (f: string) => (rel === "." ? f : `${rel}/${f}`);
    if (probe.has(j("pnpm-lock.yaml"))) return { pm: "pnpm", lockfile: j("pnpm-lock.yaml"), version: fromField?.[1] === "pnpm" ? fromField[2] : undefined };
    if (probe.has(j("bun.lockb")) || probe.has(j("bun.lock"))) return { pm: "bun", lockfile: probe.has(j("bun.lock")) ? j("bun.lock") : j("bun.lockb") };
    if (probe.has(j("yarn.lock"))) return { pm: "yarn", lockfile: j("yarn.lock"), version: fromField?.[1] === "yarn" ? fromField[2] : undefined };
    if (probe.has(j("package-lock.json")) || probe.has(j("npm-shrinkwrap.json")))
      return { pm: "npm", lockfile: probe.has(j("package-lock.json")) ? j("package-lock.json") : j("npm-shrinkwrap.json") };
  }
  if (fromField) return { pm: fromField[1] as PackageManager, lockfile: null, version: fromField[2] };
  return { pm: "npm", lockfile: null };
}

export function installCommandFor(pm: PackageManager, hasLock: boolean, yarnBerry = false): string {
  switch (pm) {
    case "pnpm":
      return hasLock ? "pnpm install --frozen-lockfile" : "pnpm install";
    case "yarn":
      return hasLock ? (yarnBerry ? "yarn install --immutable" : "yarn install --frozen-lockfile") : "yarn install";
    case "bun":
      return hasLock ? "bun install --frozen-lockfile" : "bun install";
    default:
      return hasLock ? "npm ci" : "npm install";
  }
}

export const runScript = (pm: PackageManager, script: string) =>
  pm === "npm" ? (script === "start" ? "npm start" : `npm run ${script}`) : pm === "bun" ? `bun run ${script}` : `${pm} run ${script}`;

// ───────────────────────────── detection ─────────────────────────────

type Draft = Omit<Detection, "frameworkName" | "overridden" | "notes" | "meta" | "port"> & {
  port?: number;
  notes?: string[];
  meta?: Detection["meta"];
};

export type DetectOptions = {
  /** repo root (for workspace lockfiles); defaults to dir */
  repoDir?: string;
  /** IMAGE source projects */
  image?: string | null;
};

export function detect(dir: string, settingsIn: BuildSettings = {}, opts: DetectOptions = {}): Detection {
  const settings = settingsIn ?? {};
  const probe = new Probe(dir, opts.repoDir ?? dir);
  let draft: Draft | null = null;

  if (opts.image) {
    draft = { framework: "image", language: "docker", kind: "WEB", strategy: "image", notes: [`Prebuilt image ${opts.image} — build skipped`] };
  }

  const forced = settings.framework ? presetById(settings.framework) : null;

  if (!draft && settings.dockerfileInline?.trim()) {
    const ex = settings.dockerfileInline.match(/^\s*EXPOSE\s+(\d+)/im);
    draft = {
      framework: "dockerfile",
      language: "docker",
      kind: "WEB",
      strategy: "dockerfile",
      dockerfilePath: "(inline)",
      port: ex ? Number(ex[1]) : undefined,
      notes: ["Using the inline Dockerfile from the project settings"],
      meta: { inline: true, dockerfileFound: true },
    };
  }
  if (!draft && (forced?.id === "dockerfile" || (!forced && settings.dockerfilePath))) {
    draft = dockerfileDraft(probe, settings.dockerfilePath || "Dockerfile");
  }
  if (!draft && (forced?.id === "compose" || (!forced && settings.composeFile))) {
    draft = composeDraft(probe, settings.composeFile ?? null);
  }
  if (!draft && !forced) {
    // repo-provided build definitions win over generated templates
    if (probe.has("Dockerfile")) draft = dockerfileDraft(probe, "Dockerfile");
    else if (probe.first(...COMPOSE_FILES)) draft = composeDraft(probe, null);
    if (draft && draft.strategy === "dockerfile" && probe.first(...COMPOSE_FILES)) {
      draft.notes = [...(draft.notes ?? []), `${probe.first(...COMPOSE_FILES)} ignored (Dockerfile found) — choose the "Docker Compose" preset to deploy the stack`];
    }
  }
  if (!draft) draft = detectGenerated(probe, settings, forced?.id ?? null);

  if (!draft) {
    draft = {
      framework: "unknown",
      language: "static",
      kind: "WEB",
      strategy: "generated",
      notes: ["Could not detect a framework. Add a Dockerfile, choose a framework preset, or set a start command."],
    };
  }

  // ── apply overrides (project build settings override everything) ──
  const overridden: string[] = [];
  const ov = <K extends keyof Draft>(key: K, value: Draft[K] | null | undefined) => {
    if (value !== undefined && value !== null && value !== "") {
      (draft as Draft)[key] = value as Draft[K];
      overridden.push(String(key));
    }
  };
  if (draft.strategy === "generated") {
    ov("installCommand", settings.installCommand);
    ov("buildCommand", settings.buildCommand);
    ov("startCommand", settings.startCommand);
    ov("outputDirectory", settings.outputDirectory);
    if (settings.nodeVersion && ["node", "bun"].includes(draft.language)) ov("nodeVersion", resolveNodeVersion(settings.nodeVersion));
    if (settings.pythonVersion && draft.language === "python") ov("pythonVersion", resolvePythonVersion(settings.pythonVersion));
    if (settings.packageManager && draft.language === "node" && settings.packageManager !== draft.packageManager) {
      ov("packageManager", settings.packageManager);
      if (!settings.installCommand) draft.installCommand = installCommandFor(settings.packageManager, false);
    }
    if (forced && draft.framework !== forced.id) {
      draft.notes = [...(draft.notes ?? []), `Framework preset forced to ${forced.name}`];
    }
  }
  if (draft.framework === "unknown" && draft.startCommand) {
    draft.framework = "node";
    draft.language = "node";
  }

  const preset = presetById(draft.framework);
  return {
    framework: draft.framework,
    frameworkName: preset?.name ?? (draft.framework === "image" ? "Docker image" : draft.framework === "unknown" ? "Unknown" : draft.framework),
    version: draft.version ?? null,
    language: draft.language,
    kind: draft.kind,
    strategy: draft.strategy,
    packageManager: draft.packageManager ?? null,
    installCommand: draft.installCommand ?? null,
    buildCommand: draft.buildCommand ?? null,
    startCommand: draft.startCommand ?? null,
    outputDirectory: draft.outputDirectory ?? null,
    port: draft.port ?? preset?.port ?? 3000,
    nodeVersion: draft.nodeVersion ?? null,
    pythonVersion: draft.pythonVersion ?? null,
    dockerfilePath: draft.dockerfilePath ?? null,
    composeFile: draft.composeFile ?? null,
    overridden,
    notes: draft.notes ?? [],
    meta: draft.meta ?? {},
  };
}

function dockerfileDraft(probe: Probe, file: string): Draft {
  const content = probe.read(file);
  const notes: string[] = [];
  let port: number | undefined;
  if (content == null) notes.push(`Dockerfile not found at ${file}`);
  else {
    const ex = content.match(/^\s*EXPOSE\s+(\d+)/im);
    if (ex) port = Number(ex[1]);
  }
  return {
    framework: "dockerfile",
    language: "docker",
    kind: "WEB",
    strategy: "dockerfile",
    dockerfilePath: file,
    port,
    notes,
    meta: { dockerfileFound: content != null },
  };
}

function composeDraft(probe: Probe, file: string | null): Draft {
  const f = file ?? probe.first(...COMPOSE_FILES) ?? "compose.yaml";
  const notes: string[] = [];
  if (!probe.has(f)) notes.push(`Compose file not found at ${f}`);
  return { framework: "compose", language: "docker", kind: "COMPOSE", strategy: "compose", composeFile: f, notes, meta: { composeFound: probe.has(f) } };
}

function detectGenerated(probe: Probe, settings: BuildSettings, forced: string | null): Draft | null {
  const lang = forced ? presetById(forced)!.language : null;
  const tryLang = (l: Language) => !lang || lang === l;

  if (tryLang("deno") && (forced === "deno" || ((probe.has("deno.json") || probe.has("deno.jsonc") || probe.has("deno.lock")) && !probe.has("package.json"))))
    return denoDraft(probe);
  if ((tryLang("node") || tryLang("bun")) && probe.has("package.json")) {
    const d = nodeDraft(probe, settings, forced);
    if (d) return d;
  }
  if (tryLang("python") && (forced || probe.first("requirements.txt", "pyproject.toml", "Pipfile", "manage.py", "main.py", "app.py", "setup.py", "uv.lock")))
    return pythonDraft(probe, forced);
  if (tryLang("php") && (forced || probe.first("composer.json", "index.php", "public/index.php"))) return phpDraft(probe, forced);
  if (tryLang("go") && (forced || probe.has("go.mod"))) return goDraft(probe);
  if (tryLang("rust") && (forced || probe.has("Cargo.toml"))) return rustDraft(probe);
  if (tryLang("ruby") && (forced || probe.has("Gemfile") || probe.has("config.ru"))) return rubyDraft(probe, forced);
  if (tryLang("java") && (forced || probe.first("pom.xml", "build.gradle", "build.gradle.kts"))) return javaDraft(probe);
  if (tryLang("dotnet") && (forced || probe.list().some((f) => /\.(csproj|fsproj|sln)$/.test(f)) || probe.find((r) => /\.(csproj|fsproj)$/.test(r), 2, 1).length > 0)) return dotnetDraft(probe);
  if (tryLang("elixir") && (forced || probe.has("mix.exs"))) return elixirDraft(probe);
  if (tryLang("deno") && probe.first("deno.json", "deno.jsonc", "main.ts")) return denoDraft(probe);
  if (tryLang("static") && (forced === "static" || probe.has("index.html") || (probe.has("public/index.html") && !probe.has("package.json"))))
    return staticDraft(probe, settings);
  // Procfile only (no recognizable language) → can't build it without a base image
  if (probe.has("Procfile") && !forced) {
    return {
      framework: "unknown",
      language: "static",
      kind: "WEB",
      strategy: "generated",
      notes: ["Procfile found but no supported language manifest (package.json, requirements.txt, Gemfile, go.mod…)"],
    };
  }
  return null;
}

// ── Procfile ──

export function procfileCommand(probe: Probe, proc = "web"): string | null {
  const s = probe.read("Procfile");
  if (!s) return null;
  for (const line of s.split(/\r?\n/)) {
    const m = line.match(/^\s*([\w-]+)\s*:\s*(.+)$/);
    if (m && m[1] === proc) return m[2]!.trim();
  }
  return null;
}

function procfileWorker(probe: Probe): string | null {
  return procfileCommand(probe, "worker");
}

// ── Node ──

function nodeDraft(probe: Probe, settings: BuildSettings, forced: string | null): Draft | null {
  const pkg = probe.json<Pkg>("package.json");
  if (!pkg) return { framework: "node", language: "node", kind: "WEB", strategy: "generated", notes: ["package.json is not valid JSON"] };
  const deps = depsOf(pkg);
  const scripts = pkg.scripts ?? {};
  const pmInfo = detectPackageManager(probe, pkg);
  const pm = pmInfo.pm;
  const yarnBerry = pm === "yarn" && (probe.has(".yarnrc.yml") || !!(pmInfo.version && !pmInfo.version.startsWith("1")));
  const nodeVersion =
    resolveNodeVersion(settings.nodeVersion) ??
    resolveNodeVersion(probe.read(".nvmrc")?.trim()) ??
    resolveNodeVersion(probe.read(".node-version")?.trim()) ??
    resolveNodeVersion(pkg.engines?.node) ??
    DEFAULT_NODE_VERSION;
  const install = installCommandFor(pm, !!pmInfo.lockfile, yarnBerry);
  const build = scripts.build ? runScript(pm, "build") : null;
  const start = scripts.start ? runScript(pm, "start") : null;
  const has = (d: string) => d in deps;
  const notes: string[] = [];
  const meta: Detection["meta"] = { lockfile: pmInfo.lockfile, yarnBerry, pmVersion: pmInfo.version ?? null };
  if (pmInfo.lockfile && pmInfo.lockfile.includes("/")) {
    meta.workspaceRoot = path.dirname(pmInfo.lockfile);
    notes.push(`Lockfile found in a parent directory (${pmInfo.lockfile}) — installing from the workspace root`);
  }
  const base = { language: "node" as Language, strategy: "generated" as const, packageManager: pm, installCommand: install, nodeVersion, notes, meta };

  const isBun = pm === "bun" || forced === "bun" || /\bbun\b/.test(scripts.start ?? "") || !!pkg.engines?.bun;
  const pick = (id: string): string | null => (forced ? (forced === id ? id : null) : id);

  // frameworks, in order of specificity
  if ((forced === "nextjs" || (!forced && has("next"))) && pick("nextjs")) {
    const cfg = probe.read(probe.first("next.config.js", "next.config.mjs", "next.config.ts", "next.config.cjs") ?? "") ?? "";
    const standalone = /output\s*:\s*["'`]standalone["'`]/.test(cfg);
    const staticExport = /output\s*:\s*["'`]export["'`]/.test(cfg);
    meta.nextStandalone = standalone;
    if (staticExport) {
      return { ...base, framework: "nextjs", version: cleanVersion(deps.next), kind: "STATIC", buildCommand: build ?? "npx next build", outputDirectory: "out", meta: { ...meta, nextExport: true } };
    }
    if (!standalone) notes.push('Tip: set output: "standalone" in next.config for ~5x smaller images (the build forces it when possible).');
    return {
      ...base,
      framework: "nextjs",
      version: cleanVersion(deps.next),
      kind: "WEB",
      buildCommand: build ?? "npx next build",
      startCommand: start ?? "npx next start",
      meta: { ...meta, prisma: has("prisma") || has("@prisma/client") },
    };
  }
  if ((forced === "nuxt" || (!forced && (has("nuxt") || has("nuxt3")))) && pick("nuxt")) {
    return { ...base, framework: "nuxt", version: cleanVersion(deps.nuxt), kind: "WEB", buildCommand: build ?? "npx nuxi build", startCommand: "node .output/server/index.mjs", outputDirectory: ".output" };
  }
  if ((forced === "sveltekit" || (!forced && has("@sveltejs/kit"))) && pick("sveltekit")) {
    if (has("@sveltejs/adapter-static"))
      return { ...base, framework: "sveltekit", version: cleanVersion(deps["@sveltejs/kit"]), kind: "STATIC", buildCommand: build, outputDirectory: "build", meta: { ...meta, adapter: "static" } };
    if (!has("@sveltejs/adapter-node")) notes.push("SvelteKit without @sveltejs/adapter-node: the build adds adapter-node automatically (adapter-auto cannot detect a Docker host).");
    return {
      ...base,
      framework: "sveltekit",
      version: cleanVersion(deps["@sveltejs/kit"]),
      kind: "WEB",
      buildCommand: build ?? "npx vite build",
      startCommand: "node build",
      outputDirectory: "build",
      meta: { ...meta, adapter: has("@sveltejs/adapter-node") ? "node" : "auto" },
    };
  }
  if ((forced === "react-router" || (!forced && has("@react-router/dev"))) && pick("react-router")) {
    const spa = /ssr\s*:\s*false/.test(probe.read(probe.first("react-router.config.ts", "react-router.config.js") ?? "") ?? "");
    if (spa) return { ...base, framework: "react-router", version: cleanVersion(deps["@react-router/dev"]), kind: "STATIC", buildCommand: build, outputDirectory: "build/client" };
    return { ...base, framework: "react-router", version: cleanVersion(deps["@react-router/dev"]), kind: "WEB", buildCommand: build, startCommand: start ?? "npx react-router-serve ./build/server/index.js" };
  }
  if ((forced === "remix" || (!forced && Object.keys(deps).some((d) => d.startsWith("@remix-run/")))) && pick("remix")) {
    const viteRemix = probe.first("vite.config.ts", "vite.config.js", "vite.config.mjs") != null;
    return {
      ...base,
      framework: "remix",
      version: cleanVersion(deps["@remix-run/react"] ?? deps["@remix-run/node"]),
      kind: "WEB",
      buildCommand: build,
      startCommand: start ?? (viteRemix ? "npx remix-serve ./build/server/index.js" : "npx remix-serve build/index.js"),
    };
  }
  if ((forced === "astro" || (!forced && has("astro"))) && pick("astro")) {
    const cfg = probe.read(probe.first("astro.config.mjs", "astro.config.ts", "astro.config.js") ?? "") ?? "";
    const server = has("@astrojs/node") && /output\s*:\s*["'](server|hybrid)["']/.test(cfg);
    if (server || (has("@astrojs/node") && /adapter\s*:/.test(cfg)))
      return { ...base, framework: "astro", version: cleanVersion(deps.astro), kind: "WEB", buildCommand: build ?? "npx astro build", startCommand: "node ./dist/server/entry.mjs", meta: { ...meta, astroMode: "node" } };
    return { ...base, framework: "astro", version: cleanVersion(deps.astro), kind: "STATIC", buildCommand: build ?? "npx astro build", outputDirectory: "dist", meta: { ...meta, astroMode: "static" } };
  }
  if ((forced === "nestjs" || (!forced && has("@nestjs/core"))) && pick("nestjs")) {
    return {
      ...base,
      framework: "nestjs",
      version: cleanVersion(deps["@nestjs/core"]),
      kind: "WEB",
      buildCommand: build ?? "npx nest build",
      startCommand: scripts["start:prod"] ? runScript(pm, "start:prod") : "node dist/main",
    };
  }
  if ((forced === "angular" || (!forced && has("@angular/core") && probe.has("angular.json"))) && pick("angular")) {
    const ng = probe.json<{ projects?: Record<string, { architect?: { build?: { options?: { outputPath?: string | { base?: string } }; builder?: string } } }>; defaultProject?: string }>("angular.json");
    const first = ng?.projects ? (ng.defaultProject && ng.projects[ng.defaultProject] ? ng.projects[ng.defaultProject] : Object.values(ng.projects)[0]) : undefined;
    const op = first?.architect?.build?.options?.outputPath;
    let out = typeof op === "string" ? op : (op?.base ?? "dist");
    const builder = first?.architect?.build?.builder ?? "";
    // Angular 17+ application builder emits {outputPath}/browser
    if (/:application$/.test(builder)) out = `${out}/browser`;
    return { ...base, framework: "angular", version: cleanVersion(deps["@angular/core"]), kind: "STATIC", buildCommand: build ?? "npx ng build", outputDirectory: out, meta: { ...meta, spa: true } };
  }
  if ((forced === "vue" || (!forced && has("@vue/cli-service"))) && pick("vue"))
    return { ...base, framework: "vue", version: cleanVersion(deps.vue), kind: "STATIC", buildCommand: build ?? "npx vue-cli-service build", outputDirectory: "dist", meta: { ...meta, spa: true } };
  if ((forced === "create-react-app" || (!forced && has("react-scripts"))) && pick("create-react-app"))
    return { ...base, framework: "create-react-app", version: cleanVersion(deps["react-scripts"]), kind: "STATIC", buildCommand: build ?? "npx react-scripts build", outputDirectory: "build", meta: { ...meta, spa: true } };
  if ((forced === "solid" || (!forced && (has("@solidjs/start") || (has("solid-js") && has("vite"))))) && pick("solid")) {
    if (has("@solidjs/start"))
      return { ...base, framework: "solid", version: cleanVersion(deps["@solidjs/start"]), kind: "WEB", buildCommand: build, startCommand: "node .output/server/index.mjs" };
    return { ...base, framework: "solid", version: cleanVersion(deps["solid-js"]), kind: "STATIC", buildCommand: build ?? "npx vite build", outputDirectory: "dist", meta: { ...meta, spa: true } };
  }
  const serverLib = ["express", "fastify", "koa", "hono"].find((d) => has(d) || has(d === "hono" ? "@hono/node-server" : d));
  if ((forced === "vite" || (!forced && has("vite") && !serverLib && !start)) && pick("vite")) {
    return { ...base, framework: "vite", version: cleanVersion(deps.vite), kind: "STATIC", buildCommand: build ?? "npx vite build", outputDirectory: "dist", meta: { ...meta, spa: true } };
  }

  // Bun runtime
  if (isBun && (!forced || forced === "bun")) {
    const entry = startEntry(probe, pkg);
    return {
      ...base,
      language: "bun",
      framework: "bun",
      packageManager: "bun",
      installCommand: installCommandFor("bun", probe.has("bun.lockb") || probe.has("bun.lock")),
      kind: procfileWorker(probe) && !start && !entry ? "WORKER" : "WEB",
      buildCommand: scripts.build ? "bun run build" : null,
      startCommand: procfileCommand(probe) ?? (scripts.start ? "bun run start" : entry ? `bun ${entry}` : null),
    };
  }

  // generic node servers
  const fw = forced && ["express", "fastify", "koa", "hono", "node"].includes(forced) ? forced : (serverLib ?? "node");
  const entry = startEntry(probe, pkg);
  const procStart = procfileCommand(probe);
  const startCmd = procStart ?? start ?? (entry ? `node ${entry}` : null);
  if (!startCmd) {
    if (build && !serverLib) {
      // a build-only project (static site generator) → serve the output
      const out = ["dist", "build", "out", "public", "_site"].find((d) => probe.isDir(d)) ?? "dist";
      notes.push(`No start script — serving the build output (${out}) as a static site`);
      return { ...base, framework: "node", kind: "STATIC", buildCommand: build, outputDirectory: settings.outputDirectory ?? out };
    }
    notes.push('No "start" script / entry file found — set a start command in Build & Development settings');
  }
  const workerOnly = !!procfileWorker(probe) && !procStart && !start;
  return {
    ...base,
    framework: fw,
    version: serverLib ? cleanVersion(deps[serverLib]) : null,
    kind: workerOnly ? "WORKER" : "WEB",
    buildCommand: build,
    startCommand: startCmd ?? (workerOnly ? null : null),
  };
}

function startEntry(probe: Probe, pkg: Pkg): string | null {
  if (pkg.main && probe.has(pkg.main)) return pkg.main;
  return probe.first("server.js", "index.js", "app.js", "main.js", "server.mjs", "index.mjs", "src/index.js", "src/server.js", "index.ts", "src/index.ts", "server.ts");
}

// ── Deno ──

function denoDraft(probe: Probe): Draft {
  const cfg = probe.json<{ tasks?: Record<string, string> }>(probe.first("deno.json", "deno.jsonc") ?? "deno.json");
  const entry = probe.first("main.ts", "server.ts", "mod.ts", "main.js", "src/main.ts", "app.ts");
  const start = cfg?.tasks?.start ? "deno task start" : entry ? `deno run --allow-net --allow-env --allow-read ${entry}` : null;
  const notes = start ? [] : ['No "start" task or main.ts — set a start command'];
  return {
    framework: "deno",
    language: "deno",
    kind: "WEB",
    strategy: "generated",
    installCommand: entry ? `deno cache ${entry}` : null,
    buildCommand: cfg?.tasks?.build ? "deno task build" : null,
    startCommand: start,
    port: 8000,
    notes,
    meta: { entry },
  };
}

// ── Python ──

function pythonDeps(probe: Probe): { tool: "uv" | "poetry" | "pipenv" | "pip" | "pyproject" | "none"; text: string } {
  const req = probe.read("requirements.txt") ?? "";
  const pyproject = probe.read("pyproject.toml") ?? "";
  const pipfile = probe.read("Pipfile") ?? "";
  const text = [req, pyproject, pipfile].join("\n").toLowerCase();
  if (probe.has("uv.lock")) return { tool: "uv", text };
  if (probe.has("poetry.lock") || /\[tool\.poetry\]/.test(pyproject)) return { tool: "poetry", text };
  if (probe.has("requirements.txt")) return { tool: "pip", text };
  if (probe.has("Pipfile")) return { tool: "pipenv", text };
  if (pyproject) return { tool: "pyproject", text };
  return { tool: "none", text };
}

function findPyApp(probe: Probe, re: RegExp, candidates: string[]): { module: string; varName: string } | null {
  const files = [...candidates.filter((c) => probe.has(c)), ...probe.find((r) => r.endsWith(".py"), 2, 80).filter((f) => !candidates.includes(f))];
  for (const f of files) {
    const src = probe.read(f) ?? "";
    const m = src.match(re);
    if (m) {
      const module = f.replace(/\.py$/, "").replace(/\//g, ".").replace(/^src\./, "");
      return { module: f.startsWith("src/") ? module : module, varName: m[1]! };
    }
  }
  return null;
}

function pythonDraft(probe: Probe, forced: string | null): Draft {
  const deps = pythonDeps(probe);
  const pyproject = probe.read("pyproject.toml") ?? "";
  const reqPy = pyproject.match(/requires-python\s*=\s*["']([^"']+)["']/)?.[1] ?? pyproject.match(/^\s*python\s*=\s*["']([^"']+)["']/m)?.[1];
  const pythonVersion =
    resolvePythonVersion(probe.read("runtime.txt")?.trim()) ??
    resolvePythonVersion(probe.read(".python-version")?.trim().split("\n")[0]) ??
    resolvePythonVersion(reqPy) ??
    DEFAULT_PYTHON_VERSION;
  const has = (name: string) => new RegExp(`(^|[\\s"'\\[,])${name}([\\s<>=~!;\\[\\]"',]|$)`, "m").test(deps.text);
  const notes: string[] = [];
  const meta: Detection["meta"] = { depsTool: deps.tool };
  const proc = procfileCommand(probe);
  const base = { language: "python" as Language, strategy: "generated" as const, pythonVersion, port: 8000, notes, meta };
  const pick = (id: string) => !forced || forced === id || forced === "python";

  if ((forced === "django" || (!forced && probe.has("manage.py"))) && pick("django")) {
    // <project>/wsgi.py next to settings.py
    const wsgi = probe.find((r) => r.endsWith("/wsgi.py"), 2, 5)[0];
    const module = wsgi ? wsgi.replace(/\.py$/, "").replace(/\//g, ".") : null;
    meta.wsgiModule = module;
    meta.needsGunicorn = !has("gunicorn") && !has("uvicorn");
    if (!module && !proc) notes.push("Could not find <project>/wsgi.py — set a start command");
    return {
      ...base,
      framework: "django",
      version: null,
      kind: "WEB",
      buildCommand: "python manage.py collectstatic --noinput",
      startCommand: proc ?? (module ? `gunicorn ${module}:application --bind 0.0.0.0:$PORT --workers 2 --access-logfile -` : null),
    };
  }
  if ((forced === "fastapi" || (!forced && has("fastapi"))) && pick("fastapi")) {
    const app = findPyApp(probe, /^(\w+)\s*=\s*FastAPI\(/m, ["main.py", "app.py", "app/main.py", "src/main.py", "api/main.py", "server.py"]);
    meta.needsUvicorn = !has("uvicorn");
    meta.appModule = app ? `${app.module}:${app.varName}` : null;
    if (!app && !proc) notes.push("Could not find `app = FastAPI()` — set a start command");
    return {
      ...base,
      framework: "fastapi",
      kind: "WEB",
      startCommand: proc ?? (app ? `uvicorn ${app.module}:${app.varName} --host 0.0.0.0 --port $PORT --proxy-headers --forwarded-allow-ips '*'` : null),
    };
  }
  if ((forced === "flask" || (!forced && has("flask"))) && pick("flask")) {
    const app = findPyApp(probe, /^(\w+)\s*=\s*Flask\(/m, ["app.py", "main.py", "wsgi.py", "app/__init__.py", "src/app.py", "server.py"]);
    meta.needsGunicorn = !has("gunicorn");
    const mod = app ? app.module.replace(/\.__init__$/, "") : null;
    meta.appModule = app ? `${mod}:${app.varName}` : null;
    if (!app && !proc) notes.push("Could not find `app = Flask(__name__)` — set a start command");
    return {
      ...base,
      framework: "flask",
      kind: "WEB",
      startCommand: proc ?? (app ? `gunicorn ${mod}:${app.varName} --bind 0.0.0.0:$PORT --workers 2 --access-logfile -` : null),
    };
  }
  const entry = probe.first("main.py", "app.py", "server.py", "bot.py", "worker.py", "run.py");
  const worker = procfileWorker(probe);
  const start = proc ?? (entry ? `python ${entry}` : worker);
  if (!start) notes.push("No Procfile / main.py found — set a start command");
  const kind = !proc && (worker || (entry && /bot|worker/.test(entry))) ? "WORKER" : "WEB";
  return { ...base, framework: "python", kind, startCommand: start };
}

// ── PHP ──

function phpDraft(probe: Probe, forced: string | null): Draft {
  const composer = probe.json<{ require?: Record<string, string> }>("composer.json");
  const phpReq = cleanVersion(composer?.require?.php);
  const phpVersion = phpReq && /^8\.[1-4]/.test(phpReq) ? phpReq.split(".").slice(0, 2).join(".") : "8.3";
  const isLaravel = forced === "laravel" || (!forced && (!!composer?.require?.["laravel/framework"] || probe.has("artisan")));
  const docRoot = isLaravel ? "public" : probe.has("public/index.php") && !probe.has("index.php") ? "public" : ".";
  const hasNode = probe.has("package.json");
  return {
    framework: isLaravel ? "laravel" : "php",
    version: isLaravel ? cleanVersion(composer?.require?.["laravel/framework"]) : phpVersion,
    language: "php",
    kind: "WEB",
    strategy: "generated",
    installCommand: composer ? "composer install --no-dev --optimize-autoloader --no-interaction --no-progress" : null,
    buildCommand: hasNode && isLaravel ? "npm run build" : null,
    startCommand: "apache2-foreground",
    outputDirectory: docRoot,
    port: 8080,
    meta: { phpVersion, docRoot, composer: !!composer, nodeAssets: hasNode },
  };
}

// ── Go ──

function goDraft(probe: Probe): Draft {
  const mod = probe.read("go.mod") ?? "";
  const goVersion = mod.match(/^go\s+(\d+\.\d+)/m)?.[1] ?? "1.23";
  // main package: root, else cmd/<x>
  let pkgDir = ".";
  const rootMain = probe.list().filter((f) => f.endsWith(".go")).some((f) => /^package\s+main\b/m.test(probe.read(f) ?? ""));
  if (!rootMain) {
    const mains = probe.find((r) => r.endsWith(".go") && /^package\s+main\b/m.test(probe.read(r) ?? ""), 3, 10);
    const cmd = mains.find((m) => m.startsWith("cmd/")) ?? mains[0];
    if (cmd) pkgDir = "./" + path.dirname(cmd);
  }
  return {
    framework: "go",
    version: goVersion,
    language: "go",
    kind: "WEB",
    strategy: "generated",
    installCommand: "go mod download",
    buildCommand: `go build -trimpath -ldflags="-s -w" -o /out/app ${pkgDir}`,
    startCommand: "/app/app",
    port: 8080,
    meta: { goVersion: Number(goVersion.split(".")[1]) >= 21 ? goVersion : "1.23", mainPackage: pkgDir },
  };
}

// ── Rust ──

function rustDraft(probe: Probe): Draft {
  const toml = probe.read("Cargo.toml") ?? "";
  const pkgSection = toml.split(/^\[/m).find((s) => s.startsWith("package]")) ?? "";
  const name = pkgSection.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1] ?? null;
  const binSection = toml.split(/^\[\[/m).find((s) => s.startsWith("bin]]"));
  const bin = binSection?.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1] ?? name;
  const notes = bin ? [] : ["Could not read the binary name from Cargo.toml"];
  if (toml.includes("[workspace]") && !name) notes.push("Cargo workspace: set the start command to the binary to run (e.g. /app/server)");
  return {
    framework: "rust",
    language: "rust",
    kind: "WEB",
    strategy: "generated",
    buildCommand: "cargo build --release --locked",
    startCommand: bin ? `/app/${bin}` : null,
    port: 8080,
    notes,
    meta: { binary: bin, locked: probe.has("Cargo.lock") },
  };
}

// ── Ruby ──

function rubyDraft(probe: Probe, forced: string | null): Draft {
  const gemfile = probe.read("Gemfile") ?? "";
  const isRails = forced === "rails" || (!forced && (/gem\s+["']rails["']/.test(gemfile) || probe.has("bin/rails")));
  const rubyVersion = (probe.read(".ruby-version")?.trim().replace(/^ruby-/, "") ?? gemfile.match(/^ruby\s+["']([\d.]+)["']/m)?.[1] ?? "3.3").split(".").slice(0, 2).join(".");
  const proc = procfileCommand(probe);
  if (isRails) {
    return {
      framework: "rails",
      language: "ruby",
      kind: "WEB",
      strategy: "generated",
      installCommand: "bundle install",
      buildCommand: probe.has("app/assets") || probe.has("app/javascript") ? "bundle exec rails assets:precompile" : null,
      startCommand: proc ?? "bundle exec rails server -b 0.0.0.0 -p $PORT",
      port: 3000,
      meta: { rubyVersion },
    };
  }
  const usesPuma = /gem\s+["']puma["']/.test(gemfile);
  return {
    framework: "ruby",
    language: "ruby",
    kind: "WEB",
    strategy: "generated",
    installCommand: probe.has("Gemfile") ? "bundle install" : null,
    startCommand: proc ?? (probe.has("config.ru") ? (usesPuma ? "bundle exec puma -b tcp://0.0.0.0:$PORT config.ru" : "bundle exec rackup -o 0.0.0.0 -p $PORT config.ru") : probe.first("app.rb", "main.rb") ? `bundle exec ruby ${probe.first("app.rb", "main.rb")}` : null),
    port: 3000,
    meta: { rubyVersion, rack: probe.has("config.ru") },
  };
}

// ── Java ──

function javaDraft(probe: Probe): Draft {
  const maven = probe.has("pom.xml");
  const src = (maven ? probe.read("pom.xml") : probe.read(probe.first("build.gradle.kts", "build.gradle") ?? "")) ?? "";
  const spring = /spring-boot/.test(src);
  const javaVersion = src.match(/<java\.version>(\d+)<\/java\.version>/)?.[1] ?? src.match(/JavaLanguageVersion\.of\((\d+)\)/)?.[1] ?? src.match(/sourceCompatibility\s*=\s*['"]?(?:JavaVersion\.VERSION_)?(\d+)/)?.[1] ?? "21";
  const wrapper = maven ? probe.has("mvnw") : probe.has("gradlew");
  return {
    framework: spring ? "spring-boot" : "spring-boot",
    language: "java",
    kind: "WEB",
    strategy: "generated",
    buildCommand: maven
      ? `${wrapper ? "./mvnw" : "mvn"} -B -q -DskipTests package`
      : `${wrapper ? "./gradlew" : "gradle"} --no-daemon -q ${spring ? "bootJar" : "build"} -x test`,
    startCommand: "java $JAVA_OPTS -Dserver.port=$PORT -jar /app/app.jar",
    port: 8080,
    notes: spring ? [] : ["No Spring Boot plugin found — expecting a runnable (fat) jar"],
    meta: { buildTool: maven ? "maven" : "gradle", javaVersion: ["17", "21", "25"].includes(javaVersion) ? javaVersion : "21", wrapper },
  };
}

// ── .NET ──

function dotnetDraft(probe: Probe): Draft {
  const projects = probe.find((r) => /\.(csproj|fsproj)$/.test(r), 3, 20);
  // prefer a web project
  const web = projects.find((p) => /Sdk="Microsoft\.NET\.Sdk\.Web"/.test(probe.read(p) ?? "")) ?? projects[0] ?? null;
  const proj = web ? probe.read(web) ?? "" : "";
  const tfm = proj.match(/<TargetFramework>net(\d+\.\d+)<\/TargetFramework>/)?.[1] ?? "8.0";
  const asm = proj.match(/<AssemblyName>([^<]+)<\/AssemblyName>/)?.[1] ?? (web ? path.basename(web).replace(/\.(cs|fs)proj$/, "") : null);
  return {
    framework: "dotnet",
    version: tfm,
    language: "dotnet",
    kind: "WEB",
    strategy: "generated",
    installCommand: web ? `dotnet restore "${web}"` : "dotnet restore",
    buildCommand: web ? `dotnet publish "${web}" -c Release -o /out --no-restore` : "dotnet publish -c Release -o /out --no-restore",
    startCommand: asm ? `dotnet ${asm}.dll` : null,
    port: 8080,
    notes: web ? [] : ["No .csproj found"],
    meta: { project: web, tfm: ["8.0", "9.0", "10.0"].includes(tfm) ? tfm : "8.0", assembly: asm },
  };
}

// ── Elixir ──

function elixirDraft(probe: Probe): Draft {
  const mix = probe.read("mix.exs") ?? "";
  const phoenix = /:phoenix\b/.test(mix);
  const app = mix.match(/app:\s*:(\w+)/)?.[1] ?? "app";
  return {
    framework: "phoenix",
    language: "elixir",
    kind: "WEB",
    strategy: "generated",
    installCommand: "mix deps.get --only prod",
    buildCommand: phoenix && probe.has("assets") ? "mix assets.deploy && mix release" : "mix release",
    startCommand: `/app/bin/${app} start`,
    port: 4000,
    notes: phoenix ? [] : ["Plain Mix project: expecting a release that starts an HTTP server on $PORT"],
    meta: { app, phoenix },
  };
}

// ── Static ──

function staticDraft(probe: Probe, settings: BuildSettings): Draft {
  const out = settings.outputDirectory ?? (probe.has("index.html") ? "." : "public");
  return {
    framework: "static",
    language: "static",
    kind: "STATIC",
    strategy: "generated",
    outputDirectory: out,
    port: 3000,
    meta: { spa: false },
  };
}

/** For tests / UI: all preset ids. */
export const PRESET_IDS = FRAMEWORK_PRESETS.map((p) => p.id);
export { Probe };
