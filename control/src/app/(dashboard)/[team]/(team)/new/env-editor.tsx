"use client";

import { Plus, Trash2, ClipboardPaste } from "lucide-react";
import { useState } from "react";
import { Button, Input, Textarea } from "@/components/ui";

export type EnvRow = { key: string; value: string };

/** Parses .env text (KEY=value, export KEY=…, quotes, # comments). */
export function parseDotenv(text: string): EnvRow[] {
  const out: EnvRow[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2]!;
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      const dq = v.startsWith('"');
      v = v.slice(1, -1);
      if (dq) v = v.replace(/\\n/g, "\n").replace(/\\"/g, '"');
    } else v = v.replace(/\s+#.*$/, "");
    out.push({ key: m[1]!, value: v });
  }
  return out;
}

export function EnvEditor({ rows, onChange }: { rows: EnvRow[]; onChange: (rows: EnvRow[]) => void }) {
  const [paste, setPaste] = useState(false);
  const [text, setText] = useState("");
  const merge = (add: EnvRow[]) => {
    const map = new Map(rows.filter((r) => r.key).map((r) => [r.key, r.value]));
    for (const a of add) map.set(a.key, a.value);
    onChange([...map.entries()].map(([key, value]) => ({ key, value })));
  };
  const list = rows.length ? rows : [{ key: "", value: "" }];
  return (
    <div className="space-y-2">
      {list.map((r, i) => (
        <div key={i} className="grid grid-cols-[1fr_1fr_auto] gap-2">
          <Input
            aria-label="Key"
            placeholder="EXAMPLE_NAME"
            className="font-mono text-[13px]"
            value={r.key}
            onPaste={(e) => {
              const t = e.clipboardData.getData("text");
              if (t.includes("=") && t.includes("\n")) {
                e.preventDefault();
                merge(parseDotenv(t));
              }
            }}
            onChange={(e) => onChange(list.map((x, j) => (j === i ? { ...x, key: e.target.value.trim() } : x)))}
          />
          <Input aria-label="Value" placeholder="value" className="font-mono text-[13px]" value={r.value} onChange={(e) => onChange(list.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
          <Button size="icon" variant="ghost" aria-label="Remove" onClick={() => onChange(list.filter((_, j) => j !== i))}>
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ))}
      <div className="flex flex-wrap gap-2 pt-1">
        <Button size="sm" variant="secondary" leftIcon={<Plus className="h-3.5 w-3.5" />} onClick={() => onChange([...list, { key: "", value: "" }])}>
          Add more
        </Button>
        <Button size="sm" variant="ghost" leftIcon={<ClipboardPaste className="h-3.5 w-3.5" />} onClick={() => setPaste(!paste)}>
          Paste .env
        </Button>
      </div>
      {paste && (
        <div className="space-y-2">
          <Textarea rows={5} className="font-mono text-xs" placeholder={"DATABASE_URL=postgres://…\nAPI_KEY=…"} value={text} onChange={(e) => setText(e.target.value)} />
          <Button
            size="sm"
            onClick={() => {
              merge(parseDotenv(text));
              setText("");
              setPaste(false);
            }}
          >
            Import {parseDotenv(text).length || ""} variables
          </Button>
        </div>
      )}
      <p className="text-xs text-subtle">Tip: paste a whole .env file into a key field. Values are encrypted at rest and available to all environments.</p>
    </div>
  );
}
