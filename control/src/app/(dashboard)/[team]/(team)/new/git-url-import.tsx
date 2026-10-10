"use client";

import { useState } from "react";
import { GitBranch, KeyRound, Link2 } from "lucide-react";
import { Button, Card, CardBody, CardFooter, CardHeader, CodeBlock, Field, Input, Tabs, useToast } from "@/components/ui";
import { api, ApiClientError } from "@/lib/client/api";
import type { Detection, Selection } from "./types";

type Inspect = { ok: true; url: string; name: string; defaultBranch: string | null; branches: string[]; detection: Detection | null };

const isSshUrl = (u: string) => /^(ssh:\/\/|[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:)/.test(u.trim());

export function GitUrlImport({ team, onSelect }: { team: { slug: string }; onSelect: (s: Selection) => void }) {
  const toast = useToast();
  const [url, setUrl] = useState("");
  const [auth, setAuth] = useState<"public" | "token" | "ssh">("public");
  const [token, setToken] = useState("");
  const [username, setUsername] = useState("");
  const [key, setKey] = useState<{ id: string; publicKey: string; fingerprint: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ssh = isSshUrl(url) || auth === "ssh";

  async function genKey() {
    try {
      setKey(await api("/api/v1/git/deploy-keys", { body: { team: team.slug, url } }));
    } catch (e) {
      toast.error("Could not generate a key", e instanceof ApiClientError ? e.message : undefined);
    }
  }

  async function check() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<Inspect>("/api/v1/git/inspect", {
        body: { team: team.slug, url, token: !ssh && auth === "token" ? token : null, tokenUsername: username || null, deployKeyId: ssh ? key?.id : null },
      });
      onSelect({
        kind: "git",
        url: r.url,
        token: !ssh && auth === "token" ? token : null,
        tokenUsername: username || null,
        deployKeyId: ssh ? (key?.id ?? null) : null,
        branches: r.branches,
        defaultBranch: r.defaultBranch,
        name: r.name,
        detection: r.detection,
      });
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : "Could not reach the repository");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader title="Clone from Git URL" description="Any Git host — GitHub, GitLab, Bitbucket, Gitea, your own server. Private repositories use an access token or an SSH deploy key." />
      <CardBody className="space-y-4">
        <Field label="Repository URL" htmlFor="git-url" error={error}>
          <Input
            id="git-url"
            prefix={<Link2 className="h-4 w-4" />}
            placeholder="https://gitlab.com/acme/web.git  or  git@github.com:acme/web.git"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              if (isSshUrl(e.target.value)) setAuth("ssh");
              else if (auth === "ssh") setAuth("public");
            }}
            invalid={!!error}
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
        <div>
          <Tabs
            value={ssh ? "ssh" : auth}
            onValueChange={(v) => setAuth(v)}
            tabs={[
              { value: "public", label: "Public" },
              { value: "token", label: "Access token" },
              { value: "ssh", label: "SSH deploy key" },
            ]}
          />
        </div>
        {!ssh && auth === "token" && (
          <div className="grid gap-3 sm:grid-cols-[1fr_200px]">
            <Field label="Token" hint="A read-only personal/project access token. Stored encrypted." htmlFor="git-token">
              <Input id="git-token" type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" />
            </Field>
            <Field label="Username (optional)" hint="Default per host (oauth2 for GitLab…)" htmlFor="git-user">
              <Input id="git-user" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
            </Field>
          </div>
        )}
        {ssh && (
          <div className="space-y-3 rounded-lg border border-border bg-bg-subtle p-4">
            {!isSshUrl(url) && <p className="text-[13px] text-warning">Use an SSH URL (git@host:owner/repo.git) with a deploy key.</p>}
            {!key ? (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-[13px] text-muted">Generate a read-only ed25519 key for this project, then add the public key to the repository's deploy keys.</p>
                <Button size="sm" leftIcon={<KeyRound className="h-3.5 w-3.5" />} onClick={genKey}>
                  Generate deploy key
                </Button>
              </div>
            ) : (
              <>
                <p className="text-[13px] text-muted">
                  Add this key to the repository (GitHub: Settings → Deploy keys · GitLab: Settings → Repository → Deploy keys), read-only, then continue.
                </p>
                <CodeBlock code={key.publicKey} wrap />
                <p className="font-mono text-xs text-subtle">{key.fingerprint}</p>
              </>
            )}
          </div>
        )}
      </CardBody>
      <CardFooter hint={<span className="inline-flex items-center gap-1"><GitBranch className="h-3.5 w-3.5" /> Branches are polled every 2 minutes for auto-deploys.</span>}>
        <Button variant="primary" size="sm" loading={busy} disabled={!url.trim() || (ssh && !key)} onClick={check}>
          Continue
        </Button>
      </CardFooter>
    </Card>
  );
}
