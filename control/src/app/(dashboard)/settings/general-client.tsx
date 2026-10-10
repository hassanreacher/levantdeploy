"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Radar } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { CodeBlock } from "@/components/ui/code-block";
import { CopyButton } from "@/components/ui/copy-button";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { api, ApiClientError } from "@/lib/client/api";
import type { PlatformOverview } from "@/lib/ops/platform";

type Rec = { type: string; name: string; value: string; purpose: string };

function errText(e: unknown) {
  return e instanceof ApiClientError ? (e.fields ? Object.values(e.fields)[0] : e.message) : undefined;
}

export function GeneralSettings({ overview: o, records }: { overview: PlatformOverview; records: Rec[] }) {
  const router = useRouter();
  const toast = useToast();
  const [ipv4, setIpv4] = useState(o.serverIps.ipv4 ?? "");
  const [ipv6, setIpv6] = useState(o.serverIps.ipv6 ?? "");
  const [registration, setRegistration] = useState(o.registration);
  const [busy, setBusy] = useState<string | null>(null);

  const patch = async (key: string, body: Record<string, unknown>) => {
    setBusy(key);
    try {
      await api("/api/v1/platform/settings", { method: "PATCH", body });
      toast.success("Saved");
      router.refresh();
    } catch (e) {
      toast.error("Could not save", errText(e));
    } finally {
      setBusy(null);
    }
  };

  const detect = async () => {
    setBusy("detect");
    try {
      const r = await api<{ detected: { ipv4: string | null; ipv6: string | null }; serverIps: { ipv4: string | null; ipv6: string | null } }>("/api/v1/platform/detect-ip", { method: "POST" });
      setIpv4(r.serverIps.ipv4 ?? "");
      setIpv6(r.serverIps.ipv6 ?? "");
      if (r.detected.ipv4 || r.detected.ipv6) toast.success("Public IP detected", [r.detected.ipv4, r.detected.ipv6].filter(Boolean).join(" · "));
      else toast.error("Could not detect a public IP", "This server may not have outbound internet access. Enter the address manually.");
      router.refresh();
    } catch (e) {
      toast.error("Detection failed", errText(e));
    } finally {
      setBusy(null);
    }
  };

  const dash = o.dashboardHost.replace(/:\d+$/, "");
  const reconfigure = `sudo bash ${o.installDir}/install/install.sh --domain ${o.platformDomain} --dashboard-host ${dash}`;

  return (
    <>
      <Card>
        <CardHeader
          title="Platform Domain"
          description="Deployments are served at {project}.domain and {project}-{id}.domain. The dashboard runs on its own host."
          actions={<Badge tone={o.tls === "acme" ? "success" : "neutral"}>{o.tls === "acme" ? "Automatic HTTPS" : o.tls === "internal" ? "Local CA (internal)" : "HTTP only"}</Badge>}
        />
        <CardBody className="grid gap-4 sm:grid-cols-2">
          <Field label="Platform domain" hint="Wildcard DNS *.domain must point at this server.">
            <Input value={o.platformDomain} readOnly className="font-mono" />
          </Field>
          <Field label="Dashboard host" hint={`${o.scheme}://${o.dashboardHost}`}>
            <Input value={o.dashboardHost} readOnly className="font-mono" />
          </Field>
          <div className="sm:col-span-2">
            <CodeBlock prompt wrap code={reconfigure} />
          </div>
        </CardBody>
        <CardFooter hint="Set at install time in .env. To change them, re-run the installer with the new values (above), then update your DNS." />
      </Card>

      <Card>
        <CardHeader title="Server IP Addresses" description="The public addresses your DNS records point to. Used for the DNS instructions below and for domain verification." />
        <CardBody className="grid gap-4 sm:grid-cols-2">
          <Field label="IPv4" htmlFor="ipv4">
            <Input id="ipv4" value={ipv4} onChange={(e) => setIpv4(e.target.value.trim())} placeholder="203.0.113.10" className="font-mono" />
          </Field>
          <Field label="IPv6 (optional)" htmlFor="ipv6">
            <Input id="ipv6" value={ipv6} onChange={(e) => setIpv6(e.target.value.trim())} placeholder="2001:db8::10" className="font-mono" />
          </Field>
        </CardBody>
        <CardFooter hint={o.serverIps.detectedAt ? `Last detected ${new Date(o.serverIps.detectedAt).toLocaleString()}` : "Not detected yet."}>
          <Button size="sm" variant="secondary" leftIcon={<Radar className="h-3.5 w-3.5" />} loading={busy === "detect"} onClick={detect}>
            Detect
          </Button>
          <Button
            size="sm"
            variant="primary"
            loading={busy === "ips"}
            disabled={ipv4 === (o.serverIps.ipv4 ?? "") && ipv6 === (o.serverIps.ipv6 ?? "")}
            onClick={() => patch("ips", { serverIps: { ipv4: ipv4 || null, ipv6: ipv6 || null } })}
          >
            Save
          </Button>
        </CardFooter>
      </Card>

      <Card>
        <CardHeader title="DNS Records" description="Create these records at your DNS provider. Deployment URLs and preview URLs work as soon as the wildcard resolves." />
        <CardBody className="space-y-4">
          <div className="overflow-x-auto rounded-md border border-border">
            <Table>
              <THead>
                <TR>
                  <TH>Type</TH>
                  <TH>Name</TH>
                  <TH>Value</TH>
                  <TH className="hidden sm:table-cell">Purpose</TH>
                </TR>
              </THead>
              <TBody>
                {records.map((r) => (
                  <TR key={r.type + r.name}>
                    <TD className="font-mono text-[13px]">{r.type}</TD>
                    <TD className="font-mono text-[13px]">
                      <span className="inline-flex items-center gap-1.5">
                        {r.name}
                        <CopyButton value={r.name} label={`Copy ${r.name}`} />
                      </span>
                    </TD>
                    <TD className="font-mono text-[13px]">{r.value}</TD>
                    <TD className="hidden text-[13px] text-muted sm:table-cell">{r.purpose}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
          <p className="text-[13px] text-muted">
            Using Cloudflare? Set the records to <span className="font-medium text-fg">DNS only</span> (grey cloud) so certificates can be issued on demand, or keep the
            proxy on with SSL mode <span className="font-medium text-fg">Full</span>. Custom domains: add a CNAME to <span className="font-mono text-fg">{dash}</span> or an A
            record to the IP above.
          </p>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Registration" description="Who can create an account after the first (owner) account." />
        <CardBody>
          <Select
            className="max-w-sm"
            value={registration}
            disabled={o.registrationLockedByEnv}
            onChange={(e) => setRegistration(e.target.value as "open" | "invite" | "closed")}
            options={[
              { value: "invite", label: "Invite only — people join through team invites" },
              { value: "open", label: "Open — anyone can sign up" },
              { value: "closed", label: "Closed — no new accounts" },
            ]}
          />
        </CardBody>
        <CardFooter hint={o.registrationLockedByEnv ? "Forced to open by REGISTRATION=open in .env." : "Open sign-ups require email verification — see Sign-ups for abuse protection."}>
          <Button size="sm" variant="primary" disabled={registration === o.registration} loading={busy === "reg"} onClick={() => patch("reg", { registration })}>
            Save
          </Button>
        </CardFooter>
      </Card>

      <Card>
        <CardHeader title="Instance" description="Quick facts about this installation." />
        <CardBody className="grid gap-3 text-sm sm:grid-cols-4">
          <Stat label="Version" value={o.version} mono />
          <Stat label="Users" value={String(o.counts.users)} />
          <Stat label="Teams" value={String(o.counts.teams)} />
          <Stat label="Projects" value={String(o.counts.projects)} />
        </CardBody>
        <CardFooter hint="Install directory">
          <span className="font-mono text-[13px] text-muted">{o.installDir}</span>
        </CardFooter>
      </Card>

      <CodeBlock title="Server status" prompt wrap code={`cd ${o.installDir} && docker compose ps`} />
    </>
  );
}

function Stat({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-md border border-border bg-bg-subtle px-3 py-2.5">
      <p className="text-[12px] text-muted">{label}</p>
      <p className={mono ? "mt-0.5 font-mono text-[15px] font-medium" : "mt-0.5 text-[15px] font-medium"}>{value}</p>
    </div>
  );
}
