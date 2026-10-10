"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ExternalLink, Loader2, MoreHorizontal, Pencil, Search, Sparkles, Trash2, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Dropdown, DropdownItem, DropdownSeparator } from "@/components/ui/dropdown";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs } from "@/components/ui/tabs";
import { TimeAgo } from "@/components/dashboard/time-ago";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { builderApi } from "@/lib/builder-ui/api";
import { errMessage } from "@/lib/builder-ui/errors";
import type { BuilderProject, Credits, Template } from "@/lib/builder-ui/types";
import { PromptBox } from "./prompt-box";
import { ProjectThumb } from "./project-thumb";
import { TemplateCard } from "./templates";

const FALLBACK_TEMPLATES: Template[] = [{ id: "blank", name: "Blank app", description: "Next.js 15 · Tailwind · shadcn/ui · LevantBase", kind: "template" }];

/** /{team}/build — "What do you want to build?" + your apps + templates/remix gallery. */
export function BuildHome({ team, canCreate }: { team: string; canCreate: boolean }) {
  const toast = useToast();
  const router = useRouter();
  const search = useSearchParams();
  const B = useMemo(() => builderApi(), []);
  const [projects, setProjects] = useState<BuilderProject[] | null>(null);
  const [templates, setTemplates] = useState<Template[]>(FALLBACK_TEMPLATES);
  const [credits, setCredits] = useState<Credits | null>(null);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<"recent" | "name">("recent");
  const [chosen, setChosen] = useState<{ template?: string; prompt?: string }>({ prompt: search.get("prompt") ?? undefined });

  const load = useCallback(async () => {
    try {
      setProjects(await B.listProjects(team));
    } catch (e) {
      setProjects([]);
      toast.error("Could not load your apps", errMessage(e));
    }
  }, [B, team, toast]);

  useEffect(() => {
    void load();
    B.templates().then((t) => t.length && setTemplates(t), () => {});
    B.credits(team).then(setCredits, () => {});
  }, [B, team, load]);

  // refresh generating apps (status/thumbnail) while the page is open
  useEffect(() => {
    if (!projects?.some((p) => p.status === "GENERATING" || p.previewStatus === "STARTING")) return;
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [projects, load]);

  const list = useMemo(() => {
    const f = (projects ?? []).filter((p) => !q || `${p.name} ${p.prompt ?? ""}`.toLowerCase().includes(q.toLowerCase()));
    return sort === "name" ? f.sort((a, b) => a.name.localeCompare(b.name)) : f.sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt));
  }, [projects, q, sort]);

  const remixes = templates.filter((t) => t.kind === "remix");
  const starters = templates.filter((t) => t.kind !== "remix");

  return (
    <div className="pb-16">
      <section className="relative overflow-hidden border-b border-border">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_50%_at_50%_0%,rgb(var(--accent)/0.12),transparent_70%)]" aria-hidden />
        <div className="container-page relative flex flex-col items-center py-14 sm:py-20">
          <span className="mb-4 inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1 text-[12px] text-muted">
            <Sparkles className="h-3.5 w-3.5 text-accent" /> AI app builder
          </span>
          <h1 className="text-center text-[32px] font-semibold leading-tight tracking-tight sm:text-[44px]">What do you want to build?</h1>
          <p className="mt-3 max-w-xl text-center text-[15px] text-muted">Describe your idea. AI agents design it, write a full-stack Next.js app with a real database, and show you a live preview you can edit by clicking.</p>
          <div className="mt-8 w-full max-w-2xl">
            {canCreate ? (
              <PromptBox mode="app" team={team} templates={templates} credits={credits} resumePending initialPrompt={chosen.prompt} initialTemplate={chosen.template} autoFocus />
            ) : (
              <p className="rounded-lg border border-border bg-surface p-4 text-center text-[13px] text-muted">Viewers can open apps but not create new ones. Ask a team admin for the Member role.</p>
            )}
          </div>
        </div>
      </section>

      <section className="container-page mt-10" aria-labelledby="your-apps">
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
          <h2 id="your-apps" className="text-[18px] font-semibold tracking-tight">
            Your apps
          </h2>
          <div className="flex min-w-0 flex-1 items-center gap-2 sm:justify-end">
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search apps…" prefix={<Search className="h-3.5 w-3.5" />} className="min-w-0 flex-1 sm:max-w-xs" aria-label="Search apps" />
            <Tabs<"recent" | "name"> className="shrink-0" tabs={[{ value: "recent", label: "Recent" }, { value: "name", label: "A–Z" }]} value={sort} onValueChange={setSort} />
          </div>
        </div>
        {projects === null ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="aspect-[16/12] rounded-lg" />
            ))}
          </div>
        ) : list.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border px-6 py-12 text-center">
            <Wand2 className="mx-auto mb-3 h-5 w-5 text-muted" />
            <p className="font-medium">{q ? "No apps match your search" : "No apps yet"}</p>
            <p className="mt-1 text-[13px] text-muted">{q ? "Try another name." : "Describe your first app above, or start from a template below."}</p>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="builder-projects">
            {list.map((p) => (
              <ProjectCard key={p.id} p={p} team={team} canEdit={canCreate} onChanged={load} />
            ))}
          </div>
        )}
      </section>

      <section className="container-page mt-12" aria-labelledby="templates">
        <h2 id="templates" className="text-[18px] font-semibold tracking-tight">
          Start from a template
        </h2>
        <p className="mt-1 text-[13px] text-muted">Pick a starting point — the AI adapts it to your description.</p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4" data-testid="builder-templates">
          {starters.map((t) => (
            <TemplateCard
              key={t.id}
              t={t}
              onUse={() => {
                setChosen({ template: t.id, prompt: t.prompt });
                window.scrollTo({ top: 0, behavior: "smooth" });
              }}
              disabled={!canCreate}
            />
          ))}
        </div>
        {remixes.length > 0 && (
          <>
            <h3 className="mt-10 text-[15px] font-semibold">Remix a public app</h3>
            <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {remixes.map((t) => (
                <TemplateCard
                  key={t.id}
                  t={t}
                  disabled={!canCreate}
                  onUse={async () => {
                    try {
                      const r = await B.createProject({ team, name: `${t.name} remix`, remixOf: t.projectId ?? t.id, starter: t.id, run: false });
                      router.push(`/${team}/build/${r.project.id}`);
                    } catch (e) {
                      toast.error("Could not remix", errMessage(e));
                    }
                  }}
                />
              ))}
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function ProjectCard({ p, team, canEdit, onChanged }: { p: BuilderProject; team: string; canEdit: boolean; onChanged: () => void }) {
  const toast = useToast();
  const [rename, setRename] = useState(false);
  const [del, setDel] = useState(false);
  const [name, setName] = useState(p.name);
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const href = `/${team}/build/${p.id}`;
  const generating = p.status === "GENERATING";
  return (
    <div className="group relative overflow-hidden rounded-lg border border-border bg-surface transition-colors hover:border-border-strong" data-testid="builder-project-card">
      <Link href={href} className="block" aria-label={`Open ${p.name}`}>
        <ProjectThumb p={p} className="border-b border-border" />
        <div className="p-4 pr-12">
          <p className="truncate font-medium">{p.name}</p>
          <p className="mt-0.5 flex items-center gap-1.5 text-[12.5px] text-muted">
            {generating ? (
              <>
                <Loader2 className="h-3 w-3 animate-spin text-accent" /> Building…
              </>
            ) : p.status === "ERROR" ? (
              <span className="text-danger">Last run failed</span>
            ) : (
              <>
                Edited <TimeAgo date={p.updatedAt} />
              </>
            )}
            {p.lastPublishedAt && (
              <span className="ml-1 inline-flex items-center gap-1 rounded-full border border-border px-1.5 text-[11px]">
                <span className="h-1.5 w-1.5 rounded-full bg-success" /> Live
              </span>
            )}
          </p>
        </div>
      </Link>
      {canEdit && (
        <div className="absolute bottom-3.5 right-3">
          <Dropdown
            align="end"
            width={200}
            trigger={() => (
              <Button size="icon-sm" variant="ghost" aria-label={`Actions for ${p.name}`}>
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            )}
          >
            {(close) => (
              <>
                <DropdownItem href={href} icon={<Wand2 className="h-3.5 w-3.5" />}>
                  Open editor
                </DropdownItem>
                {p.project && (
                  <DropdownItem href={`/${team}/${p.project.slug}`} icon={<ExternalLink className="h-3.5 w-3.5" />}>
                    Deployment dashboard
                  </DropdownItem>
                )}
                <DropdownItem icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => (close(), setRename(true))}>
                  Rename
                </DropdownItem>
                <DropdownSeparator />
                <DropdownItem danger icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => (close(), setDel(true))}>
                  Delete
                </DropdownItem>
              </>
            )}
          </Dropdown>
        </div>
      )}
      <Dialog
        open={rename}
        onClose={() => setRename(false)}
        title="Rename app"
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setRename(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={!name.trim()}
              onClick={async () => {
                setBusy(true);
                try {
                  await builderApi().updateProject(p.id, { name: name.trim() });
                  setRename(false);
                  onChanged();
                } catch (e) {
                  toast.error("Could not rename", errMessage(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Save
            </Button>
          </>
        }
      >
        <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} aria-label="Name" />
      </Dialog>
      <Dialog
        open={del}
        onClose={() => setDel(false)}
        title={`Delete ${p.name}?`}
        description="The code, history and preview are deleted. A published project and its backend are kept."
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDel(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={busy}
              disabled={confirm !== p.name}
              onClick={async () => {
                setBusy(true);
                try {
                  await builderApi().deleteProject(p.id, confirm);
                  setDel(false);
                  toast.success("App deleted");
                  onChanged();
                } catch (e) {
                  toast.error("Could not delete", errMessage(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Delete
            </Button>
          </>
        }
      >
        <p className={cn("mb-2 text-[13px] text-muted")}>
          Type <span className="font-medium text-fg">{p.name}</span> to confirm.
        </p>
        <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} aria-label="Confirm name" />
      </Dialog>
    </div>
  );
}
