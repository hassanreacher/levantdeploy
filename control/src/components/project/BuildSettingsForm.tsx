"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, FileCode2, FolderTree, Info, RefreshCw, Search, Sparkles } from "lucide-react";
import { Badge, Button, Card, CardBody, CardFooter, CardHeader, CodeBlock, Dialog, Field, Input, Select, Skeleton, Switch, Textarea, useToast } from "@/components/ui";
import { api, ApiClientError } from "@/lib/client/api";
import { cn, formatBytes, formatDuration, timeAgo } from "@/lib/utils";
import { FRAMEWORK_PRESETS, presetById, type BuildSettings, type Detection, type FrameworkPreset } from "@/lib/build/types";

/**
 * Project Settings → Build & Development (build area). Mounted by the settings page:
 *   <BuildSettingsForm projectId={project.id} canEdit={hasRole(role, "MEMBER")} />
 * API: GET/PUT /api/v1/projects/:id/build-settings, POST /api/v1/projects/:id/detect
 */

type View = {
  projectId: string;
  framework: string | null;
  kind: string;
  sourceType: string;
  rootDirectory: string;
  buildSettings: BuildSettings;
  presets: FrameworkPreset[];
  lastBuild: {
    deploymentId: string;
    number: number;
    status: string;
    framework: string | null;
    frameworkName: string | null;
    strategy: string | null;
    imageSize: number | null;
    durationMs: number | null;
    createdAt: string;
  } | null;
};

type Preview = {
  detection: Detection;
  summary: string;
  dockerfile: string | null;
  source: { kind: string; label: string };
  rootDirectories: string[];
};

type CmdKey = "installCommand" | "buildCommand" | "startCommand" | "outputDirectory";
const COMMANDS: { key: CmdKey; label: string; hint: string; mono?: boolean }[] = [
  { key: "installCommand", label: "Install Command", hint: "Runs in the build container before the build (cache mounts keep it fast)." },
  { key: "buildCommand", label: "Build Command", hint: "e.g. `npm run build` — project env vars are available (secrets as BuildKit secrets)." },
  { key: "startCommand", label: "Start Command", hint: "Runs in the final image. Must listen on 0.0.0.0:$PORT." },
  { key: "outputDirectory", label: "Output Directory", hint: "Static sites: the folder served by the built-in static server (SPA fallback)." },
];

const NODE_VERSIONS = ["24", "22", "20", "18"];
const PY_VERSIONS = ["3.13", "3.12", "3.11", "3.10", "3.9"];

const TONES: Record<string, string> = {
  node: "bg-success/10 text-success",
  bun: "bg-warning/10 text-warning",
  deno: "bg-surface-2 text-fg",
  python: "bg-accent/10 text-accent",
  php: "bg-accent/10 text-accent",
  go: "bg-accent/10 text-accent",
  rust: "bg-warning/10 text-warning",
  ruby: "bg-danger/10 text-danger",
  java: "bg-danger/10 text-danger",
  dotnet: "bg-accent/10 text-accent",
  elixir: "bg-accent/10 text-accent",
  static: "bg-surface-2 text-fg",
  docker: "bg-accent/10 text-accent",
};

export function FrameworkGlyph({ preset, className }: { preset: FrameworkPreset | null; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border font-mono text-[11px] font-semibold",
        preset ? TONES[preset.language] : "bg-surface-2 text-muted",
        className,
      )}
    >
      {preset ? preset.glyph : <Sparkles className="h-3.5 w-3.5" />}
    </span>
  );
}

const clean = (s: BuildSettings): BuildSettings => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s)) if (v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && !v.length)) out[k] = v;
  return out as BuildSettings;
};

