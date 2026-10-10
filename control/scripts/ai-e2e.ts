/**
 * End-to-end test of the LevantDeploy Agent against the fake Anthropic server (no real key).
 *
 *   npx tsx scripts/fake-anthropic.ts 4105 &                       # fake Messages API
 *   ANTHROPIC_BASE_URL=http://127.0.0.1:4105 ANTHROPIC_API_KEY=sk-ant-fake… PORT=3105 npm run dev   # app (own DB/Redis)
 *   set -a; . ./.env.ai; set +a; npx tsx scripts/ai-e2e.ts        # this script (same DATABASE_URL / REDIS_URL)
 *
 * Covers: streaming SSE run → parallel read tools (get_deployment + get_build_logs) → tool results in ONE user
 * message → set_env_var proposed → approved via API → executed (encrypted row + audit) → redeploy proposed →
 * approved → deployment QUEUED + build job enqueued; plus reject, destructive confirmation, viewer permissions,
 * refusal and server-side fallback handling, request-shape checks (beta header, fallbacks, effort, caching).
 */
import { db } from "@/lib/db";
import { appendLog, endLogs } from "@/lib/logs";
import { decryptString } from "@/lib/crypto";
import { hashPassword } from "@/lib/auth/password";
import { queues } from "@/lib/queues";
import { redis } from "@/lib/redis";
import type { AgentEvent } from "@/lib/ai/types";

const BASE = process.env.APP_URL || "http://localhost:3105";
const FAKE = (process.env.ANTHROPIC_BASE_URL || "http://127.0.0.1:4105").replace(/\/$/, "");
let failures = 0;
const ok = (cond: unknown, msg: string) => {
  console.log(`${cond ? "  ✓" : "  ✗"} ${msg}`);
  if (!cond) failures++;
};

class Client {
  cookie = "";
  constructor(public label: string) {}
  async req(path: string, init: { method?: string; body?: unknown } = {}) {
    const res = await fetch(BASE + path, {
      method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
      headers: { "content-type": "application/json", origin: BASE, ...(this.cookie ? { cookie: this.cookie } : {}) },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      redirect: "manual",
    });
    const set = res.headers.getSetCookie?.() ?? [];
    for (const c of set) if (c.startsWith("ld_session=")) this.cookie = c.split(";")[0]!;
    return res;
  }
  async json<T = Record<string, unknown>>(path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; data: T }> {
    const r = await this.req(path, init);
    const text = await r.text();
    return { status: r.status, data: (text ? JSON.parse(text) : null) as T };
  }
  /** POST that streams AgentEvents (SSE) → all events once the stream ends */
  async stream(path: string, body: unknown): Promise<{ status: number; events: AgentEvent[] }> {
    const r = await this.req(path, { body });
    if (!r.ok) return { status: r.status, events: [] };
    const text = await r.text();
    const events = text
      .split("\n\n")
      .map((c) => c.split("\n").find((l) => l.startsWith("data:")))
      .filter(Boolean)
      .map((l) => JSON.parse(l!.slice(5).trim()) as AgentEvent);
    return { status: r.status, events };
  }
  async login(email: string, password: string) {
    const r = await this.json("/api/v1/auth/login", { body: { email, password } });
    if (r.status !== 200) throw new Error(`${this.label} login failed: ${r.status} ${JSON.stringify(r.data)}`);
  }
}

const actionsOf = (evs: AgentEvent[]) => {
  const m = new Map<string, Extract<AgentEvent, { type: "action" }>["action"]>();
  for (const e of evs) if (e.type === "action") m.set(e.action.id, e.action);
  return [...m.values()];
};
const doneState = (evs: AgentEvent[]) => [...evs].reverse().find((e) => e.type === "done") as Extract<AgentEvent, { type: "done" }> | undefined;
const fakeRequests = async () => (await (await fetch(`${FAKE}/__requests`)).json()) as { headers: Record<string, string>; body: Record<string, unknown> }[];

