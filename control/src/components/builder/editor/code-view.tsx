"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, File, FileCode2, Folder, FolderOpen, GitCompare, Loader2, Save, Search, X } from "lucide-react";
import { javascript } from "@codemirror/lang-javascript";
import { css } from "@codemirror/lang-css";
import { json } from "@codemirror/lang-json";
import { sql } from "@codemirror/lang-sql";
import { keymap, EditorView } from "@codemirror/view";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { builderApi } from "@/lib/builder-ui/api";
import { diffStats, diffTexts } from "@/lib/builder-ui/diff";
import type { FileEntry } from "@/lib/builder-ui/types";
import { DiffStat, DiffView } from "../diff-view";
import { errMessage, useEditor } from "./context";
import { modKey } from "./shortcuts";

const CodeMirror = dynamic(() => import("@uiw/react-codemirror"), { ssr: false, loading: () => <Skeleton className="h-full w-full rounded-none" /> });

type TreeNode = { name: string; path: string; dir: boolean; children: TreeNode[] };

export function buildTree(files: FileEntry[]): TreeNode[] {
  const root: TreeNode = { name: "", path: "", dir: true, children: [] };
  for (const f of files) {
    const parts = f.path.split("/");
    let cur = root;
    parts.forEach((p, i) => {
      const path = parts.slice(0, i + 1).join("/");
      const dir = i < parts.length - 1;
      let next = cur.children.find((c) => c.name === p && c.dir === dir);
      if (!next) {
        next = { name: p, path, dir, children: [] };
        cur.children.push(next);
      }
      cur = next;
    });
  }
  const sort = (n: TreeNode) => {
    n.children.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
    n.children.forEach(sort);
  };
  sort(root);
  return root.children;
}

function langFor(path: string) {
  if (/\.(tsx|jsx)$/.test(path)) return [javascript({ jsx: true, typescript: /\.tsx$/.test(path) })];
  if (/\.(ts|mts|cts)$/.test(path)) return [javascript({ typescript: true })];
  if (/\.(js|mjs|cjs)$/.test(path)) return [javascript()];
  if (/\.(css|scss)$/.test(path)) return [css()];
  if (/\.json$/.test(path)) return [json()];
  if (/\.sql$/.test(path)) return [sql()];
  return [];
}

const DEFAULT_OPEN = ["app", "src", "src/app", "components"];

