import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compactMessages } from "./agent";
import { executeRun, normalizePlan, codeGroups } from "./orchestrator";
import { applyEdit, lineDiff, parseSearchReplaceBlocks } from "./patch";
import { readDoc, systemPrompt } from "./prompts";
import { parseJsonLoose, repairToolCalls } from "./repair";
import { contentGuard, safePath, toolSchemas, toolsFor, zodToJsonSchema, TOOLS } from "./tools";
import { fakeBackend, fakeChecks, fakeLlm, makeRun, tempWorkspace, testDeps } from "./testing";
import { planSchema, type Msg } from "./types";
import { z } from "zod";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});
function ws() {
  const w = tempWorkspace();
  cleanups.push(w.cleanup);
  return w;
}

const PLAN = {
  summary: "Coffee shop landing page with a menu and a contact form",
  kind: "new_app",
  pages: [{ route: "/", purpose: "landing" }],
  components: [{ name: "Menu", purpose: "menu grid" }],
  dataModel: [],
  backend: { needed: false },
  design: { update: true, style: "warm coffee" },
  files: [
    { path: "app/page.tsx", action: "modify", purpose: "landing", group: "home" },
    { path: "components/menu.tsx", action: "create", purpose: "menu", group: "home" },
  ],
};

// ───────────────────────────── unit: patch / repair / tools ─────────────────────────────

describe("patch", () => {
  it("applies exact, whitespace-tolerant, indentation-tolerant and fuzzy edits", () => {
    const src = "function a() {\n    const x = 1;\n    return x;\n}\n";
    expect(applyEdit(src, { search: "const x = 1;", replace: "const x = 2;" }).content).toContain("const x = 2;");
    const ws = applyEdit(src, { search: "    const x = 1;   \n    return x;", replace: "    const x = 3;\n    return x;" });
    expect(ws.strategy).toBe("whitespace");
    const ind = applyEdit(src, { search: "const x = 1;\nreturn x;", replace: "const y = 1;\nreturn y;" });
    expect(ind.strategy).toBe("indent");
    expect(ind.content).toBe("function a() {\n    const y = 1;\n    return y;\n}\n");
    const fz = applyEdit(src, { search: "const x = 1\nreturn x;", replace: "const z = 1;\nreturn z;" });
    expect(fz.strategy).toMatch(/fuzzy|indent/);
    expect(fz.content).toContain("    const z = 1;");
  });
  it("rejects ambiguous and missing search text", () => {
    expect(() => applyEdit("a\nb\na\n", { search: "a", replace: "c" })).toThrow(/more than one/);
    expect(() => applyEdit("hello\n", { search: "completely different text here", replace: "x" })).toThrow(/not found/);
  });
  it("parses SEARCH/REPLACE blocks", () => {
    const e = parseSearchReplaceBlocks("x\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE\n");
    expect(e).toEqual([{ search: "old", replace: "new" }]);
  });
  it("diffs", () => {
    const d = lineDiff("a\nb\nc\n", "a\nB\nc\n");
    expect(d).toContain("-b");
    expect(d).toContain("+B");
  });
});

describe("repair", () => {
  const known = new Set(["write_file", "finish"]);
  it("parses tool calls written as text", () => {
    expect(repairToolCalls('<tool_call>{"name": "write_file", "arguments": {"path": "a.ts", "content": "x"}}</tool_call>', known)[0].name).toBe("write_file");
    expect(repairToolCalls('Sure!\n```json\n{"tool": "finish", "args": {"summary": "ok",}}\n```', known)[0].name).toBe("finish");
    expect(repairToolCalls('write_file({"path": "b.ts", "content": "y"})', known)[0].arguments).toContain("b.ts");
    expect(repairToolCalls('{"name": "rm_rf", "arguments": {}}', known)).toEqual([]);
    expect(repairToolCalls("Just a plain answer.", known)).toEqual([]);
  });
  it("parses loose JSON", () => {
    expect(parseJsonLoose('Here:\n```json\n{"a": [1,2,],}\n```')).toEqual({ a: [1, 2] });
  });
});

