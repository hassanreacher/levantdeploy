import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Project } from "@prisma/client";
import { apiTools, getTool, minRoleFor, needsApproval, prepareToolCall, scopeFor, TOOLS } from "./tools";
import { checkAccess } from "./permissions";
import { buildRequest } from "./agent";
import { sanitizeForReplay, type StoredContent } from "./store";
import { readFromTar, safeRelPath } from "./repo-files";
import { detectSignals } from "./diagnose";
import { supportsServerFallback } from "./config";
import { SYSTEM_PROMPT } from "./prompt";

const project = { port: 3000, healthcheckPath: "/", memoryLimitMb: 512, framework: "nextjs" } as Project;

describe("tool input validation (eager input streaming → zod before running)", () => {
  it("accepts valid input and applies the schema", () => {
    const r = prepareToolCall("set_env_var", { key: "DATABASE_URL", value: "postgres://x", targets: ["PRODUCTION"] });
    expect(r.ok).toBe(true);
  });
  it.each([
    ["bad key", { key: "1BAD KEY", value: "x" }],
    ["reserved key", { key: "PORT", value: "3000" }],
    ["value not a string", { key: "A", value: 42 }],
    ["unknown target", { key: "A", value: "x", targets: ["STAGING"] }],
    ["missing value", { key: "A" }],
  ])("rejects set_env_var with %s", (_n, input) => {
    const r = prepareToolCall("set_env_var", input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("INVALID_INPUT");
  });
  it("bounds runtime settings", () => {
    expect(prepareToolCall("update_runtime_settings", { port: 70000 }).ok).toBe(false);
    expect(prepareToolCall("update_runtime_settings", { healthcheckPath: "health" }).ok).toBe(false);
    expect(prepareToolCall("update_runtime_settings", { memoryLimitMb: 16 }).ok).toBe(false);
    expect(prepareToolCall("update_runtime_settings", { port: 8080, healthcheckPath: null, replicas: 2 }).ok).toBe(true);
  });
  it("validates build settings, rollback target, logs and domains", () => {
    expect(prepareToolCall("update_build_settings", { rootDirectory: "../etc" }).ok).toBe(false);
    expect(prepareToolCall("update_build_settings", { nodeVersion: "latest" }).ok).toBe(false);
    expect(prepareToolCall("rollback", {}).ok).toBe(false);
    expect(prepareToolCall("get_build_logs", { tail: 5000 }).ok).toBe(false);
    expect(prepareToolCall("create_database", { engine: "SQLITE", name: "db" }).ok).toBe(false);
    expect(prepareToolCall("create_database", { engine: "POSTGRES", name: "Main_DB" }).ok).toBe(false);
  });
  it("rejects unknown tools", () => {
    const r = prepareToolCall("rm_rf", {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("UNKNOWN_TOOL");
  });
  it("returns the raw input in the error so the model can retry (JSON-encoded)", () => {
    const r = prepareToolCall("set_env_var", { key: 'A"B', value: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(() => JSON.parse(r.error)).not.toThrow();
  });
});

describe("approval + role policy", () => {
  const mutating = ["set_env_var", "delete_env_var", "update_build_settings", "update_runtime_settings", "redeploy", "rollback", "restart", "add_domain", "create_database", "run_base_sql"];
  it("every mutating tool needs approval; read tools don't", () => {
    for (const t of TOOLS) {
      const sample = t.name === "generate_dockerfile" ? {} : {};
      expect(needsApproval(t, sample), t.name).toBe(mutating.includes(t.name));
    }
  });
  it("generate_dockerfile only needs approval (and MEMBER) when saving", () => {
    const t = getTool("generate_dockerfile")!;
    expect(needsApproval(t, { save: false })).toBe(false);
    expect(minRoleFor(t, {})).toBe("VIEWER");
    expect(needsApproval(t, { save: true })).toBe(true);
    expect(minRoleFor(t, { save: true })).toBe("MEMBER");
  });
  it("run_base_sql: read-only SELECTs run directly, anything else needs approval (destructive → typed confirmation)", () => {
    const t = getTool("run_base_sql")!;
    expect(needsApproval(t, { sql: "select * from todos limit 5" })).toBe(false);
    expect(scopeFor(t, { sql: "select 1" })).toBe("base:read");
    expect(needsApproval(t, { sql: "insert into todos(title) values ('x')" })).toBe(true);
    expect(needsApproval(t, { sql: "select 1; drop table todos" })).toBe(true);
    expect(scopeFor(t, { sql: "update todos set done = true" })).toBe("base:write");
    expect(minRoleFor(t, { sql: "select 1" })).toBe("MEMBER");
    expect(t.confirmText).toBeTypeOf("function");
    expect(minRoleFor(getTool("get_base_project")!, {})).toBe("VIEWER");
  });
  it("revealing env values requires ADMIN + env:read", () => {
    const t = getTool("get_project")!;
    expect(minRoleFor(t, {})).toBe("VIEWER");
    expect(minRoleFor(t, { reveal_env_values: "masked" })).toBe("ADMIN");
    expect(scopeFor(t, { reveal_env_values: "plain" })).toBe("env:read");
  });
  it("destructive tools ask for a typed confirmation", () => {
    expect(getTool("delete_env_var")!.confirmText).toBeTypeOf("function");
    expect(getTool("rollback")!.confirmText).toBeTypeOf("function");
    expect(getTool("set_env_var")!.confirmText).toBeUndefined();
  });
  it("domains and databases are admin-only", () => {
    expect(minRoleFor(getTool("add_domain")!, {})).toBe("ADMIN");
    expect(minRoleFor(getTool("create_database")!, {})).toBe("ADMIN");
    expect(minRoleFor(getTool("redeploy")!, {})).toBe("MEMBER");
  });
});

describe("permission checks (same rules as requireProjectRole)", () => {
  const teamId = "team_1";
  it("non-members get NOT_FOUND (no existence leak)", () => {
    const r = checkAccess({ role: null, min: "VIEWER", teamId });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("NOT_FOUND");
  });
  it("enforces the role order VIEWER < MEMBER < ADMIN < OWNER", () => {
    expect(checkAccess({ role: "VIEWER", min: "VIEWER", teamId }).ok).toBe(true);
    expect(checkAccess({ role: "VIEWER", min: "MEMBER", teamId }).ok).toBe(false);
    expect(checkAccess({ role: "MEMBER", min: "ADMIN", teamId }).ok).toBe(false);
    expect(checkAccess({ role: "OWNER", min: "ADMIN", teamId }).ok).toBe(true);
  });
  it("checks API-token scopes and team restriction", () => {
    const token = { id: "t", teamId: null, scopes: ["projects:read", "logs:read"] };
    expect(checkAccess({ role: "OWNER", min: "VIEWER", scope: "logs:read", token, teamId }).ok).toBe(true);
    const r = checkAccess({ role: "OWNER", min: "MEMBER", scope: "env:write", token, teamId });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("FORBIDDEN");
    const other = checkAccess({ role: "OWNER", min: "VIEWER", token: { ...token, teamId: "team_2" }, teamId });
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.error.code).toBe("NOT_FOUND");
    expect(checkAccess({ role: "MEMBER", min: "MEMBER", scope: "env:write", token: { id: "t", teamId, scopes: ["*"] }, teamId }).ok).toBe(true);
  });
});

describe("request shape (Claude API rules)", () => {
  const msgs = [{ role: "user" as const, content: "hi" }];
  it("uses adaptive thinking, explicit effort, auto tool choice, caching and the default refusal fallback", () => {
    const r = buildRequest({ model: "claude-opus-5-5", effort: "medium" }, msgs);
    expect(r.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(r.output_config).toEqual({ effort: "medium" });
    expect(r.tool_choice).toEqual({ type: "auto" });
    expect(r.fallbacks).toBe("default");
    expect(r.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect(r.cache_control).toEqual({ type: "ephemeral" });
    expect(JSON.stringify(r.system)).toContain('"cache_control":{"type":"ephemeral"}');
  });
  it("omits the server-side fallback for Haiku 5.5 (not supported there)", () => {
    expect(supportsServerFallback("claude-haiku-5-5")).toBe(false);
    const r = buildRequest({ model: "claude-haiku-5-5", effort: "low" }, msgs);
    expect(r.fallbacks).toBeUndefined();
    expect(r.betas).toBeUndefined();
    expect(buildRequest({ model: "claude-sonnet-5-5", effort: "high" }, msgs).fallbacks).toBe("default");
  });
  it("tool definitions are sorted, deterministic and eager-streaming", () => {
    const a = apiTools();
    expect(a.map((t) => t.name)).toEqual([...a.map((t) => t.name)].sort());
    expect(a.every((t) => t.eager_input_streaming === true && t.input_schema.type === "object" && !("$schema" in t.input_schema))).toBe(true);
    expect(JSON.stringify(apiTools())).toBe(JSON.stringify(a));
    expect(a).toHaveLength(25); // 21 + 4 LevantBase tools (base-dashboard)
  });
  it("system prompt is frozen (no timestamps / ids)", () => {
    expect(SYSTEM_PROMPT).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });
});

describe("history replay after a server-side fallback", () => {
  it("drops thinking/tool_use before the last fallback block and the marker itself", () => {
    const blocks = [
      { type: "thinking", thinking: "x", signature: "s" },
      { type: "text", text: "partial", citations: null },
      { type: "tool_use", id: "t1", name: "list_projects", input: {} },
      { type: "fallback", from: { model: "claude-opus-5-5" }, to: { model: "claude-opus-5" }, trigger: { type: "refusal", category: "cyber" } },
      { type: "text", text: "rest", citations: null },
      { type: "tool_use", id: "t2", name: "list_projects", input: {} },
    ] as unknown as StoredContent["blocks"];
    expect(sanitizeForReplay(blocks).map((b) => b.type)).toEqual(["text", "text", "tool_use"]);
  });
});

describe("read_repo_file path safety", () => {
  it.each(["../etc/passwd", "/etc/passwd", "a/../../b", "C:\\x", "a\0b"])("rejects %s", (p) => expect(() => safeRelPath(p)).toThrow());
  it("normalises safe paths", () => {
    expect(safeRelPath("./src//index.ts")).toBe("src/index.ts");
    expect(safeRelPath("")).toBe("");
    expect(safeRelPath("a/./b")).toBe("a/b");
  });
  it.each([["flat", "."], ["wrapped in a top-level dir", "app"]])("reads files and listings from an uploaded tarball (%s)", async (_n, member) => {
    try {
      execFileSync("tar", ["--version"], { stdio: "ignore" });
    } catch {
      return; // no tar binary on this machine
    }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-tar-"));
    const src = path.join(root, "app");
    fs.mkdirSync(path.join(src, "src"), { recursive: true });
    fs.writeFileSync(path.join(src, "package.json"), '{"name":"demo"}');
    fs.writeFileSync(path.join(src, "src", "index.js"), "console.log(1)");
    fs.writeFileSync(path.join(src, "src", "big.txt"), "x".repeat(200 * 1024));
    const file = path.join(root, "up.tar.gz");
    execFileSync("tar", ["-czf", file, "-C", member === "." ? src : root, member]);
    const pkg = await readFromTar(file, "package.json");
    expect(pkg?.kind === "file" && pkg.content).toBe('{"name":"demo"}');
    const idx = await readFromTar(file, "src/index.js");
    expect(idx?.kind === "file" && idx.content).toBe("console.log(1)");
    const big = await readFromTar(file, "src/big.txt");
    expect(big?.kind === "file" && big.truncated && big.content.length).toBe(96 * 1024);
    const dir = await readFromTar(file, "src");
    expect(dir?.kind === "dir" && dir.entries).toEqual(["big.txt", "index.js"]);
    const rootList = await readFromTar(file, "");
    expect(rootList?.kind === "dir" && rootList.entries).toEqual(["package.json", "src/"]);
    expect(await readFromTar(file, "missing.txt")).toBeNull();
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("failure signal detection", () => {
  it("finds missing env vars, port mismatches and OOM kills", () => {
    const s = detectSignals(["  12 | Error: DATABASE_URL is not defined", "  40 | Server listening on http://0.0.0.0:8080", "  41 | Killed", "exited with code 137"].join("\n"), project);
    const kinds = s.map((x) => x.kind);
    expect(kinds).toContain("missing_env");
    expect(s.find((x) => x.kind === "missing_env")!.detail).toContain("DATABASE_URL");
    expect(s.find((x) => x.kind === "missing_env")!.line).toBe(12);
    expect(kinds).toContain("listen_port");
    expect(kinds).toContain("out_of_memory");
  });
  it("does not mistake other 'missing' messages for env vars", () => {
    expect(detectSignals('npm ERR! missing script: "build"', project).map((x) => x.kind)).toEqual(["missing_script"]);
    expect(detectSignals("Error: process.env.STRIPE_KEY is undefined", project)[0]?.detail).toContain("STRIPE_KEY");
  });
  it("does not flag a matching port", () => {
    expect(detectSignals("listening on port 3000", project).some((x) => x.kind === "listen_port")).toBe(false);
  });
});
