import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { extractArchive, linkStaysInside, safeRelPath } from "./archive";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "levant-archive-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** build an archive with python's tarfile/zipfile (lets us craft malicious entries) */
function py(script: string) {
  execFileSync("python3", ["-I", "-c", script], { cwd: tmp });
}

describe("safe paths", () => {
  it("rejects traversal and absolute paths", () => {
    expect(() => safeRelPath("../etc/passwd")).toThrow();
    expect(() => safeRelPath("a/../../x")).toThrow();
    expect(() => safeRelPath("/etc/passwd")).toThrow();
    expect(() => safeRelPath("C:/x")).toThrow();
    expect(safeRelPath("./a//b/./c.txt")).toBe("a/b/c.txt");
    expect(safeRelPath("./")).toBeNull();
  });
  it("symlink containment", () => {
    expect(linkStaysInside("/r", "a/link", "../b")).toBe(true);
    expect(linkStaysInside("/r", "a/link", "../../etc")).toBe(false);
    expect(linkStaysInside("/r", "link", "/etc/passwd")).toBe(false);
  });
});

describe("extractArchive", () => {
  it("extracts a normal tar.gz (exec bits, nested dirs, inner symlink)", async () => {
    const src = path.join(tmp, "src1");
    fs.mkdirSync(path.join(src, "a/b"), { recursive: true });
    fs.writeFileSync(path.join(src, "a/b/file.txt"), "hello");
    fs.writeFileSync(path.join(src, "run.sh"), "#!/bin/sh\n", { mode: 0o755 });
    fs.symlinkSync("a/b/file.txt", path.join(src, "link"));
    execFileSync("tar", ["czf", path.join(tmp, "ok.tgz"), "-C", src, "."]);
    const dest = path.join(tmp, "out1");
    const r = await extractArchive(path.join(tmp, "ok.tgz"), dest);
    expect(r.format).toBe("tar.gz");
    expect(fs.readFileSync(path.join(dest, "a/b/file.txt"), "utf8")).toBe("hello");
    expect(fs.statSync(path.join(dest, "run.sh")).mode & 0o111).toBeTruthy();
    expect(fs.readlinkSync(path.join(dest, "link"))).toBe("a/b/file.txt");
  });

  it("rejects ../ entries", async () => {
    py(`import tarfile,io
t=tarfile.open('evil.tgz','w:gz'); d=b'pwn'; i=tarfile.TarInfo('../evil.txt'); i.size=len(d); t.addfile(i,io.BytesIO(d)); t.close()`);
    await expect(extractArchive(path.join(tmp, "evil.tgz"), path.join(tmp, "out2"))).rejects.toThrow(/traversal/i);
    expect(fs.existsSync(path.join(tmp, "evil.txt"))).toBe(false);
  });

  it("skips symlinks escaping the root and never writes through them", async () => {
    py(`import tarfile,io
t=tarfile.open('link.tar','w')
l=tarfile.TarInfo('esc'); l.type=tarfile.SYMTYPE; l.linkname='/tmp'; t.addfile(l)
d=b'x'; i=tarfile.TarInfo('esc/owned.txt'); i.size=1; t.addfile(i,io.BytesIO(d)); t.close()`);
    const dest = path.join(tmp, "out3");
    // the link is skipped, so esc/ becomes a normal directory inside the root
    const r = await extractArchive(path.join(tmp, "link.tar"), dest);
    expect(r.skipped.join()).toContain("outside");
    expect(fs.lstatSync(path.join(dest, "esc")).isSymbolicLink()).toBe(false);
    expect(fs.existsSync("/tmp/owned.txt")).toBe(false);
  });

  it("refuses to write through an inner symlink", async () => {
    py(`import tarfile,io
t=tarfile.open('link2.tar','w')
l=tarfile.TarInfo('dir'); l.type=tarfile.SYMTYPE; l.linkname='.'; t.addfile(l)
d=b'x'; i=tarfile.TarInfo('dir/f.txt'); i.size=1; t.addfile(i,io.BytesIO(d)); t.close()`);
    await expect(extractArchive(path.join(tmp, "link2.tar"), path.join(tmp, "out4"))).rejects.toThrow(/symlink/);
  });

  it("enforces size limits", async () => {
    py(`import tarfile,io
t=tarfile.open('big.tgz','w:gz'); d=b'0'*200000; i=tarfile.TarInfo('big.bin'); i.size=len(d); t.addfile(i,io.BytesIO(d)); t.close()`);
    await expect(extractArchive(path.join(tmp, "big.tgz"), path.join(tmp, "out5"), { maxBytes: 100_000 })).rejects.toThrow(/too large/);
  });

  it("extracts zip (deflate + stored) and rejects zip-slip", async () => {
    py(`import zipfile
z=zipfile.ZipFile('ok.zip','w'); z.writestr('app/index.html','<h1>hi</h1>', compress_type=zipfile.ZIP_DEFLATED); z.writestr('app/raw.txt','raw', compress_type=zipfile.ZIP_STORED); z.close()
z=zipfile.ZipFile('slip.zip','w'); z.writestr('../../slip.txt','x'); z.close()`);
    const dest = path.join(tmp, "out6");
    const r = await extractArchive(path.join(tmp, "ok.zip"), dest);
    expect(r.format).toBe("zip");
    expect(fs.readFileSync(path.join(dest, "app/index.html"), "utf8")).toBe("<h1>hi</h1>");
    expect(fs.readFileSync(path.join(dest, "app/raw.txt"), "utf8")).toBe("raw");
    await expect(extractArchive(path.join(tmp, "slip.zip"), path.join(tmp, "out7"))).rejects.toThrow(/traversal/i);
  });

  it("rejects unknown formats", async () => {
    fs.writeFileSync(path.join(tmp, "x.bin"), "not an archive at all");
    await expect(extractArchive(path.join(tmp, "x.bin"), path.join(tmp, "out8"))).rejects.toThrow(/Unsupported/);
  });
});