describe("tools", () => {
  it("keeps paths inside the workspace and protects env/lock files", async () => {
    const w = ws();
    const root = w.init("p1");
    await expect(safePath(root, "../x")).rejects.toThrow(/escapes/);
    await expect(safePath(root, "/etc/passwd")).rejects.toThrow(/relative/);
    await expect(safePath(root, "node_modules/x/index.js")).rejects.toThrow(/not allowed/);
    await expect(safePath(root, ".env.local", { write: true })).rejects.toThrow(/environment/);
    await expect(safePath(root, "pnpm-lock.yaml", { write: true })).rejects.toThrow(/lock/);
    fs.symlinkSync("/etc", path.join(root, "evil"));
    await expect(safePath(root, "evil/passwd")).rejects.toThrow(/escapes/);
    expect((await safePath(root, "./app/page.tsx")).rel).toBe("app/page.tsx");
  });
  it("guards against leaking the service_role key and hardcoded JWTs", () => {
    expect(contentGuard("a.tsx", '"use client";\nconst k = process.env.SUPABASE_SERVICE_ROLE_KEY;')).toMatch(/service_role/);
    expect(contentGuard("a.ts", "const k = process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY")).toMatch(/NEXT_PUBLIC/);
    expect(contentGuard("a.ts", 'const k = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6ImxldmFudGJhc2UifQ.abcdefghijklmnop"')).toMatch(/hardcode/);
    expect(contentGuard("a.json", "{bad")).toMatch(/JSON/);
    expect(contentGuard("a.tsx", "export default function A() { return null }")).toBeNull();
  });
  it("produces OpenAI tool schemas from zod", () => {
    expect(zodToJsonSchema(z.object({ a: z.string(), b: z.number().int().optional(), c: z.enum(["x", "y"]) }))).toEqual({
      type: "object",
      properties: { a: { type: "string" }, b: { type: "integer" }, c: { type: "string", enum: ["x", "y"] } },
      required: ["a", "c"],
    });
    const names = toolSchemas(toolsFor("backend")).map((t) => t.function.name);
    expect(names).toEqual(expect.arrayContaining(["base_sql", "base_create_bucket", "base_types", "deploy_function", "write_file", "apply_patch", "read_docs"]));
    expect(toolsFor("chat").some((t) => t.mutating)).toBe(false);
    expect(Object.keys(TOOLS)).toEqual(
      expect.arrayContaining(["list_files", "read_file", "write_file", "apply_patch", "delete_file", "rename_file", "add_dependency", "run_check", "get_preview_errors", "base_sql", "base_create_bucket", "base_types", "deploy_function", "read_docs"]),
    );
  });
  it("loads prompts and docs", async () => {
    expect(systemPrompt("coder")).toMatch(/use client/);
    expect(systemPrompt("backend", { backend: { ref: "r", url: "u" } })).toMatch(/row level security/i);
    expect(await readDoc("supabase")).toMatch(/supabase-js/);
    expect(await readDoc("rls")).toMatch(/auth.uid/);
    expect(await readDoc("nope")).toBeNull();
  });
});

describe("plan helpers", () => {
  it("normalizes and groups plans", () => {
    const p = normalizePlan(
      planSchema.parse({
        summary: "x",
        kind: "feature",
        dataModel: [{ table: "todos", columns: ["title text"] }],
        files: [
          { path: "./app/todos/page.tsx", action: "create", group: "Todos Page" },
          { path: "components/ui/button.tsx", action: "modify" },
          { path: ".env.local", action: "create" },
          { path: "supabase/migrations/1_x.sql", action: "create", group: "db" },
        ],
      }),
      false,
    );
    expect(p.backend.needed).toBe(true);
    expect(p.files.map((f) => f.path)).toEqual(["app/todos/page.tsx", "supabase/migrations/1_x.sql"]);
    expect(codeGroups(p)).toEqual([{ name: "todos-page", files: [p.files[0]] }]);
  });
  it("compacts long conversations", () => {
    const big = "x".repeat(50_000);
    const msgs: Msg[] = [{ role: "system", content: "s" }, { role: "user", content: "u" }];
    for (let i = 0; i < 6; i++) msgs.push({ role: "assistant", content: "", toolCalls: [{ id: `c${i}`, name: "read_file", arguments: "{}" }] }, { role: "tool", toolCallId: `c${i}`, name: "read_file", content: big });
    const out = compactMessages(msgs, 140_000, 4);
    expect(out.reduce((n, m) => n + (typeof m.content === "string" ? m.content.length : 0), 0)).toBeLessThan(160_000);
    expect(out.length).toBe(msgs.length);
  });
});

