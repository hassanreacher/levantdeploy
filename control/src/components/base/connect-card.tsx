"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Database, Plug } from "lucide-react";
import { Button, Card, CardBody, CardFooter, CardHeader, Select, Switch, useToast } from "@/components/ui";
import { api, ApiClientError } from "@/lib/client/api";
import { cn } from "@/lib/utils";

const TARGETS = [
  { value: "PRODUCTION", label: "Production" },
  { value: "PREVIEW", label: "Preview" },
  { value: "DEVELOPMENT", label: "Development" },
] as const;

/**
 * Environment page → "Connect a Base project": writes NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY /
 * SUPABASE_URL / SUPABASE_ANON_KEY (+ optional SUPABASE_SERVICE_ROLE_KEY secret, DATABASE_URL) for the chosen targets.
 */
export function ConnectBaseCard({
  projectId,
  teamSlug,
  projectSlug,
  bases,
  attachedRef,
  canWrite,
  isAdmin,
}: {
  projectId: string;
  teamSlug: string;
  projectSlug: string;
  bases: { ref: string; name: string; status: string; attachedTo: string | null; dbUrl: boolean }[];
  attachedRef: string | null;
  canWrite: boolean;
  isAdmin: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [ref, setRef] = useState(attachedRef ?? bases[0]?.ref ?? "");
  const [targets, setTargets] = useState<string[]>(TARGETS.map((t) => t.value));
  const [serviceKey, setServiceKey] = useState(false);
  const [dbUrl, setDbUrl] = useState(false);
  const [dbKind, setDbKind] = useState<"pooler" | "direct">("pooler");
  const [busy, setBusy] = useState(false);
  const dbAvailable = !!bases.find((b) => b.ref === ref)?.dbUrl;
  const connect = async () => {
    setBusy(true);
    try {
      const r = await api<{ keys: string[] }>(`/api/v1/base/projects/${ref}/connect`, {
        body: { projectId, targets, includeServiceRole: serviceKey, includeDatabaseUrl: dbUrl && dbAvailable, databaseUrlKind: dbKind, connectEnv: true },
      });
      toast.success(`Added ${r.keys.length} environment variables`, "Redeploy to apply them.");
      router.refresh();
    } catch (e) {
      toast.error("Could not connect", e instanceof ApiClientError ? e.message : undefined);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <CardHeader
        title={
          <span className="inline-flex items-center gap-2">
            <Plug className="h-4 w-4 text-muted" /> Connect a Base project
          </span>
        }
        description="Add the URL and keys of a LevantBase backend as environment variables (Supabase client conventions)."
      />
      <CardBody className="space-y-4">
        {bases.length ? (
          <>
            <Select
              value={ref}
              onChange={(e) => setRef(e.target.value)}
              aria-label="Base project"
              className="max-w-md"
              options={bases.map((b) => ({ value: b.ref, label: `${b.name}${b.ref === attachedRef ? " (this project's backend)" : b.attachedTo ? ` (backend of ${b.attachedTo})` : ""}` }))}
            />
            <div>
              <div className="mb-1.5 text-[13px] font-medium text-muted">Environments</div>
              <div className="flex flex-wrap gap-2">
                {TARGETS.map((t) => {
                  const on = targets.includes(t.value);
                  return (
                    <button
                      key={t.value}
                      type="button"
                      aria-pressed={on}
                      onClick={() => setTargets(on ? targets.filter((x) => x !== t.value) : [...targets, t.value])}
                      className={cn("h-8 rounded-md border px-3 text-[13px] transition-colors", on ? "border-fg/40 bg-surface-2 text-fg" : "border-border text-muted hover:border-border-strong")}
                    >
                      {t.label}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="divide-y divide-border rounded-md border border-border">
              <div className="px-3 py-2.5 text-[12px] text-muted">
                <div className="font-mono">NEXT_PUBLIC_SUPABASE_URL · NEXT_PUBLIC_SUPABASE_ANON_KEY · SUPABASE_URL · SUPABASE_ANON_KEY</div>
                <div className="mt-1">SUPABASE_URL uses the private network address in Production and Preview.</div>
              </div>
              <label className="flex items-center justify-between gap-3 px-3 py-2.5 text-[13px]">
                <span>
                  <span className="font-mono">SUPABASE_SERVICE_ROLE_KEY</span> <span className="text-muted">(secret, server-side only)</span>
                  {!isAdmin && <span className="block text-[12px] text-subtle">Admins only</span>}
                </span>
                <Switch checked={serviceKey} onCheckedChange={setServiceKey} disabled={!isAdmin} label="Service role key" />
              </label>
              <label className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5 text-[13px]">
                <span>
                  <span className="font-mono">DATABASE_URL</span> <span className="text-muted">(secret, private pooler)</span>
                  {!isAdmin ? (
                    <span className="block text-[12px] text-subtle">Admins only</span>
                  ) : (
                    !dbAvailable && <span className="block text-[12px] text-subtle">The connection pooler isn&apos;t included in this backend&apos;s plan</span>
                  )}
                </span>
                <span className="flex items-center gap-2">
                  {dbUrl && dbAvailable && (
                    <Select value={dbKind} onChange={(e) => setDbKind(e.target.value as "pooler" | "direct")} aria-label="Connection type" options={[{ value: "pooler", label: "Pooler" }, { value: "direct", label: "Direct" }]} />
                  )}
                  <Switch checked={dbUrl && dbAvailable} onCheckedChange={setDbUrl} disabled={!isAdmin || !dbAvailable} label="Database URL" />
                </span>
              </label>
            </div>
          </>
        ) : (
          <p className="flex items-center gap-2 text-[13px] text-muted">
            <Database className="h-4 w-4" /> No Base projects in this team yet.
          </p>
        )}
      </CardBody>
      <CardFooter
        hint={
          <>
            Existing keys are overwritten.{" "}
            {!attachedRef && (
              <Link href={`/${teamSlug}/${projectSlug}/backend`} className="underline underline-offset-2 hover:text-fg">
                Add a backend
              </Link>
            )}
          </>
        }
      >
        <Button size="sm" variant="primary" disabled={!canWrite || !ref || !targets.length} loading={busy} onClick={connect}>
          Connect
        </Button>
      </CardFooter>
    </Card>
  );
}
