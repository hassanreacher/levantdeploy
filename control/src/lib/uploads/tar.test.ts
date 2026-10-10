import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTarGz, normalizeEntryPath, isDefaultIgnored } from "./tar";
import { isArchive } from "./storage";

const enc = new TextEncoder();

describe("tar writer", () => {
  it("produces an archive GNU tar can list and extract (incl. long PAX names)", () => {
    const long = "very/" + "deep/".repeat(30) + "file-with-a-long-name.txt";
    const gz = createTarGz([
      { path: "index.html", data: enc.encode("<h1>hi</h1>") },
      { path: "./src/app.js", data: enc.encode("console.log(1)"), mode: 0o755 },
      { path: long, data: enc.encode("x".repeat(1000)) },
      { path: "../escape", data: enc.encode("nope") },
    ]);
    expect(isArchive(gz)).toBe(true);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ld-tar-"));
    const file = path.join(dir, "a.tar.gz");
    fs.writeFileSync(file, gz);
    const list = execFileSync("tar", ["-tzf", file]).toString().trim().split("\n");
    expect(list).toEqual(["index.html", "src/app.js", long]);
    execFileSync("tar", ["-xzf", file, "-C", dir]);
    expect(fs.readFileSync(path.join(dir, "index.html"), "utf8")).toBe("<h1>hi</h1>");
    expect(fs.statSync(path.join(dir, "src/app.js")).mode & 0o777).toBe(0o755);
    expect(fs.readFileSync(path.join(dir, long), "utf8")).toHaveLength(1000);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  it("normalises paths and ignores defaults", () => {
    expect(normalizeEntryPath("./a//b\\c")).toBe("a/b/c");
    expect(normalizeEntryPath("a/../b")).toBeNull();
    expect(isDefaultIgnored("node_modules/x/index.js")).toBe(true);
    expect(isDefaultIgnored("app/.git/HEAD")).toBe(true);
    expect(isDefaultIgnored("src/index.ts")).toBe(false);
  });
  it("archive magic", () => {
    expect(isArchive(new Uint8Array([0x50, 0x4b, 3, 4]))).toBe(true);
    expect(isArchive(enc.encode("hello world"))).toBe(false);
  });
});

import { parseIgnore, isIgnored } from "./ignore";
describe("browser ignore matcher", () => {
  const rules = parseIgnore(["# comment", "dist/", "*.log", "/secret.txt", "!keep.log", "build/**/tmp", ""].join("\n"));
  it("applies gitignore semantics", () => {
    expect(isIgnored(rules, "dist/app.js")).toBe(true);
    expect(isIgnored(rules, "packages/a/dist/x.js")).toBe(true);
    expect(isIgnored(rules, "dist")).toBe(false); // dir-only rule doesn't match a file named dist
    expect(isIgnored(rules, "logs/a.log")).toBe(true);
    expect(isIgnored(rules, "keep.log")).toBe(false);
    expect(isIgnored(rules, "secret.txt")).toBe(true);
    expect(isIgnored(rules, "sub/secret.txt")).toBe(false);
    expect(isIgnored(rules, "build/x/y/tmp/f")).toBe(true);
    expect(isIgnored(rules, "src/index.ts")).toBe(false);
  });
});
