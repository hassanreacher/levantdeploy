import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { listFiles, packDirectory } from "../src/pack.js";
import { parseEnvFlags } from "../src/commands/deploy.js";
import { normalizeServer } from "../src/config.js";

let dir: string;
const write = (rel: string, content = "x") => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), content);
};

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "levant-pack-"));
  write("package.json", "{}");
  write("src/index.ts");
  write("src/util/a.ts");
  write("node_modules/react/index.js");
  write("packages/ui/node_modules/x/y.js");
  write(".git/HEAD");
  write(".next/cache/x");
  write(".env", "SECRET=1");
  write(".env.local", "SECRET=1");
  write(".env.production.local", "SECRET=1");
  write(".env.example", "KEY=");
  write("dist/bundle.js");
  write("logs/app.log");
  write("keep.log");
  write("coverage/lcov.info");
  write("secret.key.pem");
  write("packages/api/.gitignore", "generated/\n*.tmp\n");
  write("packages/api/generated/client.ts");
  write("packages/api/src/x.tmp");
  write("packages/api/src/main.ts");
  write(".gitignore", "dist/\n*.log\n!keep.log\ncoverage\n");
  write(".levantignore", "!dist/\nREADME.private.md\n");
  write("README.private.md");
  write("README.md");
  write(".levant/project.json", "{}");
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("listFiles ignore rules", () => {
  it("skips VCS, dependencies, caches, local env files and keys", () => {
    const files = listFiles(dir);
    for (const f of ["node_modules/react/index.js", "packages/ui/node_modules/x/y.js", ".git/HEAD", ".next/cache/x", ".env", ".env.local", ".env.production.local", "secret.key.pem", ".levant/project.json"]) {
      expect(files, f).not.toContain(f);
    }
    expect(files).toContain(".env.example");
  });
  it("respects .gitignore (incl. negation) and nested .gitignore files", () => {
    const files = listFiles(dir);
    expect(files).not.toContain("logs/app.log");
    expect(files).toContain("keep.log");
    expect(files).not.toContain("coverage/lcov.info");
    expect(files).not.toContain("packages/api/generated/client.ts");
    expect(files).not.toContain("packages/api/src/x.tmp");
    expect(files).toContain("packages/api/src/main.ts");
  });
  it(".levantignore can re-include gitignored paths and add its own", () => {
    const files = listFiles(dir);
    expect(files).toContain("dist/bundle.js");
    expect(files).not.toContain("README.private.md");
    expect(files).toContain("README.md");
  });
  it("packs a gzip tarball with exactly the listed files", async () => {
    const p = await packDirectory(dir);
    expect(p.size).toBeGreaterThan(0);
    expect(p.sha256).toMatch(/^[a-f0-9]{64}$/);
    const listed = execFileSync("tar", ["-tzf", p.file]).toString().trim().split("\n").filter((l) => !l.endsWith("/")).sort();
    expect(listed).toEqual([...p.files].sort());
    fs.rmSync(path.dirname(p.file), { recursive: true, force: true });
  });
});

describe("flags & config", () => {
  it("parses --env KEY=value", () => {
    expect(parseEnvFlags(["A=1", "B=x=y", "C="])).toEqual([
      { key: "A", value: "1" },
      { key: "B", value: "x=y" },
      { key: "C", value: "" },
    ]);
    expect(() => parseEnvFlags(["nope"])).toThrow();
    expect(() => parseEnvFlags(["1A=x"])).toThrow();
  });
  it("normalises server URLs", () => {
    expect(normalizeServer("deploy.example.com/")).toBe("https://deploy.example.com");
    expect(normalizeServer("localhost:3103")).toBe("http://localhost:3103");
    expect(normalizeServer("http://x.y")).toBe("http://x.y");
  });
});