async function fixture() {
  const project = await db.project.findFirstOrThrow({ where: { slug: "demo-app", team: { slug: "admin" } } });
  await db.envVar.deleteMany({ where: { projectId: project.id, key: "DATABASE_URL" } });
  const last = await db.deployment.findFirst({ where: { projectId: project.id }, orderBy: { number: "desc" } });
  const number = (last?.number ?? 0) + 1;
  // an earlier good production deployment (rollback target) + the failing one
  const good = await db.deployment.create({
    data: { projectId: project.id, number, shortId: `aie2e${Date.now().toString(36).slice(-4)}`, url: `demo-app-good${number}.levant.localhost`, target: "PRODUCTION", status: "SUPERSEDED", branch: "main", commitSha: "1111111aaaaaaa", commitMessage: "feat: landing page", readyAt: new Date() },
  });
  const failed = await db.deployment.create({
    data: {
      projectId: project.id,
      number: number + 1,
      shortId: `aie2f${Date.now().toString(36).slice(-4)}`,
      url: `demo-app-bad${number}.levant.localhost`,
      target: "PRODUCTION",
      status: "ERROR",
      branch: "main",
      commitSha: "2222222bbbbbbb",
      commitMessage: "feat: connect to postgres",
      errorStep: "BUILD",
      errorMessage: "Build failed: next build exited with code 1",
      events: { create: [{ status: "QUEUED", message: "Deployment queued" }, { fromStatus: "QUEUED", status: "BUILDING" }, { fromStatus: "BUILDING", status: "ERROR", message: "Build failed" }] },
    },
  });
  await appendLog(failed.id, "BUILD", [
    "Cloning github.com/acme/demo-app (main) …",
    "Detected framework: Next.js 15 (npm)",
    "#7 [build 4/5] RUN npm run build",
    "#7 2.311 > demo-app@1.0.0 build",
    "#7 2.312 > next build",
    "#7 9.871 Collecting page data ...",
    "#7 10.02 \u001b[31mError: DATABASE_URL is not defined\u001b[39m",
    "#7 10.02     at getPool (/app/.next/server/chunks/412.js:1:2203)",
    "#7 10.04 > Build error occurred",
    "#7 ERROR: process \"/bin/sh -c npm run build\" did not complete successfully: exit code: 1",
  ]);
  await endLogs(failed.id, "BUILD");
  return { project, good, failed };
}

