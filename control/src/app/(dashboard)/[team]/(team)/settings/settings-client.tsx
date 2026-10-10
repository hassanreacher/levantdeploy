"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { TeamRole } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { CopyButton } from "@/components/ui/copy-button";
import { useToast } from "@/components/ui/toast";
import { api, ApiClientError } from "@/lib/client/api";
import { ROLE_RANK } from "@/lib/auth/roles";

export function TeamSettingsClient({ team, role }: { team: { id: string; name: string; slug: string; isPersonal: boolean }; role: TeamRole }) {
  const router = useRouter();
  const toast = useToast();
  const [name, setName] = useState(team.name);
  const [slug, setSlug] = useState(team.slug);
  const [busy, setBusy] = useState<string | null>(null);
  const isAdmin = ROLE_RANK[role] >= ROLE_RANK.ADMIN;
  const isOwner = role === "OWNER";

  const save = async (field: "name" | "slug") => {
    setBusy(field);
    try {
      const r = await api<{ team: { slug: string } }>(`/api/v1/teams/${team.slug}`, { method: "PATCH", body: field === "name" ? { name } : { slug } });
      toast.success("Saved");
      if (field === "slug") router.push(`/${r.team.slug}/settings`);
      router.refresh();
    } catch (e) {
      toast.error("Could not save", e instanceof ApiClientError ? (e.fields ? Object.values(e.fields)[0] : e.message) : undefined);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader title="Team Name" description="This is your team's visible name within LevantDeploy." />
        <CardBody>
          <Input value={name} onChange={(e) => setName(e.target.value)} disabled={!isAdmin} maxLength={60} className="max-w-sm" />
        </CardBody>
        <CardFooter hint="Please use 60 characters at maximum.">
          <Button size="sm" variant="primary" disabled={!isAdmin || name === team.name} loading={busy === "name"} onClick={() => save("name")}>
            Save
          </Button>
        </CardFooter>
      </Card>
      <Card>
        <CardHeader title="Team URL" description="This is your team's URL namespace on this LevantDeploy instance." />
        <CardBody>
          <Input prefix="/" value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase())} disabled={!isOwner} maxLength={40} className="max-w-sm" />
        </CardBody>
        <CardFooter hint="Only owners can change the URL. Old links will stop working.">
          <Button size="sm" variant="primary" disabled={!isOwner || slug === team.slug} loading={busy === "slug"} onClick={() => save("slug")}>
            Save
          </Button>
        </CardFooter>
      </Card>
      <Card>
        <CardHeader title="Team ID" description="Used when interacting with the LevantDeploy API." />
        <CardBody>
          <div className="flex max-w-sm items-center gap-2 rounded-md border border-border bg-bg-subtle px-3 py-2 font-mono text-[13px]">
            <span className="flex-1 truncate">{team.id}</span>
            <CopyButton value={team.id} />
          </div>
        </CardBody>
      </Card>
      {!team.isPersonal && isOwner && (
        <Card className="border-danger/40">
          <CardHeader title="Delete Team" description="Permanently remove this team. All projects must be deleted first." />
          <CardFooter hint="This action is not reversible." className="mt-5 border-danger/30 bg-danger/5">
            <Button
              size="sm"
              variant="danger"
              loading={busy === "delete"}
              onClick={async () => {
                if (!confirm(`Delete team ${team.name}?`)) return;
                setBusy("delete");
                try {
                  await api(`/api/v1/teams/${team.slug}`, { method: "DELETE" });
                  router.push("/");
                  router.refresh();
                } catch (e) {
                  toast.error("Could not delete", e instanceof ApiClientError ? e.message : undefined);
                  setBusy(null);
                }
              }}
            >
              Delete
            </Button>
          </CardFooter>
        </Card>
      )}
    </div>
  );
}
