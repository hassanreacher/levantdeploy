"use client";

import { useEffect, useState } from "react";
import { api, ApiClientError } from "@/lib/client/api";
import { AI_EFFORTS, AI_MODELS } from "@/lib/ai/types";
import { Badge, Button, Card, CardBody, CardFooter, CardHeader, Field, Input, Select, Skeleton, Switch, useToast } from "@/components/ui";
import { refreshAiStatus } from "./use-ai-status";

type View = { enabled: boolean; model: string; effort: string; autoDiagnose: boolean; keySource: "setting" | "env" | null; keyHint: string };

const EFFORT_HINT: Record<string, string> = {
  low: "fastest, least thinking",
  medium: "recommended balance (default)",
  high: "more thorough",
  xhigh: "deep reasoning, slower",
  max: "maximum effort, slowest",
};

/**
 * Settings → AI (platform owner): API key (stored encrypted, never shown again), model, effort, enable switch and
 * auto-diagnosis of failed deployments. Mountable anywhere (AI tab, global panel dialog, a future platform settings page).
 */
export function AiSettingsForm({ onSaved }: { onSaved?: () => void }) {
  const toast = useToast();
  const [v, setV] = useState<View | null>(null);
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api<View>("/api/v1/ai/settings")
      .then(setV)
      .catch((e: ApiClientError) => setErr(e.message));
  }, []);

  const save = async (patch: Partial<View> & { apiKey?: string | null }) => {
    setSaving(true);
    setErr(null);
    try {
      const next = await api<View>("/api/v1/ai/settings", { method: "PUT", body: patch });
      setV(next);
      setKey("");
      refreshAiStatus();
      toast.success("AI settings saved");
      onSaved?.();
    } catch (e) {
      setErr((e as ApiClientError).fields?.apiKey ?? (e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (err && !v) return <p className="text-[13px] text-danger">{err}</p>;
  if (!v)
    return (
      <div className="space-y-3">
        <Skeleton className="h-9" />
        <Skeleton className="h-9" />
        <Skeleton className="h-9" />
      </div>
    );

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-[14px] font-medium text-fg">Enable the agent</p>
          <p className="text-[12.5px] text-muted">Shows the assistant to every member. Changes always need approval.</p>
        </div>
        <Switch checked={v.enabled} onCheckedChange={(enabled) => void save({ enabled })} disabled={saving} label="Enable the agent" />
      </div>

      <Field
        label="Anthropic API key"
        htmlFor="ai-key"
        error={err}
        hint={
          v.keySource === "setting" ? (
            <>Stored encrypted ({v.keyHint}). Enter a new key to replace it.</>
          ) : v.keySource === "env" ? (
            <>Using ANTHROPIC_API_KEY from the server environment ({v.keyHint}). A key saved here takes precedence.</>
          ) : (
            "No key configured. Create one in the Anthropic Console."
          )
        }
      >
        <div className="flex gap-2">
          <Input id="ai-key" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder={v.keySource ? "••••••••••••" : "sk-ant-…"} />
          <Button variant="secondary" onClick={() => void save({ apiKey: key })} disabled={!key.trim() || saving}>
            Save key
          </Button>
        </div>
      </Field>
      {v.keySource === "setting" && (
        <button type="button" className="-mt-3 text-[12.5px] text-muted underline-offset-2 hover:text-danger hover:underline" onClick={() => void save({ apiKey: null })}>
          Remove stored key
        </button>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Model" htmlFor="ai-model" hint={AI_MODELS.find((m) => m.id === v.model)?.hint}>
          <Select id="ai-model" value={v.model} onChange={(e) => void save({ model: e.target.value })} options={AI_MODELS.map((m) => ({ value: m.id, label: m.label }))} disabled={saving} />
        </Field>
        <Field label="Effort" htmlFor="ai-effort" hint={EFFORT_HINT[v.effort]}>
          <Select id="ai-effort" value={v.effort} onChange={(e) => void save({ effort: e.target.value })} options={AI_EFFORTS.map((x) => ({ value: x, label: x }))} disabled={saving} />
        </Field>
      </div>

      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-[14px] font-medium text-fg">Diagnose failed deployments automatically</p>
          <p className="text-[12.5px] text-muted">Runs a read-only diagnosis when a deployment fails and shows it as a banner on the deployment.</p>
        </div>
        <Switch checked={v.autoDiagnose} onCheckedChange={(autoDiagnose) => void save({ autoDiagnose })} disabled={saving} label="Automatic diagnosis" />
      </div>
    </div>
  );
}

export function AiSettingsCard() {
  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            AI agent <Badge tone="outline">Platform</Badge>
          </span>
        }
        description="Claude model, effort and API key used by the LevantDeploy Agent."
      />
      <CardBody>
        <AiSettingsForm />
      </CardBody>
      <CardFooter hint="Server-side refusal fallback is enabled for Opus and Sonnet models." />
    </Card>
  );
}