export function BuildSettingsForm({ projectId, canEdit = true }: { projectId: string; canEdit?: boolean }) {
  const toast = useToast();
  const [view, setView] = useState<View | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<BuildSettings>({});
  const [root, setRoot] = useState("");
  const [saving, setSaving] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [detectError, setDetectError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [dockerfileOpen, setDockerfileOpen] = useState(false);
  const [pkgText, setPkgText] = useState("");

  const load = useCallback(async () => {
    try {
      const v = await api<View>(`/api/v1/projects/${projectId}/build-settings`);
      setView(v);
      setForm(v.buildSettings);
      setRoot(v.rootDirectory);
      setPkgText((v.buildSettings.systemPackages ?? []).join(" "));
    } catch (e) {
      setLoadError(e instanceof ApiClientError ? e.message : "Could not load build settings");
    }
  }, [projectId]);

  const runDetect = useCallback(
    async (settings?: BuildSettings, rootDirectory?: string) => {
      setDetecting(true);
      setDetectError(null);
      try {
        setPreview(await api<Preview>(`/api/v1/projects/${projectId}/detect`, { method: "POST", body: { buildSettings: settings ? clean(settings) : undefined, rootDirectory } }));
      } catch (e) {
        setDetectError(e instanceof ApiClientError ? e.message : "Detection failed");
      } finally {
        setDetecting(false);
      }
    },
    [projectId],
  );

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (view) void runDetect(); // detected defaults for the placeholders
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view?.projectId]);

  const saved = view?.buildSettings ?? {};
  const dirty = useMemo(() => JSON.stringify(clean(form)) !== JSON.stringify(clean(saved)) || root !== (view?.rootDirectory ?? ""), [form, saved, root, view]);
  const det = preview?.detection;
  const preset = presetById(form.framework ?? null);
  const autoPreset = det ? presetById(det.framework) : null;
  const language = (preset ?? autoPreset)?.language ?? det?.language ?? null;

  async function save(section: string) {
    setSaving(section);
    try {
      const v = await api<View>(`/api/v1/projects/${projectId}/build-settings`, { method: "PUT", body: { rootDirectory: root, buildSettings: clean(form) } });
      setView(v);
      setForm(v.buildSettings);
      setRoot(v.rootDirectory);
      toast.success("Build settings saved — they apply to the next deployment");
      void runDetect(v.buildSettings, v.rootDirectory);
    } catch (e) {
      const msg = e instanceof ApiClientError ? (e.fields ? Object.entries(e.fields).map(([k, m]) => `${k.replace(/^buildSettings\./, "")}: ${m}`).join(", ") : e.message) : "Save failed";
      toast.error(msg);
    } finally {
      setSaving(null);
    }
  }

  const set = <K extends keyof BuildSettings>(k: K, v: BuildSettings[K]) => setForm((f) => ({ ...f, [k]: v }));

  if (loadError) return <Card><CardBody className="text-sm text-danger">{loadError}</CardBody></Card>;
  if (!view)
    return (
      <div className="space-y-4">
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-72 w-full" />
      </div>
    );

  const footer = (section: string, hint: React.ReactNode) => (
    <CardFooter hint={hint}>
      {canEdit && (
        <Button variant="primary" size="sm" disabled={!dirty} loading={saving === section} onClick={() => save(section)}>
          Save
        </Button>
      )}
    </CardFooter>
  );

  return (
    <div className="space-y-6">
      {/* ── Framework preset ── */}
      <Card>
        <CardHeader
          title="Framework Preset"
          description="Detected automatically from your repository on every build. Pick a preset to force it."
          actions={
            <Button variant="ghost" size="sm" leftIcon={<RefreshCw className={cn("h-3.5 w-3.5", detecting && "animate-spin")} />} onClick={() => runDetect(form, root)} disabled={detecting}>
              Re-detect
            </Button>
          }
        />
        <CardBody className="space-y-4">
          <button
            type="button"
            disabled={!canEdit}
            onClick={() => setPickerOpen(true)}
            className="flex w-full items-center gap-3 rounded-md border border-border bg-bg px-3 py-2 text-left transition-colors hover:border-border-strong disabled:opacity-60 sm:max-w-md"
          >
            <FrameworkGlyph preset={preset} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{preset ? preset.name : "Auto-detect"}</span>
              <span className="block truncate text-xs text-muted">
                {preset ? `${preset.kind.toLowerCase()} · default port ${preset.port}` : det ? `Currently detected: ${det.frameworkName}` : "Detecting…"}
              </span>
            </span>
            <ChevronDown className="h-4 w-4 text-muted" />
          </button>
          <DetectionSummary preview={preview} detecting={detecting} error={detectError} onShowDockerfile={() => setDockerfileOpen(true)} />
        </CardBody>
        {footer("framework", view.lastBuild ? <LastBuild b={view.lastBuild} /> : "No build yet.")}
      </Card>

      {/* ── Build & output commands ── */}
      <Card>
        <CardHeader title="Build & Output Settings" description="Toggle Override to replace the detected command." />
        <CardBody className="divide-y divide-border p-0">
          {COMMANDS.map((c) => {
            const on = form[c.key] != null && form[c.key] !== undefined;
            const detected = det?.[c.key] ?? null;
            const disabledForStrategy = det && det.strategy !== "generated";
            return (
              <div key={c.key} className="px-5 py-4">
                <div className="mb-1.5 flex items-center justify-between gap-3">
                  <label htmlFor={`bs-${c.key}`} className="text-[13px] font-medium text-muted">
                    {c.label}
                  </label>
                  <span className="flex items-center gap-2 text-xs text-muted">
                    Override
                    <Switch
                      size="sm"
                      label={`Override ${c.label}`}
                      checked={on}
                      disabled={!canEdit}
                      onCheckedChange={(v) => set(c.key, v ? (detected ?? "") : null)}
                    />
                  </span>
                </div>
                <Input
                  id={`bs-${c.key}`}
                  className="font-mono text-[13px]"
                  disabled={!canEdit || !on}
                  value={on ? (form[c.key] ?? "") : ""}
                  placeholder={detected ?? (detecting ? "detecting…" : "none")}
                  onChange={(e) => set(c.key, e.target.value)}
                />
                <p className="mt-1.5 text-xs text-subtle">{disabledForStrategy ? "Not used: this project builds from its own Dockerfile / compose file." : c.hint}</p>
              </div>
            );
          })}
        </CardBody>
        {footer("commands", "Changes apply to the next deployment.")}
      </Card>

      {/* ── Root directory ── */}
      <Card>
        <CardHeader title="Root Directory" description="The directory inside the repository that contains your app (monorepos). Workspace lockfiles at the repository root are used automatically." />
        <CardBody className="space-y-3">
          <Input prefix={<FolderTree className="h-3.5 w-3.5" />} className="font-mono text-[13px] sm:max-w-md" placeholder="./ (repository root)" value={root} disabled={!canEdit} onChange={(e) => setRoot(e.target.value)} />
          {!!preview?.rootDirectories.length && (
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
              <span>Apps found:</span>
              {preview.rootDirectories.slice(0, 12).map((d) => (
                <button key={d} type="button" disabled={!canEdit} onClick={() => setRoot(d)} className={cn("rounded border border-border px-1.5 py-0.5 font-mono hover:border-border-strong", root === d && "border-accent text-accent")}>
                  {d}
                </button>
              ))}
            </div>
          )}
        </CardBody>
        {footer("root", "Leave empty for the repository root.")}
      </Card>

      {/* ── Docker ── */}
      <Card>
        <CardHeader title="Dockerfile & Compose" description="A Dockerfile in the root directory is used as-is. Point to another file, or to a compose file to deploy a multi-service stack." />
        <CardBody className="grid gap-4 sm:grid-cols-2">
          <Field label="Dockerfile path" hint="Relative to the root directory. Setting it forces the Dockerfile build.">
            <Input className="font-mono text-[13px]" placeholder="Dockerfile" value={form.dockerfilePath ?? ""} disabled={!canEdit} onChange={(e) => set("dockerfilePath", e.target.value || null)} />
          </Field>
          <Field label="Docker build target" hint="Optional multi-stage target (--target).">
            <Input className="font-mono text-[13px]" placeholder="(last stage)" value={form.dockerTarget ?? ""} disabled={!canEdit} onChange={(e) => set("dockerTarget", e.target.value || null)} />
          </Field>
          <Field label="Compose file" hint="compose.yaml / docker-compose.yml — services with build: are built, others pulled.">
            <Input className="font-mono text-[13px]" placeholder="compose.yaml" value={form.composeFile ?? ""} disabled={!canEdit} onChange={(e) => set("composeFile", e.target.value || null)} />
          </Field>
        </CardBody>
        {footer("docker", <span className="inline-flex items-center gap-1.5"><FileCode2 className="h-3.5 w-3.5" /> Proxy build args are passed to custom Dockerfiles when the platform build proxy is on.</span>)}
      </Card>

      {/* ── Versions ── */}
      <Card>
        <CardHeader title="Runtime Versions" description="Detected from .nvmrc / engines / runtime.txt / .python-version / pyproject when left on Auto." />
        <CardBody className="grid gap-4 sm:grid-cols-3">
          <Field label="Node.js version" hint={det?.nodeVersion ? `Detected: ${det.nodeVersion}` : undefined}>
            <Select
              value={form.nodeVersion ?? ""}
              disabled={!canEdit}
              onChange={(e) => set("nodeVersion", e.target.value || null)}
              options={[{ value: "", label: "Auto" }, ...NODE_VERSIONS.map((v) => ({ value: v, label: `${v}.x` }))]}
            />
          </Field>
          <Field label="Package manager" hint={det?.packageManager ? `Detected: ${det.packageManager}` : undefined}>
            <Select
              value={form.packageManager ?? ""}
              disabled={!canEdit || (language !== null && language !== "node")}
              onChange={(e) => set("packageManager", (e.target.value || null) as BuildSettings["packageManager"])}
              options={[{ value: "", label: "Auto (lockfile)" }, { value: "npm", label: "npm" }, { value: "pnpm", label: "pnpm" }, { value: "yarn", label: "yarn" }, { value: "bun", label: "bun" }]}
            />
          </Field>
          <Field label="Python version" hint={det?.pythonVersion ? `Detected: ${det.pythonVersion}` : undefined}>
            <Select
              value={form.pythonVersion ?? ""}
              disabled={!canEdit}
              onChange={(e) => set("pythonVersion", e.target.value || null)}
              options={[{ value: "", label: "Auto" }, ...PY_VERSIONS.map((v) => ({ value: v, label: v }))]}
            />
          </Field>
          <div className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2 sm:col-span-3">
            <div>
              <p className="text-sm font-medium">SPA fallback</p>
              <p className="text-xs text-muted">Static sites: serve index.html for unknown paths (client-side routing). Auto = on for Vite/CRA/Angular/Vue.</p>
            </div>
            <Select
              className="w-28"
              value={form.spaFallback == null ? "" : form.spaFallback ? "on" : "off"}
              disabled={!canEdit}
              onChange={(e) => set("spaFallback", e.target.value === "" ? null : e.target.value === "on")}
              options={[{ value: "", label: "Auto" }, { value: "on", label: "On" }, { value: "off", label: "Off" }]}
            />
          </div>
        </CardBody>
        {footer("versions", "Images listen on $PORT; the runtime sets it to the project port.")}
      </Card>

      {/* ── Advanced ── */}
      <Card>
        <CardHeader title="Advanced" description="Escape hatches for builds the templates don't cover." />
        <CardBody className="space-y-5">
          <Field
            label="System packages"
            hint="Space-separated OS packages installed in the build and runtime stages of generated Dockerfiles (apt on Debian/Ubuntu images, apk on Alpine), e.g. native-extension headers like libpq-dev or build-base."
          >
            <Input
              className="font-mono text-[13px]"
              placeholder="e.g. libvips-dev ffmpeg"
              value={pkgText}
              disabled={!canEdit}
              onChange={(e) => {
                setPkgText(e.target.value);
                const list = e.target.value.split(/[\s,]+/).filter(Boolean);
                set("systemPackages", list.length ? list : null);
              }}
            />
          </Field>
          <Field
            label="Inline Dockerfile"
            hint={`Takes precedence over the repository Dockerfile and the generated one. Build context = root directory. ${(form.dockerfileInline ?? "").length.toLocaleString()} / 65,536 characters.`}
            error={(form.dockerfileInline ?? "").length > 65536 ? "Inline Dockerfile must be 64 KB or less" : null}
          >
            <Textarea
              className="min-h-[180px] font-mono text-[12.5px]"
              spellCheck={false}
              placeholder={"FROM node:22-alpine\nWORKDIR /app\nCOPY . .\nRUN npm ci && npm run build\nCMD [\"npm\", \"start\"]"}
              value={form.dockerfileInline ?? ""}
              disabled={!canEdit}
              onChange={(e) => set("dockerfileInline", e.target.value || null)}
            />
          </Field>
        </CardBody>
        {footer("advanced", "Leave empty to use the repository Dockerfile or the generated template.")}
      </Card>

      <PresetPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        value={form.framework ?? null}
        detected={det?.framework ?? null}
        onPick={(id) => {
          set("framework", id);
          setPickerOpen(false);
        }}
      />
      <Dialog open={dockerfileOpen} onClose={() => setDockerfileOpen(false)} size="lg" title={det?.strategy === "dockerfile" ? "Repository Dockerfile" : "Generated Dockerfile"} description={preview?.summary}>
        {preview?.dockerfile ? <CodeBlock code={preview.dockerfile} className="max-h-[60vh] overflow-auto" /> : <p className="text-sm text-muted">No Dockerfile for this strategy.</p>}
      </Dialog>
    </div>
  );
}

