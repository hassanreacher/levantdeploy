import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyToSource, classGroup, mergeClasses, normalizeOp, parseSrc, prettierFormat, VisualEditError, type VisualOp } from "./visual-edit";
import { safeRelPath, FileError } from "./files";

const FILE = "app/page.tsx";

// line numbers matter: elements are addressed as "app/page.tsx:line:col"
const FIXTURE = `import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col">
      <h1 className="text-4xl font-bold tracking-tight">Build something</h1>
      <p className={cn("mt-6 text-lg", "text-muted-foreground")}>Short description</p>
      <Button size="lg">
        Start
        <ArrowRight className="ml-2 h-4 w-4" />
      </Button>
      <img src="/a.png" alt="A" className="rounded" />
      <section id="one">One</section>
      <section id="two">Two</section>
      <Link href="/about">About {1 + 1}</Link>
    </main>
  );
}
`;

const fmt = (c: string) => prettierFormat(c, path.join(os.tmpdir(), "lv-fixture", "page.tsx"));

async function run(ops: VisualOp[], code = FIXTURE) {
  return applyToSource(FILE, code, ops, { format: fmt });
}

const src = (line: number, col: number) => `${FILE}:${line}:${col}`;
const H1 = src(9, 7);
const P = src(10, 7);
const BUTTON = src(11, 7);
const IMG = src(15, 7);
const SEC1 = src(16, 7);
const SEC2 = src(17, 7);
const LINK = src(18, 7);
const MAIN = src(8, 5);

describe("visual-edit: addressing", () => {
  it("parses data-lv-src", () => {
    expect(parseSrc("app/page.tsx:12:5")).toEqual({ file: "app/page.tsx", line: 12, col: 5 });
    expect(() => parseSrc("../etc/passwd.tsx:1:1")).toThrow();
    expect(() => parseSrc("app/page.ts:1:1")).toThrow(VisualEditError);
    expect(() => parseSrc("nope")).toThrow(VisualEditError);
  });
  it("reports a stale position", async () => {
    await expect(run([{ op: "setText", src: src(9, 8), text: "x" }])).rejects.toThrow(/not found/);
  });
  it("normalizes spec aliases", () => {
    expect(normalizeOp({ op: "setClassName", src: H1, classes: "a b" })).toMatchObject({ op: "setClass", className: "a b" });
    expect(normalizeOp({ op: "remove", src: H1 })).toEqual({ op: "delete", src: H1 });
    expect(normalizeOp({ op: "move", src: SEC2, beforeSrc: SEC1 })).toEqual({ op: "move", src: SEC2, target: SEC1, position: "before" });
    expect(normalizeOp({ op: "insertComponent", targetSrc: SEC1, position: "after", componentId: "hero" })).toEqual({ op: "insert", target: SEC1, position: "after", component: "hero" });
    expect(() => normalizeOp({ op: "explode" })).toThrow(VisualEditError);
  });
});

describe("visual-edit: setText", () => {
  it("replaces a text-only element's text, keeping the rest of the file", async () => {
    const r = await run([{ op: "setText", src: H1, text: "Hello world" }]);
    expect(r.code).toContain('<h1 className="text-4xl font-bold tracking-tight">Hello world</h1>');
    expect(r.code).toContain("Short description");
    expect(r.results[0]!.description).toMatch(/text of <h1>/);
  });
  it("escapes JSX-special characters", async () => {
    const r = await run([{ op: "setText", src: H1, text: "a {b} <c>" }]);
    expect(r.code).toContain('{"a {b} <c>"}');
  });
  it("keeps icons next to the text", async () => {
    const r = await run([{ op: "setText", src: BUTTON, text: "Go now" }]);
    expect(r.code).toMatch(/Go now\s*<ArrowRight/);
  });
  it("refuses computed text", async () => {
    const r = run([{ op: "setText", src: LINK, text: "x" }]);
    await expect(r).rejects.toThrow(VisualEditError);
  });
});

