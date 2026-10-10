"use client";

import { useState } from "react";
import Link from "next/link";
import { Network, ShieldCheck, Trash2 } from "lucide-react";
import { Badge, Button, Card, CardBody, CardFooter, CardHeader, Field, Input, Select, Switch, Textarea, useToast } from "@/components/ui";
import { api, ApiClientError } from "@/lib/client/api";
import type { PlatformBuildView } from "@/lib/build/platform";

const err = (e: unknown) => (e instanceof ApiClientError ? (e.fields ? Object.values(e.fields)[0] : e.message) : "Request failed");

export function PlatformBuildSettings({ initial }: { initial: PlatformBuildView }) {
  const toast = useToast();
  const [v, setV] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(initial.proxy.enabled);
  const [httpProxy, setHttpProxy] = useState(initial.proxy.httpProxy ?? "");
  const [httpsProxy, setHttpsProxy] = useState(initial.proxy.httpsProxy ?? "");
  const [noProxy, setNoProxy] = useState(initial.proxy.noProxy ?? "");
  const [network, setNetwork] = useState<"host" | "default">(initial.proxy.network);
  const [ca, setCa] = useState(initial.proxy.caCertPem ?? "");
  const [mirror, setMirror] = useState(initial.registryMirror ?? "");

  async function save(section: string, body: Record<string, unknown>, ok: string) {
    setBusy(section);
    try {
      const next = await api<PlatformBuildView>("/api/v1/platform/build", { method: "PUT", body });
      setV(next);
      setCa(next.proxy.caCertPem ?? "");
      setEnabled(next.proxy.enabled);
      toast.success(ok);
    } catch (e) {
      toast.error("Could not save", err(e));
    } finally {
      setBusy(null);
    }
  }
  const proxyBody = (caPem: string | null = ca || null) =>
    enabled ? { proxy: { httpProxy: httpProxy || null, httpsProxy: httpsProxy || null, noProxy: noProxy || null, caCertPem: caPem, network } } : { proxy: null };

  const proxyDirty =
    enabled !== v.proxy.enabled ||
    (enabled && (httpProxy !== (v.proxy.httpProxy ?? "") || httpsProxy !== (v.proxy.httpsProxy ?? "") || noProxy !== (v.proxy.noProxy ?? "") || network !== v.proxy.network));

  return (
    <>
      <Card>
        <CardHeader
          title="Build Proxy"
          description="Route every build's network traffic (package installs, git, downloads) through an HTTP(S) proxy. Real servers usually don't need this."
          actions={<Switch checked={enabled} onCheckedChange={setEnabled} label="Enable build proxy" />}
        />
        <CardBody className="grid gap-4 sm:grid-cols-2">
          <Field label="HTTPS proxy" htmlFor="bp-https" hint="Used for https:// downloads (npm, pip, git, …).">
            <Input id="bp-https" className="font-mono text-[13px]" placeholder="http://proxy.internal:3128" value={httpsProxy} disabled={!enabled} onChange={(e) => setHttpsProxy(e.target.value)} />
          </Field>
          <Field label="HTTP proxy" htmlFor="bp-http" hint="Optional: plain http:// downloads (apt mirrors).">
            <Input id="bp-http" className="font-mono text-[13px]" placeholder="http://proxy.internal:3128" value={httpProxy} disabled={!enabled} onChange={(e) => setHttpProxy(e.target.value)} />
          </Field>
          <Field label="No proxy" htmlFor="bp-no" hint="Comma-separated hosts / CIDRs reached directly." className="sm:col-span-2">
            <Input id="bp-no" className="font-mono text-[13px]" placeholder="localhost,127.0.0.1,.internal" value={noProxy} disabled={!enabled} onChange={(e) => setNoProxy(e.target.value)} />
          </Field>
          <Field label="Build network" htmlFor="bp-net" hint="Host: build containers share the server's network (needed when the proxy listens on 127.0.0.1).">
            <Select
              id="bp-net"
              value={network}
              disabled={!enabled}
              onChange={(e) => setNetwork(e.target.value as "host" | "default")}
              options={[
                { value: "default", label: "Default (bridge)" },
                { value: "host", label: "Host network" },
              ]}
            />
          </Field>
          {v.serverEnv.httpsProxy && (
            <div className="flex items-end">
              <Button
                variant="outline"
                size="sm"
                leftIcon={<Network className="h-3.5 w-3.5" />}
                disabled={!enabled}
                onClick={() => {
                  setHttpsProxy(v.serverEnv.httpsProxy ?? "");
                  setNoProxy(v.serverEnv.noProxy ?? "");
                }}
              >
                Use the server&apos;s proxy ({v.serverEnv.httpsProxy})
              </Button>
            </div>
          )}
        </CardBody>
        <CardFooter hint="Passed as HTTP(S)_PROXY / NO_PROXY build args — never stored in images.">
          <Button size="sm" variant="primary" disabled={!proxyDirty} loading={busy === "proxy"} onClick={() => save("proxy", proxyBody(), enabled ? "Build proxy saved" : "Build proxy disabled")}>
            Save
          </Button>
        </CardFooter>
      </Card>

      <Card>
        <CardHeader
          title="Custom CA Certificate"
          description="Trust an extra certificate authority during builds (TLS-intercepting proxies, private registries). Mounted as a BuildKit secret in install/build steps only."
        />
        <CardBody className="space-y-3">
          {v.proxy.certificates.length > 0 && (
            <ul className="space-y-1.5">
              {v.proxy.certificates.slice(0, 6).map((c) => (
                <li key={c.fingerprint + c.subject} className="flex flex-wrap items-center gap-2 text-[13px]">
                  <ShieldCheck className="h-3.5 w-3.5 text-success" />
                  <span className="font-medium">{c.subject || "(no CN)"}</span>
                  <span className="font-mono text-xs text-muted">{c.fingerprint}…</span>
                  <Badge tone={c.expired ? "danger" : "outline"}>{c.expired ? "expired" : `valid to ${c.validTo.slice(0, 10)}`}</Badge>
                </li>
              ))}
              {v.proxy.certificates.length > 6 && <li className="text-xs text-muted">+ {v.proxy.certificates.length - 6} more certificates in the bundle</li>}
            </ul>
          )}
          <Textarea
            className="min-h-[140px] font-mono text-[12px]"
            spellCheck={false}
            placeholder={"-----BEGIN CERTIFICATE-----\nMIID…\n-----END CERTIFICATE-----"}
            value={ca}
            disabled={!enabled}
            onChange={(e) => setCa(e.target.value)}
          />
        </CardBody>
        <CardFooter hint={enabled ? "NODE_EXTRA_CA_CERTS, SSL_CERT_FILE, PIP_CERT, REQUESTS_CA_BUNDLE, GIT_SSL_CAINFO, JVM truststore… are set automatically." : "Enable the build proxy to use a custom CA."}>
          {v.proxy.caCertPem && (
            <Button size="sm" variant="ghost" leftIcon={<Trash2 className="h-3.5 w-3.5" />} disabled={!enabled} loading={busy === "ca-rm"} onClick={() => save("ca-rm", proxyBody(null), "CA certificate removed")}>
              Remove
            </Button>
          )}
          <Button size="sm" variant="primary" disabled={!enabled || ca.trim() === (v.proxy.caCertPem ?? "").trim()} loading={busy === "ca"} onClick={() => save("ca", proxyBody(), "CA certificate saved")}>
            Save
          </Button>
        </CardFooter>
      </Card>

      <Card>
        <CardHeader title="Docker Hub Mirror" description="Pull-through mirror for the base images of generated Dockerfiles (node, python, golang…) — avoids Docker Hub rate limits (HTTP 429)." />
        <CardBody>
          <Field label="Mirror host" htmlFor="bp-mirror" hint="e.g. mirror.gcr.io → FROM mirror.gcr.io/library/node:22-alpine. Repository Dockerfiles are not rewritten.">
            <Input id="bp-mirror" className="font-mono text-[13px] sm:max-w-sm" placeholder="(Docker Hub directly)" value={mirror} onChange={(e) => setMirror(e.target.value)} />
          </Field>
        </CardBody>
        <CardFooter hint={v.registryMirror ? `Current: ${v.registryMirror}` : "Not set."}>
          <Button size="sm" variant="primary" disabled={mirror === (v.registryMirror ?? "")} loading={busy === "mirror"} onClick={() => save("mirror", { registryMirror: mirror || null }, "Registry mirror saved")}>
            Save
          </Button>
        </CardFooter>
      </Card>

      <Card>
        <CardHeader title="Build Limits" description="Concurrency and timeout are managed with the other platform limits." />
        <CardBody className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          <span>
            Concurrent builds: <span className="font-medium">{v.concurrency}</span>
          </span>
          <span>
            Timeout: <span className="font-medium">{v.timeoutMinutes} min</span>
          </span>
          <Link href="/settings/limits" className="text-[13px] font-medium text-accent hover:underline">
            Edit in Limits →
          </Link>
        </CardBody>
      </Card>
    </>
  );
}
