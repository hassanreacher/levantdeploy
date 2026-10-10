"use client";

import { useCallback, useEffect, useState } from "react";
import { Database, ExternalLink, HardDrive, Loader2, Plus, RefreshCw, Table2, Users } from "lucide-react";
import { Button, LinkButton } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { api } from "@/lib/client/api";
import { builderApi, isMock } from "@/lib/builder-ui/api";
import { errMessage, useEditor } from "./context";
import { Sheet } from "./sheet";

type BaseDTO = { ref: string; name: string; status: string; apiUrl: string; project: { slug: string; name: string } | null; errorMessage?: string | null };
type SqlResult = { rows: Record<string, unknown>[] };
type Overview = { tables: { name: string; rows: number }[]; users: number | null; buckets: { id: string; public: boolean; objects: number }[] };

const OVERVIEW_SQL = {
  tables: `select c.relname as name, greatest(c.reltuples, 0)::bigint as rows from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' order by c.relname limit 200`,
  users: `select count(*)::int as n from auth.users`,
  buckets: `select b.id, b.public, (select count(*) from storage.objects o where o.bucket_id = b.id)::int as objects from storage.buckets b order by b.id limit 100`,
};

async function sqlRows(ref: string, sql: string): Promise<Record<string, unknown>[]> {
  const r = await api<SqlResult>(`/api/v1/base/projects/${ref}/sql`, { body: { sql, maxRows: 200 } });
  return r.rows ?? [];
}

