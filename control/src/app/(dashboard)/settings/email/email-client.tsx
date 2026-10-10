"use client";

import { useState } from "react";
import { Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/client/api";
import type { PlatformOverview } from "@/lib/ops/platform";
import { errText, usePlatformPatch } from "../save-helper";

export function EmailSettings({ smtp, ownerEmail }: { smtp: PlatformOverview["smtp"]; ownerEmail: string }) {
  const { busy, setBusy, toast, router } = usePlatformPatch();
  const [host, setHost] = useState(smtp?.host ?? "");
  const [port, setPort] = useState(String(smtp?.port ?? 587));
  const [secure, setSecure] = useState(smtp?.secure ?? false);
  const [user, setUser] = useState(smtp?.user ?? "");
  const [password, setPassword] = useState("");
  const [from, setFrom] = useState(smtp?.from ?? "LevantDeploy <no-reply@example.com>");
  const [to, setTo] = useState(ownerEmail);

  const save = async () => {
    setBusy("save");
    try {
      await api("/api/v1/platform/smtp", { method: "PUT", body: { host, port: Number(port), secure, user: user || null, from, ...(password ? { password } : {}) } });
      setPassword("");
      toast.success("SMTP settings saved");
      router.refresh();
    } catch (e) {
      toast.error("Could not save", errText(e));
    } finally {
      setBusy(null);
    }
  };
  const reset = async () => {
    setBusy("reset");
    try {
      await api("/api/v1/platform/smtp", { method: "DELETE" });
      toast.success("Using the SMTP settings from .env");
      router.refresh();
    } catch (e) {
      toast.error("Could not reset", errText(e));
    } finally {
      setBusy(null);
    }
  };
  const test = async () => {
    setBusy("test");
    try {
      await api("/api/v1/platform/smtp/test", { body: { to } });
      toast.success("Test email sent", to);
    } catch (e) {
      toast.error("Test failed", errText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <Card>
        <CardHeader
          title="SMTP"
          description="Used for password resets, invites and deployment notifications."
          actions={
            smtp ? <Badge tone="success">{smtp.source === "env" ? "Configured in .env" : "Configured"}</Badge> : <Badge tone="warning">Not configured</Badge>
          }
        />
        <CardBody className="grid gap-4 sm:grid-cols-6">
          <Field label="Host" htmlFor="smtp-host" className="sm:col-span-4">
            <Input id="smtp-host" value={host} onChange={(e) => setHost(e.target.value)} placeholder="smtp.example.com" className="font-mono" />
          </Field>
          <Field label="Port" htmlFor="smtp-port" className="sm:col-span-2">
            <Input id="smtp-port" type="number" value={port} onChange={(e) => setPort(e.target.value)} />
          </Field>
          <Field label="Username" htmlFor="smtp-user" className="sm:col-span-3">
            <Input id="smtp-user" value={user} onChange={(e) => setUser(e.target.value)} autoComplete="off" />
          </Field>
          <Field label="Password" htmlFor="smtp-pass" className="sm:col-span-3" hint={smtp?.passwordSet ? "Leave empty to keep the saved password." : undefined}>
            <Input id="smtp-pass" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" placeholder={smtp?.passwordSet ? "••••••••" : ""} />
          </Field>
          <Field label="From" htmlFor="smtp-from" className="sm:col-span-6">
            <Input id="smtp-from" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <label className="flex items-center gap-3 text-sm sm:col-span-6">
            <Switch checked={secure} onCheckedChange={(v) => { setSecure(v); if (v && port === "587") setPort("465"); if (!v && port === "465") setPort("587"); }} label="Use TLS" />
            <span>
              Implicit TLS <span className="text-muted">(port 465). Off = STARTTLS on 587.</span>
            </span>
          </label>
        </CardBody>
        <CardFooter hint={smtp?.source === "settings" ? "Saved settings override SMTP_* in .env." : "Without SMTP, emails are printed to the control container log."}>
          {smtp?.source === "settings" && (
            <Button size="sm" variant="ghost" loading={busy === "reset"} onClick={reset}>
              Use .env
            </Button>
          )}
          <Button size="sm" variant="primary" disabled={!host || !from} loading={busy === "save"} onClick={save}>
            Save
          </Button>
        </CardFooter>
      </Card>

      <Card>
        <CardHeader title="Send a Test Email" description="Checks the saved configuration end to end." />
        <CardBody>
          <Input type="email" value={to} onChange={(e) => setTo(e.target.value)} className="max-w-sm" aria-label="Recipient" />
        </CardBody>
        <CardFooter hint="Save your changes first.">
          <Button size="sm" variant="secondary" leftIcon={<Send className="h-3.5 w-3.5" />} disabled={!smtp || !to} loading={busy === "test"} onClick={test}>
            Send test
          </Button>
        </CardFooter>
      </Card>
    </>
  );
}
