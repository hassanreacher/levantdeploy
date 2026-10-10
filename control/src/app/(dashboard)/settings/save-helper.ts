"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useToast } from "@/components/ui/toast";
import { api, ApiClientError } from "@/lib/client/api";

export function errText(e: unknown) {
  return e instanceof ApiClientError ? (e.fields ? Object.values(e.fields)[0] : e.message) : undefined;
}

/** PATCH /api/v1/platform/settings with toast + refresh; `busy` holds the key being saved. */
export function usePlatformPatch() {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const patch = async (key: string, body: Record<string, unknown>, okMsg = "Saved") => {
    setBusy(key);
    try {
      await api("/api/v1/platform/settings", { method: "PATCH", body });
      toast.success(okMsg);
      router.refresh();
      return true;
    } catch (e) {
      toast.error("Could not save", errText(e));
      return false;
    } finally {
      setBusy(null);
    }
  };
  return { busy, setBusy, patch, toast, router };
}
