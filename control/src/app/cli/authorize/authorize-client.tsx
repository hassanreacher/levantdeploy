"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Terminal, XCircle } from "lucide-react";
import { Button, Field, Input, Select, useToast } from "@/components/ui";
import { api, ApiClientError } from "@/lib/client/api";
import { timeAgo } from "@/lib/utils";

type Info = { userCode: string; status: string; clientName: string; hostname: string | null; ip: string | null; createdAt: number } | null;

export function AuthorizeClient({ code, info, user, teams }: { code: string; info: Info; user: { name: string; email: string }; teams: { slug: string; name: string }[] }) {
  const toast = useToast();
  const router = useRouter();
  const [team, setTeam] = useState<string>("");
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const [done, setDone] = useState<"approved" | "denied" | null>(info && info.status !== "pending" ? (info.status as "approved" | "denied") : null);
  const [entered, setEntered] = useState(code);

  if (!info) {
    return (
      <div className="rounded-xl border border-border bg-surface p-6">
        <Terminal className="mb-4 h-6 w-6 text-muted" />
        <h1 className="text-xl font-semibold tracking-tight text-fg">Connect the LevantDeploy CLI</h1>
        <p className="mt-1.5 text-sm text-muted">{code ? "This code is invalid or expired. Run levant login again." : "Enter the code shown in your terminal."}</p>
        <form
          className="mt-5 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            router.push(`/cli/authorize?code=${encodeURIComponent(entered)}`);
          }}
        >
          <Field label="Code" htmlFor="code">
            <Input id="code" value={entered} onChange={(e) => setEntered(e.target.value.toUpperCase())} placeholder="ABCD-EFGH" className="font-mono tracking-[0.2em]" autoFocus />
          </Field>
          <Button type="submit" variant="primary" className="w-full" disabled={entered.replace(/[^A-Z0-9]/gi, "").length !== 8}>
            Continue
          </Button>
        </form>
      </div>
    );
  }

  if (done) {
    return (
      <div className="rounded-xl border border-border bg-surface p-6 text-center">
        {done === "approved" ? <CheckCircle2 className="mx-auto mb-4 h-8 w-8 text-success" /> : <XCircle className="mx-auto mb-4 h-8 w-8 text-danger" />}
        <h1 className="text-xl font-semibold tracking-tight text-fg">{done === "approved" ? "CLI authorized" : "Request denied"}</h1>
        <p className="mt-1.5 text-sm text-muted">{done === "approved" ? "You can close this tab and return to your terminal." : "The CLI was not given access. You can close this tab."}</p>
      </div>
    );
  }

  async function decide(action: "approve" | "deny") {
    setBusy(action);
    try {
      const r = await api<{ status: "approved" | "denied" }>(`/api/v1/cli/login/${encodeURIComponent(info!.userCode)}`, { body: { action, team: team || null } });
      setDone(r.status);
    } catch (e) {
      toast.error("Something went wrong", e instanceof ApiClientError ? e.message : undefined);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="rounded-xl border border-border bg-surface p-6">
      <div className="mb-5 flex h-10 w-10 items-center justify-center rounded-lg border border-border bg-surface-2">
        <Terminal className="h-5 w-5 text-fg" />
      </div>
      <h1 className="text-xl font-semibold tracking-tight text-fg">Authorize {info.clientName}</h1>
      <p className="mt-1.5 text-sm text-muted">
        A terminal{info.hostname ? <> on <span className="font-medium text-fg">{info.hostname}</span></> : null} is asking to deploy as <span className="font-medium text-fg">{user.email}</span>.
      </p>
      <div className="my-5 rounded-lg border border-border bg-bg-subtle py-4 text-center">
        <div className="text-xs uppercase tracking-wider text-subtle">Confirm this code matches your terminal</div>
        <div className="mt-1 font-mono text-2xl font-semibold tracking-[0.25em] text-fg">{info.userCode}</div>
        <div className="mt-1 text-xs text-subtle" suppressHydrationWarning>
          requested {timeAgo(new Date(info.createdAt))}
          {info.ip ? ` · from ${info.ip}` : ""}
        </div>
      </div>
      <Field label="Access" htmlFor="cli-team" hint="A team-restricted token can only see that team's projects.">
        <Select id="cli-team" value={team} onChange={(e) => setTeam(e.target.value)} options={[{ value: "", label: "All my teams" }, ...teams.map((t) => ({ value: t.slug, label: `Only ${t.name}` }))]} />
      </Field>
      <div className="mt-6 grid grid-cols-2 gap-2">
        <Button variant="secondary" loading={busy === "deny"} disabled={!!busy} onClick={() => decide("deny")}>
          Deny
        </Button>
        <Button variant="primary" loading={busy === "approve"} disabled={!!busy} onClick={() => decide("approve")}>
          Authorize
        </Button>
      </div>
      <p className="mt-4 text-center text-xs text-subtle">Creates an API token (1 year) you can revoke anytime in Tokens.</p>
    </div>
  );
}
