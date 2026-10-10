"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Download, Gauge, Github, Palette, BookOpen, Settings2, Trash2, Zap, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { builderApi } from "@/lib/builder-ui/api";
import type { BuilderSettings, Quality } from "@/lib/builder-ui/types";
import { errMessage, useEditor } from "./context";
import { Sheet } from "./sheet";

type Tab = "general" | "knowledge" | "theme" | "ai" | "export" | "danger";
const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: "general", label: "General", icon: <Settings2 className="h-3.5 w-3.5" /> },
  { id: "knowledge", label: "Knowledge", icon: <BookOpen className="h-3.5 w-3.5" /> },
  { id: "theme", label: "Theme", icon: <Palette className="h-3.5 w-3.5" /> },
  { id: "ai", label: "AI quality", icon: <Gauge className="h-3.5 w-3.5" /> },
  { id: "export", label: "Export", icon: <Download className="h-3.5 w-3.5" /> },
  { id: "danger", label: "Delete", icon: <Trash2 className="h-3.5 w-3.5" /> },
];

export const QUALITY: { id: Quality; label: string; hint: string; icon: React.ReactNode }[] = [
  { id: "fast", label: "Fast", hint: "Quick, low-cost models. Great for small tweaks and copy changes.", icon: <Zap className="h-4 w-4" /> },
  { id: "balanced", label: "Balanced", hint: "Smart models for planning and code, fast ones for chat. Recommended.", icon: <Gauge className="h-4 w-4" /> },
  { id: "best", label: "Best", hint: "Best-of-N: several providers write candidates and a judge picks the best one. Slower.", icon: <Sparkles className="h-4 w-4" /> },
];

const FONTS = ["Inter", "Geist", "Manrope", "Plus Jakarta Sans", "DM Sans", "Playfair Display", "IBM Plex Sans Arabic", "Cairo", "Tajawal"];
const RADII = [
  { v: "0rem", l: "Sharp" },
  { v: "0.375rem", l: "Small" },
  { v: "0.75rem", l: "Medium" },
  { v: "1.25rem", l: "Large" },
];

