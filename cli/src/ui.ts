import readline from "node:readline";
import pc from "picocolors";

export const c = pc;
export const isTTY = () => !!process.stdout.isTTY && !process.env.CI;
export const info = (...a: unknown[]) => console.error(...a);
export const ok = (msg: string) => console.error(`${pc.green("✔")} ${msg}`);
export const warn = (msg: string) => console.error(`${pc.yellow("!")} ${msg}`);
export const fail = (msg: string) => console.error(`${pc.red("✖")} ${msg}`);

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function progress(label: string) {
  let last = 0;
  return {
    update(done: number, total: number) {
      if (!process.stderr.isTTY) return;
      const now = Date.now();
      if (now - last < 80 && done < total) return;
      last = now;
      const w = 24;
      const pct = total ? done / total : 1;
      const bar = "█".repeat(Math.round(pct * w)).padEnd(w, "░");
      process.stderr.write(`\r${label} ${pc.dim(bar)} ${Math.round(pct * 100)}% ${pc.dim(`${formatBytes(done)}/${formatBytes(total)}`)}   `);
    },
    done() {
      if (process.stderr.isTTY) process.stderr.write("\r\x1b[K");
    },
  };
}

export function ask(question: string, def?: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((res) =>
    rl.question(`${pc.cyan("?")} ${question}${def ? pc.dim(` (${def})`) : ""} `, (a) => {
      rl.close();
      res(a.trim() || def || "");
    }),
  );
}

export async function confirm(question: string, def = true): Promise<boolean> {
  const a = (await ask(`${question} ${pc.dim(def ? "[Y/n]" : "[y/N]")}`)).toLowerCase();
  return a ? a.startsWith("y") : def;
}

export async function select<T>(question: string, items: { label: string; value: T }[]): Promise<T> {
  items.forEach((it, i) => info(`  ${pc.dim(String(i + 1).padStart(2))}  ${it.label}`));
  for (;;) {
    const a = await ask(`${question} [1-${items.length}]`, "1");
    const n = Number(a);
    if (n >= 1 && n <= items.length) return items[n - 1]!.value;
  }
}

export function table(rows: string[][], header?: string[]) {
  const all = header ? [header, ...rows] : rows;
  // eslint-disable-next-line no-control-regex
  const vis = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").length;
  const widths = all[0]?.map((_, i) => Math.max(...all.map((r) => vis(r[i] ?? "")))) ?? [];
  const line = (r: string[]) => r.map((cell, i) => cell + " ".repeat(Math.max(0, widths[i]! - vis(cell)))).join("  ");
  if (header) console.log(pc.dim(line(header)));
  for (const r of rows) console.log(line(r));
}

export function timeAgo(d: string | number | Date) {
  const s = Math.round((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export const STATUS_COLOR: Record<string, (s: string) => string> = {
  READY: pc.green,
  ERROR: pc.red,
  CANCELED: pc.dim,
  BUILDING: pc.yellow,
  DEPLOYING: pc.yellow,
  QUEUED: pc.dim,
  SUPERSEDED: pc.dim,
};
export const status = (s: string) => (STATUS_COLOR[s] ?? ((x: string) => x))(`● ${s[0]}${s.slice(1).toLowerCase()}`);

/** Log lines carry ANSI colours from the server; keep them for terminals, strip them for pipes/files or NO_COLOR. */
export function logText(s: string, stream: NodeJS.WriteStream): string {
  return stream.isTTY && !process.env.NO_COLOR ? s : s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}
