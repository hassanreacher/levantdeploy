import { z } from "zod/v4";
import type Anthropic from "@anthropic-ai/sdk";
import type { TeamRole } from "@prisma/client";
import { ToolError, aiTeamAccess } from "../permissions";
import * as R from "./read";
import * as W from "./write";
import * as B from "./base";
import type { ToolCtx, ToolDef } from "./shared";

export type { ToolCtx, ToolDef } from "./shared";

/** Every agent tool, sorted by name so the serialized `tools` prefix is byte-stable (prompt caching). */
export const TOOLS: ToolDef[] = (
  [
    R.listProjects,
    R.getProject,
    R.listDeployments,
    R.getDeployment,
    R.getBuildLogs,
    R.getRuntimeLogs,
    R.getMetrics,
    R.diagnoseDeployment,
    R.checkDomainDnsTool,
    R.explainDnsSetup,
    R.readRepoFile,
    W.generateDockerfile,
    W.setEnvVar,
    W.deleteEnvVar,
    W.updateBuildSettings,
    W.updateRuntimeSettings,
    W.redeploy,
    W.rollback,
    W.restart,
    W.addDomainTool,
    W.createDatabaseTool,
    B.listBaseProjects,
    B.getBaseProject,
    B.runBaseSql,
    B.baseLogs,
  ] as unknown as ToolDef[]
).sort((a, b) => a.name.localeCompare(b.name));

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));
export const getTool = (name: string) => BY_NAME.get(name) ?? null;

function jsonSchema(schema: z.ZodType): Anthropic.Beta.BetaTool.InputSchema {
  const { $schema: _s, ...rest } = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
  return { type: "object", ...rest } as Anthropic.Beta.BetaTool.InputSchema;
}

let apiToolsCache: Anthropic.Beta.BetaTool[] | null = null;

/**
 * Tool definitions sent to the API. Streaming requests with client tools use `eager_input_streaming`,
 * so every input is validated with the tool's zod schema before it runs (prepareToolCall).
 */
export function apiTools(): Anthropic.Beta.BetaTool[] {
  apiToolsCache ??= TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: jsonSchema(t.schema),
    eager_input_streaming: true,
  }));
  return apiToolsCache;
}

export const needsApproval = (t: ToolDef, input: unknown) => (typeof t.approval === "function" ? t.approval(input) : t.approval);
export const minRoleFor = (t: ToolDef, input: unknown): TeamRole => (typeof t.minRole === "function" ? t.minRole(input) : t.minRole);
export const scopeFor = (t: ToolDef, input: unknown): string | undefined => (typeof t.scope === "function" ? t.scope(input) : t.scope);

export type PreparedCall = { ok: true; tool: ToolDef; input: unknown } | { ok: false; error: string; code: "UNKNOWN_TOOL" | "INVALID_INPUT" };

/** Validate a tool_use block's input against the tool's schema (required with eager input streaming). */
export function prepareToolCall(name: string, rawInput: unknown): PreparedCall {
  const tool = getTool(name);
  if (!tool) return { ok: false, code: "UNKNOWN_TOOL", error: `Unknown tool "${name}"` };
  const parsed = tool.schema.safeParse(rawInput);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
    return { ok: false, code: "INVALID_INPUT", error: JSON.stringify({ INVALID_INPUT: issues, received: JSON.stringify(rawInput)?.slice(0, 2000) }) };
  }
  return { ok: true, tool, input: parsed.data };
}

/** Team-level role/scope gate before any tool-specific checks (tools re-check per project). */
export async function gateTool(tool: ToolDef, input: unknown, ctx: ToolCtx) {
  await aiTeamAccess(ctx.actor, ctx.teamId, minRoleFor(tool, input), scopeFor(tool, input));
}

const MAX_RESULT_CHARS = 24_000;

/** Tool output → tool_result text (bounded). */
export function resultText(out: unknown): string {
  const s = typeof out === "string" ? out : JSON.stringify(out, null, 1);
  return s.length > MAX_RESULT_CHARS ? `${s.slice(0, MAX_RESULT_CHARS)}\n… [truncated ${s.length - MAX_RESULT_CHARS} chars]` : s;
}

export function errorText(e: unknown): string {
  if (e instanceof ToolError) return `${e.code}: ${e.message}`;
  if (e instanceof z.ZodError) return `INVALID: ${e.issues.map((i) => i.message).join("; ")}`;
  return `FAILED: ${(e as Error)?.message ?? String(e)}`.slice(0, 2000);
}
