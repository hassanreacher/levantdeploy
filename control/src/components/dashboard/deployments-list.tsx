"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Check, ChevronDown, GitBranch, GitCommitHorizontal, Rocket, Search, X } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dropdown } from "@/components/ui/dropdown";
import { EmptyState } from "@/components/ui/empty-state";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusDot, STATUS_STYLE, type DeploymentStatusName } from "@/components/ui/status-dot";
import { api } from "@/lib/client/api";
import { cn, formatDuration } from "@/lib/utils";
import type { DeploymentDTO } from "@/lib/dashboard/deployments";
import { DeploymentActionsMenu, useDeploymentActions } from "./deployment-actions";
import { useDeploymentEvents, LiveBadge } from "./live";
import { TimeAgo, Elapsed } from "./time-ago";

export type DeploymentsFilter = { target?: "PRODUCTION" | "PREVIEW"; branch?: string; status?: DeploymentStatusName[]; q?: string };

const ALL_STATUSES: DeploymentStatusName[] = ["READY", "ERROR", "BUILDING", "DEPLOYING", "QUEUED", "CANCELED", "SUPERSEDED"];
const ACTIVE = ["QUEUED", "BUILDING", "DEPLOYING"];

function qs(f: DeploymentsFilter, cursor?: string | null) {
  const p = new URLSearchParams();
  if (f.target) p.set("target", f.target);
  if (f.branch) p.set("branch", f.branch);
  if (f.status?.length) p.set("status", f.status.join(","));
  if (f.q) p.set("q", f.q);
  if (cursor) p.set("cursor", cursor);
  return p.toString();
}

function matches(d: DeploymentDTO, f: DeploymentsFilter) {
  if (f.target && d.target !== f.target) return false;
  if (f.branch && d.branch !== f.branch) return false;
  if (f.status?.length && !f.status.includes(d.status as DeploymentStatusName)) return false;
  return !f.q;
}

