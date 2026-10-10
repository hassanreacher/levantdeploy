import Anthropic from "@anthropic-ai/sdk";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { AiNotConfiguredError, getAnthropic } from "./config";
import { buildDiagnosis, heuristicSummary, type Signal } from "./diagnose";
import { buildRequest } from "./agent";

/**
 * One-shot failure summary stored on `deployment.meta.aiDiagnosis` (banner on the deployment page).
 * Uses the agent's exact `tools + system` prefix (shared prompt cache) and a single user message carrying the
 * structured diagnosis; falls back to the heuristic summary when the AI is not configured or declines.
 */
export type AiDiagnosis = { summary: string; signals: Signal[]; source: "ai" | "heuristic"; model: string | null; at: string };

export async function diagnoseAndStore(deploymentId: string): Promise<AiDiagnosis | null> {
  const d = await db.deployment.findUnique({ where: { id: deploymentId }, include: { project: true } });
  if (!d) return null;
  const { project, ...dep } = d;
  const dx = await buildDiagnosis(dep, project);
  let result: AiDiagnosis = { summary: heuristicSummary(dx), signals: dx.signals, source: "heuristic", model: null, at: new Date().toISOString() };
  try {
    const { client, config } = await getAnthropic();
    const prompt = [
      "A deployment just failed. Using ONLY the diagnosis below (do not call tools), write a short diagnosis for a banner:",
      "first line = the most likely root cause in one sentence; then up to 3 bullet points with concrete fixes (mention exact env keys, settings or commands).",
      "Plain Markdown, under 120 words.",
      "",
      "```json",
      JSON.stringify(dx, null, 1).slice(0, 40_000),
      "```",
    ].join("\n");
    const stream = client.beta.messages.stream(buildRequest(config, [{ role: "user", content: prompt }], 4000));
    const msg = await stream.finalMessage();
    const text = msg.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (msg.stop_reason !== "refusal" && text) result = { ...result, summary: text.slice(0, 2000), source: "ai", model: msg.model };
  } catch (e) {
    if (!(e instanceof AiNotConfiguredError) && !(e instanceof Anthropic.APIError)) console.warn("[ai] auto-diagnosis failed:", (e as Error).message);
  }
  const fresh = await db.deployment.findUnique({ where: { id: deploymentId }, select: { meta: true } });
  const meta = { ...((fresh?.meta as Prisma.JsonObject) ?? {}), aiDiagnosis: result as unknown as Prisma.InputJsonObject };
  await db.deployment.update({ where: { id: deploymentId }, data: { meta } });
  return result;
}

export function readDiagnosis(meta: unknown): AiDiagnosis | null {
  const m = (meta as { aiDiagnosis?: AiDiagnosis } | null)?.aiDiagnosis;
  return m && typeof m.summary === "string" ? m : null;
}