export function SettingsDialog() {
  const ed = useEditor();
  const toast = useToast();
  const router = useRouter();
  const open = ed.panel === "settings";
  const p = ed.project;
  const [tab, setTab] = useState<Tab>("general");
  const [name, setName] = useState(p.name);
  const [description, setDescription] = useState(p.description ?? "");
  const [s, setS] = useState<BuilderSettings>(p.settings ?? {});
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [gh, setGh] = useState({ repo: p.name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, ""), private: true });
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(p.name);
    setDescription(p.description ?? "");
    setS(p.settings ?? {});
    setConfirm("");
  }, [open, p]);

  const save = async (patch: { name?: string; description?: string; settings?: Partial<BuilderSettings> }, msg = "Saved") => {
    setSaving(true);
    try {
      ed.setProject(await builderApi().updateProject(p.id, patch));
      toast.success(msg);
    } catch (e) {
      toast.error("Could not save", errMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const del = async () => {
    setDeleting(true);
    try {
      await builderApi().deleteProject(p.id, confirm);
      toast.success("App deleted");
      router.push(`/${ed.team}/build`);
    } catch (e) {
      toast.error("Could not delete", errMessage(e));
      setDeleting(false);
    }
  };

  const exportGithub = async () => {
    setExporting(true);
    try {
      const r = await builderApi().exportGithub(p.id, gh);
      toast.success("Exported to GitHub", r.repo);
      window.open(r.url, "_blank", "noopener");
    } catch (e) {
      toast.error("Export failed", errMessage(e));
    } finally {
      setExporting(false);
    }
  };

  const theme = s.theme ?? {};
  const setTheme = (t: Partial<NonNullable<BuilderSettings["theme"]>>) => setS((x) => ({ ...x, theme: { ...(x.theme ?? {}), ...t } }));

  return (
    <Sheet open={open} onClose={() => ed.setPanel(null)} title="Settings" description={p.name} width={640}>
      <div className="flex flex-col gap-5 sm:flex-row" data-testid="settings-dialog">
        <nav className="-mx-1 flex shrink-0 gap-1 overflow-x-auto sm:mx-0 sm:w-36 sm:flex-col" aria-label="Settings sections">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              aria-current={tab === t.id}
              className={cn("flex shrink-0 items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors", tab === t.id ? "bg-surface-2 text-fg" : "text-muted hover:text-fg", t.id === "danger" && "sm:mt-4")}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </nav>
        <div className="min-w-0 flex-1 space-y-4">
          {tab === "general" && (
            <>
              <Labeled label="App name">
                <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
              </Labeled>
              <Labeled label="Description" hint="Shown on your apps list.">
                <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} maxLength={500} />
              </Labeled>
              <Labeled label="Visibility" hint="Public apps can be remixed by other members of your team from the templates gallery.">
                <div className="flex items-center gap-2 text-[13px]">
                  <Switch checked={s.visibility === "public"} onCheckedChange={(v) => setS((x) => ({ ...x, visibility: v ? "public" : "private" }))} label="Public" />
                  {s.visibility === "public" ? "Public" : "Private"}
                </div>
              </Labeled>
              <Footer>
                <Button variant="primary" loading={saving} onClick={() => void save({ name: name.trim() || p.name, description, settings: { visibility: s.visibility } })}>
                  Save
                </Button>
              </Footer>
            </>
          )}
          {tab === "knowledge" && (
            <>
              <Labeled label="Project knowledge" hint="Facts the AI should always know: your business, audience, brand voice, data model, links… Sent with every request.">
                <Textarea value={s.knowledge ?? ""} onChange={(e) => setS((x) => ({ ...x, knowledge: e.target.value }))} rows={8} maxLength={20000} placeholder="We are a family bakery in Beirut. Prices are in USD. Opening hours 7–19…" />
              </Labeled>
              <Labeled label="Custom instructions" hint="How the AI should work: coding conventions, things to avoid, language of the UI…">
                <Textarea value={s.instructions ?? ""} onChange={(e) => setS((x) => ({ ...x, instructions: e.target.value }))} rows={5} maxLength={10000} placeholder="Always support Arabic (RTL). Never remove the newsletter form." />
              </Labeled>
              <Footer>
                <Button variant="primary" loading={saving} onClick={() => void save({ settings: { knowledge: s.knowledge, instructions: s.instructions } }, "Knowledge saved")}>
                  Save
                </Button>
              </Footer>
            </>
          )}
          {tab === "theme" && (
            <>
              <p className="text-[13px] text-muted">These preferences guide the Designer agent and fill the color palette of the visual editor. Ask the AI to “apply the theme” to restyle existing pages.</p>
              <Labeled label="Primary color">
                <div className="flex items-center gap-2">
                  <input type="color" value={theme.colors?.primary ?? "#3291ff"} onChange={(e) => setTheme({ colors: { ...(theme.colors ?? {}), primary: e.target.value } })} className="h-8 w-10 cursor-pointer rounded border border-border bg-transparent" aria-label="Primary color" />
                  <Input value={theme.colors?.primary ?? ""} onChange={(e) => setTheme({ colors: { ...(theme.colors ?? {}), primary: e.target.value } })} placeholder="#3291ff" className="w-32 font-mono" />
                </div>
              </Labeled>
              <Labeled label="Accent color">
                <div className="flex items-center gap-2">
                  <input type="color" value={theme.colors?.accent ?? "#f59e0b"} onChange={(e) => setTheme({ colors: { ...(theme.colors ?? {}), accent: e.target.value } })} className="h-8 w-10 cursor-pointer rounded border border-border bg-transparent" aria-label="Accent color" />
                  <Input value={theme.colors?.accent ?? ""} onChange={(e) => setTheme({ colors: { ...(theme.colors ?? {}), accent: e.target.value } })} placeholder="#f59e0b" className="w-32 font-mono" />
                </div>
              </Labeled>
              <Labeled label="Font">
                <select value={theme.font ?? ""} onChange={(e) => setTheme({ font: e.target.value || undefined })} className="h-9 w-full rounded-md border border-border bg-bg px-2 text-[13px]">
                  <option value="">Template default</option>
                  {FONTS.map((f) => (
                    <option key={f}>{f}</option>
                  ))}
                </select>
              </Labeled>
              <Labeled label="Corners">
                <div className="grid grid-cols-4 gap-1.5">
                  {RADII.map((r) => (
                    <button key={r.v} onClick={() => setTheme({ radius: r.v })} className={cn("h-9 border text-[12.5px]", theme.radius === r.v ? "border-accent text-fg" : "border-border text-muted hover:text-fg")} style={{ borderRadius: r.v === "0rem" ? 2 : r.v }}>
                      {r.l}
                    </button>
                  ))}
                </div>
              </Labeled>
              <Labeled label="Color mode">
                <select value={theme.mode ?? "system"} onChange={(e) => setTheme({ mode: e.target.value as "light" | "dark" | "system" })} className="h-9 w-full rounded-md border border-border bg-bg px-2 text-[13px]">
                  <option value="system">Follow the visitor&apos;s system</option>
                  <option value="light">Light</option>
                  <option value="dark">Dark</option>
                </select>
              </Labeled>
              <Footer>
                <Button variant="primary" loading={saving} onClick={() => void save({ settings: { theme: s.theme } }, "Theme saved")}>
                  Save theme
                </Button>
              </Footer>
            </>
          )}
          {tab === "ai" && (
            <>
              <div className="space-y-2" role="radiogroup" aria-label="AI quality">
                {QUALITY.map((q) => (
                  <button
                    key={q.id}
                    role="radio"
                    aria-checked={(s.quality ?? "balanced") === q.id}
                    onClick={() => setS((x) => ({ ...x, quality: q.id }))}
                    className={cn("flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors", (s.quality ?? "balanced") === q.id ? "border-accent bg-accent/5" : "border-border hover:border-border-strong")}
                  >
                    <span className="mt-0.5 text-muted">{q.icon}</span>
                    <span>
                      <span className="block text-[13.5px] font-medium">{q.label}</span>
                      <span className="block text-[12.5px] text-muted">{q.hint}</span>
                    </span>
                  </button>
                ))}
              </div>
              <p className="text-[12px] text-subtle">Providers and models are configured by the platform owner in Settings → AI providers. If a provider is down or rate-limited the agents fall back to the next one automatically.</p>
              <Footer>
                <Button variant="primary" loading={saving} onClick={() => void save({ settings: { quality: s.quality ?? "balanced" } }, "AI quality saved")}>
                  Save
                </Button>
              </Footer>
            </>
          )}
          {tab === "export" && (
            <>
              <div className="rounded-lg border border-border p-4">
                <p className="font-medium">Download the code</p>
                <p className="mt-0.5 text-[13px] text-muted">A ZIP of the current version — a standard Next.js app you can run anywhere.</p>
                <a href={builderApi().exportZipUrl(p.id)} className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-[13px] font-medium hover:bg-surface-2" download data-testid="download-zip">
                  <Download className="h-3.5 w-3.5" /> Download ZIP
                </a>
              </div>
              <div className="space-y-3 rounded-lg border border-border p-4">
                <div>
                  <p className="flex items-center gap-1.5 font-medium">
                    <Github className="h-4 w-4" /> Export to GitHub
                  </p>
                  <p className="mt-0.5 text-[13px] text-muted">Creates a new repository with the full history through the team&apos;s GitHub App.</p>
                </div>
                <Labeled label="Repository name">
                  <Input value={gh.repo} onChange={(e) => setGh((g) => ({ ...g, repo: e.target.value }))} className="font-mono" />
                </Labeled>
                <label className="flex items-center gap-2 text-[13px]">
                  <Switch size="sm" checked={gh.private} onCheckedChange={(v) => setGh((g) => ({ ...g, private: v }))} label="Private repository" /> Private repository
                </label>
                <Button loading={exporting} disabled={!gh.repo.trim()} onClick={() => void exportGithub()} leftIcon={<Github className="h-3.5 w-3.5" />}>
                  Export
                </Button>
              </div>
            </>
          )}
          {tab === "danger" && (
            <div className="rounded-lg border border-danger/40 p-4">
              <p className="font-medium">Delete this app</p>
              <p className="mt-0.5 text-[13px] text-muted">Deletes the code, history and preview. A published project and its backend are kept (delete them from their own settings).</p>
              <Labeled label={`Type “${p.name}” to confirm`} className="mt-3">
                <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} />
              </Labeled>
              <Button className="mt-3" variant="danger" loading={deleting} disabled={confirm !== p.name} onClick={() => void del()}>
                Delete app
              </Button>
            </div>
          )}
        </div>
      </div>
    </Sheet>
  );
}

function Labeled({ label, hint, children, className }: { label: string; hint?: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <p className="text-[13px] font-medium">{label}</p>
      {children}
      {hint && <p className="text-[12px] text-subtle">{hint}</p>}
    </div>
  );
}

function Footer({ children }: { children: React.ReactNode }) {
  return <div className="flex justify-end border-t border-border pt-4">{children}</div>;
}