export function CodeView() {
  const ed = useEditor();
  const toast = useToast();
  const B = useMemo(() => builderApi(), []);
  const [files, setFiles] = useState<FileEntry[] | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set(DEFAULT_OPEN));
  const [path, setPath] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [orig, setOrig] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [diff, setDiff] = useState<{ prev: string; ref: string } | null>(null);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<{ path: string; line: number; text: string }[] | null>(null);
  const [dark, setDark] = useState(true);
  const [treeOpen, setTreeOpen] = useState(true);
  const dirty = content !== orig;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  useEffect(() => {
    setDark(!document.documentElement.classList.contains("light"));
  }, []);

  const loadFiles = useCallback(async () => {
    try {
      const list = await B.files(ed.project.id);
      setFiles(list);
      setPath((p) => p ?? (list.find((f) => /^(src\/)?app\/page\.tsx$/.test(f.path))?.path ?? list[0]?.path ?? null));
    } catch (e) {
      toast.error("Could not list files", errMessage(e));
      setFiles([]);
    }
  }, [B, ed.project.id, toast]);
  useEffect(() => void loadFiles(), [loadFiles, ed.headVersion]);

  const openFile = useCallback(
    async (p: string, line?: number) => {
      if (dirtyRef.current && !confirm("Discard unsaved changes?")) return;
      setPath(p);
      setDiff(null);
      setLoading(true);
      try {
        const r = await B.readFile(ed.project.id, p);
        setContent(r.binary ? "// binary file" : r.content);
        setOrig(r.binary ? "// binary file" : r.content);
        if (line) setTimeout(() => scrollToLine(line), 150);
      } catch (e) {
        toast.error("Could not open the file", errMessage(e));
      } finally {
        setLoading(false);
      }
      // reveal in tree
      setOpen((o) => {
        const n = new Set(o);
        p.split("/").slice(0, -1).forEach((_, i, a) => n.add(a.slice(0, i + 1).join("/")));
        return n;
      });
      ed.setMobileTab("preview");
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [B, ed.project.id, toast],
  );

  // (re)load the current file when HEAD changes (agent commits) unless the user has unsaved edits
  useEffect(() => {
    if (!path || dirtyRef.current) return;
    let alive = true;
    B.readFile(ed.project.id, path).then(
      (r) => {
        if (!alive || dirtyRef.current) return;
        setContent(r.content);
        setOrig(r.content);
      },
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [B, ed.project.id, path, ed.headVersion]);

  const viewRef = useRef<EditorView | null>(null);
  const scrollToLine = (line: number) => {
    const v = viewRef.current;
    if (!v) return;
    const l = v.state.doc.line(Math.min(Math.max(1, line), v.state.doc.lines));
    v.dispatch({ selection: { anchor: l.from }, effects: EditorView.scrollIntoView(l.from, { y: "center" }) });
    v.focus();
  };

  const save = useCallback(async () => {
    if (!path || !dirtyRef.current) return;
    setSaving(true);
    try {
      const r = await B.writeFile(ed.project.id, path, content, `Edit ${path}`);
      setOrig(content);
      if (r.commit) ed.setProject({ ...ed.project, lastCommit: r.commit.sha });
      toast.success("Saved", r.commit ? `Committed ${r.commit.sha.slice(0, 7)} · the preview reloads automatically` : "No changes to commit");
    } catch (e) {
      toast.error("Could not save", errMessage(e));
    } finally {
      setSaving(false);
    }
  }, [B, ed, path, content, toast]);
  const saveRef = useRef(save);
  saveRef.current = save;

  const toggleDiff = async () => {
    if (diff) return setDiff(null);
    if (!path) return;
    try {
      const commits = await B.commits(ed.project.id);
      const prev = commits[1];
      if (!prev) return toast.info("No previous version yet");
      const r = await B.readFile(ed.project.id, path, prev.sha).catch(() => ({ content: "" }));
      setDiff({ prev: r.content, ref: prev.sha });
    } catch (e) {
      toast.error("Could not load the previous version", errMessage(e));
    }
  };

  const runSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!q.trim()) return setResults(null);
    try {
      setResults(await B.search(ed.project.id, q.trim()));
    } catch (err) {
      toast.error("Search failed", errMessage(err));
    }
  };

  const extensions = useMemo(
    () => [
      ...(path ? langFor(path) : []),
      keymap.of([{ key: "Mod-s", preventDefault: true, run: () => (void saveRef.current(), true) }]),
      EditorView.theme({ "&": { fontSize: "12.5px" }, ".cm-scroller": { fontFamily: "var(--font-geist-mono), ui-monospace, monospace" } }),
    ],
    [path],
  );
  const diffLines = useMemo(() => (diff ? diffTexts(diff.prev, content) : []), [diff, content]);

  return (
    <div className="flex min-h-0 flex-1" data-testid="code-view">
      <aside className={cn("w-full shrink-0 flex-col border-r border-border bg-bg sm:flex sm:w-60", treeOpen ? "flex" : "hidden sm:flex")}>
        <form onSubmit={runSearch} className="border-b border-border p-2">
          <div className="flex h-7 items-center gap-1.5 rounded-md border border-border bg-bg-subtle px-2 focus-within:border-border-strong">
            <Search className="h-3.5 w-3.5 shrink-0 text-subtle" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search in files" aria-label="Search in files" className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-subtle" />
            {results && (
              <button
                type="button"
                onClick={() => {
                  setResults(null);
                  setQ("");
                }}
                aria-label="Clear search"
              >
                <X className="h-3 w-3 text-subtle" />
              </button>
            )}
          </div>
        </form>
        <div className="min-h-0 flex-1 overflow-y-auto py-1 text-[12.5px]">
          {results ? (
            results.length ? (
              results.map((r, i) => (
                <button
                  key={i}
                  onClick={() => {
                    void openFile(r.path, r.line);
                    setTreeOpen(false);
                  }}
                  className="block w-full px-3 py-1 text-left hover:bg-surface-2"
                >
                  <span className="block truncate font-mono text-[11px] text-subtle">
                    {r.path}:{r.line}
                  </span>
                  <span className="block truncate font-mono text-[11.5px]">{r.text}</span>
                </button>
              ))
            ) : (
              <p className="px-3 py-2 text-subtle">No matches.</p>
            )
          ) : files === null ? (
            <div className="space-y-1.5 p-3">
              {Array.from({ length: 8 }, (_, i) => (
                <Skeleton key={i} className="h-4" />
              ))}
            </div>
          ) : (
            <Tree
              nodes={buildTree(files)}
              open={open}
              current={path}
              onToggle={(p) =>
                setOpen((o) => {
                  const n = new Set(o);
                  if (n.has(p)) n.delete(p);
                  else n.add(p);
                  return n;
                })
              }
              onOpen={(p) => {
                void openFile(p);
                setTreeOpen(false);
              }}
            />
          )}
        </div>
      </aside>
      <div className={cn("min-w-0 flex-1 flex-col", treeOpen ? "hidden sm:flex" : "flex")}>
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-2">
          <button onClick={() => setTreeOpen(true)} className="rounded p-1 text-muted hover:text-fg sm:hidden" aria-label="Show files">
            <Folder className="h-4 w-4" />
          </button>
          <FileCode2 className="hidden h-3.5 w-3.5 shrink-0 text-subtle sm:block" />
          <span className="min-w-0 flex-1 truncate font-mono text-[12px]">
            {path ?? "No file"}
            {dirty && <span className="ml-1.5 text-warning" title="Unsaved changes">●</span>}
          </span>
          {diff && <DiffStat {...diffStats(diffLines)} />}
          <Button size="sm" variant={diff ? "secondary" : "ghost"} leftIcon={<GitCompare className="h-3.5 w-3.5" />} onClick={() => void toggleDiff()} disabled={!path} aria-pressed={!!diff}>
            <span className="hidden sm:inline">Diff vs previous</span>
          </Button>
          <Button size="sm" variant="primary" leftIcon={<Save className="h-3.5 w-3.5" />} onClick={() => void save()} disabled={!dirty} loading={saving} title={`Save & commit (${modKey()}S)`} data-testid="code-save">
            Save
          </Button>
        </div>
        {ed.activeRunId && <p className="shrink-0 border-b border-warning/30 bg-warning/10 px-3 py-1 text-[12px] text-warning">The agents are editing files right now — your edits may conflict.</p>}
        <div className="relative min-h-0 flex-1 overflow-hidden">
          {loading && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-bg/60">
              <Loader2 className="h-5 w-5 animate-spin text-muted" />
            </div>
          )}
          {diff ? (
            <div className="h-full overflow-auto bg-bg">
              <p className="border-b border-border px-3 py-1.5 text-[12px] text-muted">
                Changes in this file since <span className="font-mono">{diff.ref.slice(0, 7)}</span> (previous version), including unsaved edits
              </p>
              <DiffView lines={diffLines} />
            </div>
          ) : path ? (
            <CodeMirror
              value={content}
              onChange={setContent}
              extensions={extensions}
              theme={dark ? "dark" : "light"}
              height="100%"
              style={{ height: "100%" }}
              basicSetup={{ tabSize: 2, foldGutter: true, highlightActiveLine: true }}
              onCreateEditor={(v) => (viewRef.current = v)}
              aria-label={`Code of ${path}`}
              className="h-full"
            />
          ) : (
            <p className="p-6 text-[13px] text-muted">Select a file.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function Tree({ nodes, open, current, onToggle, onOpen, depth = 0 }: { nodes: TreeNode[]; open: Set<string>; current: string | null; onToggle: (p: string) => void; onOpen: (p: string) => void; depth?: number }) {
  return (
    <ul role={depth === 0 ? "tree" : "group"} aria-label={depth === 0 ? "Files" : undefined}>
      {nodes.map((n) => (
        <li key={n.path} role="treeitem" aria-expanded={n.dir ? open.has(n.path) : undefined} aria-selected={current === n.path}>
          <button
            onClick={() => (n.dir ? onToggle(n.path) : onOpen(n.path))}
            className={cn("flex w-full items-center gap-1 py-[3px] pr-2 text-left transition-colors hover:bg-surface-2", current === n.path ? "bg-surface-2 text-fg" : "text-muted")}
            style={{ paddingLeft: 8 + depth * 12 }}
          >
            {n.dir ? (
              <>
                <ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform", open.has(n.path) && "rotate-90")} />
                {open.has(n.path) ? <FolderOpen className="h-3.5 w-3.5 shrink-0 text-subtle" /> : <Folder className="h-3.5 w-3.5 shrink-0 text-subtle" />}
              </>
            ) : (
              <File className="ml-4 h-3.5 w-3.5 shrink-0 text-subtle" />
            )}
            <span className="truncate">{n.name}</span>
          </button>
          {n.dir && open.has(n.path) && <Tree nodes={n.children} open={open} current={current} onToggle={onToggle} onOpen={onOpen} depth={depth + 1} />}
        </li>
      ))}
    </ul>
  );
}
