"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowUp, Globe, ImagePlus, LayoutTemplate, Lock, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dropdown, DropdownItem, DropdownLabel } from "@/components/ui/dropdown";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { builderApi } from "@/lib/builder-ui/api";
import { imageToDataUrl } from "@/lib/builder-ui/image";
import { nameFromPrompt, PROMPT_SUGGESTIONS, savePending, takePending } from "@/lib/builder-ui/prompts";
import type { Credits, Template } from "@/lib/builder-ui/types";
import { CreditCounter } from "./credit-counter";
import { errMessage } from "@/lib/builder-ui/errors";

export type PromptBoxProps = {
  /** "app": creates the project and opens the editor. "landing": stores the prompt and sends the visitor to sign-up. */
  mode: "app" | "landing";
  team?: string;
  templates?: Template[];
  credits?: Credits | null;
  compact?: boolean;
  /** landing: where to send signed-out visitors (default /register) */
  signUpHref?: string;
  /** app: pick up a prompt typed on the landing page before sign-up and start it */
  resumePending?: boolean;
  initialPrompt?: string;
  initialTemplate?: string;
  className?: string;
  autoFocus?: boolean;
};

export function PromptBox({ mode, team, templates = [], credits, compact, signUpHref = "/register", resumePending, initialPrompt, initialTemplate, className, autoFocus }: PromptBoxProps) {
  const router = useRouter();
  const toast = useToast();
  const [prompt, setPrompt] = useState(initialPrompt ?? "");
  const [files, setFiles] = useState<{ file: File; url: string }[]>([]);
  const [template, setTemplate] = useState<string>(initialTemplate ?? "blank");
  const [visibility, setVisibility] = useState<"private" | "public">("private");
  const [busy, setBusy] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (initialPrompt) setPrompt(initialPrompt);
  }, [initialPrompt]);
  useEffect(() => {
    if (initialTemplate) setTemplate(initialTemplate);
  }, [initialTemplate]);

  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(Math.max(el.scrollHeight, compact ? 56 : 96), 280)}px`;
  }, [prompt, compact]);

  useEffect(() => () => files.forEach((f) => URL.revokeObjectURL(f.url)), [files]);

  const create = async (p: string, tpl: string, vis: "private" | "public", imgs: File[]) => {
    if (!team) return;
    setBusy(true);
    try {
      const B = builderApi();
      const attachments: { url: string; name?: string; type?: string }[] = [];
      for (const f of imgs) {
        try {
          const url = await imageToDataUrl(f);
          attachments.push({ url, name: f.name, type: url.slice(5, url.indexOf(";")) });
        } catch {}
      }
      const { project, run, runError } = await B.createProject({ team, prompt: p, name: nameFromPrompt(p), starter: tpl, visibility: vis, attachments: attachments.length ? attachments : undefined });
      // the app exists even when the agents could not start (credits, no AI provider) — the editor shows why
      if (!run && runError) toast.error("The AI could not start", runError);
      router.push(`/${team}/build/${project.id}`);
    } catch (e) {
      toast.error("Could not start building", errMessage(e));
      setBusy(false);
    }
  };

  // resume a prompt typed on the landing page before signing up
  const resumed = useRef(false);
  useEffect(() => {
    if (!resumePending || resumed.current || mode !== "app") return;
    resumed.current = true;
    const pending = takePending();
    if (pending) {
      setPrompt(pending.prompt);
      toast.info("Picking up where you left off", "Building the app you described…");
      void create(pending.prompt, pending.template ?? "blank", pending.visibility ?? "private", []);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resumePending, mode]);

  const submit = () => {
    const p = prompt.trim();
    if (!p || busy) return;
    if (mode === "landing") {
      savePending({ prompt: p, template, visibility });
      router.push(signUpHref);
      return;
    }
    void create(p, template, visibility, files.map((f) => f.file));
  };

  const addFiles = (list: FileList | File[]) => {
    const imgs = Array.from(list).filter((f) => f.type.startsWith("image/") && f.size <= 5 * 1024 * 1024);
    setFiles((cur) => [...cur, ...imgs.map((file) => ({ file, url: URL.createObjectURL(file) }))].slice(0, 4));
  };

  const tpl = templates.find((t) => t.id === template);
  const outOfCredits = credits?.remaining === 0;

  return (
    <div className={cn("w-full", className)}>
      <div
        className={cn("rounded-2xl border border-border transition-colors focus-within:border-border-strong", compact ? "bg-bg" : "bg-surface shadow-[0_0_0_1px_rgb(var(--border)/0.4),0_16px_48px_-24px_rgb(var(--accent)/0.35)]")}
        onDragOver={(e) => mode === "app" && e.dataTransfer.types.includes("Files") && e.preventDefault()}
        onDrop={(e) => {
          if (mode !== "app") return;
          e.preventDefault();
          addFiles(e.dataTransfer.files);
        }}
      >
        {files.length > 0 && (
          <div className="flex flex-wrap gap-2 px-4 pt-4">
            {files.map((f, i) => (
              <span key={f.url} className="relative">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={f.url} alt={f.file.name} className="h-14 w-14 rounded-md border border-border object-cover" />
                <button onClick={() => setFiles((c) => c.filter((_, j) => j !== i))} className="absolute -right-1.5 -top-1.5 rounded-full border border-border bg-surface p-0.5 text-muted hover:text-fg" aria-label="Remove image">
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={ta}
          value={prompt}
          autoFocus={autoFocus}
          onChange={(e) => setPrompt(e.target.value)}
          onPaste={(e) => {
            if (mode === "app" && e.clipboardData.files.length) {
              e.preventDefault();
              addFiles(e.clipboardData.files);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="Describe the app you want — e.g. a booking site for my barbershop with online payments"
          aria-label="What do you want to build?"
          maxLength={4000}
          className={cn("block w-full resize-none bg-transparent px-4 pt-4 text-[15px] leading-relaxed outline-none placeholder:text-subtle", compact ? "min-h-[56px]" : "min-h-[96px]")}
          data-testid="build-prompt"
        />
        <div className="flex flex-wrap items-center gap-1 px-2.5 pb-2.5 pt-1">
          {mode === "app" && (
            <>
              <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => e.target.files && addFiles(e.target.files)} />
              <Button size="sm" variant="ghost" leftIcon={<ImagePlus className="h-3.5 w-3.5" />} onClick={() => fileRef.current?.click()} aria-label="Attach images" title="Attach screenshots or mockups">
                <span className="hidden sm:inline">Attach</span>
              </Button>
            </>
          )}
          {templates.length > 0 && (
            <Dropdown
              width={260}
              trigger={() => (
                <Button size="sm" variant="ghost" leftIcon={<LayoutTemplate className="h-3.5 w-3.5" />} aria-label="Template">
                  <span className="max-w-[120px] truncate">{tpl?.name ?? "Template"}</span>
                </Button>
              )}
            >
              {(close) => (
                <>
                  <DropdownLabel>Start from</DropdownLabel>
                  {templates
                    .filter((t) => t.kind !== "remix")
                    .map((t) => (
                      <DropdownItem
                        key={t.id}
                        onClick={() => {
                          setTemplate(t.id);
                          if (!prompt.trim() && t.prompt) setPrompt(t.prompt);
                          close();
                        }}
                      >
                        <span className="min-w-0">
                          <span className={cn("block truncate", t.id === template && "text-fg")}>{t.name}</span>
                          <span className="block truncate text-[11.5px] text-subtle">{t.description}</span>
                        </span>
                      </DropdownItem>
                    ))}
                </>
              )}
            </Dropdown>
          )}
          <Button
            size="sm"
            variant="ghost"
            leftIcon={visibility === "private" ? <Lock className="h-3.5 w-3.5" /> : <Globe className="h-3.5 w-3.5" />}
            onClick={() => setVisibility((v) => (v === "private" ? "public" : "private"))}
            aria-label={`Visibility: ${visibility}`}
            title={visibility === "private" ? "Private: only your team can see it" : "Public: others can view and remix it"}
          >
            <span className="hidden sm:inline">{visibility === "private" ? "Private" : "Public"}</span>
          </Button>
          <div className="ml-auto flex items-center gap-2">
            {mode === "app" && <CreditCounter credits={credits ?? null} team={team} className="hidden sm:inline-flex" />}
            <Button variant="primary" size="icon" className="rounded-full" onClick={submit} disabled={!prompt.trim() || busy || outOfCredits} loading={busy} aria-label="Build it" data-testid="build-submit">
              {!busy && <ArrowUp className="h-4 w-4" />}
            </Button>
          </div>
        </div>
      </div>
      {!compact && (
        <div className="mt-4 flex flex-wrap justify-center gap-2" aria-label="Suggestions">
          {PROMPT_SUGGESTIONS.map((s) => (
            <button
              key={s.label}
              onClick={() => {
                setPrompt(s.prompt);
                ta.current?.focus();
              }}
              className="rounded-full border border-border bg-bg px-3 py-1.5 text-[12.5px] text-muted transition-colors hover:border-border-strong hover:text-fg"
            >
              {s.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
