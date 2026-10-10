"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Archive, Download, Eye, EyeOff, Plus, RotateCcw } from "lucide-react";
import { Badge, Button, Card, CardBody, CardFooter, CardHeader, CopyButton, EmptyState, Spinner, Switch, Tabs, useToast } from "@/components/ui";
import { api, ApiClientError } from "@/lib/client/api";
import type { BackupDTO, ConnectionInfoDTO } from "@/lib/base-ui/shared";
import { formatBytes } from "@/lib/utils";
import { TimeAgo } from "@/components/dashboard/time-ago";
import { TypedConfirmDialog } from "./confirm-dialog";

const errMsg = (e: unknown) => (e instanceof ApiClientError ? e.message : undefined);

export function ConnectionCard({ refId, initial, isAdmin, internalApiUrl, running }: { refId: string; initial: ConnectionInfoDTO; isAdmin: boolean; internalApiUrl: string; running: boolean }) {
  const toast = useToast();
  const router = useRouter();
  const [info, setInfo] = useState(initial);
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [kind, setKind] = useState<"pooler" | "session" | "direct" | "public">(initial.pooler ? "pooler" : "direct");
  const reveal = async () => {
    if (revealed) {
      setInfo(initial);
      return setRevealed(false);
    }
    setBusy("reveal");
    try {
      setInfo(await api<ConnectionInfoDTO>(`/api/v1/base/projects/${refId}/connection?reveal=1`));
      setRevealed(true);
    } catch (e) {
      toast.error("Could not reveal the password", errMsg(e));
    } finally {
      setBusy(null);
    }
  };
  const togglePublic = async (enabled: boolean) => {
    setBusy("public");
    try {
      await api(`/api/v1/base/projects/${refId}/connection/public-port`, { body: { enabled } });
      toast.success(enabled ? "Public port enabled" : "Public port disabled");
      setInfo(await api<ConnectionInfoDTO>(`/api/v1/base/projects/${refId}/connection`));
      setRevealed(false);
      router.refresh();
    } catch (e) {
      toast.error("Could not change the public port", errMsg(e));
    } finally {
      setBusy(null);
    }
  };
  const url = kind === "pooler" ? info.pooler : kind === "session" ? info.poolerSession : kind === "public" ? info.publicUrl : info.direct;
  const tabs = [
    ...(info.pooler ? [{ value: "pooler" as const, label: "Transaction pooler" }] : []),
    ...(info.poolerSession ? [{ value: "session" as const, label: "Session pooler" }] : []),
    { value: "direct" as const, label: "Inside the project" },
    ...(info.publicUrl ? [{ value: "public" as const, label: "Public" }] : []),
  ];
  return (
    <Card>
      <CardHeader
        title="Connection strings"
        description="LevantDeploy apps on this server connect privately through the pooler (or use the API via the internal URL). Connections from outside need the public port (TLS)."
        actions={
          isAdmin ? (
            <Button size="sm" variant="ghost" loading={busy === "reveal"} leftIcon={revealed ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />} onClick={reveal}>
              {revealed ? "Hide password" : "Reveal password"}
            </Button>
          ) : undefined
        }
      />
      <CardBody className="space-y-4">
        <Tabs tabs={tabs} value={kind} onValueChange={setKind} />
        <div className="flex min-w-0 items-center gap-1 rounded-md border border-border bg-bg-subtle pl-3">
          <span className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap py-2 font-mono text-[13px]">{url ?? "—"}</span>
          {url && revealed && <CopyButton value={url} className="mr-1 shrink-0" />}
        </div>
        <p className="text-[12px] text-muted">
          {kind === "pooler"
            ? "For LevantDeploy apps on this server (private network, user postgres.<ref>). Transaction mode: best for many short connections; disable prepared statements (Prisma: ?pgbouncer=true)."
            : kind === "session"
              ? "Session mode on the private network — use it for migrations and tools that need prepared statements or LISTEN/NOTIFY."
              : kind === "direct"
              ? "Host db is only resolvable inside the project's own network (Edge Functions, Studio, backups)."
                : "Reachable from the internet through the pooler. TLS is required (sslmode=require). Prefer the private pooler when your app runs on this server."}
          {!revealed && " The password is hidden; admins can reveal it (audited)."}
        </p>
        <dl className="grid grid-cols-[110px_minmax(0,1fr)] gap-y-1.5 text-[13px]">
          <dt className="text-muted">Host</dt>
          <dd className="truncate font-mono">{info.host}</dd>
          <dt className="text-muted">Port</dt>
          <dd className="font-mono">{info.port}</dd>
          <dt className="text-muted">Database</dt>
          <dd className="font-mono">{info.database}</dd>
          <dt className="text-muted">User</dt>
          <dd className="font-mono">{info.user}</dd>
          <dt className="text-muted">Internal API</dt>
          <dd className="flex min-w-0 items-center gap-1 font-mono">
            <span className="truncate">{internalApiUrl}</span>
            <CopyButton value={internalApiUrl} />
          </dd>
        </dl>
      </CardBody>
      <CardFooter
        hint={
          !info.publicSupported ? (
            "A public database port (through the pooler) is not available in this release yet."
          ) : info.publicAllowed ? (
            info.publicPort ? (
              <>
                Public port <span className="font-mono text-fg">{info.publicHost ? `${info.publicHost}:` : ""}{info.publicPort}</span> is open · TLS required.
              </>
            ) : (
              "Expose the database on a public TCP port (through the pooler, TLS required)."
            )
          ) : (
            <>
              Public database port: <Badge tone="outline">Pro plan</Badge>
            </>
          )
        }
      >
        <div className="flex items-center gap-2 text-[13px]">
          {busy === "public" && <Spinner className="h-3.5 w-3.5" />}
          <Switch checked={!!info.publicPort} onCheckedChange={togglePublic} disabled={!isAdmin || !info.publicSupported || !info.publicAllowed || busy === "public" || !running} label="Public port" />
        </div>
      </CardFooter>
    </Card>
  );
}

