"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/client/api";

export type AiStatus = { enabled: boolean; configured: boolean; model: string; effort: string; autoDiagnose: boolean; canConfigure: boolean };

let cache: Promise<AiStatus> | null = null;

/** GET /api/v1/ai/status (cached per page load). */
export function useAiStatus(enabled = true) {
  const [status, setStatus] = useState<AiStatus | null>(null);
  useEffect(() => {
    if (!enabled) return;
    cache ??= api<AiStatus>("/api/v1/ai/status").catch((e) => {
      cache = null;
      throw e;
    });
    cache.then(setStatus).catch(() => setStatus(null));
  }, [enabled]);
  return status;
}

export const refreshAiStatus = () => {
  cache = null;
};

export function disabledReasonFor(s: AiStatus | null): string | null {
  if (!s) return null;
  if (!s.enabled) return s.canConfigure ? "The agent is disabled. Enable it in Settings → AI." : "The AI agent is disabled on this platform.";
  if (!s.configured) return s.canConfigure ? "Add an Anthropic API key in Settings → AI to start using the agent." : "The AI agent isn't configured yet — ask the platform owner to add an API key.";
  return null;
}
