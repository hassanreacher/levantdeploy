"use client";

import { useCallback, useEffect, useState } from "react";
import { FolderGit2, GitBranch, Github, KeyRound, Link2, Plus, RefreshCw, Trash2, Unplug, Webhook } from "lucide-react";
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  CodeBlock,
  CopyButton,
  Dialog,
  EmptyState,
  Field,
  Input,
  Skeleton,
  Switch,
  useToast,
} from "@/components/ui";
import { api, ApiClientError } from "@/lib/client/api";
import { timeAgo } from "@/lib/utils";

/**
 * Project Settings → Git (git+cli area). Mounted by the dashboard's project settings page:
 *   <GitSettings projectId={project.id} teamSlug={team.slug} canEdit={hasRole(role, "ADMIN")} />
 */
type Hook = { id: string; name: string; branch: string; url: string; createdAt: string; lastTriggeredAt: string | null };
type GitView = {
  sourceType: "GITHUB" | "GIT" | "UPLOAD" | "IMAGE";
  productionBranch: string;
  rootDirectory: string;
  autoDeploy: boolean;
  previewDeployments: boolean;
  github: { repoFullName: string | null; installationId: number | null; account: string | null; connected: boolean } | null;
  git: { url: string | null; isSsh: boolean; hasToken: boolean; tokenUsername: string | null; deployKeyPublic: string | null; polling: { enabled: boolean; lastCheckedAt: string | null; lastError: string | null; branches: number } } | null;
  image: string | null;
  deployHooks: Hook[];
  githubApp: { configured: boolean };
};

export function GitSettings({ projectId, teamSlug, canEdit = true }: { projectId: string; teamSlug: string; canEdit?: boolean }) {
  const toast = useToast();
  const [v, setV] = useState<GitView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setV(await api<GitView>(`/api/v1/projects/${projectId}/git`));
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : "Could not load Git settings");
    }
  }, [projectId]);
  useEffect(() => {
    void load();
  }, [load]);

  async function patch(body: Record<string, unknown>, ok = "Saved") {
    try {
      setV(await api<GitView>(`/api/v1/projects/${projectId}/git`, { method: "PATCH", body }));
      toast.success(ok);
      return true;
    } catch (e) {
      toast.error("Could not save", e instanceof ApiClientError ? e.message : undefined);
      return false;
    }
  }

  if (error) return <Card><CardBody className="text-sm text-danger">{error}</CardBody></Card>;
  if (!v) return <Skeleton className="h-48 w-full rounded-lg" />;
  const isGit = v.sourceType === "GITHUB" || v.sourceType === "GIT";

  return (
    <div className="space-y-6" id="git">
      <ConnectedRepo v={v} teamSlug={teamSlug} canEdit={canEdit} patch={patch} />
      {isGit && <BranchCard v={v} canEdit={canEdit} patch={patch} projectId={projectId} />}
      {isGit && (
        <Card>
          <CardHeader title="Automatic deployments" description="What happens when commits are pushed." />
          <CardBody className="space-y-4">
            <Toggle label="Auto-deploy" hint={`Deploy every push to ${v.productionBranch} to production.`} checked={v.autoDeploy} disabled={!canEdit} onChange={(x) => patch({ autoDeploy: x })} />
            <Toggle label="Preview deployments" hint="Deploy pushes to other branches and pull requests to their own preview URL." checked={v.previewDeployments} disabled={!canEdit} onChange={(x) => patch({ previewDeployments: x })} />
            {v.git && !v.github && (
              <Toggle
                label="Poll for new commits"
                hint={
                  v.git.polling.lastCheckedAt
                    ? `Checked ${timeAgo(v.git.polling.lastCheckedAt)} · ${v.git.polling.branches} branches${v.git.polling.lastError ? ` · error: ${v.git.polling.lastError}` : ""}`
                    : "Checks the repository every 2 minutes (no webhook needed)."
                }
                checked={v.git.polling.enabled}
                disabled={!canEdit}
                onChange={(x) => patch({ polling: x })}
              />
            )}
          </CardBody>
          <CardFooter hint="Commits with [skip ci] or [skip deploy] in the message are never deployed." />
        </Card>
      )}
      {v.git && !v.git.isSsh && <TokenCard v={v} canEdit={canEdit} patch={patch} />}
      {v.git?.isSsh && <DeployKeyCard v={v} projectId={projectId} canEdit={canEdit} reload={load} />}
      {isGit && <DeployHooksCard hooks={v.deployHooks} projectId={projectId} canEdit={canEdit} defaultBranch={v.productionBranch} reload={load} />}
    </div>
  );
}