function LastBuild({ b }: { b: NonNullable<View["lastBuild"]> }) {
  return (
    <span>
      Last build #{b.number}: {b.frameworkName ?? b.framework ?? "?"}
      {b.durationMs ? ` · ${formatDuration(b.durationMs)}` : ""}
      {b.imageSize ? ` · ${formatBytes(b.imageSize)}` : ""} · {timeAgo(b.createdAt)}
    </span>
  );
}

function DetectionSummary({ preview, detecting, error, onShowDockerfile }: { preview: Preview | null; detecting: boolean; error: string | null; onShowDockerfile: () => void }) {
  if (error)
    return (
      <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-[13px] text-warning">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>{error}</span>
      </div>
    );
  if (!preview) return detecting ? <Skeleton className="h-16 w-full" /> : null;
  const d = preview.detection;
  const p = presetById(d.framework);
  return (
    <div className={cn("rounded-md border border-border bg-bg-subtle p-3 text-[13px]", detecting && "opacity-60")}>
      <div className="flex flex-wrap items-center gap-2">
        <FrameworkGlyph preset={p} className="h-6 w-6 text-[10px]" />
        <span className="font-medium text-fg">{preview.summary}</span>
        <Badge tone="outline">{d.strategy === "generated" ? "generated Dockerfile" : d.strategy}</Badge>
        {d.overridden.length > 0 && <Badge tone="accent">{d.overridden.length} override{d.overridden.length > 1 ? "s" : ""}</Badge>}
      </div>
      <p className="mt-1.5 truncate text-xs text-muted">Source: {preview.source.label}</p>
      {d.notes.length > 0 && (
        <ul className="mt-2 space-y-1 text-xs text-muted">
          {d.notes.map((n) => (
            <li key={n} className="flex gap-1.5">
              <Info className="mt-0.5 h-3 w-3 shrink-0" />
              {n}
            </li>
          ))}
        </ul>
      )}
      {preview.dockerfile && (
        <button type="button" onClick={onShowDockerfile} className="mt-2 text-xs font-medium text-accent hover:underline">
          View {d.strategy === "dockerfile" ? "Dockerfile" : "generated Dockerfile"}
        </button>
      )}
    </div>
  );
}

