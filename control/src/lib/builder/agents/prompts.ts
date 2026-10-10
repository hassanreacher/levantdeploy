/**
 * Prompt loading. System prompts live in ./prompts/<role>.md (+ shared conventions in ./prompts/_conventions.md);
 * cheat sheets for the read_docs tool in ./prompts/docs/<topic>.md. Loaded from disk once and cached
 * (agents run on the worker, which ships src/).
 */
import fs from "node:fs";
import path from "node:path";
import type { Role } from "./types";

export const DOC_TOPICS = ["next15", "shadcn", "supabase-js", "supabase-auth", "rls", "storage", "tailwind", "accessibility", "seo"] as const;

function promptsDir(): string {
  const candidates = [
    path.join(__dirname, "prompts"),
    path.join(process.cwd(), "src/lib/builder/agents/prompts"),
    path.join(process.cwd(), "control/src/lib/builder/agents/prompts"),
  ];
  for (const c of candidates) if (fs.existsSync(path.join(c, "_conventions.md"))) return c;
  return candidates[0];
}

const cache = new Map<string, string>();
function load(rel: string): string | null {
  if (cache.has(rel)) return cache.get(rel)!;
  try {
    const text = fs.readFileSync(path.join(promptsDir(), rel), "utf8");
    cache.set(rel, text);
    return text;
  } catch {
    return null;
  }
}

export async function readDoc(topic: string): Promise<string | null> {
  const key = topic.toLowerCase().trim().replace(/\.md$/, "").replace(/[^a-z0-9-]/g, "");
  const alias: Record<string, string> = { next: "next15", nextjs: "next15", supabase: "supabase-js", auth: "supabase-auth", tailwindcss: "tailwind", a11y: "accessibility", ui: "shadcn" };
  const name = (DOC_TOPICS as readonly string[]).includes(key) ? key : alias[key];
  if (!name) return null;
  return load(`docs/${name}.md`);
}

/** Role system prompt = role file + shared conventions (+ backend facts when a backend exists). */
export function systemPrompt(role: Role, extra: { knowledge?: string; backend?: { ref: string; url: string } | null } = {}): string {
  const parts = [load(`${role}.md`) ?? `You are the ${role} of an AI app builder.`];
  if (!["judge", "summarizer"].includes(role)) parts.push(load("_conventions.md") ?? "");
  if (extra.backend) {
    parts.push(
      `## This app's backend\nA LevantBase (Supabase-compatible) backend is attached: ref ${extra.backend.ref}, URL ${extra.backend.url}. ` +
        "The preview has NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY set; use the client from lib/supabase.ts.",
    );
  }
  if (extra.knowledge?.trim()) parts.push(`## Project knowledge (from the owner — follow it)\n${extra.knowledge.trim().slice(0, 6000)}`);
  return parts.filter(Boolean).join("\n\n");
}