export function DeploymentsList({
  projectId,
  teamSlug,
  projectSlug,
  repo,
  canWrite,
  branches,
  initial,
  initialFilter,
}: {
  projectId: string;
  teamSlug: string;
  projectSlug: string;
  repo: string | null;
  canWrite: boolean;
  branches: string[];
  initial: { items: DeploymentDTO[]; next: string | null };
  initialFilter: DeploymentsFilter;
}) {
  const [filter, setFilter] = useState<DeploymentsFilter>(initialFilter);
  const [items, setItems] = useState(initial.items);
  const [next, setNext] = useState(initial.next);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [q, setQ] = useState(initialFilter.q ?? "");
  const first = useRef(true);
  const { ask, dialogs } = useDeploymentActions({ teamSlug, projectSlug });

  const load = useCallback(
    async (f: DeploymentsFilter) => {
      setLoading(true);
      try {
        const r = await api<{ items: DeploymentDTO[]; next: string | null }>(`/api/v1/projects/${projectId}/deployments?${qs(f)}`);
        setItems(r.items);
        setNext(r.next);
      } finally {
        setLoading(false);
      }
    },
    [projectId],
  );

  // filters → URL + fetch
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const s = qs(filter);
    window.history.replaceState(null, "", s ? `?${s}` : window.location.pathname);
    void load(filter);
  }, [filter, load]);

  // debounced search
  useEffect(() => {
    const t = setTimeout(() => setFilter((f) => (f.q === (q.trim() || undefined) ? f : { ...f, q: q.trim() || undefined })), 300);
    return () => clearTimeout(t);
  }, [q]);

  // live updates
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  useDeploymentEvents((ev) => {
    if (ev.status === "RESYNC") return void refreshTop();
    if (ev.projectId !== projectId) return;
    const known = items.some((d) => d.id === ev.deploymentId);
    if (known) {
      void api<{ deployment: DeploymentDTO }>(`/api/v1/deployments/${ev.deploymentId}`)
        .then((r) => setItems((l) => l.map((d) => (d.id === r.deployment.id ? r.deployment : ev.status === "READY" && d.isCurrentProduction && r.deployment.isCurrentProduction ? { ...d, isCurrentProduction: false } : d))))
        .catch(() => {});
      if (ev.status === "READY" || ev.status === "SUPERSEDED") {
        // production flags of other rows may have moved
        if (pending.current) clearTimeout(pending.current);
        pending.current = setTimeout(() => void refreshTop(), 800);
      }
    } else {
      if (pending.current) clearTimeout(pending.current);
      pending.current = setTimeout(() => void refreshTop(), 300);
    }
  });
  const refreshTop = async () => {
    const r = await api<{ items: DeploymentDTO[] }>(`/api/v1/projects/${projectId}/deployments?${qs({ ...filter })}`).catch(() => null);
    if (!r) return;
    setItems((l) => {
      const fresh = new Map(r.items.map((d) => [d.id, d]));
      const merged = l.map((d) => fresh.get(d.id) ?? d);
      const newOnes = r.items.filter((d) => !l.some((x) => x.id === d.id) && matches(d, filter));
      return [...newOnes, ...merged].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    });
  };

  const more = async () => {
    if (!next) return;
    setLoadingMore(true);
    try {
      const r = await api<{ items: DeploymentDTO[]; next: string | null }>(`/api/v1/projects/${projectId}/deployments?${qs(filter, next)}`);
      setItems((l) => [...l, ...r.items.filter((d) => !l.some((x) => x.id === d.id))]);
      setNext(r.next);
    } finally {
      setLoadingMore(false);
    }
  };

  const activeFilters = !!(filter.target || filter.branch || filter.status?.length || filter.q);
  const statusLabel = useMemo(() => {
    const s = filter.status ?? [];
    if (!s.length) return "All statuses";
    if (s.length === 1) return STATUS_STYLE[s[0]!].label;
    return `${s.length} statuses`;
  }, [filter.status]);

  return (
    <div>
      <div className="mb-4 flex flex-col gap-2 md:flex-row md:items-center">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by commit, branch, id or #number…"
            className="h-9 w-full rounded-md border border-border bg-bg pl-9 pr-3 text-sm text-fg placeholder:text-subtle transition-colors hover:border-border-strong focus:border-fg/40 focus:outline-none focus:ring-2 focus:ring-fg/10"
            aria-label="Search deployments"
          />
        </div>
        <div className="grid grid-cols-2 gap-2 sm:flex sm:items-center">
          <Select
            aria-label="Environment"
            value={filter.target ?? ""}
            onChange={(e) => setFilter((f) => ({ ...f, target: (e.target.value || undefined) as DeploymentsFilter["target"] }))}
            options={[
              { value: "", label: "All environments" },
              { value: "PRODUCTION", label: "Production" },
              { value: "PREVIEW", label: "Preview" },
            ]}
            className="sm:w-44"
          />
          <Select
            aria-label="Branch"
            value={filter.branch ?? ""}
            onChange={(e) => setFilter((f) => ({ ...f, branch: e.target.value || undefined }))}
            options={[{ value: "", label: "All branches" }, ...branches.map((b) => ({ value: b, label: b }))]}
            className="sm:w-44"
          />
          <Dropdown
            align="end"
            width={200}
            trigger={(open) => (
              <button
                type="button"
                aria-label="Status filter"
                className={cn(
                  "flex h-9 w-full items-center justify-between gap-2 rounded-md border border-border bg-bg pl-3 pr-2.5 text-sm text-fg transition-colors hover:border-border-strong sm:w-40",
                  open && "border-border-strong",
                )}
              >
                <span className="truncate">{statusLabel}</span>
                <ChevronDown className="h-4 w-4 text-muted" />
              </button>
            )}
          >
            {ALL_STATUSES.map((s) => {
              const on = filter.status?.includes(s);
              return (
                <button
                  key={s}
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={!!on}
                  onClick={() => setFilter((f) => ({ ...f, status: on ? f.status!.filter((x) => x !== s) : [...(f.status ?? []), s] }))}
                  className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] text-muted hover:bg-surface-2 hover:text-fg"
                >
                  <span className={cn("flex h-4 w-4 items-center justify-center rounded border", on ? "border-fg bg-fg text-bg" : "border-border-strong")}>{on && <Check className="h-3 w-3" />}</span>
                  <StatusDot status={s} />
                  {STATUS_STYLE[s].label}
                </button>
              );
            })}
          </Dropdown>
          {activeFilters ? (
            <Button
              variant="ghost"
              size="sm"
              leftIcon={<X className="h-3.5 w-3.5" />}
              onClick={() => {
                setQ("");
                setFilter({});
              }}
            >
              Clear
            </Button>
          ) : (
            <LiveBadge className="hidden px-2 sm:inline-flex" />
          )}
        </div>
      </div>

      {loading && !items.length ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-[68px] w-full" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={<Rocket className="h-5 w-5" />}
          title={activeFilters ? "No deployments match these filters" : "No deployments yet"}
          description={activeFilters ? "Try another branch, environment or status." : "Push to your repository, run `levant deploy`, or hit Deploy on the project overview."}
        />
      ) : (
        <div className={cn("overflow-hidden rounded-lg border border-border bg-surface transition-opacity", loading && "opacity-60")} data-testid="deployments-list">
          <ul className="divide-y divide-border">
            {items.map((d) => (
              <DeploymentRow key={d.id} d={d} teamSlug={teamSlug} projectSlug={projectSlug} repo={repo} canWrite={canWrite} ask={ask} />
            ))}
          </ul>
        </div>
      )}
      {next && (
        <div className="mt-4 flex justify-center">
          <Button variant="secondary" size="sm" onClick={more} loading={loadingMore}>
            Load more
          </Button>
        </div>
      )}
      {dialogs}
    </div>
  );
}