async function main() {
  console.log(`LevantDeploy Agent e2e — app ${BASE}, fake API ${FAKE}`);
  await fetch(`${FAKE}/__reset`, { method: "POST" });
  const { project, good, failed } = await fixture();
  const admin = new Client("admin");
  await admin.login("admin@levantdeploy.local", "Admin@12345");

  const st = await admin.json<{ configured: boolean; model: string; effort: string }>("/api/v1/ai/status");
  ok(st.data.configured && st.data.model === "claude-opus-5-5" && st.data.effort === "medium", `status: configured, default model claude-opus-5-5, effort medium (${st.data.model}/${st.data.effort})`);

  // ── 1. diagnose + fix flow ─────────────────────────────────────────────
  console.log("\n1) Why did it fail? → diagnose → set_env_var (approve) → redeploy (approve)");
  const conv = await admin.json<{ conversation: { id: string } }>("/api/v1/ai/conversations", { body: { team: "admin", project: "demo-app" } });
  ok(conv.status === 201, "conversation created");
  const cid = conv.data.conversation.id;
  const r1 = await admin.stream(`/api/v1/ai/conversations/${cid}/messages`, { content: "Why did my latest deployment fail? Please fix it.", page: { deploymentId: failed.id } });
  ok(r1.status === 200, "messages endpoint streams (200 text/event-stream)");
  ok(r1.events.some((e) => e.type === "text_delta"), "text deltas streamed");
  ok(r1.events.some((e) => e.type === "thinking_delta"), "thinking (summarized) streamed");
  const a1 = actionsOf(r1.events);
  const getDep = a1.find((a) => a.tool === "get_deployment");
  const getLogs = a1.find((a) => a.tool === "get_build_logs");
  ok(getDep?.status === "SUCCEEDED" && getLogs?.status === "SUCCEEDED", "get_deployment + get_build_logs executed (read-only, no approval)");
  ok(String(getLogs?.output ?? "").includes("DATABASE_URL is not defined"), "build log search found the DATABASE_URL error (ANSI stripped)");
  const setEnv = a1.find((a) => a.tool === "set_env_var");
  ok(setEnv?.status === "PENDING_APPROVAL" && setEnv.requiresApproval, "set_env_var proposed → PENDING_APPROVAL");
  ok(setEnv && String(setEnv.input.value).startsWith("••••") && !JSON.stringify(setEnv).includes("s3cret-pass"), "secret value masked in the action shown to the UI");
  ok(doneState(r1.events)?.state === "awaiting_approval", "run paused: awaiting_approval");
  ok(!(await db.envVar.findFirst({ where: { projectId: project.id, key: "DATABASE_URL" } })), "nothing changed before approval");

  let reqs = await fakeRequests();
  ok(reqs.length === 2, `2 model calls so far (${reqs.length})`);
  const second = reqs[1]!.body as { messages: { role: string; content: { type: string }[] }[] };
  const lastMsg = second.messages[second.messages.length - 1]!;
  ok(lastMsg.role === "user" && lastMsg.content.filter((b) => b.type === "tool_result").length === 2 && lastMsg.content.length === 2, "parallel tool results returned in ONE user message");
  const h = reqs[0]!.headers;
  ok(String(h["anthropic-beta"]).includes("server-side-fallback-2026-07-01"), "beta header server-side-fallback-2026-07-01 sent");
  const b0 = reqs[0]!.body as Record<string, unknown>;
  ok(b0.fallbacks === "default", 'fallbacks: "default" sent');
  ok(JSON.stringify(b0.thinking) === JSON.stringify({ type: "adaptive", display: "summarized" }), "thinking adaptive (never disabled / budget)");
  ok((b0.output_config as { effort?: string })?.effort === "medium", "output_config.effort set explicitly");
  ok((b0.tool_choice as { type?: string })?.type === "auto", "tool_choice auto (no forced tool use)");
  ok((b0.tools as { eager_input_streaming?: boolean }[]).every((t) => t.eager_input_streaming === true), "every tool has eager_input_streaming");
  ok(JSON.stringify(b0.system).includes('"cache_control":{"type":"ephemeral"}') && (b0.cache_control as { type?: string })?.type === "ephemeral", "cache breakpoint on system + automatic tail caching");
  ok(JSON.stringify(reqs[0]!.body.system) === JSON.stringify(reqs[1]!.body.system) && JSON.stringify(reqs[0]!.body.tools) === JSON.stringify(reqs[1]!.body.tools), "tools + system prefix byte-identical across calls");
  ok(!JSON.stringify(b0.system).includes("demo-app") && JSON.stringify(b0.messages).includes("<levant_context>"), "volatile project context lives in the user turn, not the system prompt");

  const ap1 = await admin.stream(`/api/v1/ai/actions/${setEnv!.id}/approve`, {});
  ok(ap1.status === 200, "approve endpoint streams");
  const a2 = actionsOf(ap1.events);
  ok(a2.find((a) => a.id === setEnv!.id)?.status === "SUCCEEDED", "set_env_var executed after approval");
  const row = await db.envVar.findFirst({ where: { projectId: project.id, key: "DATABASE_URL" } });
  ok(row && decryptString(row.valueEnc) === "postgres://app:s3cret-pass@db.internal:5432/app" && row.isSecret && row.targets.join() === "PRODUCTION,PREVIEW", "env var stored encrypted (AES-GCM) with targets + secret flag");
  ok(!!(await db.auditLog.findFirst({ where: { action: "ai.action.execute", targetId: setEnv!.id } })) && !!(await db.auditLog.findFirst({ where: { action: "env.create", targetId: row?.id } })), "audit: ai.action.execute + env.create");
  const redeploy = a2.find((a) => a.tool === "redeploy");
  ok(redeploy?.status === "PENDING_APPROVAL", "model continued and proposed redeploy");
  ok(doneState(ap1.events)?.state === "awaiting_approval", "paused again for approval");

  const before = await db.deployment.count({ where: { projectId: project.id } });
  const ap2 = await admin.stream(`/api/v1/ai/actions/${redeploy!.id}/approve`, {});
  const rd = actionsOf(ap2.events).find((a) => a.id === redeploy!.id);
  ok(rd?.status === "SUCCEEDED", "redeploy executed");
  const queued = await db.deployment.findFirst({ where: { projectId: project.id }, orderBy: { number: "desc" } });
  ok((await db.deployment.count({ where: { projectId: project.id } })) === before + 1 && queued?.status === "QUEUED" && queued.trigger === "REDEPLOY" && queued.sourceDeploymentId === failed.id, `redeploy queued as #${queued?.number} (QUEUED, trigger REDEPLOY, source = failed deployment)`);
  const job = queued ? await queues.build.raw.getJob(`build-${queued.id}`) : null;
  ok(!!job && (job.data as { deploymentId?: string }).deploymentId === queued?.id, `build job enqueued in BullMQ (${job?.id})`);
  const finalText = ap2.events.filter((e) => e.type === "message").map((e) => JSON.stringify(e)).join("");
  ok(finalText.includes("Recap") && doneState(ap2.events)?.state === "idle", "final recap message; run idle");
  const detail = await admin.json<{ messages: { role: string }[]; actions: unknown[]; state: string }>(`/api/v1/ai/conversations/${cid}`);
  ok(detail.data.state === "idle" && detail.data.actions.length === 4, `conversation persisted (${detail.data.messages.length} messages, ${detail.data.actions.length} actions)`);
  reqs = await fakeRequests();
  const cacheHits = reqs.length;
  ok(cacheHits === 4, `4 model calls in the whole flow (${cacheHits})`);

  // ── 2. reject ─────────────────────────────────────────────────────────
  console.log("\n2) Reject a proposal");
  await db.envVar.deleteMany({ where: { projectId: project.id, key: "DATABASE_URL" } });
  const c2 = (await admin.json<{ conversation: { id: string } }>("/api/v1/ai/conversations", { body: { team: "admin", project: "demo-app" } })).data.conversation.id;
  const r2 = await admin.stream(`/api/v1/ai/conversations/${c2}/messages`, { content: "Fix the failed deployment" });
  const prop = actionsOf(r2.events).find((a) => a.tool === "set_env_var")!;
  const rj = await admin.stream(`/api/v1/ai/actions/${prop.id}/reject`, { reason: "I'll set it myself" });
  ok(actionsOf(rj.events).find((a) => a.id === prop.id)?.status === "REJECTED", "action REJECTED");
  ok(!(await db.envVar.findFirst({ where: { projectId: project.id, key: "DATABASE_URL" } })), "no env var written");
  ok(rj.events.some((e) => e.type === "message" && JSON.stringify(e).includes("won't change")), "model told about the rejection and stopped");
  const again = await admin.req(`/api/v1/ai/actions/${prop.id}/approve`, { body: {} });
  ok(again.status === 409, "approving an already-handled action → 409");

  // ── 3. destructive confirmation ───────────────────────────────────────
  console.log("\n3) Destructive action needs typed confirmation");
  await db.deployment.update({ where: { id: good.id }, data: { status: "SUPERSEDED" } });
  const c3 = (await admin.json<{ conversation: { id: string } }>("/api/v1/ai/conversations", { body: { team: "admin", project: "demo-app" } })).data.conversation.id;
  const r3 = await admin.stream(`/api/v1/ai/conversations/${c3}/messages`, { content: `Please roll back production to #${good.number}` });
  // the fake model asks for "#1"; point it at the real good deployment number if they differ
  const rb = actionsOf(r3.events).find((a) => a.tool === "rollback");
  ok(!!rb, `rollback tool called (${rb?.status}${rb?.error ? `: ${rb.error}` : ""})`);
  if (rb?.status === "PENDING_APPROVAL") {
    ok(rb.confirmText === "demo-app", "confirmation text = project slug");
    const noConfirm = await admin.json<{ error: { code: string } }>(`/api/v1/ai/actions/${rb.id}/approve`, { body: {} });
    ok(noConfirm.status === 422 && noConfirm.data.error.code === "VALIDATION", "approve without the typed slug → 422");
    const rej = await admin.stream(`/api/v1/ai/actions/${rb.id}/reject`, {});
    ok(actionsOf(rej.events).find((a) => a.id === rb.id)?.status === "REJECTED", "rejected (cleanup)");
  } else ok(rb?.status === "FAILED", "rollback precheck rejected an invalid target (not proposed)");

  // ── 4. viewer permissions ─────────────────────────────────────────────
  console.log("\n4) Viewer can read but cannot get mutations proposed");
  const team = await db.team.findFirstOrThrow({ where: { slug: "admin" } });
  const email = "viewer-ai-e2e@levantdeploy.local";
  const viewer = await db.user.upsert({ where: { email }, create: { email, name: "Vera Viewer", passwordHash: await hashPassword("Viewer@12345"), emailVerifiedAt: new Date() }, update: { passwordHash: await hashPassword("Viewer@12345") } });
  await db.membership.upsert({ where: { teamId_userId: { teamId: team.id, userId: viewer.id } }, create: { teamId: team.id, userId: viewer.id, role: "VIEWER" }, update: { role: "VIEWER" } });
  const v = new Client("viewer");
  await v.login(email, "Viewer@12345");
  const c4 = (await v.json<{ conversation: { id: string } }>("/api/v1/ai/conversations", { body: { team: "admin", project: "demo-app" } })).data.conversation.id;
  const r4 = await v.stream(`/api/v1/ai/conversations/${c4}/messages`, { content: "Why did it fail? fix it" });
  const va = actionsOf(r4.events);
  ok(va.find((a) => a.tool === "get_build_logs")?.status === "SUCCEEDED", "viewer: read tools work");
  const vset = va.find((a) => a.tool === "set_env_var");
  ok(vset?.status === "FAILED" && /member role/i.test(vset.error ?? ""), `viewer: set_env_var not proposed (${vset?.error})`);
  const otherConv = await v.json(`/api/v1/ai/conversations/${cid}`);
  ok(otherConv.status === 404, "viewer cannot open the admin's conversation (404)");

  // ── 5. refusal + fallback ─────────────────────────────────────────────
  console.log("\n5) Refusal and server-side fallback");
  const c5 = (await admin.json<{ conversation: { id: string } }>("/api/v1/ai/conversations", { body: { team: "admin", project: "demo-app" } })).data.conversation.id;
  const r5 = await admin.stream(`/api/v1/ai/conversations/${c5}/messages`, { content: "please refuse this" });
  const refusal = r5.events.find((e) => e.type === "refusal") as Extract<AgentEvent, { type: "refusal" }> | undefined;
  ok(refusal?.category === "cyber", "stop_reason refusal surfaced with category");
  const r5b = await admin.stream(`/api/v1/ai/conversations/${c5}/messages`, { content: "ok, check the fallback path" });
  ok(r5b.events.some((e) => e.type === "fallback"), "fallback block surfaced (claude-opus-5-5 → claude-opus-5)");
  reqs = await fakeRequests();
  const lastBody = reqs[reqs.length - 1]!.body as { messages: { role: string; content: unknown }[] };
  ok(!JSON.stringify(lastBody.messages).includes("Let me look at th"), "refused partial output is not replayed in history");
  const r5c = await admin.stream(`/api/v1/ai/conversations/${c5}/messages`, { content: "hello" });
  reqs = await fakeRequests();
  const afterFallback = JSON.stringify((reqs[reqs.length - 1]!.body as { messages: unknown[] }).messages);
  ok(!afterFallback.includes('"type":"fallback"') && afterFallback.includes("Answered by the fallback model"), "fallback marker dropped, fallback text echoed back");
  ok(doneState(r5c.events)?.state === "idle", "conversation continues normally");

  // ── 6. invalid tool input ─────────────────────────────────────────────
  console.log("\n6) Invalid tool input (eager streaming) is validated, never executed");
  const c6 = (await admin.json<{ conversation: { id: string } }>("/api/v1/ai/conversations", { body: { team: "admin", project: "demo-app" } })).data.conversation.id;
  const r6 = await admin.stream(`/api/v1/ai/conversations/${c6}/messages`, { content: "send invalid input please" });
  const bad = actionsOf(r6.events).find((a) => a.tool === "set_env_var");
  ok(bad?.status === "FAILED" && (bad.error ?? "").includes("INVALID_INPUT"), "zod validation failed → is_error tool_result, nothing proposed");

  // ── 7. diagnosis banner API ───────────────────────────────────────────
  console.log("\n7) One-shot diagnosis (auto-diagnosis path)");
  const dx = await admin.json<{ diagnosis: { summary: string; source: string } }>(`/api/v1/ai/deployments/${failed.id}/diagnose`, { body: {} });
  ok(dx.status === 200 && dx.data.diagnosis.source === "ai" && dx.data.diagnosis.summary.includes("DATABASE_URL"), "diagnosis stored on deployment.meta.aiDiagnosis");

  console.log(failures ? `\n✗ ${failures} check(s) failed` : "\n✓ all checks passed");
  await queues.build.raw.close().catch(() => {});
  await redis().quit().catch(() => {});
  await db.$disconnect();
  process.exit(failures ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
