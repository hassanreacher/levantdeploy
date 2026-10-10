"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Laptop, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/card";
import { CodeBlock } from "@/components/ui/code-block";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { api, ApiClientError } from "@/lib/client/api";
import { timeAgo } from "@/lib/utils";

type SessionRow = { id: string; ip: string | null; userAgent: string | null; lastSeenAt: string; createdAt: string; current: boolean };

function describeUA(ua: string | null) {
  if (!ua) return "Unknown device";
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : /node|curl|levant/i.test(ua) ? "CLI" : "Browser";
  const os = /Windows/.test(ua) ? "Windows" : /Mac OS/.test(ua) ? "macOS" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Linux/.test(ua) ? "Linux" : "";
  return `${browser}${os ? ` on ${os}` : ""}`;
}

export function AccountClient({ user, sessions }: { user: { name: string; email: string; totpEnabled: boolean }; sessions: SessionRow[] }) {
  const router = useRouter();
  const toast = useToast();
  const [name, setName] = useState(user.name);
  const [pw, setPw] = useState({ currentPassword: "", password: "" });
  const [busy, setBusy] = useState<string | null>(null);
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [disablePw, setDisablePw] = useState("");
  const [disabling, setDisabling] = useState(false);

  const run = async (key: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(key);
    try {
      await fn();
      if (ok) toast.success(ok);
      router.refresh();
      return true;
    } catch (e) {
      toast.error("Something went wrong", e instanceof ApiClientError ? (e.fields ? Object.values(e.fields)[0] : e.message) : undefined);
      return false;
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader title="Display Name" description="Your name as shown to team members." />
        <CardBody>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} className="max-w-sm" />
        </CardBody>
        <CardFooter hint="Please use 80 characters at maximum.">
          <Button size="sm" variant="primary" disabled={name === user.name} loading={busy === "name"} onClick={() => run("name", () => api("/api/v1/me", { method: "PATCH", body: { name } }), "Saved")}>
            Save
          </Button>
        </CardFooter>
      </Card>

      <Card>
        <CardHeader title="Password" description="Changing your password signs out all other sessions." />
        <CardBody className="grid gap-3 sm:grid-cols-2">
          <Field label="Current password" htmlFor="cur-pw">
            <Input id="cur-pw" type="password" value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} autoComplete="current-password" />
          </Field>
          <Field label="New password" htmlFor="new-pw">
            <Input id="new-pw" type="password" value={pw.password} onChange={(e) => setPw({ ...pw, password: e.target.value })} autoComplete="new-password" />
          </Field>
        </CardBody>
        <CardFooter hint="At least 8 characters with a letter and a number.">
          <Button
            size="sm"
            variant="primary"
            disabled={!pw.currentPassword || !pw.password}
            loading={busy === "pw"}
            onClick={async () => {
              if (await run("pw", () => api("/api/v1/me/password", { body: pw }), "Password changed")) setPw({ currentPassword: "", password: "" });
            }}
          >
            Change password
          </Button>
        </CardFooter>
      </Card>

      <Card>
        <CardHeader
          title={
            <span className="flex items-center gap-2">
              Two-Factor Authentication {user.totpEnabled ? <Badge tone="success">Enabled</Badge> : <Badge>Disabled</Badge>}
            </span>
          }
          description="Require a code from an authenticator app (TOTP) when logging in."
        />
        <CardBody>
          {setup && !user.totpEnabled ? (
            <div className="flex flex-col gap-5 sm:flex-row">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={setup.qr} alt="QR code" className="h-[180px] w-[180px] rounded-md bg-white p-2" />
              <div className="flex-1 space-y-3">
                <p className="text-sm text-muted">Scan the QR code, or enter this secret manually:</p>
                <CodeBlock code={setup.secret} />
                <Field label="Code from the app" htmlFor="totp">
                  <Input id="totp" value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" placeholder="123456" className="max-w-[180px] font-mono tracking-widest" />
                </Field>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-3 text-sm text-muted">
              <ShieldCheck className="h-5 w-5" />
              {user.totpEnabled ? "Your account is protected with an authenticator app." : "Add an extra layer of security to your account."}
            </div>
          )}
        </CardBody>
        <CardFooter>
          {user.totpEnabled ? (
            <Button size="sm" variant="secondary" onClick={() => setDisabling(true)}>
              Disable
            </Button>
          ) : setup ? (
            <Button
              size="sm"
              variant="primary"
              loading={busy === "2fa"}
              onClick={() =>
                run("2fa", async () => {
                  const r = await api<{ recoveryCodes: string[] }>("/api/v1/me/2fa/enable", { body: { code } });
                  setCodes(r.recoveryCodes);
                  setSetup(null);
                }, "Two-factor authentication enabled")
              }
            >
              Verify &amp; enable
            </Button>
          ) : (
            <Button size="sm" variant="primary" loading={busy === "2fa"} onClick={() => run("2fa", async () => setSetup(await api("/api/v1/me/2fa/setup", { method: "POST" })))}>
              Set up
            </Button>
          )}
        </CardFooter>
      </Card>

      <Card>
        <CardHeader title="Sessions" description="Devices currently signed in to your account." />
        <CardBody className="p-0 pt-4">
          <ul className="divide-y divide-border border-t border-border" data-testid="sessions-list">
            {sessions.map((s) => (
              <li key={s.id} className="flex items-center gap-3 px-5 py-3">
                <Laptop className="h-4 w-4 text-subtle" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm">
                    {describeUA(s.userAgent)} {s.current && <Badge tone="success">This device</Badge>}
                  </p>
                  <p className="text-[12px] text-subtle">
                    {s.ip ?? "unknown IP"} · last active {timeAgo(s.lastSeenAt)} · signed in {timeAgo(s.createdAt)}
                  </p>
                </div>
                {!s.current && (
                  <Button size="sm" variant="ghost" loading={busy === s.id} onClick={() => run(s.id, () => api(`/api/v1/me/sessions/${s.id}`, { method: "DELETE" }), "Session revoked")}>
                    Revoke
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>

      <Dialog open={!!codes} onClose={() => setCodes(null)} title="Save your recovery codes" description="Each code can be used once if you lose access to your authenticator. They won't be shown again." footer={<Button variant="primary" onClick={() => setCodes(null)}>I saved them</Button>}>
        {codes && <CodeBlock code={codes.join("\n")} />}
      </Dialog>
      <Dialog
        open={disabling}
        onClose={() => setDisabling(false)}
        title="Disable two-factor authentication"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDisabling(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={busy === "dis"}
              onClick={async () => {
                if (await run("dis", () => api("/api/v1/me/2fa/disable", { body: { password: disablePw } }), "Two-factor authentication disabled")) {
                  setDisabling(false);
                  setDisablePw("");
                }
              }}
            >
              Disable
            </Button>
          </>
        }
      >
        <Field label="Confirm your password" htmlFor="dis-pw">
          <Input id="dis-pw" type="password" value={disablePw} onChange={(e) => setDisablePw(e.target.value)} />
        </Field>
      </Dialog>
    </div>
  );
}
