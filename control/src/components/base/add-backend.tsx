"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Link2 } from "lucide-react";
import { Button, Card, CardBody, CardFooter, CardHeader, Select, Switch, Tabs, useToast } from "@/components/ui";
import { api, ApiClientError } from "@/lib/client/api";
import { CreateBaseForm } from "./create-form";
import { BaseStatusBadge } from "./common";

type Candidate = { ref: string; name: string; status: string };

/** Backend tab when no backend is attached: create a new Base project for this project, or attach an existing one. */
export function AddBackend({
  teamSlug,
  project,
  candidates,
  canUse,
  isAdmin,
  plan,
}: {
  teamSlug: string;
  project: { id: string; slug: string; name: string };
  candidates: Candidate[];
  canUse: boolean;
  isAdmin: boolean;
  plan: { name: string; used: number; limit: number | null; upgradeUrl: string };
}) {
  const router = useRouter();
  const toast = useToast();
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [ref, setRef] = useState(candidates[0]?.ref ?? "");
  const [serviceKey, setServiceKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const attach = async () => {
    setBusy(true);
    try {
      await api(`/api/v1/base/projects/${ref}/connect`, { body: { projectId: project.id, attach: true, connectEnv: true, includeServiceRole: serviceKey } });
      toast.success("Backend attached", "Env vars were added — redeploy to apply them.");
      router.refresh();
    } catch (e) {
      toast.error("Could not attach", e instanceof ApiClientError ? e.message : undefined);
    } finally {
      setBusy(false);
    }
  };
  if (!canUse) {
    return <p className="text-[13px] text-muted">This project has no backend yet. Members can add one.</p>;
  }
  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <Tabs
        tabs={[
          { value: "new" as const, label: "Create a new backend" },
          { value: "existing" as const, label: `Attach existing${candidates.length ? ` (${candidates.length})` : ""}` },
        ]}
        value={mode}
        onValueChange={setMode}
      />
      {mode === "new" ? (
        <CreateBaseForm teamSlug={teamSlug} project={project} defaultName={`${project.slug}-backend`} isAdmin={isAdmin} plan={plan} />
      ) : (
        <Card>
          <CardHeader title="Attach a Base project" description="Pick a backend of this team that isn't attached to another project. Its URL and keys are written into this project's environment variables." />
          <CardBody className="space-y-4">
            {candidates.length ? (
              <>
                <Select value={ref} onChange={(e) => setRef(e.target.value)} options={candidates.map((c) => ({ value: c.ref, label: `${c.name} (${c.ref})` }))} aria-label="Base project" />
                {candidates.find((c) => c.ref === ref) && <BaseStatusBadge status={candidates.find((c) => c.ref === ref)!.status} />}
                <label className="flex items-center justify-between gap-3 text-[13px]">
                  <span>
                    Also add <span className="font-mono">SUPABASE_SERVICE_ROLE_KEY</span> (secret)
                    {!isAdmin && <span className="block text-[12px] text-subtle">Admins only</span>}
                  </span>
                  <Switch checked={serviceKey} onCheckedChange={setServiceKey} disabled={!isAdmin} label="Add service role key" />
                </label>
              </>
            ) : (
              <p className="text-[13px] text-muted">There are no unattached Base projects in this team.</p>
            )}
          </CardBody>
          <CardFooter hint="You can detach it later from the backend's Settings.">
            <Button variant="primary" size="sm" leftIcon={<Link2 className="h-3.5 w-3.5" />} disabled={!ref} loading={busy} onClick={attach}>
              Attach backend
            </Button>
          </CardFooter>
        </Card>
      )}
    </div>
  );
}
