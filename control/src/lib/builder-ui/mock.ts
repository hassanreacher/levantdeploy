"use client";

/**
 * builder-ui: in-memory mock of the Builder APIs — ONLY for early UI work when no builder-core/agents stack is running
 * (enabled explicitly with ?mock=1). The final UI and screenshots use the real APIs.
 */
import type { BuilderMessage, BuilderProject, BuilderRun, Commit, Credits, FileEntry, PreviewState, PublishState, RunEvent, Template, VisualEditOp } from "./types";
import { MOCK_PREVIEW_HTML } from "./mock-preview";

const now = () => new Date().toISOString();
const sha = () => Array.from({ length: 40 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");
const id = () => Math.random().toString(36).slice(2, 12);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type MockProject = BuilderProject & { files: Record<string, string>; commits: Commit[]; messages: BuilderMessage[]; runs: BuilderRun[] };
const projects: MockProject[] = [];

const FILES: Record<string, string> = {
  "app/page.tsx": `export default function Home() {\n  return (\n    <main>\n      <section className="mx-auto max-w-5xl px-6 py-24 text-center">\n        <h1 className="text-5xl font-bold">Fresh bread, every morning</h1>\n        <p className="mt-4 text-lg text-muted-foreground">Order online and pick up in 10 minutes.</p>\n      </section>\n    </main>\n  );\n}\n`,
  "app/layout.tsx": `import "./globals.css";\n\nexport default function RootLayout({ children }: { children: React.ReactNode }) {\n  return (\n    <html lang="en">\n      <body>{children}</body>\n    </html>\n  );\n}\n`,
  "app/globals.css": `@tailwind base;\n@tailwind components;\n@tailwind utilities;\n`,
  "components/ui/button.tsx": `export function Button(props: React.ButtonHTMLAttributes<HTMLButtonElement>) {\n  return <button {...props} />;\n}\n`,
  "lib/supabase.ts": `import { createClient } from "@supabase/supabase-js";\n\nexport const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);\n`,
  "package.json": `{\n  "name": "bakery",\n  "private": true,\n  "scripts": { "dev": "next dev", "build": "next build" }\n}\n`,
  "supabase/migrations/0001_init.sql": `create table public.orders (\n  id uuid primary key default gen_random_uuid(),\n  item text not null,\n  created_at timestamptz default now()\n);\nalter table public.orders enable row level security;\n`,
};

function seed(team: string) {
  if (projects.length) return;
  const mk = (name: string, prompt: string, ago: number, status: string, preview: string): MockProject => {
    const c: Commit = { sha: sha(), message: "Initial version", date: new Date(Date.now() - ago).toISOString(), author: { kind: "agent", role: "coder", name: "Coder" } };
    return {
      id: id(), teamId: team, name, prompt, template: "next15", status, previewStatus: preview, previewUrl: preview === "RUNNING" ? "mock:preview" : null,
      settings: { quality: "balanced", visibility: "private", knowledge: "", instructions: "" }, createdAt: c.date, updatedAt: c.date, lastCommit: c.sha,
      files: { ...FILES }, commits: [c], messages: [
        { id: id(), role: "USER", content: prompt, attachments: [], createdAt: c.date },
        { id: id(), role: "ASSISTANT", content: "I built the first version of your app: a landing page with a hero, a menu and an order form backed by a `orders` table.", attachments: [], commitSha: c.sha, createdAt: c.date },
      ], runs: [],
    };
  };
  projects.push(mk("Bakery orders", "An online ordering site for my bakery with a menu and pickup times", 3_600_000, "READY", "RUNNING"));
  projects.push(mk("Gym tracker", "A workout tracker where I log sets and see progress charts", 86_400_000 * 2, "READY", "STOPPED"));
  projects.push(mk("Portfolio", "A personal portfolio with projects and a contact form", 86_400_000 * 6, "READY", "STOPPED"));
}

function get(pid: string) {
  const p = projects.find((x) => x.id === pid);
  if (!p) throw Object.assign(new Error("Not found"), { status: 404 });
  return p;
}
const strip = (p: MockProject): BuilderProject => {
  const { files: _f, commits: _c, messages: _m, runs: _r, ...rest } = p;
  return rest;
};

function addCommit(p: MockProject, message: string, kind: Commit["author"]["kind"], files?: Commit["files"]): Commit {
  const c: Commit = { sha: sha(), message, date: now(), author: { kind, role: kind === "agent" ? "coder" : null, name: kind === "user" ? "You" : kind === "visual" ? "Visual edit" : "Coder" }, files };
  p.commits.unshift(c);
  p.lastCommit = c.sha;
  p.updatedAt = c.date;
  return c;
}

const runListeners = new Map<string, { events: RunEvent[]; subs: Set<(e: RunEvent) => void>; done: boolean }>();

async function simulateRun(p: MockProject, run: BuilderRun) {
  const ch = { events: [] as RunEvent[], subs: new Set<(e: RunEvent) => void>(), done: false };
  runListeners.set(run.id, ch);
  let seq = 0;
  const emit = (type: string, data: Record<string, unknown>) => {
    const e = { seq: ++seq, type, data } as RunEvent;
    ch.events.push(e);
    ch.subs.forEach((f) => f(e));
  };
  const cancelled = () => run.status === "CANCELED";
  await sleep(300);
  run.status = "RUNNING";
  p.status = "GENERATING";
  emit("status", { status: "RUNNING" });
  emit("provider", { provider: "gemini", model: "gemini-3.5-flash", role: "planner" });
  const steps = [
    { title: "Plan the changes", role: "planner", status: "pending" },
    { title: "Update the design system", role: "designer", status: "pending" },
    { title: "Write components", role: "coder", status: "pending" },
    { title: "Type-check & build", role: "reviewer", status: "pending" },
  ];
  emit("plan", { summary: "Add a testimonials section and tune the hero", steps });
  for (let i = 0; i < steps.length; i++) {
    if (cancelled()) break;
    emit("step", { index: i, ...steps[i], status: "running" });
    if (i === 2) {
      emit("provider", { provider: "groq", model: "llama-3.3-70b-versatile", role: "coder", fallbackFrom: { provider: "gemini", model: "gemini-3.5-flash", reason: "429 rate limited" } });
      emit("tool_call", { id: "t1", name: "read_file", args: { path: "app/page.tsx" } });
      await sleep(400);
      emit("tool_result", { id: "t1", name: "read_file", ok: true });
      emit("tool_call", { id: "t2", name: "apply_patch", args: { path: "app/page.tsx" } });
      const text = "I'll add a testimonials section below the hero and make the headline bolder. ";
      for (const w of text.split(" ")) {
        emit("delta", { text: w + " " });
        await sleep(40);
      }
      await sleep(400);
      emit("tool_result", { id: "t2", name: "apply_patch", ok: true });
      p.files["app/page.tsx"] = p.files["app/page.tsx"]!.replace("</section>", "</section>\n      <section className=\"py-16\">\n        <h2 className=\"text-3xl font-bold\">What customers say</h2>\n      </section>");
      const c = addCommit(p, "Add testimonials section", "agent", [{ path: "app/page.tsx", status: "modified", additions: 3, deletions: 0, patch: "@@ -5,6 +5,9 @@\n         <p className=\"mt-4 text-lg\">Order online and pick up in 10 minutes.</p>\n       </section>\n+      <section className=\"py-16\">\n+        <h2 className=\"text-3xl font-bold\">What customers say</h2>\n+      </section>\n     </main>" }]);
      emit("commit", { sha: c.sha, message: c.message, files: c.files });
    } else await sleep(700);
    if (i === 3) {
      emit("check", { kind: "typecheck", ok: true, summary: "tsc: no errors", durationMs: 2100 });
      emit("check", { kind: "build", ok: true, summary: "next build: compiled successfully", durationMs: 9800 });
    }
    emit("step", { index: i, ...steps[i], status: "done" });
  }
  if (!cancelled()) {
    run.status = "SUCCEEDED";
    run.resultCommit = p.lastCommit;
    const msg = "Done! I added a **testimonials** section below the hero and made the headline bolder. The preview has been updated.";
    emit("message", { content: msg });
    p.messages.push({ id: id(), role: "ASSISTANT", content: msg, attachments: [], agentRunId: run.id, commitSha: p.lastCommit, createdAt: now() });
    emit("usage", { credits: { used: 4, limit: 5, period: "day" } });
    emit("suggestions", { items: ["Add a pricing section", "Make it dark mode", "Add an order form with a database", "Add a FAQ"] });
  }
  emit("status", { status: run.status });
  p.status = "READY";
  ch.done = true;
}

export const mockApi = {
  listProjects: async (team: string) => {
    seed(team);
    return projects.map(strip);
  },
  createProject: async (input: { team: string; prompt?: string; name?: string; template?: string }) => {
    seed(input.team);
    const p: MockProject = {
      id: id(), teamId: input.team, name: input.name || (input.prompt ?? "New app").split(/\s+/).slice(0, 3).join(" "), prompt: input.prompt, template: input.template ?? "next15",
      status: "GENERATING", previewStatus: "STARTING", previewUrl: null, settings: { quality: "balanced", visibility: "private" }, createdAt: now(), updatedAt: now(),
      files: { ...FILES }, commits: [], messages: [], runs: [],
    };
    addCommit(p, "Create project from template next15", "system");
    projects.unshift(p);
    const run = await mockApi.startRun(p.id, { prompt: input.prompt ?? "Build the app", kind: "build" });
    setTimeout(() => {
      p.previewStatus = "RUNNING";
      p.previewUrl = "mock:preview";
    }, 2500);
    return { project: strip(p), run: run.run };
  },
  getProject: async (pid: string) => strip(get(pid)),
  updateProject: async (pid: string, patch: { name?: string; settings?: Record<string, unknown> }) => {
    const p = get(pid);
    if (patch.name) p.name = patch.name;
    if (patch.settings) p.settings = { ...p.settings, ...patch.settings };
    return strip(p);
  },
  deleteProject: async (pid: string) => {
    projects.splice(projects.indexOf(get(pid)), 1);
    return { ok: true as const };
  },
  templates: async (): Promise<Template[]> => [
    { id: "next15", name: "Blank app", description: "Next.js 15 + Tailwind + shadcn/ui + LevantBase", kind: "template" },
    { id: "saas-landing", name: "SaaS landing", description: "Hero, features, pricing and FAQ", prompt: "A modern SaaS landing page with pricing and FAQ", kind: "template" },
    { id: "dashboard", name: "Admin dashboard", description: "Sidebar, charts and tables with auth", prompt: "An admin dashboard with login, sidebar, KPIs and a data table", kind: "template" },
    { id: "store", name: "Online store", description: "Products, cart and checkout", prompt: "A small online store with a product grid, cart and checkout", kind: "template" },
  ],
  credits: async (): Promise<Credits> => ({ usedToday: 3, perDay: 5, usedMonth: 12, perMonth: 30, plan: "Hobby", remaining: 2 }),
  messages: async (pid: string) => [...get(pid).messages],
  runs: async (pid: string) => [...get(pid).runs],
  getRun: async (_pid: string, rid: string) => {
    for (const p of projects) {
      const r = p.runs.find((x) => x.id === rid);
      if (r) return r;
    }
    throw new Error("not found");
  },
  startRun: async (pid: string, input: { prompt: string; kind?: string; attachments?: unknown[] }) => {
    const p = get(pid);
    const message: BuilderMessage = { id: id(), role: "USER", content: input.prompt, attachments: (input.attachments as BuilderMessage["attachments"]) ?? [], createdAt: now() };
    p.messages.push(message);
    const run: BuilderRun = { id: id(), status: "QUEUED", kind: input.kind ?? "edit", prompt: input.prompt, steps: [], createdAt: now() };
    p.runs.unshift(run);
    p.activeRunId = run.id;
    void simulateRun(p, run).then(() => (p.activeRunId = null));
    return { run, message };
  },
  cancelRun: async (pid: string, rid: string) => {
    const r = await mockApi.getRun(pid, rid);
    r.status = "CANCELED";
    return { ok: true as const };
  },
  runEventsUrl: (_pid: string, rid: string) => `mock:${rid}`,
  streamRun: (rid: string, onEvent: (e: RunEvent) => void, opts: { from?: number; onEnd?: () => void } = {}) => {
    const ch = runListeners.get(rid);
    if (!ch) {
      setTimeout(() => opts.onEnd?.(), 0);
      return () => {};
    }
    ch.events.filter((e) => e.seq > (opts.from ?? 0)).forEach((e) => setTimeout(() => onEvent(e), 0));
    const sub = (e: RunEvent) => {
      onEvent(e);
      if (e.type === "status" && ["SUCCEEDED", "FAILED", "CANCELED"].includes(String((e.data as { status: string }).status))) setTimeout(() => opts.onEnd?.(), 0);
    };
    ch.subs.add(sub);
    if (ch.done) setTimeout(() => opts.onEnd?.(), 0);
    return () => ch.subs.delete(sub);
  },
  files: async (pid: string): Promise<FileEntry[]> => Object.keys(get(pid).files).sort().map((path) => ({ path, size: get(pid).files[path]!.length })),
  readFile: async (pid: string, path: string) => ({ path, content: get(pid).files[path] ?? "" }),
  writeFile: async (pid: string, path: string, content: string, message?: string) => {
    const p = get(pid);
    p.files[path] = content;
    return { commit: addCommit(p, message ?? `Edit ${path}`, "user", [{ path, status: "modified" }]) };
  },
  search: async (pid: string, q: string) => {
    const out: { path: string; line: number; text: string }[] = [];
    for (const [path, c] of Object.entries(get(pid).files)) c.split("\n").forEach((t, i) => t.toLowerCase().includes(q.toLowerCase()) && out.push({ path, line: i + 1, text: t.trim() }));
    return out.slice(0, 100);
  },
  commits: async (pid: string) => get(pid).commits,
  commit: async (pid: string, s: string) => {
    const c = get(pid).commits.find((x) => x.sha === s)!;
    return { commit: c, files: c.files ?? [] };
  },
  restore: async (pid: string, s: string) => {
    const p = get(pid);
    const c = p.commits.find((x) => x.sha === s);
    return { commit: addCommit(p, `Restore to “${c?.message ?? s.slice(0, 7)}”`, "user") };
  },
  preview: async (pid: string): Promise<PreviewState> => {
    const p = get(pid);
    return { status: p.previewStatus, url: p.previewUrl, errors: [] };
  },
  startPreview: async (pid: string): Promise<PreviewState> => {
    const p = get(pid);
    p.previewStatus = "STARTING";
    setTimeout(() => {
      p.previewStatus = "RUNNING";
      p.previewUrl = "mock:preview";
    }, 1500);
    return { status: "STARTING", url: null };
  },
  previewUrl: async () => "mock:preview",
  previewErrors: async () => [],
  clearPreviewErrors: async () => ({ ok: true as const }),
  shareInfo: async () => ({ enabled: false, expiresAt: null, createdAt: null }),
  visualEdit: async (pid: string, ops: VisualEditOp[], message?: string) => {
    const p = get(pid);
    return { commit: addCommit(p, message ?? `Visual edit: ${ops.map((o) => o.op).join(", ")}`, "visual") };
  },
  upload: async (_pid: string, file: File) => ({ url: URL.createObjectURL(file) }),
  publishState: async (pid: string): Promise<PublishState> => {
    const p = get(pid);
    return p.lastPublishedAt ? { url: `https://${p.name.toLowerCase().replace(/\W+/g, "-")}.levant.localhost`, lastPublishedAt: p.lastPublishedAt, deployment: { id: "d1", status: "READY" } } : { deployment: null };
  },
  publish: async (pid: string): Promise<PublishState> => {
    const p = get(pid);
    p.lastPublishedAt = now();
    return { deployment: { id: "d1", status: "QUEUED" }, url: `https://${p.name.toLowerCase().replace(/\W+/g, "-")}.levant.localhost` };
  },
  exportZipUrl: (pid: string) => `#zip-${pid}`,
  exportGithub: async () => ({ url: "https://github.com/example/app", repo: "example/app" }),
  share: async (_pid: string, input: { enabled: boolean }) => ({ url: input.enabled ? "https://preview-abc.levant.localhost/?share=demo" : null }),
  attachBackend: async (pid: string) => {
    const p = get(pid);
    p.baseRef = "mockbaseref01";
    return { project: strip(p) };
  },
};

export function mockPreviewHtml(): string {
  return MOCK_PREVIEW_HTML;
}
