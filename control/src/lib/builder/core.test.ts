import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// isolated storage + redis db for the lock (keys expire; no DB needed — HEAD bookkeeping errors are ignored)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lv-builder-core-"));
process.env.STORAGE_DIR = tmp;
process.env.REDIS_URL ??= "redis://localhost:6379/13";
process.env.PLATFORM_DOMAIN = "levant.test";
process.env.SESSION_SECRET ??= "test-session-secret-test-session-secret-0000";

import { createWorkspace, repoDir, writeEnvLocal } from "./workspace";
import { archive, commitAll, diff, getCommit, headSha, log, restore, authorIdentity } from "./git";
import { listFiles, readFile, writeFile, renameFile, deleteFile, FileError } from "./files";
import { applyVisualEdits } from "./visual-edit";
import { builderIdFromHost } from "./host";
import { parseDevLines, parseEslintJson, parseNextBuild, parseTsc, parsePreviewCookie, signPreviewCookie, demuxBuffer } from "./preview";
import { nameFromPrompt } from "./projects";
import { buildBuilderPreviewRoutes, previewHostPattern } from "@/lib/proxy/builder";
import { buildCaddyConfig } from "@/lib/proxy/config";

const ID = "ctestworkspace0000000001";

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("workspace + git", () => {
  beforeAll(async () => {
    await createWorkspace(ID, { name: "My Test App" });
  }, 60_000);

  it("creates the repo from the template with one system commit", async () => {
    const commits = await log(ID);
    expect(commits).toHaveLength(1);
    expect(commits[0]!.author.kind).toBe("system");
    const pkg = JSON.parse(fs.readFileSync(path.join(repoDir(ID), "package.json"), "utf8"));
    expect(pkg.name).toBe("my-test-app");
    expect(fs.existsSync(path.join(repoDir(ID), "components/levant/bridge.tsx"))).toBe(true);
    expect(fs.existsSync(path.join(repoDir(ID), "node_modules"))).toBe(false);
  });

  it("commits file writes with agent / user authors, lists and diffs them", async () => {
    const w = await writeFile(ID, "app/about/page.tsx", "export default function About() {\n  return <h1>About</h1>;\n}\n", { commit: { message: "add about page", author: "agent:coder" } });
    expect(w.commit).toMatch(/^[0-9a-f]{40}$/);
    const c = await getCommit(ID, w.commit!);
    expect(c.author).toMatchObject({ kind: "agent", role: "coder" });
    const files = await diff(ID, w.commit!, { patches: true });
    expect(files).toEqual([expect.objectContaining({ path: "app/about/page.tsx", status: "added", additions: 3, deletions: 0 })]);
    expect(files[0]!.patch).toContain("+  return <h1>About</h1>;");
    expect((await listFiles(ID)).some((f) => f.path === "app/about/page.tsx")).toBe(true);
    expect((await readFile(ID, "app/about/page.tsx")).content).toContain("About");
    // nothing changed → no commit
    expect(await commitAll(ID, "noop", { name: "Sara", email: "sara@example.com" })).toBeNull();
  });

  it("never commits .env.local and refuses unsafe paths", async () => {
    await writeEnvLocal(ID, { NEXT_PUBLIC_SUPABASE_URL: "https://x.example", NEXT_PUBLIC_SUPABASE_ANON_KEY: 'a"b' });
    expect(fs.readFileSync(path.join(repoDir(ID), ".env.local"), "utf8")).toContain('NEXT_PUBLIC_SUPABASE_ANON_KEY="a\\"b"');
    expect(await commitAll(ID, "env?", "system")).toBeNull();
    await expect(writeFile(ID, "../escape.txt", "x")).rejects.toBeInstanceOf(FileError);
    await expect(readFile(ID, ".env.local")).rejects.toBeInstanceOf(FileError);
    fs.symlinkSync("/etc", path.join(repoDir(ID), "etc-link"));
    await expect(writeFile(ID, "etc-link/hosts", "x")).rejects.toThrow(/escapes/);
    fs.unlinkSync(path.join(repoDir(ID), "etc-link"));
  });

  it("renames / deletes with commits, binary files round-trip as base64", async () => {
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    const w = await writeFile(ID, "public/uploads/a.png", png, { commit: { message: "upload", author: "system" } });
    const r = await readFile(ID, "public/uploads/a.png");
    expect(r).toMatchObject({ binary: true, encoding: "base64" });
    expect(Buffer.from(r.content, "base64").equals(png)).toBe(true);
    const files = await diff(ID, w.commit!);
    expect(files[0]).toMatchObject({ binary: true, status: "added" });
    const mv = await renameFile(ID, "app/about/page.tsx", "app/team/page.tsx", { commit: { message: "rename", author: "system" } });
    expect((await diff(ID, mv.commit!))[0]).toMatchObject({ status: "renamed", from: "app/about/page.tsx", path: "app/team/page.tsx" });
    const del = await deleteFile(ID, "public/uploads/a.png", { commit: { message: "rm", author: "system" } });
    expect((await diff(ID, del.commit!))[0]).toMatchObject({ status: "deleted" });
  });

  it("restore creates a new commit with the old tree; history is kept", async () => {
    const all = await log(ID, { limit: 100 });
    const first = all[all.length - 1]!;
    const before = all.length;
    const r = await restore(ID, first.sha, { name: "Sara", email: "sara@example.com" });
    expect(r.changed).toBe(true);
    const after = await log(ID, { limit: 100 });
    expect(after).toHaveLength(before + 1);
    expect(after[0]!.title).toBe(`Restore to ${first.shortSha}: ${first.title}`);
    expect(after[0]!.author.kind).toBe("user");
    expect(fs.existsSync(path.join(repoDir(ID), "app/team/page.tsx"))).toBe(false);
    expect(fs.existsSync(path.join(repoDir(ID), ".env.local"))).toBe(true); // ignored files untouched
    expect((await diff(ID, "HEAD", { against: first.sha })).length).toBe(0);
    // restoring to the same tree again is a no-op
    expect((await restore(ID, first.sha, "system")).changed).toBe(false);
  });

  it("applies visual edits to the real template (prettier config honoured) and commits once", async () => {
    const page = fs.readFileSync(path.join(repoDir(ID), "app/page.tsx"), "utf8").split("\n");
    const line = page.findIndex((l) => l.includes("<h1")) + 1;
    const col = page[line - 1]!.indexOf("<h1") + 1;
    const r = await applyVisualEdits(ID, [{ op: "setText", src: `app/page.tsx:${line}:${col}`, text: "Hello bakery" }], { author: { name: "Sara", email: "s@x.io" } });
    expect(r.commit).toMatch(/^[0-9a-f]{40}$/);
    const files = await diff(ID, r.commit!);
    expect(files).toEqual([expect.objectContaining({ path: "app/page.tsx", additions: 1, deletions: 1 })]); // minimal diff
    expect((await getCommit(ID, r.commit!)).author.kind).toBe("visual");
    const ins = await applyVisualEdits(ID, [{ op: "insertComponent", targetSrc: `app/page.tsx:${line}:${col}`, position: "after", componentId: "faq" }], { author: "system" });
    expect(ins.files.sort()).toEqual(["app/page.tsx", "components/sections/faq.tsx"]);
  });

  it("archives HEAD (tar.gz and zip) without ignored files", async () => {
    const zip = await archive(ID, { format: "zip", prefix: "my-app" });
    expect(zip.subarray(0, 2).toString()).toBe("PK");
    expect(zip.includes(Buffer.from("my-app/app/page.tsx"))).toBe(true);
    expect(zip.includes(Buffer.from(".env.local"))).toBe(false);
    const tgz = await archive(ID);
    expect(tgz[0]).toBe(0x1f);
    expect(await headSha(ID)).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("authors", () => {
  it("maps author kinds", () => {
    expect(authorIdentity("agent:Planner!")).toEqual({ name: "agent:planner", email: "planner@agents.levantdeploy.local" });
    expect(authorIdentity({ name: "Omar <x>", userId: "u1" })).toEqual({ name: "Omar x", email: "u1@users.levantdeploy.local" });
  });
  it("derives app names from prompts", () => {
    expect(nameFromPrompt("Build me a todo app with login and dark mode please")).toBe("Todo App With Login And Dark");
    expect(nameFromPrompt("!!!")).toBe("My App");
  });
});

describe("preview helpers", () => {
  it("parses hosts", () => {
    expect(builderIdFromHost("preview-cmv2liyy900057d9788apo994.levant.test:8443")).toBe("cmv2liyy900057d9788apo994");
    expect(builderIdFromHost("preview-short.levant.test")).toBeNull();
    expect(builderIdFromHost("preview-cmv2liyy900057d9788apo994.evil.test")).toBeNull();
    expect(builderIdFromHost("a.preview-cmv2liyy900057d9788apo994.levant.test")).toBeNull();
  });
  it("signs and verifies preview cookies", () => {
    const now = Date.now();
    const v = signPreviewCookie("abc123abc123abc123ab", "u", "user1", now);
    expect(parsePreviewCookie(v, "abc123abc123abc123ab", now)).toEqual({ kind: "u", sub: "user1" });
    expect(parsePreviewCookie(v, "other0other0other0ot", now)).toBeNull();
    expect(parsePreviewCookie(v.slice(0, -1) + (v.endsWith("a") ? "b" : "a"), "abc123abc123abc123ab", now)).toBeNull();
    expect(parsePreviewCookie(v, "abc123abc123abc123ab", now + 13 * 3600_000)).toBeNull();
  });
  it("parses tsc / eslint / next build output", () => {
    expect(parseTsc("lib/utils.ts(9,14): error TS2322: Type 'string' is not assignable to type 'number'.")).toEqual([
      { file: "lib/utils.ts", line: 9, col: 14, severity: "error", code: "TS2322", message: "Type 'string' is not assignable to type 'number'.", source: "typecheck" },
    ]);
    const eslint = JSON.stringify([{ filePath: "/app/app/page.tsx", messages: [{ line: 3, column: 7, severity: 1, ruleId: "no-unused-vars", message: "x is unused" }] }]);
    expect(parseEslintJson("noise\n" + eslint)).toEqual([{ file: "app/page.tsx", line: 3, col: 7, severity: "warning", code: "no-unused-vars", message: "x is unused", source: "lint" }]);
    const build = parseNextBuild("Failed to compile.\n\n./lib/utils.ts:9:14\nType error: Type 'string' is not assignable to type 'number'.\n");
    expect(build).toContainEqual(expect.objectContaining({ file: "lib/utils.ts", line: 9, message: expect.stringContaining("Type error") }));
  });
  it("turns dev-server output into errors and success markers", () => {
    const r = parseDevLines([" ○ Compiling / ...", " ⨯ ./app/page.tsx:12:5", "Module not found: Can't resolve '@/components/x'", "", " ✓ Compiled / in 2s"]);
    expect(r.ok).toBe(true);
    expect(r.errors[0]).toMatchObject({ file: "app/page.tsx:12:5" });
    expect(r.errors[0]!.message).toContain("Module not found");
  });
  it("demuxes docker log frames", () => {
    const frame = (s: string) => Buffer.concat([Buffer.from([1, 0, 0, 0, 0, 0, 0, s.length]), Buffer.from(s)]);
    expect(demuxBuffer(Buffer.concat([frame("a\n"), frame("bc\n")]))).toBe("a\nbc\n");
  });
});

describe("caddy routes for previews", () => {
  it("one static route set: sso/share/errors → control, rest → forward-auth then lvb-{id}:3000", () => {
    const routes = buildBuilderPreviewRoutes({ controlUpstream: "control:3000", dashboardHost: "app.example.com" }, "example.com") as Array<{ match: Array<Record<string, any>>; handle: Array<Record<string, any>> }>;
    expect(routes).toHaveLength(3);
    expect(new RegExp(previewHostPattern("example.com")).test("preview-cmv2liyy900057d9788apo994.example.com")).toBe(true);
    expect(new RegExp(previewHostPattern("example.com")).test("preview-cmv2liyy900057d9788apo994.example.com.evil.io")).toBe(false);
    const gated = routes[2]!;
    expect(gated.handle[0]!.rewrite.uri).toBe("/api/internal/builder/preview-auth");
    expect(gated.handle[0]!.headers.request.delete).toContain("Upgrade");
    expect(gated.handle[1]!.upstreams[0].dial).toBe("lvb-{http.regexp.lvpreview.1}:3000");
    expect(gated.handle[1]!.flush_interval).toBe(-1);
  });
  it("is included in the full config only when enabled", () => {
    const base = { dashboardHost: "app.example.com", controlUpstream: "control:3000", scheme: "https" as const, tls: "internal" as const, logDir: "/tmp", adminListen: ":2019", adminOrigins: [], sites: [], redirects: [] };
    expect(JSON.stringify(buildCaddyConfig(base))).not.toContain("lvpreview");
    const on = JSON.stringify(buildCaddyConfig({ ...base, builderPreviewDomain: "example.com" }));
    expect(on).toContain("lvpreview");
    expect(on).toContain("/api/internal/builder/preview-page");
  });
});
