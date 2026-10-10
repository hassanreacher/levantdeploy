import { describe, expect, it } from "vitest";
import { classGroup, colorClass, currentOf, splitVariant, swapClass } from "./tailwind";
import { diffStats, diffTexts, parseUnifiedDiff } from "./diff";
import { emptyRun, providerChips, reduceRun } from "./run-state";
import { elementLabel, isBridgeMessage, parseSrc } from "./bridge";
import { nameFromPrompt } from "./prompts";
import { SECTION_LIBRARY, sectionById } from "./sections";
import type { RunEvent } from "./types";

describe("tailwind helpers", () => {
  it("classifies classes into style groups", () => {
    expect(classGroup("text-xl")).toBe("fontSize");
    expect(classGroup("text-center")).toBe("align");
    expect(classGroup("text-red-500")).toBe("textColor");
    expect(classGroup("text-primary-foreground")).toBe("textColor");
    expect(classGroup("text-[#ff0000]")).toBe("textColor");
    expect(classGroup("text-[18px]")).toBe("fontSize");
    expect(classGroup("bg-white")).toBe("bgColor");
    expect(classGroup("bg-gradient-to-r")).toBeNull();
    expect(classGroup("px-4")).toBe("padding");
    expect(classGroup("-mt-2")).toBe("margin");
    expect(classGroup("rounded-xl")).toBe("radius");
    expect(classGroup("max-w-2xl")).toBe("width");
    expect(classGroup("font-bold")).toBe("fontWeight");
    expect(classGroup("flex")).toBeNull();
  });
  it("splits variants (incl. arbitrary values)", () => {
    expect(splitVariant("md:hover:text-lg")).toEqual({ variant: "md:hover:", base: "text-lg" });
    expect(splitVariant("bg-[url(https://x)]")).toEqual({ variant: "", base: "bg-[url(https://x)]" });
    expect(splitVariant("md:bg-[url(https://x)]")).toEqual({ variant: "md:", base: "bg-[url(https://x)]" });
  });
  it("swaps a group's base class but keeps responsive variants", () => {
    const r = swapClass("text-4xl font-bold md:text-6xl tracking-tight", "fontSize", "text-5xl");
    expect(r.remove).toEqual(["text-4xl"]);
    expect(r.add).toEqual(["text-5xl"]);
    expect(r.className).toBe("font-bold md:text-6xl tracking-tight text-5xl");
    expect(currentOf(r.className, "fontSize")).toBe("text-5xl");
  });
  it("removes a group when next is null and is a no-op when unchanged", () => {
    expect(swapClass("p-4 text-center", "align", null)).toMatchObject({ remove: ["text-center"], add: [], className: "p-4" });
    expect(swapClass("p-4 text-center", "align", "text-center")).toMatchObject({ remove: [], add: [] });
  });
  it("respects padding axes", () => {
    expect(swapClass("px-4 py-2", "padding", "p-6").remove).toEqual(["px-4", "py-2"]);
    expect(swapClass("px-4 py-2 pl-1", "padding", "px-8")).toMatchObject({ remove: ["px-4", "pl-1"], add: ["px-8"] });
  });
  it("builds arbitrary color classes", () => {
    expect(colorClass("text", "#ff0000")).toBe("text-[#ff0000]");
    expect(colorClass("bg", "primary")).toBe("bg-primary");
  });
});

describe("diff helpers", () => {
  it("parses a multi-file git diff", () => {
    const patch = [
      "diff --git a/app/page.tsx b/app/page.tsx",
      "--- a/app/page.tsx",
      "+++ b/app/page.tsx",
      "@@ -1,3 +1,3 @@",
      " a",
      "-b",
      "+B",
      " c",
      "diff --git a/new.ts b/new.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.ts",
      "@@ -0,0 +1 @@",
      "+x",
    ].join("\n");
    const files = parseUnifiedDiff(patch);
    expect(files).toHaveLength(2);
    expect(files[0]).toMatchObject({ path: "app/page.tsx", status: "modified", additions: 1, deletions: 1 });
    expect(files[1]).toMatchObject({ path: "new.ts", status: "added", additions: 1 });
    expect(files[0]!.lines.find((l) => l.kind === "add")).toMatchObject({ text: "B", newNo: 2 });
  });
  it("parses a bare hunk with a fallback path", () => {
    expect(parseUnifiedDiff("@@ -1 +1 @@\n-a\n+b", "x.css")[0]).toMatchObject({ path: "x.css", additions: 1, deletions: 1 });
  });
  it("diffs two texts with collapsed context", () => {
    const a = Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n");
    const b = a.replace("l10", "L10");
    const lines = diffTexts(a, b, 2);
    expect(diffStats(lines)).toEqual({ additions: 1, deletions: 1 });
    expect(lines[0]!.kind).toBe("hunk");
    expect(lines.filter((l) => l.kind === "ctx")).toHaveLength(4);
  });
  it("handles identical texts", () => {
    expect(diffTexts("a\nb", "a\nb")).toEqual([]);
  });
});

