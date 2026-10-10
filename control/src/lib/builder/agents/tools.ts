/**
 * Agent tools (OpenAI function schema, zod-validated, path-safe). Every tool returns plain text for the model;
 * errors are returned as text too (the model gets a chance to correct itself) — only cancellation throws.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { z, type ZodTypeAny } from "zod";
import type { AgentDeps } from "./adapters";
import { applyEdits, diffStats, lineDiff, parseSearchReplaceBlocks, PatchError, type Edit } from "./patch";
import { readDoc, DOC_TOPICS } from "./prompts";
import { parseArgs } from "./repair";
import type { CheckKind, Role, RunEventType, RunRecord, ToolSchema } from "./types";

export type ToolCtx = {
  deps: AgentDeps;
  run: RunRecord;
  projectId: string;
  root: string;
  role: Role;
  signal?: AbortSignal;
  emit: (type: RunEventType, data: Record<string, unknown>) => Promise<void>;
  /** the run's backend ref (null until attached) */
  baseRef: () => string | null;
  /** files changed in this agent turn (for commit messages / fixer focus) */
  changed: Set<string>;
  /** check iteration (for check events) */
  iteration?: number;
  /** restrict writes (e.g. the Designer owns only theme/layout files) */
  writeAllow?: { re: RegExp; why: string };
};

async function writablePath(ctx: ToolCtx, p: string) {
  const r = await safePath(ctx.root, p, { write: true });
  if (ctx.writeAllow && !ctx.writeAllow.re.test(r.rel)) throw new ToolInputError(`${r.rel} is not yours to change — ${ctx.writeAllow.why}`);
  return r;
}

export type ToolDef<S extends ZodTypeAny = ZodTypeAny> = {
  name: string;
  description: string;
  schema: S;
  mutating: boolean;
  run: (args: z.infer<S>, ctx: ToolCtx) => Promise<string>;
};

export class ToolInputError extends Error {}

// ───────────────────────────── zod → JSON schema (subset) ─────────────────────────────

export function zodToJsonSchema(s: ZodTypeAny): Record<string, unknown> {
  const def = s._def as { typeName: string; description?: string; [k: string]: unknown };
  const withDesc = (o: Record<string, unknown>) => (s.description ? { ...o, description: s.description } : o);
  switch (def.typeName) {
    case "ZodObject": {
      const shape = (s as unknown as z.ZodObject<z.ZodRawShape>).shape;
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [k, v] of Object.entries(shape)) {
        properties[k] = zodToJsonSchema(v as ZodTypeAny);
        if (!(v as ZodTypeAny).isOptional()) required.push(k);
      }
      return withDesc({ type: "object", properties, ...(required.length ? { required } : {}) });
    }
    case "ZodString":
      return withDesc({ type: "string" });
    case "ZodNumber":
      return withDesc({ type: (def.checks as { kind: string }[] | undefined)?.some((c) => c.kind === "int") ? "integer" : "number" });
    case "ZodBoolean":
      return withDesc({ type: "boolean" });
    case "ZodArray":
      return withDesc({ type: "array", items: zodToJsonSchema(def.type as ZodTypeAny) });
    case "ZodEnum":
      return withDesc({ type: "string", enum: def.values as string[] });
    case "ZodOptional":
    case "ZodNullable":
      return { ...zodToJsonSchema(def.innerType as ZodTypeAny), ...(s.description ? { description: s.description } : {}) };
    case "ZodDefault":
      return { ...zodToJsonSchema(def.innerType as ZodTypeAny), ...(s.description ? { description: s.description } : {}) };
    case "ZodEffects":
      return zodToJsonSchema(def.schema as ZodTypeAny);
    default:
      return withDesc({});
  }
}

export function toolSchemas(tools: ToolDef[]): ToolSchema[] {
  return tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: zodToJsonSchema(t.schema) } }));
}

// ───────────────────────────── path safety ─────────────────────────────

const DENY_SEGMENTS = new Set([".git", "node_modules", ".next", ".turbo", ".pnpm-store"]);
const MAX_WRITE = 300 * 1024;

