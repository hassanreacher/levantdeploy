"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Github, Lock, Plus, Search, RefreshCw } from "lucide-react";
import { Avatar, Badge, Button, Card, EmptyState, Input, Select, Skeleton, buttonClass } from "@/components/ui";
import { GitHubAppCard, type GitHubAppStatus } from "@/components/github/GitHubAppCard";
import { api, ApiClientError } from "@/lib/client/api";
import { timeAgo } from "@/lib/utils";
import type { Installation, Selection } from "./types";

type Repo = {
  id: number;
  name: string;
  fullName: string;
  owner: string;
  private: boolean;
  defaultBranch: string;
  pushedAt: string | null;
  language: string | null;
  imported: { projectId: string; slug: string }[];
};

export function GitHubImport({
  team,
  app,
  isOwner,
  installations,
  onSelect,
}: {
  team: { slug: string };
  app: GitHubAppStatus;
  isOwner: boolean;
  installations: Installation[];
  onSelect: (s: Selection) => void;
}) {
  const [inst, setInst] = useState<number | null>(installations[0]?.installationId ?? null);
  const [q, setQ] = useState("");
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const installHref = `/api/v1/github/install?team=${encodeURIComponent(team.slug)}`;

  useEffect(() => {
    if (!inst) return;
    const ctl = new AbortController();
    const t = setTimeout(async () => {
      setError(null);
      try {
        const r = await api<{ items: Repo[] }>(`/api/v1/github/repos?team=${team.slug}&installationId=${inst}&limit=30&q=${encodeURIComponent(q)}${nonce ? "&fresh=1" : ""}`, { signal: ctl.signal });
        setRepos(r.items);
      } catch (e) {
        if ((e as Error).name !== "AbortError") setError(e instanceof ApiClientError ? e.message : "Could not load repositories");
      }
    }, 250);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [inst, q, team.slug, nonce]);

  if (!app.configured) return <GitHubAppCard status={app} isOwner={isOwner} teamSlug={team.slug} />;

  if (!installations.length) {
    return (
      <EmptyState
        icon={<Github className="h-5 w-5" />}
        title="Install the GitHub App"
        description="Choose which accounts and repositories LevantDeploy can deploy. You'll come back here to pick a repository."
        action={
          <a href={installHref} className={buttonClass("primary", "md")}>
            <Github className="h-4 w-4" /> Install GitHub App
          </a>
        }
      />
    );
  }

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-col gap-2 border-b border-border p-4 sm:flex-row">
        <Select
          aria-label="GitHub account"
          className="sm:w-56"
          value={String(inst ?? "")}
          onChange={(e) => {
            if (e.target.value === "__add") {
              window.location.href = installHref;
              return;
            }
            setRepos(null);
            setInst(Number(e.target.value));
          }}
          options={[
            ...installations.map((i) => ({ value: String(i.installationId), label: `${i.accountLogin}${i.suspended ? " (suspended)" : ""}` })),
            { value: "__add", label: "+ Add GitHub Account" },
          ]}
        />
        <div className="flex flex-1 items-center gap-2">
          <Input prefix={<Search className="h-4 w-4" />} placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search repositories" className="flex-1" />
          <Button variant="ghost" size="icon" aria-label="Refresh" onClick={() => setNonce((n) => n + 1)}>
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </div>
      {error ? (
        <div className="p-6 text-sm text-danger">{error}</div>
      ) : !repos ? (
        <div className="divide-y divide-border">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="flex items-center gap-3 p-4">
              <Skeleton className="h-6 w-6 rounded-full" />
              <Skeleton className="h-4 w-48" />
            </div>
          ))}
        </div>
      ) : repos.length === 0 ? (
        <div className="p-8 text-center text-sm text-muted">
          No repositories {q ? `matching “${q}”` : "yet"}.{" "}
          <a className="text-fg underline underline-offset-4" href={installHref}>
            Adjust GitHub App permissions →
          </a>
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {repos.map((r) => (
            <li key={r.id} className="flex items-center gap-3 px-4 py-3">
              <Avatar name={r.owner} size={24} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 truncate text-sm font-medium text-fg">
                  <span className="truncate">{r.name}</span>
                  {r.private && <Lock className="h-3.5 w-3.5 shrink-0 text-muted" aria-label="Private" />}
                  <span className="hidden shrink-0 text-[13px] font-normal text-subtle sm:inline">· {r.pushedAt ? timeAgo(r.pushedAt) : "never pushed"}</span>
                </div>
              </div>
              {r.imported.length > 0 && (
                <Link href={`/${team.slug}/${r.imported[0]!.slug}`} className="hidden sm:block">
                  <Badge tone="outline">Imported</Badge>
                </Link>
              )}
              <Button size="sm" variant="primary" onClick={() => onSelect({ kind: "github", installationId: inst!, repo: { id: r.id, fullName: r.fullName, defaultBranch: r.defaultBranch, private: r.private } })}>
                Import
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="border-t border-border bg-bg-subtle px-4 py-2.5 text-[13px] text-muted">
        Missing a repository?{" "}
        <a href={installHref} className="text-fg underline-offset-4 hover:underline">
          <Plus className="mr-0.5 inline h-3 w-3" />
          Configure the GitHub App
        </a>
      </div>
    </Card>
  );
}