function Toggle({ label, hint, checked, disabled, onChange }: { label: string; hint: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <div className="text-sm font-medium text-fg">{label}</div>
        <p className="text-[13px] text-muted">{hint}</p>
      </div>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onChange} label={label} />
    </div>
  );
}

function ConnectedRepo({ v, teamSlug, canEdit, patch }: { v: GitView; teamSlug: string; canEdit: boolean; patch: (b: Record<string, unknown>, ok?: string) => Promise<boolean> }) {
  const [disconnect, setDisconnect] = useState(false);
  const [connect, setConnect] = useState(false);
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const connected = v.sourceType === "GITHUB" || v.sourceType === "GIT";
  return (
    <Card>
      <CardHeader title="Connected Git Repository" description="Pushes to this repository create deployments automatically." />
      <CardBody>
        {v.github ? (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Github className="h-4 w-4" />
            <a href={`https://github.com/${v.github.repoFullName}`} target="_blank" rel="noreferrer" className="font-medium text-fg hover:underline">
              {v.github.repoFullName}
            </a>
            {v.github.connected ? <Badge tone="success">Connected</Badge> : <Badge tone="warning">App not installed</Badge>}
          </div>
        ) : v.git ? (
          <div className="flex min-w-0 items-center gap-2 text-sm">
            <FolderGit2 className="h-4 w-4 shrink-0" />
            <span className="truncate font-mono text-[13px] text-fg">{v.git.url}</span>
            <Badge tone="outline">{v.git.isSsh ? "SSH" : v.git.hasToken ? "HTTPS + token" : "HTTPS"}</Badge>
          </div>
        ) : (
          <EmptyState
            className="py-8"
            icon={<Unplug className="h-5 w-5" />}
            title={v.sourceType === "IMAGE" ? `Runs the image ${v.image}` : "No Git repository connected"}
            description={v.sourceType === "UPLOAD" ? "This project is deployed from uploads (CLI or dashboard). Connect a repository to deploy on every push." : undefined}
          />
        )}
        {connect && (
          <div className="mt-4 space-y-3 rounded-lg border border-border p-4">
            <Field label="Git URL (HTTPS)" hint="SSH repositories: create the project from the import flow to generate a deploy key, or use a token.">
              <Input prefix={<Link2 className="h-4 w-4" />} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://gitlab.com/acme/web.git" />
            </Field>
            <Field label="Access token (private repositories)">
              <Input type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" />
            </Field>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="primary"
                loading={busy}
                disabled={!url}
                onClick={async () => {
                  setBusy(true);
                  if (await patch({ connect: { type: "git", url, token: token || null } }, "Repository connected")) setConnect(false);
                  setBusy(false);
                }}
              >
                Connect
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConnect(false)}>
                Cancel
              </Button>
            </div>
            {v.githubApp.configured && (
              <p className="text-[13px] text-muted">
                GitHub repositories get pull-request previews and commit statuses: import them from{" "}
                <a className="text-fg underline underline-offset-4" href={`/${teamSlug}/new`}>
                  New Project → Import Git Repository
                </a>
                .
              </p>
            )}
          </div>
        )}
      </CardBody>
      {canEdit && (
        <CardFooter hint={connected ? undefined : "Connect any Git host over HTTPS."}>
          {connected ? (
            <Button size="sm" variant="secondary" leftIcon={<Unplug className="h-3.5 w-3.5" />} onClick={() => setDisconnect(true)}>
              Disconnect
            </Button>
          ) : (
            !connect && (
              <Button size="sm" variant="primary" onClick={() => setConnect(true)}>
                Connect repository
              </Button>
            )
          )}
        </CardFooter>
      )}
      <Dialog
        open={disconnect}
        onClose={() => setDisconnect(false)}
        title="Disconnect the Git repository?"
        description="Existing deployments keep running. New pushes won't be deployed and deploy hooks stop working until a repository is connected again."
        footer={
          <>
            <Button variant="ghost" onClick={() => setDisconnect(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={async () => {
                await patch({ connect: { type: "disconnect" } }, "Repository disconnected");
                setDisconnect(false);
                toast.info("Deploy from the CLI with `levant deploy` meanwhile.");
              }}
            >
              Disconnect
            </Button>
          </>
        }
      />
    </Card>
  );
}

function BranchCard({ v, canEdit, patch, projectId }: { v: GitView; canEdit: boolean; patch: (b: Record<string, unknown>, ok?: string) => Promise<boolean>; projectId: string }) {
  const [branch, setBranch] = useState(v.productionBranch);
  const [deployBranch, setDeployBranch] = useState("");
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  return (
    <Card>
      <CardHeader title="Production Branch" description="Commits to this branch are deployed to your production domains." />
      <CardBody className="space-y-4">
        <Input prefix={<GitBranch className="h-4 w-4" />} value={branch} onChange={(e) => setBranch(e.target.value)} disabled={!canEdit} className="max-w-sm" />
        <div className="flex flex-col gap-2 border-t border-border pt-4 sm:flex-row sm:items-end">
          <Field label="Deploy a branch now" hint="Production branch → production, other branches → preview." className="flex-1">
            <Input placeholder={v.productionBranch} value={deployBranch} onChange={(e) => setDeployBranch(e.target.value)} />
          </Field>
          <Button
            size="md"
            loading={busy}
            leftIcon={<RefreshCw className="h-3.5 w-3.5" />}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await api<{ deployment: { number: number } }>(`/api/v1/projects/${projectId}/git/deploy`, { body: { branch: deployBranch || undefined } });
                toast.success(`Deployment #${r.deployment.number} queued`);
              } catch (e) {
                toast.error("Could not deploy", e instanceof ApiClientError ? e.message : undefined);
              } finally {
                setBusy(false);
              }
            }}
          >
            Deploy
          </Button>
        </div>
      </CardBody>
      {canEdit && (
        <CardFooter hint="Branch protection is up to your Git host.">
          <Button size="sm" variant="primary" disabled={!branch.trim() || branch === v.productionBranch} onClick={() => patch({ productionBranch: branch.trim() })}>
            Save
          </Button>
        </CardFooter>
      )}
    </Card>
  );
}

