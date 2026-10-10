"use client";

import { useState } from "react";
import { Container, FolderGit2, Github, LayoutTemplate, UploadCloud } from "lucide-react";
import { cn } from "@/lib/utils";
import type { GitHubAppStatus } from "@/components/github/GitHubAppCard";
import { GitHubImport } from "./github-import";
import { GitUrlImport } from "./git-url-import";
import { UploadImport } from "./upload-import";
import { ImageImport } from "./image-import";
import { TemplateImport } from "./template-import";
import { ConfigureProject } from "./configure-project";
import type { Installation, Selection, Template } from "./types";

export type Tab = "github" | "git" | "upload" | "image" | "template";

const TABS: { value: Tab; label: string; icon: React.ReactNode }[] = [
  { value: "github", label: "Import Git Repository", icon: <Github className="h-4 w-4" /> },
  { value: "git", label: "Clone from Git URL", icon: <FolderGit2 className="h-4 w-4" /> },
  { value: "upload", label: "Upload a folder", icon: <UploadCloud className="h-4 w-4" /> },
  { value: "image", label: "Docker image", icon: <Container className="h-4 w-4" /> },
  { value: "template", label: "Templates", icon: <LayoutTemplate className="h-4 w-4" /> },
];

export function NewProjectClient(props: {
  team: { id: string; slug: string; name: string };
  isOwner: boolean;
  app: GitHubAppStatus;
  installations: Installation[];
  templates: Template[];
  initialTab: Tab;
  initialTemplate: string | null;
  flash: { tone: "error" | "success"; text: string } | null;
}) {
  const [tab, setTab] = useState<Tab>(props.initialTab);
  const initialSel = props.initialTemplate ? props.templates.find((t) => t.id === props.initialTemplate) : null;
  const [selection, setSelection] = useState<Selection | null>(initialSel ? { kind: "template", template: initialSel } : null);

  if (selection) return <ConfigureProject team={props.team} selection={selection} onBack={() => setSelection(null)} />;

  return (
    <div className="space-y-6">
      {props.flash && (
        <div className={cn("rounded-lg border px-4 py-3 text-sm", props.flash.tone === "error" ? "border-danger/30 bg-danger/10 text-danger" : "border-success/30 bg-success/10 text-success")}>{props.flash.text}</div>
      )}
      <div role="tablist" aria-label="Project source" className="-mx-4 flex gap-1 overflow-x-auto px-4 sm:mx-0 sm:flex-wrap sm:px-0">
        {TABS.map((t) => (
          <button
            key={t.value}
            role="tab"
            type="button"
            aria-selected={tab === t.value}
            onClick={() => {
              setTab(t.value);
              const u = new URL(window.location.href);
              u.searchParams.set("tab", t.value);
              window.history.replaceState(null, "", u);
            }}
            className={cn(
              "inline-flex shrink-0 items-center gap-2 rounded-md border px-3 py-2 text-[13px] font-medium transition-colors",
              tab === t.value ? "border-border-strong bg-surface-2 text-fg" : "border-transparent text-muted hover:bg-surface-2 hover:text-fg",
            )}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>
      <div className="max-w-3xl">
        {tab === "github" && <GitHubImport team={props.team} app={props.app} isOwner={props.isOwner} installations={props.installations} onSelect={setSelection} />}
        {tab === "git" && <GitUrlImport team={props.team} onSelect={setSelection} />}
        {tab === "upload" && <UploadImport team={props.team} onSelect={setSelection} />}
        {tab === "image" && <ImageImport onSelect={setSelection} />}
      </div>
      {tab === "template" && <TemplateImport templates={props.templates} onSelect={setSelection} />}
    </div>
  );
}