function PresetPicker({ open, onClose, value, detected, onPick }: { open: boolean; onClose: () => void; value: string | null; detected: string | null; onPick: (id: string | null) => void }) {
  const [q, setQ] = useState("");
  const list = FRAMEWORK_PRESETS.filter((p) => !q || `${p.name} ${p.language} ${p.id}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <Dialog open={open} onClose={onClose} title="Framework Preset" description="Auto-detect is recommended — presets force a template." size="lg">
      <Input autoFocus prefix={<Search className="h-3.5 w-3.5" />} placeholder="Search frameworks…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="mt-3 grid max-h-[55vh] grid-cols-1 gap-1.5 overflow-y-auto sm:grid-cols-2">
        {!q && (
          <PresetRow name="Auto-detect" sub={detected ? `currently ${presetById(detected)?.name ?? detected}` : "recommended"} preset={null} active={value === null} onClick={() => onPick(null)} />
        )}
        {list.map((p) => (
          <PresetRow key={p.id} name={p.name} sub={`${p.kind.toLowerCase()} · port ${p.port}${p.id === detected ? " · detected" : ""}`} preset={p} active={value === p.id} onClick={() => onPick(p.id)} />
        ))}
      </div>
    </Dialog>
  );
}

function PresetRow({ name, sub, preset, active, onClick }: { name: string; sub: string; preset: FrameworkPreset | null; active: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={cn("flex items-center gap-3 rounded-md border px-3 py-2 text-left transition-colors hover:bg-surface-2", active ? "border-accent" : "border-border")}>
      <FrameworkGlyph preset={preset} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{name}</span>
        <span className="block truncate text-xs text-muted">{sub}</span>
      </span>
      {active && <Check className="h-4 w-4 text-accent" />}
    </button>
  );
}
