import { appendLog } from "@/lib/logs";

/**
 * Batched BUILD log writer: lines are buffered and flushed every 250 ms / 200 lines so a chatty docker build
 * doesn't do one Redis round-trip per line. Step headers are bold + prefixed with ▲ (rendered by the LogViewer).
 */
export class BuildLog {
  private buf: string[] = [];
  private timer: NodeJS.Timeout | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  /** last N lines (for error messages) */
  tail: string[] = [];
  constructor(
    private deploymentId: string,
    private sink: (id: string, lines: string[]) => Promise<unknown> = (id, lines) => appendLog(id, "BUILD", lines),
  ) {}

  line(s: string) {
    for (const l of s.replace(/\r\n/g, "\n").split("\n")) {
      this.buf.push(l);
      this.tail.push(l);
      if (this.tail.length > 300) this.tail.shift();
    }
    if (this.buf.length >= 200) void this.flush();
    else if (!this.timer) this.timer = setTimeout(() => void this.flush(), 250);
  }
  /** bold step header */
  step(s: string) {
    this.line(`\x1b[1m▲ ${s}\x1b[0m`);
  }
  info(s: string) {
    this.line(`  ${s}`);
  }
  warn(s: string) {
    this.line(`\x1b[33m! ${s}\x1b[0m`);
  }
  error(s: string) {
    this.line(`\x1b[31m✕ ${s}\x1b[0m`);
  }
  success(s: string) {
    this.line(`\x1b[32m✓ ${s}\x1b[0m`);
  }
  flush(): Promise<unknown> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.buf.length) return this.chain;
    const lines = this.buf;
    this.buf = [];
    this.chain = this.chain.then(() => this.sink(this.deploymentId, lines)).catch((e) => console.warn("[build] appendLog failed", (e as Error).message));
    return this.chain;
  }
}

const NOISE = [
  /^#\d+ (DONE|CACHED|\[internal\])/,
  /^#\d+ (sha256:|extracting|resolve|exporting|naming|writing|unpacking|transferring)/,
  /^#\d+ \d+(\.\d+)? (npm (notice|warn)|warning )/i,
  /^-{4,}$/,
  /^\s*$/,
  /^\s*\d+ \| /,
  /^ > \[/,
  /^Dockerfile:\d+$/,
  /^#\d+ \[[^\]]+\] (RUN|COPY|FROM|WORKDIR|ENV|ARG)/,
  /did not complete successfully/,
  /^\s*>{1,3} ?(\[|RUN|COPY)/,
  /^#\d+ ERROR: process "/,
];

/** Last meaningful lines of a failed build for Deployment.errorMessage (≤ 6 lines, ≤ 1000 chars). */
export function summarizeError(tail: string[], fallback: string): string {
  const cleaned = tail
    .map((l) =>
      l
        .replace(/\x1b\[[0-9;]*m/g, "")
        .replace(/^#\d+ \d+(\.\d+)? /, "")
        .trimEnd(),
    )
    .filter((l) => !NOISE.some((re) => re.test(l)));
  // collapse repeated lines (e.g. 300 × "No space left on device")
  for (let i = cleaned.length - 1; i > 0; i--) if (cleaned[i] === cleaned[i - 1]) cleaned.splice(i, 1);
  // explicit "Error: …" / "ERR!" lines are the best cause indicators
  const explicit = cleaned.filter((l) => /^\s*(\[?\w*Error\]?: |error(\[\w+\])?: |npm ERR!|ERROR: (?!failed to (build|solve)))/.test(l));
  if (explicit.length) return explicit.slice(-4).join("\n").slice(0, 1000);
  const err = cleaned.filter((l) => /error|failed|cannot|could not|not found|no such|denied|ERR!|exception|panic|fatal|invalid|unable|forbidden|unauthorized|✕/i.test(l));
  const pick = (err.length ? err : cleaned).slice(-6);
  const msg = pick.join("\n").trim();
  return (msg || fallback).slice(0, 1000);
}
