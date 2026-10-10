"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, ChevronRight, Container, FolderGit2, Github, GitBranch, LayoutTemplate, Lock, UploadCloud } from "lucide-react";
import { Badge, Button, Card, CardBody, CardHeader, Field, Input, Select, Spinner, Switch, useToast } from "@/components/ui";
import { FRAMEWORK_PRESETS, presetById } from "@/lib/build/types";
import { api, ApiClientError } from "@/lib/client/api";
import { cn, formatBytes } from "@/lib/utils";
import { EnvEditor, type EnvRow } from "./env-editor";
import type { Detection, Selection } from "./types";

type CreateResponse = { project: { id: string; slug: string }; deployment: { id: string } | null; urls: { dashboard: string; deployment: string | null } };

function defaultName(s: Selection) {
  switch (s.kind) {
    case "github":
      return s.repo.fullName.split("/")[1]!;
    case "git":
      return s.name;
    case "upload":
      return s.label.replace(/\.(zip|tgz|tar\.gz|tar)$/i, "");
    case "image":
      return s.image.split("/").pop()!.split(/[:@]/)[0]!;
    case "template":
      return s.template.name;
  }
}

const slugPreview = (n: string) =>
  n
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

export function ConfigureProject({ team, selection, onBack }: { team: { slug: string; name: string }; selection: Selection; onBack: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [name, setName] = useState(slugPreview(defaultName(selection)) || "my-app");
  const [rootDirectory, setRootDirectory] = useState("");
  const [detection, setDetection] = useState<Detection | null>(selection.kind === "git" ? selection.detection : null);
  const [detecting, setDetecting] = useState(false);
  const [framework, setFramework] = useState<string>(
    selection.kind === "template" ? selection.template.framework : selection.kind === "git" ? (selection.detection?.framework ?? "auto") : "auto",
  );
  const [touchedFramework, setTouchedFramework] = useState(false);
  const [branch, setBranch] = useState(selection.kind === "github" ? selection.repo.defaultBranch : selection.kind === "git" ? (selection.defaultBranch ?? selection.branches[0] ?? "main") : "main");
  const [build, setBuild] = useState({ installCommand: "", buildCommand: "", startCommand: "", outputDirectory: "" });
  const [port, setPort] = useState(selection.kind === "image" ? String(selection.port) : "");
  const [env, setEnv] = useState<EnvRow[]>([]);
  const [polling, setPolling] = useState(true);
  const [showBuild, setShowBuild] = useState(false);
  const [showEnv, setShowEnv] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  // GitHub repos: detect on open and when the root directory changes
  useEffect(() => {
    if (selection.kind !== "github") return;
    const ctl = new AbortController();
    const t = setTimeout(async () => {
      setDetecting(true);
      try {
        const qs = new URLSearchParams({ team: team.slug, installationId: String(selection.installationId), repo: selection.repo.fullName, branch, rootDirectory });
        const r = await api<{ detection: Detection }>(`/api/v1/github/repos/detect?${qs}`, { signal: ctl.signal });
        setDetection(r.detection);
        if (!touchedFramework) setFramework(r.detection.framework);
      } catch {
        /* keep auto */
      } finally {
        setDetecting(false);
      }
    }, 400);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [selection, rootDirectory, branch, team.slug, touchedFramework]);

  const preset = presetById(framework);
  const placeholders = {
    installCommand: detection?.installCommand ?? "auto-detected",
    buildCommand: detection?.buildCommand ?? "auto-detected",
    startCommand: detection?.startCommand ?? "auto-detected",
    outputDirectory: detection?.outputDirectory ?? "auto-detected",
  };
  const canPickRoot = selection.kind === "github" || selection.kind === "git";
  const frameworkOptions = useMemo(
    () => [{ value: "auto", label: "Auto-detect at build time" }, ...FRAMEWORK_PRESETS.map((p) => ({ value: p.id, label: p.name })), ...(detection?.framework === "image" ? [{ value: "image", label: "Docker image" }] : [])],
    [detection],
  );

  async function deploy() {
    setBusy(true);
    setErrors({});
    const source =
      selection.kind === "github"
        ? { type: "github", installationId: selection.installationId, repoId: selection.repo.id }
        : selection.kind === "git"
          ? { type: "git", url: selection.url, token: selection.token, tokenUsername: selection.tokenUsername, deployKeyId: selection.deployKeyId, polling }
          : selection.kind === "upload"
            ? { type: "upload", uploadId: selection.uploadId }
            : selection.kind === "image"
              ? { type: "image", image: selection.image }
              : { type: "template", template: selection.template.id };
    const buildSettings = Object.fromEntries(Object.entries(build).filter(([, v]) => v.trim()).map(([k, v]) => [k, v.trim()]));
    try {
      const r = await api<CreateResponse>("/api/v1/projects", {
        body: {
          team: team.slug,
          name,
          framework: framework === "auto" || framework === "image" ? null : framework,
          rootDirectory,
          productionBranch: selection.kind === "github" || selection.kind === "git" ? branch : undefined,
          buildSettings,
          port: port ? Number(port) : undefined,
          env: env.filter((e) => e.key),
          source,
        },
      });
      toast.success("Project created", r.deployment ? "Your first deployment is on its way." : undefined);
      router.push(new URL(r.urls.deployment ?? r.urls.dashboard).pathname);
    } catch (e) {
      if (e instanceof ApiClientError) {
        setErrors(e.fields ?? {});
        toast.error("Could not create the project", e.message);
      }
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[300px_1fr]">
      <aside className="space-y-4">
        <Button variant="ghost" size="sm" leftIcon={<ArrowLeft className="h-3.5 w-3.5" />} onClick={onBack} className="-ml-2">
          Back
        </Button>
        <SourceSummary selection={selection} branch={branch} />
        {detection && (
          <div className="rounded-lg border border-border p-4 text-[13px]">
            <div className="mb-1 text-muted">Detected</div>
            <div className="font-medium text-fg">{detection.frameworkName}</div>
            {detection.notes.slice(0, 3).map((n, i) => (
              <p key={i} className="mt-1 text-xs text-subtle">
                {n}
              </p>
            ))}
          </div>
        )}
      </aside>

      <Card>
        <CardHeader title="Configure Project" description={`Deploying to ${team.name}`} />
        <CardBody className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Project Name" htmlFor="p-name" error={errors.name} hint={`URL: ${slugPreview(name) || "…"}.<your domain>`}>
              <Input id="p-name" value={name} onChange={(e) => setName(e.target.value)} invalid={!!errors.name} maxLength={100} />
            </Field>
            {selection.kind !== "image" && (
              <Field label={<span className="inline-flex items-center gap-2">Framework Preset {detecting && <Spinner className="h-3 w-3" />}</span>} htmlFor="p-fw" error={errors.framework}>
                <Select
                  id="p-fw"
                  value={framework}
                  onChange={(e) => {
                    setTouchedFramework(true);
                    setFramework(e.target.value);
                  }}
                  options={frameworkOptions}
                />
              </Field>
            )}
            {(selection.kind === "github" || selection.kind === "git") && (
              <Field label="Production Branch" htmlFor="p-branch" error={errors.productionBranch}>
                {selection.kind === "git" && selection.branches.length ? (
                  <Select id="p-branch" value={branch} onChange={(e) => setBranch(e.target.value)} options={selection.branches.map((b) => ({ value: b, label: b }))} />
                ) : (
                  <Input id="p-branch" prefix={<GitBranch className="h-4 w-4" />} value={branch} onChange={(e) => setBranch(e.target.value)} />
                )}
              </Field>
            )}
            {canPickRoot && (
              <Field label="Root Directory" htmlFor="p-root" error={errors.rootDirectory} hint="The folder with your app's code (monorepos).">
                <Input id="p-root" prefix="./" value={rootDirectory} onChange={(e) => setRootDirectory(e.target.value.replace(/^\.?\/+/, ""))} list="p-root-list" placeholder="" />
                <datalist id="p-root-list">
                  {(detection?.rootDirectories ?? []).map((d) => (
                    <option key={d} value={d} />
                  ))}
                </datalist>
              </Field>
            )}
          </div>

          {selection.kind !== "image" && (
            <Section title="Build and Output Settings" open={showBuild} onToggle={() => setShowBuild(!showBuild)}>
              <div className="grid gap-3 sm:grid-cols-2">
                {(["installCommand", "buildCommand", "startCommand", "outputDirectory"] as const).map((k) => (
                  <Field key={k} label={{ installCommand: "Install Command", buildCommand: "Build Command", startCommand: "Start Command", outputDirectory: "Output Directory" }[k]} error={errors[`buildSettings.${k}`]}>
                    <Input className="font-mono text-[13px]" placeholder={placeholders[k]} value={build[k]} onChange={(e) => setBuild({ ...build, [k]: e.target.value })} />
                  </Field>
                ))}
                <Field label="Port" hint={`Default ${preset?.port ?? detection?.port ?? 3000} — the app must listen on $PORT`}>
                  <Input inputMode="numeric" value={port} placeholder={String(preset?.port ?? detection?.port ?? 3000)} onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))} />
                </Field>
              </div>
              <p className="mt-2 text-xs text-subtle">Leave empty to use what the build detects. A Dockerfile or docker-compose file in the repository always wins.</p>
            </Section>
          )}

          <Section title="Environment Variables" open={showEnv} onToggle={() => setShowEnv(!showEnv)} badge={env.filter((e) => e.key).length || undefined}>
            <EnvEditor rows={env} onChange={setEnv} />
          </Section>

          {selection.kind === "git" && (
            <div className="flex items-center justify-between gap-4 rounded-lg border border-border p-4">
              <div>
                <div className="text-sm font-medium text-fg">Auto-deploy on new commits</div>
                <p className="text-[13px] text-muted">Checks the repository every 2 minutes (or use a deploy hook / webhook from your Git host).</p>
              </div>
              <Switch checked={polling} onCheckedChange={setPolling} label="Auto-deploy" />
            </div>
          )}

          <Button variant="primary" size="lg" className="w-full" loading={busy} disabled={!name.trim()} onClick={deploy}>
            Deploy
          </Button>
        </CardBody>
      </Card>
    </div>
  );
}