// ───────────────────────────── orchestrator (scripted fake LLM) ─────────────────────────────

describe("orchestrator", () => {
  it("plan → design → code → check → fix → summarize, with role-authored commits", async () => {
    const w = ws();
    w.init("p1");
    const llm = fakeLlm({
      planner: [{ json: PLAN }],
      designer: [
        { calls: [{ name: "read_file", args: { path: "app/globals.css" } }] },
        { calls: [{ name: "apply_patch", args: { path: "app/globals.css", edits: [{ search: "--primary: 222 47% 11%;", replace: "--primary: 24 60% 35%;" }] } }] },
        { calls: [{ name: "finish", args: { summary: "warm brown primary" } }] },
      ],
      coder: [
        {
          calls: [
            { name: "write_file", args: { path: "components/menu.tsx", content: "export function Menu() {\n  return <ul><li>Espresso</li></ul>;\n}\n" } },
            { name: "write_file", args: { path: "app/page.tsx", content: 'import { Menu } from "@/components/menu";\nexport default function Home() {\n  return <main><h1>Brew</h1><Menu /></main>;\n}\n' } },
          ],
        },
        { calls: [{ name: "finish", args: { summary: "landing page" } }] },
      ],
      fixer: [
        { calls: [{ name: "apply_patch", args: { path: "components/menu.tsx", patch: "<<<<<<< SEARCH\n  return <ul><li>Espresso</li></ul>;\n=======\n  return <ul><li>Espresso</li><li>Latte</li></ul>;\n>>>>>>> REPLACE" } }] },
        { calls: [{ name: "run_check", args: { kind: "typecheck" } }] },
        { calls: [{ name: "finish", args: { summary: "fixed" } }] },
      ],
      summarizer: [{ text: "Your coffee shop site is ready!" }],
    });
    const checks = fakeChecks({ typecheck: [{ ok: false, output: "components/menu.tsx(2,3): error TS2322: Type 'x' is not assignable" }, { ok: true, output: "" }, { ok: true, output: "" }] });
    const { deps, store } = testDeps(llm, w, checks);
    store.runs.set("r1", makeRun({ id: "r1", builderProjectId: "p1", message: "Build a landing page for a coffee shop with menu and contact form" }));

    expect(await executeRun(deps, "r1")).toBe("SUCCEEDED");
    const run = store.runs.get("r1")!;
    expect(run.status).toBe("SUCCEEDED");
    expect(run.plan?.summary).toMatch(/Coffee/);
    expect(fs.readFileSync(path.join(w.rootFor("p1"), "components/menu.tsx"), "utf8")).toContain("Latte");
    expect(fs.readFileSync(path.join(w.rootFor("p1"), "app/globals.css"), "utf8")).toContain("24 60% 35%");
    const log = w.gitLog("p1");
    expect(log.some((l) => l.startsWith("agent:designer|Design"))).toBe(true);
    expect(log.some((l) => l.startsWith("agent:coder|Code (home)"))).toBe(true);
    expect(log.some((l) => l.startsWith("agent:fixer|Fix #1"))).toBe(true);
    expect(run.state!.lastGreenCommit).toBe(run.endCommit);
    const types = store.events.get("r1")!.map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(["status", "phase", "plan", "file", "check", "commit", "provider", "message", "usage"]));
    const fileEv = store.events.get("r1")!.find((e) => e.type === "file" && e.data.path === "components/menu.tsx" && e.data.action === "modify");
    expect(String(fileEv?.data.diff)).toContain("+  return <ul><li>Espresso</li><li>Latte</li></ul>;");
    expect(store.messages[0].content).toBe("Your coffee shop site is ready!");
    expect(run.steps.map((s) => s.key)).toEqual(expect.arrayContaining(["plan", "design", "code:home", "check:0", "fix:0", "check:1", "summarize"]));
    expect(run.steps.every((s) => s.status !== "running")).toBe(true);
    expect(run.endCommit).toBeTruthy();
  });

  it("continues on another provider when one fails mid-run", async () => {
    const w = ws();
    w.init("p2");
    const llm = fakeLlm(
      {
        planner: [{ json: { ...PLAN, design: { update: false } } }],
        coder: [
          { calls: [{ name: "write_file", args: { path: "components/menu.tsx", content: "export const Menu = () => null;\n" } }] },
          { fail: "gemini" },
          (req) => ({ calls: [{ name: "write_file", args: { path: "app/page.tsx", content: `// served while excluding ${req.excludeProviders?.join(",")}\nexport default function H() { return null; }\n` } }] }),
          { calls: [{ name: "finish", args: { summary: "ok" } }] },
        ],
      },
      { providers: ["gemini", "groq"], defaultProvider: "gemini" },
    );
    const { deps, store } = testDeps(llm, w);
    store.runs.set("r2", makeRun({ id: "r2", builderProjectId: "p2", message: "landing page", state: null }));
    expect(await executeRun(deps, "r2", { budgets: { ensembleSize: 1 } })).toBe("SUCCEEDED");
    const page = fs.readFileSync(path.join(w.rootFor("p2"), "app/page.tsx"), "utf8");
    expect(page).toContain("excluding gemini");
    const coderCalls = llm.calls.filter((c) => c.role === "coder");
    expect(coderCalls[2].provider).toBe("groq");
    // the retried step received the same conversation (provider-agnostic) including the first tool result
    expect(coderCalls[2].req.messages.some((m) => m.role === "tool" && m.content.includes("created components/menu.tsx"))).toBe(true);
    const evs = store.events.get("r2")!;
    expect(evs.some((e) => e.type === "warning" && String(e.data.message).includes("gemini failed"))).toBe(true);
    expect(evs.some((e) => e.type === "provider" && e.data.provider === "groq" && e.data.attempt === 2)).toBe(true);
    expect(store.runs.get("r2")!.state!.usage.providers.gemini.failures).toBe(1);
  });

  it("waits out a global rate-limit cooldown instead of failing the step", async () => {
    const w = ws();
    w.init("p2c");
    const cool = { fail: "gemini", allFailed: true } as const;
    const llm = fakeLlm({
      planner: [{ json: { ...PLAN, design: { update: false } } }],
      coder: [cool, cool, { calls: [{ name: "write_file", args: { path: "components/menu.tsx", content: "export const Menu = () => null;\n" } }] }],
    });
    const t = testDeps(llm, w);
    const slept: number[] = [];
    t.deps.sleep = async (ms) => void slept.push(ms);
    t.store.runs.set("r2c", makeRun({ id: "r2c", builderProjectId: "p2c", message: "landing" }));
    expect(await executeRun(t.deps, "r2c", { budgets: { ensembleSize: 1 } })).toBe("SUCCEEDED");
    expect(slept.slice(0, 2)).toEqual([5000, 10000]);
    expect(t.store.events.get("r2c")!.filter((e) => e.type === "warning" && String(e.data.message).includes("waiting")).length).toBe(2);
    expect(fs.existsSync(path.join(w.rootFor("p2c"), "components/menu.tsx"))).toBe(true);
  });

  it("a failing coder group doesn't stop the run: retried, then the others continue", async () => {
    const w = ws();
    w.init("p2b");
    const plan = {
      ...PLAN,
      design: { update: false },
      files: [
        { path: "app/page.tsx", action: "modify", group: "a" },
        { path: "app/about/page.tsx", action: "create", group: "b" },
      ],
    };
    const failAll = { fail: "gemini" } as const; // provider-specific failures: 5 → the step gives up
    const llm = fakeLlm({
      planner: [{ json: plan }],
      coder: [
        // group a: 5 attempts fail → group failed (retried later)
        failAll, failAll, failAll, failAll, failAll,
        // group b ok
        { calls: [{ name: "write_file", args: { path: "app/about/page.tsx", content: "export default function A() { return null; }\n" } }] },
        { calls: [{ name: "finish", args: { summary: "b" } }] },
        // retry of group a succeeds
        { calls: [{ name: "write_file", args: { path: "app/page.tsx", content: "export default function H() { return <h1>Hi</h1>; }\n" } }] },
        { calls: [{ name: "finish", args: { summary: "a" } }] },
      ],
    });
    const { deps, store } = testDeps(llm, w);
    store.runs.set("r2b", makeRun({ id: "r2b", builderProjectId: "p2b", message: "two pages" }));
    expect(await executeRun(deps, "r2b", { budgets: { ensembleSize: 1 }, codeConcurrency: 1 })).toBe("SUCCEEDED");
    expect(fs.readFileSync(path.join(w.rootFor("p2b"), "app/page.tsx"), "utf8")).toContain("Hi");
    expect(fs.existsSync(path.join(w.rootFor("p2b"), "app/about/page.tsx"))).toBe(true);
    const run = store.runs.get("r2b")!;
    expect(run.steps.find((s) => s.key === "code:a")?.status).toBe("done");
    expect(store.events.get("r2b")!.some((e) => e.type === "error" && String(e.data.message).includes("group a failed"))).toBe(true);
  });

  it("cancel stops the run and keeps partial changes in history", async () => {
    const w = ws();
    w.init("p3");
    let store!: ReturnType<typeof testDeps>["store"];
    const llm = fakeLlm({
      planner: [{ json: { ...PLAN, design: { update: false } } }],
      coder: [
        { calls: [{ name: "write_file", args: { path: "components/menu.tsx", content: "export const Menu = () => null;\n" } }] },
        () => {
          store.requestCancel("r3");
          return { calls: [{ name: "read_file", args: { path: "app/page.tsx" } }] };
        },
        { calls: [{ name: "finish", args: { summary: "never" } }] },
      ],
    });
    const t = testDeps(llm, w);
    store = t.store;
    store.runs.set("r3", makeRun({ id: "r3", builderProjectId: "p3", message: "landing" }));
    // cancel checks are throttled to every 2 s — make them immediate
    const realNow = Date.now;
    let fake = realNow();
    Date.now = () => (fake += 5000);
    try {
      expect(await executeRun(t.deps, "r3", { budgets: { ensembleSize: 1 } })).toBe("CANCELED");
    } finally {
      Date.now = realNow;
    }
    expect(store.runs.get("r3")!.status).toBe("CANCELED");
    expect(w.gitLog("p3")[0]).toMatch(/Partial changes \(run canceled\)/);
    expect(llm.remaining("coder")).toBe(1);
    expect(store.messages[0].content).toMatch(/Stopped/);
  });

  it("the designer may only touch theme/layout files", async () => {
    const w = ws();
    w.init("p12");
    const llm = fakeLlm({
      planner: [{ json: PLAN }],
      designer: [
        { calls: [{ name: "write_file", args: { path: "app/page.tsx", content: "export default function X() { return null; }\n" } }] },
        { calls: [{ name: "apply_patch", args: { path: "app/globals.css", edits: [{ search: "--primary: 222 47% 11%;", replace: "--primary: 1 1% 1%;" }] } }] },
      ],
      coder: [{ calls: [{ name: "write_file", args: { path: "components/menu.tsx", content: "export const Menu = () => null;\n" } }] }],
    });
    const { deps, store } = testDeps(llm, w);
    store.runs.set("r12", makeRun({ id: "r12", builderProjectId: "p12", message: "landing" }));
    expect(await executeRun(deps, "r12", { budgets: { ensembleSize: 1 } })).toBe("SUCCEEDED");
    expect(fs.readFileSync(path.join(w.rootFor("p12"), "app/page.tsx"), "utf8")).toContain("Hello");
    const designerSecond = llm.calls.filter((c) => c.role === "designer")[1].req.messages;
    expect(JSON.stringify(designerSecond)).toContain("is not yours to change");
  });

  it("never runs the same run twice at once (lease)", async () => {
    const w = ws();
    w.init("p13");
    const llm = fakeLlm({ planner: [{ json: { ...PLAN, design: { update: false } } }], coder: [{ hang: true }] });
    const { deps, store } = testDeps(llm, w);
    store.runs.set("r13", makeRun({ id: "r13", builderProjectId: "p13", message: "landing" }));
    const ac = new AbortController();
    const first = executeRun(deps, "r13", { budgets: { ensembleSize: 1 }, signal: ac.signal });
    for (let i = 0; i < 200 && !llm.calls.some((c) => c.role === "coder"); i++) await new Promise((r) => setTimeout(r, 5));
    // a second executor (e.g. the resume sweep) must not start working on it
    expect(await executeRun(deps, "r13", { budgets: { ensembleSize: 1 } })).toBe("RUNNING");
    expect(llm.calls.filter((c) => c.role === "planner")).toHaveLength(1);
    ac.abort();
    expect(await first).toBe("CANCELED");
    expect(store.leases.size).toBe(0);
  });

  it("resumes after a worker restart from the last checkpoint", async () => {
    const w = ws();
    w.init("p4");
    const script = {
      planner: [{ json: PLAN }],
      designer: [{ calls: [{ name: "write_file", args: { path: "app/globals.css", content: "@tailwind base;\n:root { --primary: 1 2% 3%; }\n" } }] }, { calls: [{ name: "finish", args: { summary: "d" } }] }],
      coder: [{ calls: [{ name: "write_file", args: { path: "components/menu.tsx", content: "export const Menu = () => null;\n" } }] }, { hang: true as const }],
    };
    const llm1 = fakeLlm(script);
    const t1 = testDeps(llm1, w);
    t1.store.runs.set("r4", makeRun({ id: "r4", builderProjectId: "p4", message: "landing" }));
    const crashed = new AbortController();
    const p = executeRun(t1.deps, "r4", { budgets: { ensembleSize: 1 }, signal: crashed.signal });
    // wait until the coder hangs (worker "dies" mid-step)
    for (let i = 0; i < 200 && !llm1.calls.some((c) => c.role === "coder" && llm1.remaining("coder") === 0); i++) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 20));
    const snapshot = structuredClone(t1.store.runs.get("r4")!);
    expect(snapshot.status).toBe("RUNNING");
    expect(snapshot.state!.completed).toEqual(["plan", "backend", "design"]);
    // simulate the crash: the old process is gone; a new worker picks the job up with the persisted row
    crashed.abort();
    await p.catch(() => {});

    const llm2 = fakeLlm({
      coder: [
        (req) => {
          // the resumed conversation contains the first tool step + a resume note
          expect(req.messages.some((m) => m.role === "tool" && m.content.includes("components/menu.tsx"))).toBe(true);
          expect(JSON.stringify(req.messages.at(-1))).toMatch(/resumed/);
          return { calls: [{ name: "write_file", args: { path: "app/page.tsx", content: "export default function H() { return null; }\n" } }] };
        },
        { calls: [{ name: "finish", args: { summary: "resumed ok" } }] },
      ],
    });
    const t2 = testDeps(llm2, w);
    t2.store.runs.set("r4", snapshot);
    expect(await executeRun(t2.deps, "r4", { budgets: { ensembleSize: 1 } })).toBe("SUCCEEDED");
    expect(llm2.calls.some((c) => c.role === "planner" || c.role === "designer")).toBe(false);
    const run = t2.store.runs.get("r4")!;
    expect(run.state!.resumes).toBe(1);
    expect(fs.existsSync(path.join(w.rootFor("p4"), "app/page.tsx"))).toBe(true);
    expect(t2.store.events.get("r4")!.some((e) => e.type === "warning" && String(e.data.message).includes("resuming"))).toBe(true);
  });

  it("restores the last green commit when checks never pass", async () => {
    const w = ws();
    w.init("p5");
    const original = fs.readFileSync(path.join(w.rootFor("p5"), "app/page.tsx"), "utf8");
    const llm = fakeLlm({
      planner: [{ json: { ...PLAN, design: { update: false } } }],
      coder: [{ calls: [{ name: "write_file", args: { path: "app/page.tsx", content: "export default function H() { return <broken> }\n" } }] }],
    });
    const red = { ok: false, output: "app/page.tsx(1,40): error TS17008: JSX element 'broken' has no corresponding closing tag." };
    const checks = fakeChecks({ typecheck: Array(10).fill(red) });
    const { deps, store } = testDeps(llm, w, checks);
    store.runs.set("r5", makeRun({ id: "r5", builderProjectId: "p5", message: "landing" }));
    expect(await executeRun(deps, "r5", { budgets: { ensembleSize: 1, maxFixIterations: 2 } })).toBe("FAILED");
    expect(fs.readFileSync(path.join(w.rootFor("p5"), "app/page.tsx"), "utf8")).toBe(original);
    const log = w.gitLog("p5");
    expect(log[0]).toMatch(/Restore last working version/);
    expect(log.some((l) => l.includes("Code (home)"))).toBe(true); // the attempt stays in history
    const run = store.runs.get("r5")!;
    expect(run.error).toMatch(/still failing/);
    expect(store.events.get("r5")!.some((e) => e.type === "restore")).toBe(true);
  });

  it("best-of-N plan with judge + ensemble fix for hard errors", async () => {
    const w = ws();
    w.init("p6");
    const planA = { ...PLAN, summary: "plan A", design: { update: false } };
    const planB = { ...PLAN, summary: "plan B", design: { update: false } };
    const llm = fakeLlm(
      {
        "planner@gemini": [{ json: planA }],
        "planner@groq": [{ json: planB }],
        judge: [{ json: { best: 1, reason: "B is more complete" } }, { json: { best: 0, reason: "smaller" } }],
        coder: [{ calls: [{ name: "write_file", args: { path: "components/menu.tsx", content: "export const Menu = () => <ul>bad</ul>\n" } }] }],
        fixer: [{ calls: [{ name: "finish", args: { summary: "tried" } }] }, { calls: [{ name: "finish", args: { summary: "tried again" } }] }],
        "fixer@gemini": [{ json: { explanation: "close list", edits: [{ path: "components/menu.tsx", search: "<ul>bad</ul>", replace: "<ul><li>good</li></ul>" }] } }],
        "fixer@groq": [{ json: { explanation: "nonsense", edits: [{ path: "components/menu.tsx", search: "does not exist", replace: "x" }] } }],
      },
      { providers: ["gemini", "groq"] },
    );
    const red = { ok: false, output: "components/menu.tsx(1,30): error TS2322: bad" };
    const checks = fakeChecks({ typecheck: [red, red, red, { ok: true, output: "" }] });
    const { deps, store } = testDeps(llm, w, checks);
    store.runs.set("r6", makeRun({ id: "r6", builderProjectId: "p6", message: "landing" }));
    expect(await executeRun(deps, "r6", { budgets: { ensembleSize: 2 } })).toBe("SUCCEEDED");
    expect(store.runs.get("r6")!.plan!.summary).toBe("plan B");
    expect(fs.readFileSync(path.join(w.rootFor("p6"), "components/menu.tsx"), "utf8")).toContain("<li>good</li>");
    expect(store.events.get("r6")!.some((e) => e.type === "file" && String(e.data.via).startsWith("best-of-1"))).toBe(true);
  });

  it("backend agent: attaches the backend, applies + saves migrations, generates types", async () => {
    const w = ws();
    w.init("p7");
    const plan = {
      summary: "Todos with login",
      kind: "feature",
      dataModel: [{ table: "todos", columns: ["title text"], ownerScoped: true }],
      backend: { needed: true, auth: true },
      design: { update: false },
      files: [{ path: "app/todos/page.tsx", action: "create", group: "todos" }],
    };
    const sql = "create table if not exists public.todos (id uuid primary key default gen_random_uuid(), user_id uuid not null default auth.uid(), title text not null);\nalter table public.todos enable row level security;";
    const llm = fakeLlm({
      planner: [{ json: plan }],
      backend: [
        { calls: [{ name: "base_sql", args: { sql: "select x syntax error", description: "bad" } }] },
        { calls: [{ name: "base_sql", args: { sql, description: "todos table with RLS", migration_name: "create todos" } }] },
        { calls: [{ name: "base_sql", args: { sql: "create role hacker", description: "nope" } }] },
        { calls: [{ name: "write_file", args: { path: "app/login/page.tsx", content: "export default function Login() { return null; }\n" } }] },
        { calls: [{ name: "finish", args: { summary: "todos table (RLS own rows), login page" } }] },
      ],
      coder: [{ calls: [{ name: "write_file", args: { path: "app/todos/page.tsx", content: "export default function T() { return null; }\n" } }] }],
    });
    const backend = fakeBackend();
    const { deps, store } = testDeps(llm, w, fakeChecks(), backend);
    store.projects.set("p7", { id: "p7", teamId: "team1", name: "todo", knowledge: "", baseRef: null, history: [] });
    store.runs.set("r7", makeRun({ id: "r7", builderProjectId: "p7", message: "Add a todo app with login" }));
    expect(await executeRun(deps, "r7", { budgets: { ensembleSize: 1 } })).toBe("SUCCEEDED");
    const root = w.rootFor("p7");
    const migs = fs.readdirSync(path.join(root, "supabase/migrations"));
    expect(migs).toHaveLength(1);
    expect(migs[0]).toMatch(/^\d{14}_create_todos\.sql$/);
    expect(fs.readFileSync(path.join(root, "supabase/migrations", migs[0]), "utf8")).toContain("enable row level security");
    expect(fs.readFileSync(path.join(root, "lib/database.types.ts"), "utf8")).toContain("todos");
    expect(backend.sqlRan).toHaveLength(2); // the role statement was rejected before reaching the DB
    expect(store.projects.get("p7")!.baseRef).toBe("abcdefghijklmnopqrst");
    const coderReq = llm.calls.find((c) => c.role === "coder")!.req;
    expect(JSON.stringify(coderReq.messages)).toContain("todos table (RLS own rows)");
    expect(w.gitLog("p7").some((l) => l.startsWith("agent:backend|Backend: todos + auth"))).toBe(true);
  });

  it("chat mode answers without editing; repaired text tool calls work", async () => {
    const w = ws();
    w.init("p8");
    const llm = fakeLlm({
      chat: [{ text: '<tool_call>{"name": "read_file", "arguments": {"path": "app/page.tsx"}}</tool_call>' }, { text: "Your home page renders a Hello message." }],
    });
    const { deps, store } = testDeps(llm, w);
    store.runs.set("r8", makeRun({ id: "r8", builderProjectId: "p8", message: "What does my home page show?", mode: "chat" }));
    const before = w.gitLog("p8");
    expect(await executeRun(deps, "r8")).toBe("SUCCEEDED");
    expect(store.messages[0].content).toBe("Your home page renders a Hello message.");
    expect(w.gitLog("p8")).toEqual(before);
    const chatCalls = llm.calls.filter((c) => c.role === "chat");
    expect(chatCalls[1].req.messages.some((m) => m.role === "tool" && m.content.includes("Hello"))).toBe(true);
  });

  it("fix mode starts from the user's report when checks are green", async () => {
    const w = ws();
    w.init("p9");
    const llm = fakeLlm({
      fixer: [
        (req) => {
          expect(JSON.stringify(req.messages)).toContain("button does nothing");
          return { calls: [{ name: "apply_patch", args: { path: "app/page.tsx", edits: [{ search: "Hello", replace: "Hello there" }] } }] };
        },
      ],
      summarizer: [{ text: "Fixed." }],
    });
    const { deps, store } = testDeps(llm, w);
    store.runs.set("r9", makeRun({ id: "r9", builderProjectId: "p9", message: "The button does nothing", mode: "fix" }));
    expect(await executeRun(deps, "r9")).toBe("SUCCEEDED");
    expect(fs.readFileSync(path.join(w.rootFor("p9"), "app/page.tsx"), "utf8")).toContain("Hello there");
  });

  it("fails clearly when no provider works at all", async () => {
    const w = ws();
    w.init("p10");
    const down = { fail: "gemini", allFailed: true } as const;
    const llm = fakeLlm({ planner: Array(20).fill(down) });
    const { deps, store } = testDeps(llm, w);
    store.runs.set("r10", makeRun({ id: "r10", builderProjectId: "p10", message: "landing" }));
    expect(await executeRun(deps, "r10", { budgets: { ensembleSize: 1 } })).toBe("FAILED");
    expect(store.runs.get("r10")!.error).toMatch(/No AI provider/);
  });

  it("stops at the step budget and still reports", async () => {
    const w = ws();
    w.init("p11");
    const loop = { calls: [{ name: "list_files", args: {} }] };
    const llm = fakeLlm({ planner: [{ json: { ...PLAN, design: { update: false } } }], coder: Array(50).fill(loop) });
    const { deps, store } = testDeps(llm, w);
    store.runs.set("r11", makeRun({ id: "r11", builderProjectId: "p11", message: "landing" }));
    const status = await executeRun(deps, "r11", { budgets: { ensembleSize: 1, maxSteps: 6 } });
    expect(status).toBe("SUCCEEDED");
    expect(store.runs.get("r11")!.state!.degraded.join()).toMatch(/budget/);
    expect(store.messages).toHaveLength(1);
  });
});
