"use client";

import { useState } from "react";
import { ArrowUpCircle, CheckCircle2, RefreshCw, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/input";
import { CodeBlock } from "@/components/ui/code-block";
import { api } from "@/lib/client/api";
import { timeAgo } from "@/lib/utils";
import type { UpdateInfo } from "@/lib/ops/version";
import { errText, usePlatformPatch } from "../save-helper";

export function UpdatesSettings(props: { version: string; update: UpdateInfo | null; checkUrl: string | null; envUrl: string | null; installDir: string }) {
  const { busy, setBusy, patch, toast } = usePlatformPatch();
  const [update, setUpdate] = useState(props.update);
  const [url, setUrl] = useState(props.checkUrl ?? "");

  const check = async () => {
    setBusy("check");
    try {
      const r = await api<{ update: UpdateInfo }>("/api/v1/platform/updates?refresh=1");
      setUpdate(r.update);
      if (r.update.error) toast.error("Update check failed", r.update.error);
      else toast.success(r.update.available ? `Version ${r.update.latest} is available` : "You're up to date");
    } catch (e) {
      toast.error("Update check failed", errText(e));
    } finally {
      setBusy(null);
    }
  };

  const status = !update?.source ? (
    <Badge tone="neutral">No update source</Badge>
  ) : update.error ? (
    <Badge tone="warning" icon={<AlertTriangle className="h-3 w-3" />}>
      Check failed
    </Badge>
  ) : update.available ? (
    <Badge tone="accent" icon={<ArrowUpCircle className="h-3 w-3" />}>
      Update available
    </Badge>
  ) : (
    <Badge tone="success" icon={<CheckCircle2 className="h-3 w-3" />}>
      Up to date
    </Badge>
  );

  return (
    <>
      <Card>
        <CardHeader title="Version" description="The LevantDeploy release running on this server." actions={status} />
        <CardBody className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-md border border-border bg-bg-subtle px-4 py-3">
            <p className="text-[12px] text-muted">Installed</p>
            <p className="mt-0.5 font-mono text-xl font-semibold">{props.version}</p>
          </div>
          <div className={update?.available ? "rounded-md border border-accent/40 bg-accent/10 px-4 py-3" : "rounded-md border border-border bg-bg-subtle px-4 py-3"}>
            <p className="text-[12px] text-muted">Latest</p>
            <p className="mt-0.5 font-mono text-xl font-semibold">{update?.latest ?? "—"}</p>
          </div>
          {update?.available && update.notes && (
            <div className="sm:col-span-2">
              <p className="mb-1.5 text-[13px] font-medium">Release notes</p>
              <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-bg-subtle p-3 text-[13px] text-muted">{update.notes}</pre>
            </div>
          )}
          {update?.available && update.url && (
            <a href={update.url} target="_blank" rel="noreferrer" className="link text-sm sm:col-span-2">
              View release →
            </a>
          )}
        </CardBody>
        <CardFooter hint={update?.checkedAt ? `Checked ${timeAgo(update.checkedAt)}${update.error ? ` · ${update.error}` : ""}` : "Not checked yet."}>
          <Button size="sm" variant="secondary" leftIcon={<RefreshCw className="h-3.5 w-3.5" />} loading={busy === "check"} disabled={!update?.source} onClick={check}>
            Check now
          </Button>
        </CardFooter>
      </Card>

      <Card>
        <CardHeader title="Install an Update" description="Updates pull the new images (or rebuild from source), apply database migrations and restart the stack. Deployed apps keep running." />
        <CardBody className="space-y-3">
          <CodeBlock prompt code={`sudo ${props.installDir}/install/update.sh`} />
          <p className="text-[13px] text-muted">A database backup is taken automatically before the update. Downtime of the dashboard is usually under a minute.</p>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Update Source" description="URL of a version file: JSON like {&quot;version&quot;:&quot;1.2.0&quot;,&quot;notes&quot;:&quot;…&quot;}, a GitHub latest-release API URL, or plain text." />
        <CardBody>
          <Field label="Version URL" htmlFor="update-url" hint={props.envUrl ? `Empty = LEVANT_UPDATE_URL from .env (${props.envUrl})` : "Checked every 12 hours by the worker."}>
            <Input
              id="update-url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://api.github.com/repos/<owner>/levantdeploy/releases/latest"
              className="font-mono"
            />
          </Field>
        </CardBody>
        <CardFooter>
          <Button size="sm" variant="primary" disabled={url === (props.checkUrl ?? "")} loading={busy === "url"} onClick={() => patch("url", { updateUrl: url.trim() || null })}>
            Save
          </Button>
        </CardFooter>
      </Card>
    </>
  );
}
