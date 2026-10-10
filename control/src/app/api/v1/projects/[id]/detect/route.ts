import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";
import { route, json, requireProjectRole, throttle, E } from "@/lib/http";
import { LIMITS } from "@/lib/rate-limit";
import { buildSettingsSchema } from "@/lib/build/types";
import { detectPreview } from "@/lib/build/preview";
import { describe } from "@/lib/build/engine";
import { ArchiveError } from "@/lib/sources/archive";

export const dynamic = "force-dynamic";
export const maxDuration = 180;

const MAX_ARCHIVE = 100 * 1024 * 1024;

const jsonSchema = z.object({
  /** preview with unsaved form values */
  buildSettings: buildSettingsSchema.optional(),
  rootDirectory: z.string().max(255).optional(),
});

/**
 * POST /api/v1/projects/:id/detect
 *  - JSON `{ buildSettings?, rootDirectory? }` → detection on the latest source (git HEAD of the production branch / latest upload)
 *  - raw body (Content-Type application/gzip | application/x-tar | application/zip, ≤ 100 MB) → detection on that archive
 *    (query ?rootDirectory= & ?settings=<json> optional)
 * → { detection, summary, dockerfile, source, rootDirectories }
 */
export const POST = route<{ id: string }>(
  async (req, { params }) => {
    const { id } = await params;
    const { project, actor } = await requireProjectRole(id, "MEMBER", { scope: "projects:read" });
    await throttle(`detect:${actor.user.id}`, { limit: 20, window: 60 });
    const ct = (req.headers.get("content-type") ?? "").split(";")[0]!.trim();
    const url = new URL(req.url);
    let archivePath: string | undefined;
    let settings;
    let rootDirectory: string | undefined;
    if (/gzip|tar|zip|octet-stream/.test(ct)) {
      const len = Number(req.headers.get("content-length") || 0);
      if (len > MAX_ARCHIVE) throw E.bad("Archive too large (max 100 MB)");
      archivePath = path.join(os.tmpdir(), `levant-detect-${crypto.randomBytes(6).toString("hex")}`);
      const buf = Buffer.from(await req.arrayBuffer());
      if (buf.length > MAX_ARCHIVE) throw E.bad("Archive too large (max 100 MB)");
      await fsp.writeFile(archivePath, buf);
      rootDirectory = url.searchParams.get("rootDirectory") ?? undefined;
      const s = url.searchParams.get("settings");
      if (s) {
        try {
          settings = buildSettingsSchema.parse(JSON.parse(s));
        } catch {
          throw E.bad("Invalid settings parameter");
        }
      }
    } else {
      const text = await req.text();
      let data: unknown = {};
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        throw E.bad("Invalid JSON body");
      }
      const input = jsonSchema.parse(data);
      settings = input.buildSettings;
      rootDirectory = input.rootDirectory;
    }
    try {
      const preview = await detectPreview(project, { archivePath, settings, rootDirectory, signal: req.signal });
      return json({ ...preview, summary: describe(preview.detection) });
    } catch (e) {
      if (e instanceof ArchiveError) throw E.bad(e.message);
      throw E.bad((e as Error).message.slice(0, 300));
    } finally {
      if (archivePath && fs.existsSync(archivePath)) await fsp.rm(archivePath, { force: true });
    }
  },
  { limit: LIMITS.deploy, key: "detect" },
);