describe("visual-edit: setClass + merge helper", () => {
  it("merges tailwind classes by conflict group", () => {
    expect(mergeClasses("text-4xl font-bold text-red-500 p-4", ["text-2xl", "text-blue-600", "px-2"])).toBe("font-bold p-4 text-2xl text-blue-600 px-2");
    expect(mergeClasses("md:text-lg text-sm", ["text-base"])).toBe("md:text-lg text-base");
    expect(mergeClasses("flex hidden", ["block"])).toBe("block");
    expect(mergeClasses("rounded-lg border", [], ["border"])).toBe("rounded-lg");
    expect(classGroup("hover:bg-primary/90")).toBe("hover:|bg-color");
    expect(classGroup("text-[22px]")).toBe("|text-size");
  });
  it("updates a string className", async () => {
    const r = await run([{ op: "setClass", src: H1, add: ["text-6xl", "text-primary"] }]);
    expect(r.code).toContain('className="font-bold tracking-tight text-6xl text-primary"');
  });
  it("updates the first literal of cn()", async () => {
    const r = await run([{ op: "setClass", src: P, add: ["mt-10"], remove: ["text-lg"] }]);
    expect(r.code).toContain('className={cn("mt-10", "text-muted-foreground")}');
  });
  it("adds className when missing and replaces with className", async () => {
    const r = await run([
      { op: "setClass", src: SEC1, add: ["py-20"] },
      { op: "setClass", src: IMG, className: "rounded-xl shadow" },
    ]);
    expect(r.code).toContain('<section id="one" className="py-20">');
    expect(r.code).toContain('className="rounded-xl shadow"');
  });
});

