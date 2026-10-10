"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Check, ChevronsUpDown, Plus } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Dropdown, DropdownLabel, DropdownSeparator } from "@/components/ui/dropdown";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { api, ApiClientError } from "@/lib/client/api";
import { cn } from "@/lib/utils";

export type SwitcherTeam = { id: string; name: string; slug: string; avatar: string | null; isPersonal: boolean; role: string };

export function TeamSwitcher({ teams, current }: { teams: SwitcherTeam[]; current: SwitcherTeam }) {
  const router = useRouter();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const switchTo = async (t: SwitcherTeam) => {
    await api(`/api/v1/teams/${t.slug}/switch`, { method: "POST" }).catch(() => {});
    router.push(`/${t.slug}`);
    router.refresh();
  };

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const res = await api<{ team: SwitcherTeam }>("/api/v1/teams", { body: { name } });
      toast.success("Team created", res.team.name);
      setCreating(false);
      setName("");
      await switchTo(res.team);
    } catch (e) {
      setErr(e instanceof ApiClientError ? (e.fields?.name ?? e.message) : "Could not create team");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Dropdown
        width={260}
        trigger={(open) => (
          <button
            className={cn("flex items-center gap-2 rounded-md px-1.5 py-1 text-sm font-medium transition-colors hover:bg-surface-2", open && "bg-surface-2")}
            data-testid="team-switcher"
          >
            <Avatar name={current.name + current.slug} src={current.avatar} size={20} />
            <span className="max-w-[160px] truncate">{current.name}</span>
            {current.isPersonal && <Badge tone="outline">Hobby</Badge>}
            <ChevronsUpDown className="h-3.5 w-3.5 text-subtle" />
          </button>
        )}
      >
        {(close) => (
          <>
            <DropdownLabel>Teams</DropdownLabel>
            <div className="max-h-72 overflow-y-auto">
              {teams.map((t) => (
                <button
                  key={t.id}
                  onClick={() => {
                    close();
                    void switchTo(t);
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] text-fg hover:bg-surface-2"
                >
                  <Avatar name={t.name + t.slug} src={t.avatar} size={18} />
                  <span className="flex-1 truncate">{t.name}</span>
                  {t.id === current.id && <Check className="h-3.5 w-3.5" />}
                </button>
              ))}
            </div>
            <DropdownSeparator />
            <button
              onClick={() => {
                close();
                setCreating(true);
              }}
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] text-muted hover:bg-surface-2 hover:text-fg"
            >
              <Plus className="h-3.5 w-3.5" />
              Create team
            </button>
          </>
        )}
      </Dropdown>
      <Dialog
        open={creating}
        onClose={() => setCreating(false)}
        title="Create a team"
        description="Teams share projects, domains, databases and environment variables."
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" form="create-team" loading={busy}>
              Create team
            </Button>
          </>
        }
      >
        <form id="create-team" onSubmit={create}>
          <Field label="Team name" htmlFor="team-name" error={err}>
            <Input id="team-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Inc" required maxLength={60} />
          </Field>
        </form>
      </Dialog>
    </>
  );
}