function TokenCard({ v, canEdit, patch }: { v: GitView; canEdit: boolean; patch: (b: Record<string, unknown>, ok?: string) => Promise<boolean> }) {
  const [token, setToken] = useState("");
  const [username, setUsername] = useState(v.git?.tokenUsername ?? "");
  return (
    <Card>
      <CardHeader title="Access Token" description="For private repositories over HTTPS. Use a read-only token; it is stored encrypted and sent only to your Git host." actions={v.git?.hasToken ? <Badge tone="success">Set</Badge> : <Badge tone="outline">Public</Badge>} />
      {canEdit && (
        <>
          <CardBody className="grid gap-3 sm:grid-cols-[1fr_200px]">
            <Field label={v.git?.hasToken ? "Replace token" : "Token"}>
              <Input type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" placeholder="••••••••" />
            </Field>
            <Field label="Username" hint="Optional">
              <Input value={username} onChange={(e) => setUsername(e.target.value)} />
            </Field>
          </CardBody>
          <CardFooter>
            {v.git?.hasToken && (
              <Button size="sm" variant="ghost" onClick={() => patch({ token: null }, "Token removed")}>
                Remove
              </Button>
            )}
            <Button
              size="sm"
              variant="primary"
              disabled={!token}
              onClick={async () => {
                if (await patch({ token, tokenUsername: username || null }, "Token saved")) setToken("");
              }}
            >
              Save
            </Button>
          </CardFooter>
        </>
      )}
    </Card>
  );
}