export function BackendPanel() {
  const ed = useEditor();
  const toast = useToast();
  const open = ed.panel === "backend";
  const ref = ed.project.baseRef;
  const [base, setBase] = useState<BaseDTO | null>(null);
  const [ov, setOv] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(false);
  const [teamBases, setTeamBases] = useState<BaseDTO[] | null>(null);
  const [pick, setPick] = useState("");
  const [busy, setBusy] = useState<"create" | "attach" | "studio" | null>(null);

  const load = useCallback(async () => {
    if (!ref || isMock()) return;
    setLoading(true);
    try {
      const { project } = await api<{ project: BaseDTO }>(`/api/v1/base/projects/${ref}`);
      setBase(project);
      if (project.status === "ACTIVE") {
        const [tables, users, buckets] = await Promise.all([
          sqlRows(ref, OVERVIEW_SQL.tables).catch(() => []),
          sqlRows(ref, OVERVIEW_SQL.users).catch(() => null),
          sqlRows(ref, OVERVIEW_SQL.buckets).catch(() => []),
        ]);
        setOv({
          tables: tables.map((t) => ({ name: String(t.name), rows: Number(t.rows ?? 0) })),
          users: users ? Number(users[0]?.n ?? 0) : null,
          buckets: buckets.map((b) => ({ id: String(b.id), public: Boolean(b.public), objects: Number(b.objects ?? 0) })),
        });
      } else setOv(null);
    } catch (e) {
      toast.error("Could not load the backend", errMessage(e));
    } finally {
      setLoading(false);
    }
  }, [ref, toast]);

  useEffect(() => {
    if (open) void load();
  }, [open, load, ed.headVersion]);

  useEffect(() => {
    if (!open || ref || teamBases) return;
    api<{ items: BaseDTO[] }>(`/api/v1/base/projects?team=${encodeURIComponent(ed.team)}`).then(
      (r) => setTeamBases(r.items.filter((b) => !b.project)),
      () => setTeamBases([]),
    );
  }, [open, ref, teamBases, ed.team]);

  const attach = async (input: { ref?: string; create?: boolean }) => {
    setBusy(input.create ? "create" : "attach");
    try {
      const r = await builderApi().attachBackend(ed.project.id, input);
      ed.setProject(r.project);
      toast.success(input.create ? "Backend is being created" : "Backend attached", "The agents can now create tables, auth and storage for your app.");
    } catch (e) {
      toast.error("Could not attach a backend", errMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const openStudio = async () => {
    if (!ref) return;
    setBusy("studio");
    const w = window.open("about:blank", "_blank");
    try {
      const r = await api<{ url: string }>(`/api/v1/base/projects/${ref}/studio`, { method: "POST" });
      if (w) w.location.href = r.url;
      else window.open(r.url, "_blank");
    } catch (e) {
      w?.close();
      toast.error("Could not open Studio", errMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const basePath = base ? (base.project ? `/${ed.team}/${base.project.slug}/backend` : `/${ed.team}/base/${base.ref}`) : null;

  return (
    <Sheet open={open} onClose={() => ed.setPanel(null)} title="Backend" description="Database, auth, storage and functions powered by LevantBase.">
      {!ref ? (
        <div className="space-y-5" data-testid="backend-empty">
          <div className="rounded-lg border border-border bg-surface p-5 text-center">
            <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full border border-border bg-bg-subtle">
              <Database className="h-4 w-4 text-accent" />
            </div>
            <p className="font-medium">No backend yet</p>
            <p className="mx-auto mt-1 max-w-xs text-[13px] text-muted">Add a Postgres database with auth, storage and realtime. You can also just ask the AI: “save orders in a database”.</p>
            <Button className="mt-4" variant="primary" loading={busy === "create"} leftIcon={<Plus className="h-4 w-4" />} onClick={() => void attach({ create: true })} data-testid="backend-create">
              Create a backend
            </Button>
          </div>
          {teamBases && teamBases.length > 0 && (
            <div className="space-y-2">
              <p className="text-[13px] font-medium">Or connect an existing Base project</p>
              <div className="flex gap-2">
                <Select value={pick} onChange={(e) => setPick(e.target.value)} options={[{ value: "", label: "Choose…" }, ...teamBases.map((b) => ({ value: b.ref, label: `${b.name} (${b.ref})` }))]} aria-label="Existing Base project" />
                <Button disabled={!pick} loading={busy === "attach"} onClick={() => void attach({ ref: pick })}>
                  Connect
                </Button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-5" data-testid="backend-attached">
          <div className="flex items-center gap-3 rounded-lg border border-border bg-surface p-4">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-bg-subtle">
              <Database className="h-4 w-4 text-accent" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{base?.name ?? ref}</p>
              <p className="truncate font-mono text-[11.5px] text-subtle">{base?.apiUrl ?? ref}</p>
            </div>
            <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11.5px]", base?.status === "ACTIVE" ? "border-success/30 text-success" : base?.status === "ERROR" ? "border-danger/30 text-danger" : "border-border text-muted")}>
              <span className={cn("h-1.5 w-1.5 rounded-full", base?.status === "ACTIVE" ? "bg-success" : base?.status === "ERROR" ? "bg-danger" : "animate-pulse2 bg-warning")} />
              {(base?.status ?? "…").toLowerCase()}
            </span>
          </div>
          {base?.errorMessage && <p className="rounded-md border border-danger/30 bg-danger/10 p-2 text-[12.5px] text-danger">{base.errorMessage}</p>}
          <div className="grid grid-cols-3 gap-2">
            <Stat icon={<Table2 className="h-3.5 w-3.5" />} label="Tables" value={ov ? ov.tables.length : null} loading={loading} />
            <Stat icon={<Users className="h-3.5 w-3.5" />} label="Auth users" value={ov?.users ?? null} loading={loading} />
            <Stat icon={<HardDrive className="h-3.5 w-3.5" />} label="Buckets" value={ov ? ov.buckets.length : null} loading={loading} />
          </div>
          <div>
            <div className="mb-2 flex items-center justify-between">
              <p className="text-[13px] font-medium">Tables</p>
              <Button size="icon-sm" variant="ghost" onClick={() => void load()} aria-label="Refresh">
                <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
              </Button>
            </div>
            <div className="overflow-hidden rounded-lg border border-border">
              {loading && !ov ? (
                <p className="flex items-center gap-2 p-3 text-[13px] text-muted">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
                </p>
              ) : ov?.tables.length ? (
                <ul className="divide-y divide-border">
                  {ov.tables.map((t) => (
                    <li key={t.name} className="flex items-center gap-2 px-3 py-2 text-[13px]">
                      <Table2 className="h-3.5 w-3.5 text-subtle" />
                      <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{t.name}</span>
                      <span className="text-[12px] text-subtle">~{t.rows.toLocaleString()} rows</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="p-3 text-[13px] text-muted">{base?.status === "ACTIVE" ? "No tables yet — ask the AI to store something." : "Available once the backend is running."}</p>
              )}
            </div>
          </div>
          {ov && ov.buckets.length > 0 && (
            <div>
              <p className="mb-2 text-[13px] font-medium">Storage</p>
              <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
                {ov.buckets.map((b) => (
                  <li key={b.id} className="flex items-center gap-2 px-3 py-2 text-[13px]">
                    <HardDrive className="h-3.5 w-3.5 text-subtle" />
                    <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{b.id}</span>
                    <span className="text-[12px] text-subtle">
                      {b.objects} files · {b.public ? "public" : "private"}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" leftIcon={<ExternalLink className="h-3.5 w-3.5" />} loading={busy === "studio"} disabled={base?.status !== "ACTIVE"} onClick={() => void openStudio()}>
              Open Studio
            </Button>
            {basePath && (
              <LinkButton href={basePath} variant="secondary">
                Backend dashboard
              </LinkButton>
            )}
          </div>
        </div>
      )}
    </Sheet>
  );
}

function Stat({ icon, label, value, loading }: { icon: React.ReactNode; label: string; value: number | null; loading: boolean }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <p className="flex items-center gap-1.5 text-[11.5px] text-muted">
        {icon}
        {label}
      </p>
      <p className="mt-1 text-[20px] font-semibold tabular-nums">{value == null ? (loading ? "…" : "—") : value.toLocaleString()}</p>
    </div>
  );
}
