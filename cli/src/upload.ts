import fs from "node:fs";
import type { Client } from "./api.js";

/** Chunked, resumable upload: init → PUT chunks (3 retries each) → complete (sha256 verified server-side). */
export async function uploadFile(
  client: Client,
  file: string,
  meta: { size: number; sha256: string; team?: string; projectId?: string },
  onProgress?: (sent: number, total: number) => void,
): Promise<{ id: string }> {
  const init = await client.request<{ id: string; chunkSize: number; totalChunks: number }>("POST", "/api/v1/uploads", {
    body: { team: meta.team, projectId: meta.projectId, size: meta.size, sha256: meta.sha256 },
  });
  const fd = fs.openSync(file, "r");
  try {
    let sent = 0;
    for (let i = 0; i < init.totalChunks; i++) {
      const len = Math.min(init.chunkSize, meta.size - i * init.chunkSize);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, i * init.chunkSize);
      for (let attempt = 0; ; attempt++) {
        try {
          await client.request("PUT", `/api/v1/uploads/${init.id}/chunks/${i}`, { raw: buf, headers: { "content-type": "application/octet-stream" } });
          break;
        } catch (e) {
          if (attempt >= 3 || ((e as { status?: number }).status ?? 0) < 500) {
            if (attempt >= 3) throw e;
            if (((e as { status?: number }).status ?? 0) >= 400) throw e;
          }
          await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        }
      }
      sent += len;
      onProgress?.(sent, meta.size);
    }
  } finally {
    fs.closeSync(fd);
  }
  await client.request("POST", `/api/v1/uploads/${init.id}/complete`, { body: { sha256: meta.sha256 } });
  return { id: init.id };
}
