"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Eye, EyeOff, RefreshCw, Server } from "lucide-react";
import { Button, Card, CardBody, CardFooter, CopyButton, Field, Input, Switch, useToast } from "@/components/ui";
import { api, ApiClientError } from "@/lib/client/api";
import { BASE_NAME_RE, BASE_REGION, DB_PASSWORD_RE, generatePassword, passwordStrength, type BaseProjectDTO } from "@/lib/base-ui/shared";
import { cn } from "@/lib/utils";

const STRENGTH = ["Very weak", "Weak", "Fair", "Strong", "Very strong"];

/**
 * New Base project form (team "Base → New project" and a Deploy project's "Add a backend").
 * After creation the user lands on the project home, which shows the live provisioning screen.
 */
export function CreateBaseForm({
  teamSlug,
  project,
  defaultName = "",
  isAdmin,
  plan,
}: {
  teamSlug: string;
  /** create as the backend of this Deploy project (attaches + writes env vars) */
  project?: { id: string; slug: string; name: string } | null;
  defaultName?: string;
  isAdmin: boolean;
  plan: { name: string; used: number; limit: number | null; upgradeUrl: string };
}) {
  const router = useRouter();
  const toast = useToast();
  const [name, setName] = useState(defaultName);
  const [password, setPassword] = useState(() => generatePassword());
  const [show, setShow] = useState(false);
  const [serviceKey, setServiceKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const strength = useMemo(() => passwordStrength(password), [password]);
  const atLimit = plan.limit !== null && plan.used >= plan.limit;
  const nameOk = BASE_NAME_RE.test(name.trim());
  const pwOk = DB_PASSWORD_RE.test(password) && strength.score >= 3;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    try {
      const r = await api<{ project: BaseProjectDTO }>("/api/v1/base/projects", {
        body: { team: teamSlug, name: name.trim(), dbPassword: password, ...(project ? { projectId: project.id, connectEnv: true, includeServiceRole: serviceKey } : {}) },
      });
      toast.success(`Creating ${r.project.name}…`, project ? "Env vars were added to the project — redeploy once it is ready." : undefined);
      router.push(project ? `/${teamSlug}/${project.slug}/backend` : `/${teamSlug}/base/${r.project.ref}`);
      router.refresh();
    } catch (err) {
      const e2 = err as ApiClientError;
      if (e2.fields) setErrors(e2.fields);
      toast.error("Could not create the project", e2.fields ? Object.values(e2.fields)[0] : e2.message);
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit}>
      <Card>
        <CardBody className="space-y-5">
          <Field label="Project name" htmlFor="base-name" error={errors.name ?? (name && !nameOk ? "Use letters, digits, spaces, dots, dashes or underscores" : null)}>
            <Input id="base-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="my-app-backend" maxLength={63} autoFocus required />
          </Field>
          <Field
            label="Database password"
            htmlFor="base-pw"
            error={errors.dbPassword}
            hint="The postgres user's password. Save it in your password manager — admins can reveal it later from the Database page."
          >
            <div className="flex gap-2">
              <div className="min-w-0 flex-1">
              <Input
                id="base-pw"
                type={show ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value.trim())}
                className="font-mono"
                autoComplete="new-password"
                suffix={
                  <span className="flex items-center gap-0.5">
                    <button type="button" onClick={() => setShow(!show)} className="rounded p-1 text-muted hover:text-fg" aria-label={show ? "Hide password" : "Show password"}>
                      {show ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                    </button>
                    <CopyButton value={password} label="Copy password" className="h-6 w-6" />
                  </span>
                }
              />
              </div>
              <Button type="button" variant="secondary" aria-label="Generate password" leftIcon={<RefreshCw className="h-3.5 w-3.5" />} onClick={() => (setPassword(generatePassword()), setShow(true))}>
                <span className="hidden sm:inline">Generate</span>
              </Button>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <div className="flex flex-1 gap-1" aria-hidden>
                {[0, 1, 2, 3].map((i) => (
                  <span key={i} className={cn("h-1 flex-1 rounded-full", i < strength.score ? (strength.score >= 3 ? "bg-success" : strength.score === 2 ? "bg-warning" : "bg-danger") : "bg-surface-2")} />
                ))}
              </div>
              <span className={cn("text-[12px]", strength.score >= 3 ? "text-success" : "text-muted")}>{STRENGTH[strength.score]}</span>
            </div>
            {strength.hints.length > 0 && <p className="mt-1 text-[12px] text-muted">{strength.hints[0]}</p>}
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-md border border-border px-3 py-2.5">
              <div className="text-[12px] text-muted">Region</div>
              <div className="mt-0.5 flex items-center gap-2 text-[13px] font-medium">
                <Server className="h-3.5 w-3.5 text-muted" /> {BASE_REGION}
              </div>
            </div>
            <div className={cn("rounded-md border px-3 py-2.5", atLimit ? "border-danger/40 bg-danger/5" : "border-border")}>
              <div className="text-[12px] text-muted">{plan.name} plan</div>
              <div className="mt-0.5 text-[13px] font-medium">
                {plan.used} / {plan.limit ?? "∞"} active projects
              </div>
            </div>
          </div>
          {project && (
            <div className="space-y-2 rounded-md border border-border bg-bg-subtle px-3 py-3 text-[13px]">
              <div className="font-medium">Connect to {project.name}</div>
              <p className="text-[12px] text-muted">
                Adds <span className="font-mono">NEXT_PUBLIC_SUPABASE_URL</span>, <span className="font-mono">NEXT_PUBLIC_SUPABASE_ANON_KEY</span>, <span className="font-mono">SUPABASE_URL</span> and{" "}
                <span className="font-mono">SUPABASE_ANON_KEY</span> to every environment.
              </p>
              <label className="flex items-center justify-between gap-3 pt-1">
                <span>
                  Also add <span className="font-mono">SUPABASE_SERVICE_ROLE_KEY</span> (secret)
                  {!isAdmin && <span className="block text-[12px] text-subtle">Admins only</span>}
                </span>
                <Switch checked={serviceKey} onCheckedChange={setServiceKey} disabled={!isAdmin} label="Add service role key" />
              </label>
            </div>
          )}
          {atLimit && (
            <p className="text-[13px] text-danger">
              Your plan's project limit is reached. Pause or delete a project, or{" "}
              <Link href={plan.upgradeUrl} className="underline underline-offset-2">
                upgrade the plan
              </Link>
              .
            </p>
          )}
        </CardBody>
        <CardFooter hint="Postgres, Auth, REST, Realtime, Storage, Edge Functions and Studio — on this server.">
          <Button type="submit" variant="primary" loading={busy} disabled={!nameOk || !pwOk || atLimit}>
            Create project
          </Button>
        </CardFooter>
      </Card>
    </form>
  );
}