export function BackupsCard({ refId, name, initial, isAdmin, running, backupsKept }: { refId: string; name: string; initial: BackupDTO[]; isAdmin: boolean; running: boolean; backupsKept: number }) {
  const toast = useToast();
  const router = useRouter();
  const [items, setItems] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [restore, setRestore] = useState<BackupDTO | null>(null);
  const [restoring, setRestoring] = useState(false);
  useEffect(() => setItems(initial), [initial]);
  const reload = async () => {
    try {
      setItems((await api<{ items: BackupDTO[] }>(`/api/v1/base/projects/${refId}/backups`)).items);
    } catch {}
  };
  const running_ = items.some((b) => b.status === "RUNNING");
  useEffect(() => {
    if (!running_) return;
    const t = setInterval(reload, 3000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running_]);
  const create = async () => {
    setBusy(true);
    try {
      await api(`/api/v1/base/projects/${refId}/backups`, { method: "POST" });
      toast.success("Backup started");
      await reload();
    } catch (e) {
      toast.error("Could not start a backup", errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <CardHeader
        title="Backups"
        description={backupsKept > 0 ? `Daily backups are kept for ${backupsKept} days. You can also take a manual backup at any time.` : "Your plan includes manual backups (pg_dump). Upgrade for daily automatic backups."}
        actions={
          isAdmin ? (
            <Button size="sm" variant="primary" leftIcon={<Plus className="h-3.5 w-3.5" />} loading={busy} disabled={!running || running_} onClick={create}>
              Create backup
            </Button>
          ) : undefined
        }
      />
      <CardBody>
        {items.length ? (
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full min-w-[520px] text-[13px]">
              <thead className="bg-bg-subtle text-left text-[12px] text-muted">
                <tr>
                  <th className="px-3 py-2 font-medium">Created</th>
                  <th className="px-3 py-2 font-medium">Type</th>
                  <th className="px-3 py-2 font-medium">Size</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {items.map((b) => (
                  <tr key={b.id} className="border-t border-border">
                    <td className="px-3 py-2">
                      <div suppressHydrationWarning>{new Date(b.createdAt).toLocaleString()}</div>
                      <div className="text-[12px] text-muted">
                        <TimeAgo date={b.createdAt} />
                        {b.createdBy ? ` · ${b.createdBy}` : ""}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-muted">{b.kind.toLowerCase().replace("_", "-")}</td>
                    <td className="px-3 py-2 font-mono text-[12px]">
                      {b.sizeBytes !== null ? formatBytes(b.sizeBytes) : "—"}
                      {b.hasStorage && b.storageSizeBytes !== null && <div className="text-muted">+ {formatBytes(b.storageSizeBytes)} files</div>}
                    </td>
                    <td className="px-3 py-2">
                      <Badge tone={b.status === "SUCCEEDED" ? "success" : b.status === "FAILED" ? "danger" : "warning"} icon={b.status === "RUNNING" ? <Spinner className="h-3 w-3" /> : undefined}>
                        {b.status === "SUCCEEDED" ? "ready" : b.status.toLowerCase()}
                      </Badge>
                      {b.error && <div className="mt-1 max-w-[200px] truncate text-[12px] text-danger" title={b.error}>{b.error}</div>}
                    </td>
                    <td className="px-3 py-2">
                      {isAdmin && b.status === "SUCCEEDED" && (
                        <div className="flex justify-end gap-1">
                          <a href={`/api/v1/base/projects/${refId}/backups/${b.id}/download`} className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[13px] text-muted hover:bg-surface-2 hover:text-fg" download title="Database dump (.sql.gz)">
                            <Download className="h-3.5 w-3.5" /> SQL
                          </a>
                          {b.hasStorage && (
                            <a href={`/api/v1/base/projects/${refId}/backups/${b.id}/download?part=storage`} className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[13px] text-muted hover:bg-surface-2 hover:text-fg" download title="Storage files (.tar.gz)">
                              <Download className="h-3.5 w-3.5" /> Files
                            </a>
                          )}
                          <Button size="sm" variant="ghost" leftIcon={<RotateCcw className="h-3.5 w-3.5" />} disabled={!running} onClick={() => setRestore(b)}>
                            Restore
                          </Button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState icon={<Archive className="h-5 w-5" />} title="No backups yet" description="Backups contain a compressed SQL dump (schemas, data, auth users) and an archive of the Storage files." />
        )}
      </CardBody>
      <TypedConfirmDialog
        open={!!restore}
        onClose={() => setRestore(null)}
        title="Restore backup"
        description={
          <>
            The database is replaced with the backup from <span className="font-medium text-fg">{restore ? new Date(restore.createdAt).toLocaleString() : ""}</span>. Changes made since then are lost (a safety
            backup is taken first). The API is unavailable for a few minutes.
          </>
        }
        expected={name}
        action="Restore"
        busy={restoring}
        onConfirm={async (typed) => {
          setRestoring(true);
          try {
            await api(`/api/v1/base/projects/${refId}/backups/${restore!.id}/restore`, { body: { confirm: typed } });
            toast.success("Restore started", "Follow the progress on the project home page.");
            setRestore(null);
            router.refresh();
          } catch (e) {
            toast.error("Could not restore", errMsg(e));
          } finally {
            setRestoring(false);
          }
        }}
      />
    </Card>
  );
}
