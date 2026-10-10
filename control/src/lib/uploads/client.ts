import { createTarGz, isDefaultIgnored, normalizeEntryPath, type TarEntry } from "./tar";
import { isIgnored, parseIgnore } from "./ignore";

/**
 * Browser helpers for the dashboard "Upload a folder" flow:
 *   files = await filesFromDrop(e.dataTransfer)  |  filesFromInput(input.files)
 *   const { bytes, count } = await packFiles(files)          // .tar.gz (ignores .gitignore/.levantignore/node_modules/.git…)
 *   const { id } = await uploadBytes(bytes, { team, onProgress })
 * A dropped .zip / .tar.gz / .tgz file is uploaded as-is (the build area extracts all three).
 */
export type PickedFile = { path: string; file: File };

export async function filesFromDrop(dt: DataTransfer): Promise<PickedFile[]> {
  const out: PickedFile[] = [];
  const entries = Array.from(dt.items)
    .map((i) => (i.kind === "file" ? (i as DataTransferItem & { webkitGetAsEntry?: () => FileSystemEntry | null }).webkitGetAsEntry?.() : null))
    .filter(Boolean) as FileSystemEntry[];
  if (!entries.length) return Array.from(dt.files).map((f) => ({ path: f.name, file: f }));
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
      out.push({ path: prefix + entry.name, file });
    } else if (entry.isDirectory) {
      if (isDefaultIgnored(entry.name)) return;
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const e of batch) await walk(e, `${prefix}${entry.name}/`);
      }
    }
  };
  for (const e of entries) await walk(e, "");
  return stripCommonRoot(out);
}

export function filesFromInput(list: FileList | null): PickedFile[] {
  if (!list) return [];
  return stripCommonRoot(Array.from(list).map((f) => ({ path: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name, file: f })));
}

/** A single dropped folder "my-app/…" → paths relative to it. */
function stripCommonRoot(files: PickedFile[]): PickedFile[] {
  const firsts = new Set(files.map((f) => f.path.split("/")[0]));
  if (firsts.size === 1 && files.every((f) => f.path.includes("/"))) {
    return files.map((f) => ({ ...f, path: f.path.slice(f.path.indexOf("/") + 1) }));
  }
  return files;
}

export const isArchiveFile = (f: File) => /\.(zip|tar\.gz|tgz|tar)$/i.test(f.name);

export async function packFiles(files: PickedFile[], onProgress?: (done: number, total: number) => void): Promise<{ bytes: Uint8Array; count: number; skipped: number; rootName: string | null }> {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const rulesText = (await byPath.get(".gitignore")?.file.text()) ?? "";
  const levText = (await byPath.get(".levantignore")?.file.text()) ?? "";
  const rules = [...parseIgnore(rulesText), ...parseIgnore(levText)];
  const entries: TarEntry[] = [];
  let skipped = 0;
  let i = 0;
  for (const f of files) {
    i++;
    const p = normalizeEntryPath(f.path);
    if (!p || isDefaultIgnored(p) || isIgnored(rules, p)) {
      skipped++;
      continue;
    }
    entries.push({ path: p, data: new Uint8Array(await f.file.arrayBuffer()), mtime: f.file.lastModified / 1000 });
    if (i % 50 === 0) onProgress?.(i, files.length);
  }
  if (!entries.length) throw new Error("No files to upload (everything was ignored)");
  return { bytes: createTarGz(entries), count: entries.length, skipped, rootName: null };
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", data as unknown as ArrayBuffer);
  return Array.from(new Uint8Array(d))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function req<T>(path: string, init: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: "same-origin", ...init });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.error?.message ?? `Upload failed (${res.status})`);
  return data as T;
}

/** Chunked upload with retries per chunk; returns the COMPLETE upload id. */
export async function uploadBytes(bytes: Uint8Array, opts: { team?: string; projectId?: string; onProgress?: (sent: number, total: number) => void }): Promise<{ id: string; sha256: string }> {
  const sha = await sha256Hex(bytes);
  const init = await req<{ id: string; chunkSize: number; totalChunks: number }>("/api/v1/uploads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ team: opts.team, projectId: opts.projectId, size: bytes.length, sha256: sha, chunkSize: 4 * 1024 * 1024 }),
  });
  let sent = 0;
  for (let i = 0; i < init.totalChunks; i++) {
    const chunk = bytes.subarray(i * init.chunkSize, Math.min(bytes.length, (i + 1) * init.chunkSize));
    for (let attempt = 0; ; attempt++) {
      try {
        await req(`/api/v1/uploads/${init.id}/chunks/${i}`, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: chunk as unknown as BodyInit });
        break;
      } catch (e) {
        if (attempt >= 3) throw e;
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      }
    }
    sent += chunk.length;
    opts.onProgress?.(sent, bytes.length);
  }
  await req(`/api/v1/uploads/${init.id}/complete`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sha256: sha }) });
  return { id: init.id, sha256: sha };
}