function DeployKeyCard({ v, projectId, canEdit, reload }: { v: GitView; projectId: string; canEdit: boolean; reload: () => Promise<void> }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  return (
    <Card>
      <CardHeader title="Deploy Key" description="LevantDeploy clones over SSH with this key. Add it to the repository as a read-only deploy key." />
      <CardBody>{v.git?.deployKeyPublic ? <CodeBlock code={v.git.deployKeyPublic} wrap /> : <p className="text-sm text-muted">No key yet.</p>}</CardBody>
      {canEdit && (
        <CardFooter hint="Regenerating invalidates the old key immediately.">
          <Button size="sm" leftIcon={<KeyRound className="h-3.5 w-3.5" />} onClick={() => setOpen(true)}>
            Regenerate
          </Button>
        </CardFooter>
      )}
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Regenerate the deploy key?"
        description="Deployments will fail until you replace the key in your repository's deploy keys."
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={async () => {
                await api(`/api/v1/projects/${projectId}/git/deploy-key`, { method: "POST" }).catch((e) => toast.error("Failed", (e as Error).message));
                setOpen(false);
                await reload();
              }}
            >
              Regenerate
            </Button>
          </>
        }
      />
    </Card>
  );
}

function DeployHooksCard({ hooks, projectId, canEdit, defaultBranch, reload }: { hooks: Hook[]; projectId: string; canEdit: boolean; defaultBranch: string; reload: () => Promise<void> }) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [branch, setBranch] = useState(defaultBranch);
  const [busy, setBusy] = useState(false);
  return (
    <Card>
      <CardHeader title="Deploy Hooks" description="Unique URLs that trigger a deployment of a branch when they receive a POST request (CMS, cron, CI…)." />
      <CardBody className="space-y-4">
        {canEdit && (
          <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <Field label="Name">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. CMS publish" maxLength={60} />
            </Field>
            <Field label="Branch">
              <Input prefix={<GitBranch className="h-4 w-4" />} value={branch} onChange={(e) => setBranch(e.target.value)} />
            </Field>
            <Button
              variant="primary"
              loading={busy}
              disabled={!name.trim() || !branch.trim()}
              leftIcon={<Plus className="h-3.5 w-3.5" />}
              onClick={async () => {
                setBusy(true);
                try {
                  await api(`/api/v1/projects/${projectId}/git/hooks`, { body: { name, branch } });
                  setName("");
                  await reload();
                } catch (e) {
                  toast.error("Could not create the hook", e instanceof ApiClientError ? e.message : undefined);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Create Hook
            </Button>
          </div>
        )}
        {hooks.length === 0 ? (
          <p className="text-[13px] text-muted">No deploy hooks yet.</p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {hooks.map((h) => (
              <li key={h.id} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-sm font-medium text-fg">
                    <Webhook className="h-3.5 w-3.5 text-muted" />
                    {h.name}
                    <Badge tone="outline">{h.branch}</Badge>
                  </div>
                  <div className="mt-1 flex min-w-0 items-center gap-1">
                    <code className="truncate font-mono text-xs text-muted">{h.url}</code>
                    <CopyButton value={h.url} />
                  </div>
                  <div className="text-xs text-subtle">{h.lastTriggeredAt ? `Last triggered ${timeAgo(h.lastTriggeredAt)}` : `Created ${timeAgo(h.createdAt)}`}</div>
                </div>
                {canEdit && (
                  <Button
                    size="sm"
                    variant="ghost"
                    leftIcon={<Trash2 className="h-3.5 w-3.5" />}
                    onClick={async () => {
                      await api(`/api/v1/projects/${projectId}/git/hooks/${h.id}`, { method: "DELETE" }).catch(() => {});
                      await reload();
                    }}
                  >
                    Revoke
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardBody>
      <CardFooter hint={<span className="font-mono text-xs">curl -X POST &lt;hook url&gt;</span>} />
    </Card>
  );
}
