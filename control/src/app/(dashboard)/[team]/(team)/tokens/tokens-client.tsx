"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { KeyRound } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/card";
import { CodeBlock } from "@/components/ui/code-block";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { api, ApiClientError } from "@/lib/client/api";
import { timeAgo } from "@/lib/utils";

type Token = { id: string; name: string; prefix: string; scopes: string[]; teamScoped: boolean; lastUsedAt: string | null; expiresAt: string | null; createdAt: string };

export function TokensClient({ team, teamName, tokens }: { team: string; teamName: string; tokens: Token[] }) {
  const router = useRouter();
  const toast = useToast();
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"team" | "all">("team");
  const [expiry, setExpiry] = useState("90");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<string | null>(null);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader title="Create token" description="The token is displayed once — store it somewhere safe." />
        <CardBody>
          <form
            id="token-form"
            className="grid gap-3 sm:grid-cols-[1fr_200px_160px]"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              try {
                const r = await api<{ token: string }>("/api/v1/tokens", {
                  body: { name, team: scope === "team" ? team : null, expiresInDays: expiry === "never" ? null : Number(expiry) },
                });
                setCreated(r.token);
                setName("");
                router.refresh();
              } catch (e) {
                toast.error("Could not create token", e instanceof ApiClientError ? e.message : undefined);
              } finally {
                setBusy(false);
              }
            }}
          >
            <Field label="Name" htmlFor="token-name">
              <Input id="token-name" required value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. GitHub Actions" maxLength={60} />
            </Field>
            <Field label="Scope" htmlFor="token-scope">
              <Select
                id="token-scope"
                value={scope}
                onChange={(e) => setScope(e.target.value as "team" | "all")}
                options={[
                  { value: "team", label: `Only ${teamName}` },
                  { value: "all", label: "All my teams" },
                ]}
              />
            </Field>
            <Field label="Expiration" htmlFor="token-exp">
              <Select
                id="token-exp"
                value={expiry}
                onChange={(e) => setExpiry(e.target.value)}
                options={[
                  { value: "7", label: "7 days" },
                  { value: "30", label: "30 days" },
                  { value: "90", label: "90 days" },
                  { value: "365", label: "1 year" },
                  { value: "never", label: "No expiration" },
                ]}
              />
            </Field>
          </form>
        </CardBody>
        <CardFooter hint="Use it with: levant login --token <token>">
          <Button type="submit" form="token-form" variant="primary" size="sm" loading={busy}>
            Create
          </Button>
        </CardFooter>
      </Card>

      {tokens.length === 0 ? (
        <EmptyState icon={<KeyRound className="h-5 w-5" />} title="No tokens yet" description="Create a token to use the CLI or the REST API." />
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-surface">
          <ul className="divide-y divide-border">
            {tokens.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-3 px-5 py-3.5">
                <KeyRound className="h-4 w-4 text-subtle" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{t.name}</p>
                  <p className="font-mono text-[12px] text-subtle">{t.prefix}…</p>
                </div>
                <Badge tone="outline">{t.teamScoped ? teamName : "All teams"}</Badge>
                <span className="text-[12px] text-subtle">{t.lastUsedAt ? `used ${timeAgo(t.lastUsedAt)}` : "never used"}</span>
                <span className="text-[12px] text-subtle">{t.expiresAt ? `expires ${new Date(t.expiresAt).toLocaleDateString()}` : "no expiry"}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    try {
                      await api(`/api/v1/tokens/${t.id}`, { method: "DELETE" });
                      toast.success("Token revoked");
                      router.refresh();
                    } catch (e) {
                      toast.error("Could not revoke", e instanceof ApiClientError ? e.message : undefined);
                    }
                  }}
                >
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <Dialog open={!!created} onClose={() => setCreated(null)} title="Token created" description="Copy it now — you won't be able to see it again." footer={<Button variant="primary" onClick={() => setCreated(null)}>Done</Button>}>
        {created && <CodeBlock code={created} wrap />}
      </Dialog>
    </div>
  );
}
