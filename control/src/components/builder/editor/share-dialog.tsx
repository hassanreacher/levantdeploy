"use client";

import { useEffect, useState } from "react";
import { Link2 } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { CopyButton } from "@/components/ui/copy-button";
import { useToast } from "@/components/ui/toast";
import { builderApi } from "@/lib/builder-ui/api";
import { errMessage, useEditor } from "./context";

/** Read-only signed share link of the live preview (builder-core: share tokens). */
export function ShareDialog() {
  const ed = useEditor();
  const toast = useToast();
  const open = ed.panel === "share";
  const [link, setLink] = useState<{ url: string | null; expiresAt?: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  // builder-core only reveals the URL once (on creation); afterwards we know whether a link is active
  const [active, setActive] = useState<{ enabled: boolean; expiresAt: string | null } | null>(null);
  useEffect(() => {
    if (!open) return;
    builderApi()
      .shareInfo(ed.project.id)
      .then(setActive, () => setActive(ed.project.share ?? null));
  }, [open, ed.project.id, ed.project.share]);
  const enabled = !!link?.url || (!link && !!active?.enabled);

  const toggle = async (v: boolean) => {
    setBusy(true);
    try {
      const r = await builderApi().share(ed.project.id, { enabled: v });
      setLink(r);
      setActive({ enabled: v, expiresAt: r.expiresAt ?? null });
    } catch (e) {
      toast.error("Could not update the share link", errMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={() => ed.setPanel(null)} title="Share preview" description="Anyone with the link can view the live preview (read-only, no editing). Publishing gives you a permanent URL.">
      <div className="space-y-4" data-testid="share-dialog">
        <label className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
          <span className="flex items-center gap-2 text-[13.5px]">
            <Link2 className="h-4 w-4 text-muted" /> Share link
          </span>
          <Switch checked={enabled} disabled={busy} onCheckedChange={(v) => void toggle(v)} label="Share link" />
        </label>
        {link?.url && (
          <div className="flex items-center gap-2 rounded-md border border-border bg-bg-subtle px-3 py-2">
            <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{link.url}</span>
            <CopyButton value={link.url} />
          </div>
        )}
        {enabled && !link?.url && (
          <p className="text-[12.5px] text-muted">
            A share link is active. For security its URL is only shown once —{" "}
            <button className="underline underline-offset-4 hover:text-fg" disabled={busy} onClick={() => void toggle(true)}>
              create a new link
            </button>{" "}
            (the old one stops working).
          </p>
        )}
        {link?.expiresAt && <p className="text-[12px] text-subtle">Expires {new Date(link.expiresAt).toLocaleString()}</p>}
        <p className="text-[12px] text-subtle">Team members can always open the editor from your apps list.</p>
      </div>
    </Dialog>
  );
}