/** Validates a workspace-relative path and returns its absolute form (throws ToolInputError). */
export async function safePath(root: string, p: string, opts: { write?: boolean } = {}): Promise<{ abs: string; rel: string }> {
  if (typeof p !== "string" || !p.trim()) throw new ToolInputError("path is required");
  let rel = p.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (rel.startsWith("/") || /^[a-zA-Z]:/.test(rel) || rel.includes("\0")) throw new ToolInputError(`path must be relative to the project root: ${p}`);
  rel = path.posix.normalize(rel);
  if (rel === "." || rel === "") rel = ".";
  if (rel.startsWith("../") || rel === "..") throw new ToolInputError(`path escapes the project: ${p}`);
  const segs = rel.split("/");
  if (segs.some((s) => DENY_SEGMENTS.has(s))) throw new ToolInputError(`path not allowed: ${p}`);
  if (opts.write) {
    const base = segs[segs.length - 1];
    if (/^\.env/.test(base)) throw new ToolInputError("environment files are managed by the platform (the backend URL and anon key are injected automatically); never write .env files");
    if (/^(pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$/.test(base)) throw new ToolInputError("lock files are managed by add_dependency");
  }
  const abs = path.resolve(root, rel);
  const realRoot = await fs.realpath(root);
  // resolve the nearest existing ancestor (symlink escape protection)
  let probe = abs;
  for (;;) {
    try {
      const real = await fs.realpath(probe);
      if (real !== realRoot && !real.startsWith(realRoot + path.sep)) throw new ToolInputError(`path escapes the project: ${p}`);
      break;
    } catch (e) {
      if (e instanceof ToolInputError) throw e;
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
  }
  return { abs, rel };
}

/** Security guard for generated code. Returns an error message or null. */
export function contentGuard(rel: string, content: string): string | null {
  if (/NEXT_PUBLIC_[A-Z0-9_]*SERVICE[A-Z0-9_]*/.test(content)) return "never expose the service_role key through NEXT_PUBLIC_* variables — the browser must only use the anon key";
  const isClient = /^\s*(['"])use client\1/m.test(content.slice(0, 400));
  if (isClient && /service_?role/i.test(content)) return "client components must never reference the service_role key — use the anon key with RLS, or move the code to a server route";
  if (/eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}/.test(content)) return "do not hardcode JWTs/API keys — read process.env.NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY instead";
  if (/sk-[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{30,}/.test(content)) return "do not hardcode secret API keys in source files";
  if (rel.endsWith(".json")) {
    try {
      JSON.parse(content);
    } catch (e) {
      return `invalid JSON: ${(e as Error).message}`;
    }
  }
  return null;
}

async function readText(abs: string): Promise<string | null> {
  try {
    return await fs.readFile(abs, "utf8");
  } catch {
    return null;
  }
}

async function writeWithEvent(ctx: ToolCtx, rel: string, abs: string, content: string, before: string | null) {
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
  ctx.changed.add(rel);
  const diff = lineDiff(before ?? "", content, { maxLines: 300 });
  await ctx.emit("file", { role: ctx.role, path: rel, action: before === null ? "create" : "modify", diff, ...diffStats(diff) });
}

const IGNORED_DIRS = new Set([".git", "node_modules", ".next", ".turbo", ".vercel", "dist", "out", ".pnpm-store"]);

export async function walkFiles(root: string, dir = "", out: { path: string; size: number }[] = [], limit = 2000): Promise<{ path: string; size: number }[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(path.join(root, dir), { withFileTypes: true });
  } catch {
    return out;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if (out.length >= limit) break;
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (IGNORED_DIRS.has(e.name)) continue;
      await walkFiles(root, rel, out, limit);
    } else if (e.isFile()) {
      const st = await fs.stat(path.join(root, rel)).catch(() => null);
      out.push({ path: rel, size: st?.size ?? 0 });
    }
  }
  return out;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n… (${s.length - n} more characters)` : s);

const SQL_DENY: [RegExp, string][] = [
  [/\b(create|alter|drop)\s+role\b/i, "roles are managed by the platform"],
  [/\balter\s+system\b/i, "ALTER SYSTEM is not allowed"],
  [/\bcopy\b[\s\S]*\bprogram\b/i, "COPY … PROGRAM is not allowed"],
  [/\bdrop\s+schema\s+(public|auth|storage|realtime|extensions)\b/i, "dropping platform schemas is not allowed"],
  [/\bdrop\s+database\b/i, "DROP DATABASE is not allowed"],
  [/\b(alter|drop)\s+table\s+(auth|storage)\./i, "auth/storage tables are managed by the platform (use triggers or your own tables)"],
];

function migrationStamp(d = new Date()) {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

// ───────────────────────────── tool definitions ─────────────────────────────

const t = <S extends ZodTypeAny>(d: ToolDef<S>): ToolDef => d as unknown as ToolDef;

export const TOOLS: Record<string, ToolDef> = {
  list_files: t({
    name: "list_files",
    description: "List project files (recursively). Optional dir to narrow. Ignores node_modules/.next/.git.",
    schema: z.object({ dir: z.string().optional().describe("sub directory, e.g. 'app' or 'components/ui'") }),
    mutating: false,
    async run({ dir }, ctx) {
      const { rel } = await safePath(ctx.root, dir || ".");
      const files = await walkFiles(ctx.root, rel === "." ? "" : rel, [], 600);
      if (!files.length) return "(no files)";
      return files.map((f) => `${f.path} (${f.size}b)`).join("\n");
    },
  }),

  read_file: t({
    name: "read_file",
    description: "Read a file. Returns the exact content (use it to copy SEARCH text for apply_patch). Optional 1-based line range for big files.",
    schema: z.object({ path: z.string(), start_line: z.number().int().optional(), end_line: z.number().int().optional() }),
    mutating: false,
    async run({ path: p, start_line, end_line }, ctx) {
      const { abs, rel } = await safePath(ctx.root, p);
      const content = await readText(abs);
      if (content === null) return `ERROR: ${rel} does not exist. Use list_files to see what exists.`;
      const lines = content.split("\n");
      if (start_line || end_line) {
        const s = Math.max(1, start_line ?? 1);
        const e = Math.min(lines.length, end_line ?? lines.length);
        return `${rel} lines ${s}-${e} of ${lines.length}:\n${lines.slice(s - 1, e).join("\n")}`;
      }
      return `${rel} (${lines.length} lines):\n${clip(content, 60_000)}`;
    },
  }),

  write_file: t({
    name: "write_file",
    description: "Create or overwrite a file with the COMPLETE content. Prefer apply_patch for small changes to existing files.",
    schema: z.object({ path: z.string(), content: z.string() }),
    mutating: true,
    async run({ path: p, content }, ctx) {
      const { abs, rel } = await writablePath(ctx, p);
      if (content.length > MAX_WRITE) return `ERROR: file too large (${content.length} bytes, max ${MAX_WRITE}). Split it into smaller modules.`;
      const guard = contentGuard(rel, content);
      if (guard) return `ERROR: rejected — ${guard}`;
      const before = await readText(abs);
      if (before === content) return `${rel} unchanged`;
      await writeWithEvent(ctx, rel, abs, content, before);
      return `${before === null ? "created" : "updated"} ${rel} (${content.split("\n").length} lines)`;
    },
  }),

  apply_patch: t({
    name: "apply_patch",
    description:
      "Edit an existing file with search/replace edits (smallest change). Each `search` must match existing lines (whitespace/indentation differences are tolerated) and be unique. Pass `edits` as a list, or `patch` as SEARCH/REPLACE blocks:\n<<<<<<< SEARCH\nold lines\n=======\nnew lines\n>>>>>>> REPLACE",
    schema: z.object({
      path: z.string(),
      edits: z.array(z.object({ search: z.string(), replace: z.string() })).optional(),
      patch: z.string().optional().describe("alternative to edits: one or more SEARCH/REPLACE blocks"),
    }),
    mutating: true,
    async run({ path: p, edits, patch }, ctx) {
      const { abs, rel } = await writablePath(ctx, p);
      let list: Edit[] = edits ?? [];
      if (patch) {
        try {
          list = [...list, ...parseSearchReplaceBlocks(patch)];
        } catch (e) {
          return `ERROR: ${(e as Error).message}`;
        }
      }
      if (!list.length) return "ERROR: no edits given (pass `edits` or `patch`)";
      const before = await readText(abs);
      if (before === null) {
        if (list.every((e) => !e.search.trim())) {
          const content = list.map((e) => e.replace).join("\n");
          const guard = contentGuard(rel, content);
          if (guard) return `ERROR: rejected — ${guard}`;
          await writeWithEvent(ctx, rel, abs, content.endsWith("\n") ? content : content + "\n", null);
          return `created ${rel}`;
        }
        return `ERROR: ${rel} does not exist — use write_file to create it`;
      }
      try {
        const r = applyEdits(before, list);
        const guard = contentGuard(rel, r.content);
        if (guard) return `ERROR: rejected — ${guard}`;
        if (r.content === before) return `${rel} unchanged (the replacement equals the original)`;
        await writeWithEvent(ctx, rel, abs, r.content, before);
        return `patched ${rel} (${list.length} edit${list.length > 1 ? "s" : ""}: ${r.strategies.join(", ")})`;
      } catch (e) {
        if (e instanceof PatchError) return `ERROR: ${e.message}`;
        throw e;
      }
    },
  }),

  delete_file: t({
    name: "delete_file",
    description: "Delete a file.",
    schema: z.object({ path: z.string() }),
    mutating: true,
    async run({ path: p }, ctx) {
      const { abs, rel } = await writablePath(ctx, p);
      const before = await readText(abs);
      if (before === null) return `${rel} does not exist`;
      await fs.rm(abs);
      ctx.changed.add(rel);
      await ctx.emit("file", { role: ctx.role, path: rel, action: "delete" });
      return `deleted ${rel}`;
    },
  }),

  rename_file: t({
    name: "rename_file",
    description: "Rename/move a file (update imports yourself afterwards).",
    schema: z.object({ from: z.string(), to: z.string() }),
    mutating: true,
    async run({ from, to }, ctx) {
      const a = await writablePath(ctx, from);
      const b = await writablePath(ctx, to);
      if ((await readText(a.abs)) === null) return `ERROR: ${a.rel} does not exist`;
      if ((await readText(b.abs)) !== null) return `ERROR: ${b.rel} already exists`;
      await fs.mkdir(path.dirname(b.abs), { recursive: true });
      await fs.rename(a.abs, b.abs);
      ctx.changed.add(a.rel).add(b.rel);
      await ctx.emit("file", { role: ctx.role, path: b.rel, from: a.rel, action: "rename" });
      return `renamed ${a.rel} → ${b.rel}`;
    },
  }),

  add_dependency: t({
    name: "add_dependency",
    description: "Install npm packages (only when the template doesn't already provide them — shadcn/ui, lucide-react, @supabase/supabase-js, tailwind are already installed).",
    schema: z.object({ packages: z.array(z.string()), dev: z.boolean().optional() }),
    mutating: true,
    async run({ packages, dev }, ctx) {
      const bad = packages.find((p) => !/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(@[\w.^~<>=*-]+)?$/i.test(p));
      if (bad) return `ERROR: invalid package name ${bad}`;
      if (!packages.length) return "ERROR: no packages";
      if (packages.length > 8) return "ERROR: at most 8 packages at once";
      const r = await ctx.deps.workspace.addDependency(ctx.projectId, packages, { dev });
      ctx.changed.add("package.json");
      await ctx.emit("tool", { role: ctx.role, name: "add_dependency", args: packages.join(" "), ok: r.ok, result: clip(r.output, 300) });
      return r.ok ? `installed ${packages.join(", ")}` : `ERROR installing: ${clip(r.output, 2000)}`;
    },
  }),

  run_check: t({
    name: "run_check",
    description: "Run a project check: typecheck (tsc), lint (next lint) or build (next build). Returns errors to fix.",
    schema: z.object({ kind: z.enum(["typecheck", "lint", "build"]) }),
    mutating: false,
    async run({ kind }, ctx) {
      const r = await ctx.deps.checks.run(ctx.projectId, kind as CheckKind, { signal: ctx.signal });
      await ctx.emit("check", { kind, ok: r.ok, skipped: !!r.skipped, output: clip(r.output, 3000), iteration: ctx.iteration ?? null, by: ctx.role });
      if (r.skipped) return `${kind}: skipped (${r.output})`;
      return r.ok ? `${kind}: OK` : `${kind} FAILED:\n${clip(r.output, 6000)}`;
    },
  }),

  get_preview_errors: t({
    name: "get_preview_errors",
    description: "Recent runtime errors from the live preview (dev server + browser console).",
    schema: z.object({}),
    mutating: false,
    async run(_a, ctx) {
      const errs = await ctx.deps.checks.previewErrors(ctx.projectId);
      return errs.length ? clip(errs.slice(0, 10).join("\n---\n"), 6000) : "no preview errors";
    },
  }),

  base_sql: t({
    name: "base_sql",
    description:
      "Run SQL on the app's LevantBase (Postgres) database as admin. For schema changes pass migration_name: the SQL is saved as supabase/migrations/<timestamp>_<name>.sql after it applied successfully. Always enable RLS + add policies for new tables.",
    schema: z.object({
      sql: z.string(),
      description: z.string().describe("what this SQL does, for the user"),
      migration_name: z.string().optional().describe("snake_case name; set for schema changes (create table, policies, functions)"),
    }),
    mutating: true,
    async run({ sql, description, migration_name }, ctx) {
      const ref = ctx.baseRef();
      if (!ref) return "ERROR: no backend attached to this app yet";
      for (const [re, why] of SQL_DENY) if (re.test(sql)) return `ERROR: rejected — ${why}`;
      const r = await ctx.deps.backend.sql(ref, sql);
      await ctx.emit("sql", { description, ok: r.ok, error: r.error ?? null, migration: migration_name ?? null, sql: clip(sql, 4000) });
      if (!r.ok) return `SQL ERROR: ${r.error}\nFix the SQL and try again (statements before the error were rolled back only if you wrapped them in a transaction).`;
      let saved = "";
      if (migration_name) {
        const name = migration_name.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "migration";
        const rel = `supabase/migrations/${migrationStamp()}_${name}.sql`;
        const { abs } = await safePath(ctx.root, rel, { write: true });
        await writeWithEvent(ctx, rel, abs, sql.trim() + "\n", null);
        saved = ` — saved as ${rel}`;
      }
      const rows = r.rows.length ? `\n${clip(JSON.stringify(r.rows.slice(0, 20)), 3000)}` : "";
      return `OK (${r.rowCount} rows)${saved}${rows}`;
    },
  }),

  base_create_bucket: t({
    name: "base_create_bucket",
    description: "Create a Storage bucket (public = files readable by URL without auth). Add storage.objects policies with base_sql for uploads.",
    schema: z.object({ name: z.string(), public: z.boolean().optional() }),
    mutating: true,
    async run({ name, public: pub }, ctx) {
      const ref = ctx.baseRef();
      if (!ref) return "ERROR: no backend attached to this app yet";
      if (!/^[a-z0-9][a-z0-9_-]{1,62}$/.test(name)) return "ERROR: bucket names are lowercase letters, digits, - and _";
      try {
        await ctx.deps.backend.createBucket(ref, name, { public: !!pub });
      } catch (e) {
        return `ERROR: ${(e as Error).message}`;
      }
      await ctx.emit("backend", { ref, action: "bucket", name, public: !!pub });
      return `bucket ${name} ready (${pub ? "public" : "private"})`;
    },
  }),

  base_types: t({
    name: "base_types",
    description: "Generate TypeScript types of the database into lib/database.types.ts (run after schema changes).",
    schema: z.object({}),
    mutating: true,
    async run(_a, ctx) {
      const ref = ctx.baseRef();
      if (!ref) return "ERROR: no backend attached to this app yet";
      let ts: string;
      try {
        ts = await ctx.deps.backend.types(ref);
      } catch (e) {
        return `ERROR: ${(e as Error).message}`;
      }
      const rel = "lib/database.types.ts";
      const { abs } = await safePath(ctx.root, rel, { write: true });
      const before = await readText(abs);
      if (before !== ts) await writeWithEvent(ctx, rel, abs, ts, before);
      const tables = [...ts.matchAll(/^\s{6}(\w+): \{\s*$/gm)].map((m) => m[1]).filter((n) => !["Row", "Insert", "Update", "Relationships", "Args", "Returns"].includes(n));
      return `wrote ${rel}. Use: import type { Database } from "@/lib/database.types"; createClient<Database>(…). Tables/objects: ${[...new Set(tables)].slice(0, 30).join(", ") || "(none)"}`;
    },
  }),

  deploy_function: t({
    name: "deploy_function",
    description: "Deploy a Deno edge function (supabase/functions/<slug>/index.ts) to the backend. Use only for server-side secrets/webhooks.",
    schema: z.object({ slug: z.string(), source: z.string(), verify_jwt: z.boolean().optional() }),
    mutating: true,
    async run({ slug, source, verify_jwt }, ctx) {
      const ref = ctx.baseRef();
      if (!ref) return "ERROR: no backend attached to this app yet";
      if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(slug)) return "ERROR: slug must be lowercase letters, digits and -";
      const rel = `supabase/functions/${slug}/index.ts`;
      const { abs } = await safePath(ctx.root, rel, { write: true });
      const guard = /eyJ[A-Za-z0-9_-]{15,}\./.test(source) ? "do not hardcode keys — use Deno.env.get(...)" : null;
      if (guard) return `ERROR: rejected — ${guard}`;
      try {
        const r = await ctx.deps.backend.deployFunction(ref, slug, source, { verifyJwt: verify_jwt ?? true, userId: ctx.run.createdById });
        await writeWithEvent(ctx, rel, abs, source, await readText(abs));
        await ctx.emit("backend", { ref, action: "function", slug, url: r.url });
        return `deployed ${slug} → ${r.url}`;
      } catch (e) {
        return `ERROR: ${(e as Error).message}`;
      }
    },
  }),

  read_docs: t({
    name: "read_docs",
    description: `Read a concise cheat sheet. Topics: ${DOC_TOPICS.join(", ")}.`,
    schema: z.object({ topic: z.string() }),
    mutating: false,
    async run({ topic }) {
      const d = await readDoc(topic);
      return d ?? `unknown topic "${topic}". Topics: ${DOC_TOPICS.join(", ")}`;
    },
  }),

  finish: t({
    name: "finish",
    description: "Call when your task is complete, with a one-paragraph summary of what you did.",
    schema: z.object({ summary: z.string() }),
    mutating: false,
    async run({ summary }) {
      return `finished: ${summary}`;
    },
  }),
};

const FILE_READ = ["list_files", "read_file", "read_docs"];
const FILE_WRITE = ["write_file", "apply_patch", "delete_file", "rename_file"];
const BASE = ["base_sql", "base_create_bucket", "base_types", "deploy_function"];

export const ROLE_TOOLS: Record<Role, string[]> = {
  planner: [],
  judge: [],
  summarizer: [],
  chat: [...FILE_READ, "get_preview_errors"],
  designer: [...FILE_READ, ...FILE_WRITE, "finish"],
  coder: [...FILE_READ, ...FILE_WRITE, "add_dependency", "run_check", "get_preview_errors", "finish"],
  backend: [...FILE_READ, ...FILE_WRITE, ...BASE, "add_dependency", "finish"],
  fixer: [...FILE_READ, ...FILE_WRITE, "add_dependency", "run_check", "get_preview_errors", "base_sql", "base_types", "finish"],
};

export function toolsFor(role: Role, opts: { backend?: boolean } = {}): ToolDef[] {
  return ROLE_TOOLS[role].filter((n) => opts.backend !== false || !BASE.includes(n)).map((n) => TOOLS[n]);
}

/** Validates + runs one tool call; never throws for tool-level errors. */
export async function executeTool(name: string, rawArgs: string, ctx: ToolCtx, allowed: Set<string>): Promise<{ ok: boolean; output: string; mutating: boolean }> {
  const def = TOOLS[name];
  if (!def || !allowed.has(name)) return { ok: false, output: `ERROR: unknown tool "${name}". Available: ${[...allowed].join(", ")}`, mutating: false };
  const parsedArgs = parseArgs(rawArgs);
  if (parsedArgs === null) return { ok: false, output: `ERROR: arguments for ${name} are not valid JSON. Send a JSON object matching the schema.`, mutating: false };
  const parsed = def.schema.safeParse(parsedArgs);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    return { ok: false, output: `ERROR: invalid arguments for ${name}: ${issues}`, mutating: false };
  }
  try {
    const output = await def.run(parsed.data, ctx);
    return { ok: !output.startsWith("ERROR") && !output.startsWith("SQL ERROR"), output, mutating: def.mutating };
  } catch (e) {
    if (ctx.signal?.aborted) throw e;
    if (e instanceof ToolInputError) return { ok: false, output: `ERROR: ${e.message}`, mutating: def.mutating };
    return { ok: false, output: `ERROR: ${name} failed: ${(e as Error).message.slice(0, 500)}`, mutating: def.mutating };
  }
}