describe("run reducer", () => {
  const ev = (seq: number, type: string, data: Record<string, unknown>) => ({ seq, type, data }) as RunEvent;
  it("builds the chat view from events and ignores duplicates", () => {
    let s = emptyRun("r1");
    const events = [
      ev(1, "status", { status: "RUNNING" }),
      ev(2, "plan", { summary: "Add pricing", steps: [{ title: "Plan", status: "pending" }, { title: "Code", status: "pending" }] }),
      ev(3, "step", { index: 0, title: "Plan", status: "done" }),
      ev(4, "step", { index: 1, title: "Code", status: "running" }),
      ev(5, "provider", { provider: "groq", model: "llama", fallbackFrom: { provider: "gemini", reason: "429" } }),
      ev(6, "tool_call", { id: "t1", name: "write_file", args: { path: "app/page.tsx" } }),
      ev(7, "delta", { text: "Hello " }),
      ev(8, "delta", { text: "world" }),
      ev(9, "tool_result", { id: "t1", name: "write_file", ok: true }),
      ev(10, "commit", { sha: "abc", message: "Add pricing", files: [{ path: "app/page.tsx", status: "modified" }] }),
      ev(11, "check", { kind: "build", ok: true }),
      ev(12, "suggestions", { items: ["a", "b", "c", "d", "e"] }),
      ev(13, "status", { status: "SUCCEEDED" }),
    ];
    for (const e of events) s = reduceRun(s, e);
    s = reduceRun(s, ev(8, "delta", { text: "dup" }));
    expect(s.status).toBe("SUCCEEDED");
    expect(s.text).toBe("Hello world");
    expect(s.planSummary).toBe("Add pricing");
    expect(s.steps.map((x) => x.status)).toEqual(["done", "done"]);
    expect(s.tools[0]).toMatchObject({ label: "Writing app/page.tsx", ok: true, done: true });
    expect(s.commits).toHaveLength(1);
    expect(s.checks[0]!.ok).toBe(true);
    expect(s.suggestions).toHaveLength(4);
    expect(providerChips(s.providers)[0]!.label).toBe("groq, fell back from gemini");
  });
  it("labels builder-agents tool events and collapses retry notices", () => {
    let s = reduceRun(emptyRun("r"), ev(1, "tool", { name: "read_file", args: "start_line=1 path=components/hero.tsx", ok: true }));
    expect(s.tools[0]).toMatchObject({ label: "Reading components/hero.tsx", done: true, ok: true });
    s = reduceRun(s, ev(2, "warning", { message: "all AI providers are busy — waiting 5s and retrying" }));
    s = reduceRun(s, ev(3, "warning", { message: "all AI providers are busy — waiting 10s and retrying" }));
    expect(s.notices).toHaveLength(1);
    s = reduceRun(s, ev(4, "phase", { phase: "plan", label: "Planning" }));
    s = reduceRun(s, ev(5, "phase", { phase: "code", label: "Writing code" }));
    s = reduceRun(s, ev(6, "file", { path: "a.tsx", action: "create", diff: "@@ -1 +1 @@\n+x" }));
    s = reduceRun(s, ev(7, "commit", { sha: "abc", message: "Code" }));
    expect(s.steps.map((x) => [x.title, x.status])).toEqual([["Planning", "done"], ["Writing code", "running"]]);
    expect(s.commits[0]!.files[0]).toMatchObject({ path: "a.tsx", status: "added", additions: 1 });
    expect(s.pendingFiles).toHaveLength(0);
  });
  it("marks running steps failed when the run fails", () => {
    let s = reduceRun(emptyRun("r"), ev(1, "plan", { steps: [{ title: "x", status: "running" }] }));
    s = reduceRun(s, ev(2, "status", { status: "FAILED", error: "All providers failed" }));
    expect(s.steps[0]!.status).toBe("failed");
    expect(s.error).toBe("All providers failed");
  });
  it("final message replaces the streamed text", () => {
    let s = reduceRun(emptyRun("r"), ev(1, "delta", { text: "partial" }));
    s = reduceRun(s, ev(2, "message", { content: "final" }));
    expect(s.text).toBe("final");
  });
});

describe("bridge protocol", () => {
  it("validates messages and parses sources", () => {
    expect(isBridgeMessage({ __lv: 1, type: "ready" })).toBe(true);
    expect(isBridgeMessage({ type: "ready" })).toBe(false);
    expect(isBridgeMessage(null)).toBe(false);
    expect(parseSrc("app/(site)/page.tsx:12:5")).toEqual({ file: "app/(site)/page.tsx", line: 12, col: 5 });
    expect(parseSrc("nope")).toBeNull();
    expect(elementLabel({ tag: "H1" })).toBe("Heading 1");
    expect(elementLabel({ tag: "x-foo" })).toBe("<x-foo>");
  });
});

describe("prompts & sections", () => {
  it("derives a short app name", () => {
    expect(nameFromPrompt("An online store for my bakery with pickup times")).toBe("Online store bakery");
    expect(nameFromPrompt("!!!")).toBe("New app");
  });
  it("has the required section library (ids = builder-core library components)", () => {
    for (const id of ["hero", "features", "pricing", "testimonials", "faq", "cta", "footer", "navbar", "contact-form", "gallery", "stats", "team", "blog-list", "auth-forms"]) {
      expect(sectionById(id), id).toBeTruthy();
    }
    expect(new Set(SECTION_LIBRARY.map((s) => s.id)).size).toBe(SECTION_LIBRARY.length);
  });
});