function Section({ title, open, onToggle, badge, children }: { title: string; open: boolean; onToggle: () => void; badge?: number; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border">
      <button type="button" onClick={onToggle} className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-medium text-fg" aria-expanded={open}>
        <ChevronRight className={cn("h-4 w-4 text-muted transition-transform", open && "rotate-90")} />
        {title}
        {badge ? <Badge tone="neutral">{badge}</Badge> : null}
      </button>
      {open && <div className="border-t border-border p-4">{children}</div>}
    </div>
  );
}

function SourceSummary({ selection, branch }: { selection: Selection; branch: string }) {
  const row = (icon: React.ReactNode, title: React.ReactNode, sub?: React.ReactNode) => (
    <div className="rounded-lg border border-border p-4">
      <div className="mb-1 text-[13px] text-muted">Importing from</div>
      <div className="flex items-center gap-2 text-sm font-medium text-fg">
        {icon}
        <span className="min-w-0 truncate">{title}</span>
      </div>
      {sub && <div className="mt-2 flex items-center gap-1.5 font-mono text-xs text-muted">{sub}</div>}
    </div>
  );
  switch (selection.kind) {
    case "github":
      return row(<Github className="h-4 w-4 shrink-0" />, <>{selection.repo.fullName} {selection.repo.private && <Lock className="ml-1 inline h-3 w-3 text-muted" />}</>, <><GitBranch className="h-3.5 w-3.5" />{branch}</>);
    case "git":
      return row(<FolderGit2 className="h-4 w-4 shrink-0" />, selection.url, <><GitBranch className="h-3.5 w-3.5" />{branch}</>);
    case "upload":
      return row(<UploadCloud className="h-4 w-4 shrink-0" />, selection.label, <>{formatBytes(selection.size)}{selection.files ? ` · ${selection.files} files` : ""}</>);
    case "image":
      return row(<Container className="h-4 w-4 shrink-0" />, selection.image);
    case "template":
      return row(<LayoutTemplate className="h-4 w-4 shrink-0" />, selection.template.name, selection.template.frameworkName);
  }
}