describe("visual-edit: setStyle / setAttr", () => {
  it("sets and removes inline styles", async () => {
    const r = await run([{ op: "setStyle", src: H1, style: { color: "#ff0000", "font-size": "40px" } }]);
    expect(r.code.replace(/\s+/g, " ")).toMatch(/style=\{\{ color: "#ff0000", fontSize: "40px",? \}\}/);
    const r2 = await run([{ op: "setStyle", src: H1, style: { color: null, fontSize: null } }], r.code);
    expect(r2.code).not.toContain("style=");
  });
  it("sets img src/alt and link href; rejects unsafe values", async () => {
    const r = await run([
      { op: "setAttr", src: IMG, name: "src", value: "https://example.com/x.png" },
      { op: "setAttr", src: IMG, name: "alt", value: 'A "nice" image' },
      { op: "setAttr", src: LINK, name: "href", value: "/contact" },
    ]);
    expect(r.code).toContain('src="https://example.com/x.png"');
    expect(r.code).toContain(`alt={'A "nice" image'}`);
    expect(r.code).toContain('href="/contact"');
    await expect(run([{ op: "setAttr", src: LINK, name: "href", value: "javascript:alert(1)" }])).rejects.toThrow(/Unsafe/);
    await expect(run([{ op: "setAttr", src: LINK, name: "onClick", value: "x" }])).rejects.toThrow(/can't be edited/);
  });
});

describe("visual-edit: move / duplicate / delete", () => {
  it("moves a sibling before another and returns its new position", async () => {
    const r = await run([{ op: "move", src: SEC2, target: SEC1, position: "before" }]);
    expect(r.code.indexOf('id="two"')).toBeLessThan(r.code.indexOf('id="one"'));
    expect(r.results[0]!.newSrc).toBe(src(16, 7));
    expect(r.code).not.toContain("data-lv-new");
  });
  it("moves after", async () => {
    const r = await run([{ op: "move", src: H1, target: SEC2, position: "after" }]);
    const lines = r.code.split("\n");
    expect(lines.findIndex((l) => l.includes("<h1"))).toBeGreaterThan(lines.findIndex((l) => l.includes('id="two"')));
  });
  it("only moves within the same parent", async () => {
    await expect(run([{ op: "move", src: H1, target: MAIN, position: "before" }])).rejects.toThrow(/root|same parent/);
  });
  it("duplicates an element (without id/key)", async () => {
    const r = await run([{ op: "duplicate", src: SEC1 }]);
    expect(r.code.match(/>One</g)?.length).toBe(2);
    expect(r.code.match(/id="one"/g)?.length).toBe(1);
    expect(r.results[0]!.newSrc).toBe(src(17, 7));
  });
  it("deletes an element and prunes imports it alone used", async () => {
    const r = await run([{ op: "delete", src: BUTTON }]);
    expect(r.code).not.toContain("<Button");
    expect(r.code).not.toContain("@/components/ui/button");
    expect(r.code).not.toContain("lucide-react");
    expect(r.code).toContain('import Link from "next/link"');
  });
  it("refuses to delete a component's root element", async () => {
    await expect(run([{ op: "delete", src: MAIN }])).rejects.toThrow(/root/);
  });
});

describe("visual-edit: asChild (Radix Slot) pairs", () => {
  const CODE = `export default function X() {
  return (
    <div>
      <Button asChild>
        <Link href="/a">A</Link>
      </Button>
      <span>after</span>
    </div>
  );
}
`;
  const LINK = "app/page.tsx:5:9";
  it("duplicates / deletes the asChild parent, edits text on the child", async () => {
    const d = await applyToSource(FILE, CODE, [{ op: "duplicate", src: LINK }], { format: fmt });
    expect(d.code.match(/<Button asChild>/g)?.length).toBe(2);
    const del = await applyToSource(FILE, CODE, [{ op: "delete", src: LINK }], { format: fmt });
    expect(del.code).not.toContain("Button");
    const t = await applyToSource(FILE, CODE, [{ op: "setText", src: LINK, text: "B" }], { format: fmt });
    expect(t.code).toContain('<Link href="/a">B</Link>');
    const m = await applyToSource(FILE, CODE, [{ op: "move", src: "app/page.tsx:7:7", target: LINK, position: "before" }], { format: fmt });
    expect(m.code.indexOf("<span>")).toBeLessThan(m.code.indexOf("<Button"));
  });
});

describe("visual-edit: insert component", () => {
  it("inserts a library section after a target and adds the import", async () => {
    const r = await run([{ op: "insert", target: SEC2, position: "after", component: "pricing" }]);
    expect(r.code).toContain('import Pricing from "@/components/sections/pricing";');
    expect(r.code).toMatch(/<section id="two">Two<\/section>\s*<Pricing \/>/);
    expect(r.results[0]!.newSrc).toMatch(/^app\/page\.tsx:\d+:7$/);
  });
  it("inserts inside (end) and avoids name clashes", async () => {
    const code = FIXTURE.replace('import { cn } from "@/lib/utils";', 'import { cn } from "@/lib/utils";\nconst Hero = 1;');
    const r = await run([{ op: "insert", target: src(10, 7), position: "inside", component: "hero" }], code.replace("<h1", "<div").replace("</h1>", "</div>"));
    expect(r.code).toContain('import Hero2 from "@/components/sections/hero";');
    expect(r.code).toContain("<Hero2 />");
  });
  it("applies several ops resolved against original positions", async () => {
    const r = await run([
      { op: "setText", src: SEC1, text: "First" },
      { op: "delete", src: H1 },
      { op: "setText", src: SEC2, text: "Second" },
    ]);
    expect(r.code).toContain(">First<");
    expect(r.code).toContain(">Second<");
    expect(r.code).not.toContain("<h1");
  });
});

describe("files: path safety", () => {
  it("rejects escapes and protected paths", () => {
    expect(safeRelPath("app/page.tsx")).toBe("app/page.tsx");
    expect(safeRelPath("./app//x.ts")).toBe("app/x.ts");
    for (const bad of ["../x", "/etc/passwd", "a/../../b", ".git/config", "node_modules/x/y.js", ".env.local", "app/.env", "a\0b", "C:/x"]) {
      expect(() => safeRelPath(bad), bad).toThrow(FileError);
    }
  });
});

// keep the fixture honest: positions used above must point at the intended tags
describe("fixture", () => {
  it("has the expected tags at the referenced positions", () => {
    const lines = FIXTURE.split("\n");
    const at = (s: string) => {
      const { line, col } = parseSrc(s);
      return lines[line - 1]!.slice(col - 1, col + 8);
    };
    expect(at(H1)).toMatch(/^<h1/);
    expect(at(BUTTON)).toMatch(/^<Button/);
    expect(at(SEC1)).toMatch(/^<section/);
    expect(at(MAIN)).toMatch(/^<main/);
    expect(fs.existsSync(path.resolve(__dirname, "../../../../builder-template/library/pricing.tsx"))).toBe(true);
  });
});