function DeploymentRow({
  d,
  teamSlug,
  projectSlug,
  repo,
  canWrite,
  ask,
}: {
  d: DeploymentDTO;
  teamSlug: string;
  projectSlug: string;
  repo: string | null;
  canWrite: boolean;
  ask: Parameters<typeof DeploymentActionsMenu>[0]["ask"];
}) {
  const href = `/${teamSlug}/${projectSlug}/deployments/${d.id}`;
  const who = d.createdBy?.name ?? d.commitAuthor ?? null;
  const avatar = d.createdBy?.avatar ?? d.commitAuthorAvatar;
  const running = ACTIVE.includes(d.status);
  return (
    <li className="group relative grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 px-4 py-3 transition-colors hover:bg-surface-2/50 md:grid-cols-[minmax(0,180px)_minmax(0,150px)_minmax(0,1fr)_minmax(0,150px)_auto]" data-testid="deployment-row">
      {/* id + environment */}
      <div className="min-w-0">
        <Link href={href} className="block truncate font-mono text-[13px] font-medium text-fg after:absolute after:inset-0 after:content-['']">
          {d.shortId}
        </Link>
        <p className="mt-0.5 flex items-center gap-1.5 text-[12px] text-muted">
          {d.target === "PRODUCTION" ? "Production" : "Preview"}
          {d.isCurrentProduction && (
            <Badge tone="accent" className="h-4 px-1.5 text-[10px]">
              Current
            </Badge>
          )}
        </p>
      </div>
      {/* status + duration (mobile: right column) */}
      <div className="flex flex-col items-end gap-0.5 md:items-start">
        <StatusDot status={d.status as DeploymentStatusName} withLabel />
        <span className="font-mono text-[12px] text-muted">{running ? <Elapsed from={d.createdAt} /> : formatDuration(d.duration)}</span>
      </div>
      {/* source */}
      <div className="col-span-2 min-w-0 md:col-span-1">
        {d.branch ? (
          <p className="flex min-w-0 items-center gap-1.5 text-[13px] text-fg">
            <GitBranch className="h-3.5 w-3.5 shrink-0 text-muted" />
            <span className="truncate font-mono">{d.branch}</span>
          </p>
        ) : (
          <p className="text-[13px] text-muted">{d.trigger === "CLI" ? "Uploaded with the CLI" : "Manual deployment"}</p>
        )}
        {(d.commitSha || d.commitMessage) && (
          <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[12px] text-muted">
            <GitCommitHorizontal className="h-3.5 w-3.5 shrink-0" />
            {d.commitSha &&
              (repo ? (
                <a href={`https://github.com/${repo}/commit/${d.commitSha}`} target="_blank" rel="noreferrer" className="relative z-10 shrink-0 font-mono hover:text-fg hover:underline">
                  {d.commitSha.slice(0, 7)}
                </a>
              ) : (
                <span className="shrink-0 font-mono">{d.commitSha.slice(0, 7)}</span>
              ))}
            <span className="truncate">{d.commitMessage?.split("\n")[0]}</span>
          </p>
        )}
      </div>
      {/* age + author */}
      <div className="flex min-w-0 items-center gap-2 text-[12px] text-muted md:justify-end">
        <TimeAgo date={d.createdAt} />
        {who && (
          <>
            <span className="md:hidden">by {who}</span>
            <span title={who} className="hidden md:inline-flex">
              <Avatar name={who} src={avatar} size={22} />
            </span>
          </>
        )}
      </div>
      <div className="relative z-10 justify-self-end">
        <DeploymentActionsMenu d={d} teamSlug={teamSlug} projectSlug={projectSlug} canWrite={canWrite} ask={ask} />
      </div>
    </li>
  );
}
