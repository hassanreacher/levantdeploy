"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Layers, Lock, Plus, Trash2 } from "lucide-react";
import type { EnvTarget } from "@prisma/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input, Textarea } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { api, ApiClientError } from "@/lib/client/api";
import type { EnvItemView } from "@/lib/dashboard/env-api";

type Group = { id: string; name: string; description: string | null; vars: EnvItemView[]; projects: { id: string; name: string; slug: string }[] };
const TARGETS: { value: EnvTarget; label: string }[] = [
  { value: "PRODUCTION", label: "Production" },
  { value: "PREVIEW", label: "Preview" },
  { value: "DEVELOPMENT", label: "Development" },
];

export function EnvGroupsManager({ teamSlug, groups, isAdmin }: { teamSlug: string; groups: Group[]; isAdmin: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    try {
      await api(`/api/v1/teams/${teamSlug}/env-groups`, { method: "POST", body: { name, description: desc || null } });
      toast.success(`Created ${name}`);
      setCreating(false);
      setName("");
      setDesc("");
      router.refresh();
    } catch (e) {
      const err = e as ApiClientError;
      toast.error("Could not create", err.fields ? Object.values(err.fields)[0] : err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title="Shared Environment Variables"
          description="Groups of variables shared by several projects (e.g. observability keys). Link a group from a project's Environment tab; project values with the same key win."
          actions={
            isAdmin ? (
              <Button size="sm" variant="secondary" leftIcon={<Plus className="h-3.5 w-3.5" />} onClick={() => setCreating(true)}>
                New Group
              </Button>
            ) : undefined
          }
        />
        <CardBody>{groups.length === 0 && <EmptyState icon={<Layers className="h-5 w-5" />} title="No shared groups" description="Create a group, add variables, then link it to projects." className="py-10" />}</CardBody>
      </Card>
      {groups.map((g) => (
        <GroupCard key={g.id} g={g} teamSlug={teamSlug} isAdmin={isAdmin} />
      ))}
      <Dialog
        open={creating}
        onClose={() => setCreating(false)}
        title="New Shared Group"
        footer={
          <>
            <Button size="sm" variant="ghost" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" onClick={create} loading={busy} disabled={!name.trim()}>
              Create
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="observability" maxLength={60} aria-label="Group name" />
          <Input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Description (optional)" maxLength={300} aria-label="Description" />
        </div>
      </Dialog>
    </div>
  );
}

function GroupCard({ g, teamSlug, isAdmin }: { g: Group; teamSlug: string; isAdmin: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [text, setText] = useState("");
  const [targets, setTargets] = useState<EnvTarget[]>(["PRODUCTION", "PREVIEW", "DEVELOPMENT"]);
  const [secret, setSecret] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const base = `/api/v1/teams/${teamSlug}/env-groups/${g.id}`;
  const add = async () => {
    setBusy(true);
    try {
      const r = await api<{ created: number; updated: number }>(`${base}/vars`, { method: "POST", body: { dotenv: text, targets, isSecret: secret, overwrite: true } });
      toast.success(`Saved ${r.created + r.updated} variable${r.created + r.updated === 1 ? "" : "s"} in ${g.name}`);
      setText("");
      router.refresh();
    } catch (e) {
      const err = e as ApiClientError;
      toast.error("Could not save", err.fields ? Object.values(err.fields)[0] : err.message);
    } finally {
      setBusy(false);
    }
  };
  const del = async (path: string, msg: string) => {
    try {
      await api(path, { method: "DELETE" });
      toast.success(msg);
      router.refresh();
    } catch (e) {
      toast.error("Could not delete", (e as Error).message);
    }
  };
  return (
    <Card>
      <CardHeader
        title={g.name}
        description={g.description ?? undefined}
        actions={
          isAdmin ? (
            <Button size="icon-sm" variant="ghost" aria-label={`Delete group ${g.name}`} onClick={() => setConfirmDelete(true)}>
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          ) : undefined
        }
      />
      <CardBody className="space-y-4">
        <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-muted">
          Linked to:
          {g.projects.length ? (
            g.projects.map((p) => (
              <Link key={p.id} href={`/${teamSlug}/${p.slug}/environment`}>
                <Badge tone="neutral">{p.name}</Badge>
              </Link>
            ))
          ) : (
            <span className="text-subtle">no projects yet</span>
          )}
        </div>
        {g.vars.length > 0 && (
          <ul className="divide-y divide-border rounded-md border border-border">
            {g.vars.map((v) => (
              <li key={v.id} className="flex min-w-0 items-center gap-3 px-3 py-2">
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 font-mono text-[13px] text-fg">
                    <span className="truncate">{v.key}</span>
                    {v.isSecret && <Lock className="h-3 w-3 shrink-0 text-subtle" />}
                  </span>
                  <span className="block truncate font-mono text-[12px] text-muted">{v.value ?? "••••••••"}</span>
                </span>
                <span className="hidden text-[12px] text-subtle sm:inline">{v.targets.length === 3 ? "All Environments" : v.targets.map((t) => t.toLowerCase()).join(", ")}</span>
                {isAdmin && (
                  <Button size="icon-sm" variant="ghost" aria-label={`Remove ${v.key}`} onClick={() => del(`${base}/vars/${v.id}`, `Removed ${v.key}`)}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {isAdmin && (
          <div className="space-y-3">
            <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} className="font-mono text-[12px]" placeholder={"KEY=value\nOTHER_KEY=value"} spellCheck={false} aria-label="Variables (.env format)" />
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              {TARGETS.map((t) => (
                <label key={t.value} className="inline-flex items-center gap-2 text-[13px]">
                  <input type="checkbox" className="h-4 w-4 accent-[rgb(var(--accent))]" checked={targets.includes(t.value)} onChange={() => setTargets((x) => (x.includes(t.value) ? x.filter((y) => y !== t.value) : [...x, t.value]))} />
                  {t.label}
                </label>
              ))}
              <label className="inline-flex items-center gap-2 text-[13px] text-muted">
                <Switch checked={secret} onCheckedChange={setSecret} size="sm" label="Sensitive" /> Sensitive
              </label>
            </div>
          </div>
        )}
      </CardBody>
      {isAdmin && (
        <CardFooter hint="Paste KEY=value lines. Existing keys are overwritten.">
          <Button size="sm" variant="primary" onClick={add} loading={busy} disabled={!text.trim() || !targets.length}>
            Save Variables
          </Button>
        </CardFooter>
      )}
      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        size="sm"
        title={`Delete ${g.name}?`}
        description="The group is unlinked from every project. Their next deployments won't get these variables."
        footer={
          <>
            <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button size="sm" variant="danger" onClick={() => (setConfirmDelete(false), del(base, `Deleted ${g.name}`))}>
              Delete
            </Button>
          </>
        }
      />
    </Card>
  );
}
