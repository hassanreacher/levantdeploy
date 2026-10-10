"use client";

import { useRef, useState } from "react";
import { FolderUp, FileArchive, UploadCloud } from "lucide-react";
import { Button, Card, CardBody, CardHeader, Code, useToast } from "@/components/ui";
import { cn, formatBytes } from "@/lib/utils";
import { filesFromDrop, filesFromInput, isArchiveFile, packFiles, uploadBytes, type PickedFile } from "@/lib/uploads/client";
import type { Selection } from "./types";

type Phase = { step: "idle" } | { step: "packing"; files: number } | { step: "uploading"; sent: number; total: number } | { step: "done" };

/** Drag & drop a folder (packed to .tar.gz in the browser, .gitignore respected) or a .zip / .tar.gz archive. */
export function UploadImport({ team, onSelect, projectId }: { team: { slug: string }; onSelect: (s: Selection) => void; projectId?: string }) {
  const toast = useToast();
  const folderInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [phase, setPhase] = useState<Phase>({ step: "idle" });
  const busy = phase.step === "packing" || phase.step === "uploading";

  async function handle(files: PickedFile[], label: string) {
    if (!files.length) return;
    try {
      let bytes: Uint8Array;
      let count: number | null = null;
      if (files.length === 1 && isArchiveFile(files[0]!.file)) {
        bytes = new Uint8Array(await files[0]!.file.arrayBuffer());
        label = files[0]!.file.name;
      } else {
        setPhase({ step: "packing", files: files.length });
        const packed = await packFiles(files);
        bytes = packed.bytes;
        count = packed.count;
      }
      setPhase({ step: "uploading", sent: 0, total: bytes.length });
      const { id } = await uploadBytes(bytes, { team: team.slug, projectId, onProgress: (sent, total) => setPhase({ step: "uploading", sent, total }) });
      setPhase({ step: "done" });
      onSelect({ kind: "upload", uploadId: id, label, size: bytes.length, files: count });
    } catch (e) {
      setPhase({ step: "idle" });
      toast.error("Upload failed", (e as Error).message);
    }
  }

  const pct = phase.step === "uploading" ? Math.round((phase.sent / Math.max(phase.total, 1)) * 100) : 0;

  return (
    <Card>
      <CardHeader title="Upload a folder" description="Deploy a project straight from your computer. node_modules, .git, build outputs and everything in .gitignore / .levantignore are skipped." />
      <CardBody>
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={async (e) => {
            e.preventDefault();
            setOver(false);
            if (busy) return;
            const files = await filesFromDrop(e.dataTransfer);
            const first = e.dataTransfer.items[0] as (DataTransferItem & { webkitGetAsEntry?: () => FileSystemEntry | null }) | undefined;
            await handle(files, first?.webkitGetAsEntry?.()?.name ?? "upload");
          }}
          className={cn(
            "flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-6 py-14 text-center transition-colors",
            over ? "border-accent bg-accent/5" : "border-border-strong bg-bg-subtle",
          )}
        >
          <div className="flex h-11 w-11 items-center justify-center rounded-full border border-border bg-surface text-muted">
            <UploadCloud className="h-5 w-5" />
          </div>
          {phase.step === "idle" || phase.step === "done" ? (
            <>
              <p className="text-sm font-medium text-fg">Drag & drop a folder or an archive here</p>
              <p className="text-[13px] text-muted">
                <Code>.zip</Code> <Code>.tar.gz</Code> or a project folder · up to the platform upload limit
              </p>
              <div className="mt-2 flex flex-wrap justify-center gap-2">
                <Button size="sm" leftIcon={<FolderUp className="h-3.5 w-3.5" />} onClick={() => folderInput.current?.click()}>
                  Choose folder
                </Button>
                <Button size="sm" variant="ghost" leftIcon={<FileArchive className="h-3.5 w-3.5" />} onClick={() => fileInput.current?.click()}>
                  Choose archive
                </Button>
              </div>
            </>
          ) : phase.step === "packing" ? (
            <p className="text-sm text-muted">Packing {phase.files.toLocaleString()} files…</p>
          ) : (
            <div className="w-full max-w-sm space-y-2">
              <p className="text-sm text-muted">
                Uploading {formatBytes(phase.sent)} / {formatBytes(phase.total)}
              </p>
              <div className="h-1.5 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                <div className="h-full bg-accent transition-[width]" style={{ width: `${pct}%` }} />
              </div>
            </div>
          )}
          <input
            ref={folderInput}
            type="file"
            className="hidden"
            // @ts-expect-error non-standard attribute supported by every evergreen browser
            webkitdirectory=""
            multiple
            onChange={async (e) => {
              const files = filesFromInput(e.target.files);
              const name = (e.target.files?.[0] as (File & { webkitRelativePath?: string }) | undefined)?.webkitRelativePath?.split("/")[0] ?? "folder";
              e.target.value = "";
              await handle(files, name);
            }}
          />
          <input
            ref={fileInput}
            type="file"
            accept=".zip,.tgz,.tar.gz,.tar,application/zip,application/gzip"
            className="hidden"
            onChange={async (e) => {
              const files = filesFromInput(e.target.files);
              e.target.value = "";
              await handle(files, files[0]?.file.name ?? "archive");
            }}
          />
        </div>
        <p className="mt-3 text-[13px] text-muted">
          Prefer the terminal? <Code>npx levant deploy</Code> uploads the current folder the same way.
        </p>
      </CardBody>
    </Card>
  );
}
