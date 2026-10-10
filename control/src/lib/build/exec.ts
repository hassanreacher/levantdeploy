import { spawn } from "node:child_process";

/**
 * Spawn a command, stream every output line to `onLine`, support cancellation (AbortSignal) and timeouts.
 * The child runs in its own process group so the whole tree is killed on cancel.
 */
export type ExecOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  onLine?: (line: string, stream: "stdout" | "stderr") => void;
  /** strings to redact from output lines (tokens) */
  redact?: string[];
  /** keep the last N lines (default 200) */
  tail?: number;
  input?: string;
};

export type ExecResult = { code: number | null; signal: NodeJS.Signals | null; tail: string[]; timedOut: boolean; aborted: boolean; durationMs: number };

export class ExecError extends Error {
  constructor(
    message: string,
    public result: ExecResult,
  ) {
    super(message);
  }
}

export function redactLine(line: string, redact: string[] = []): string {
  let out = line;
  for (const r of redact) if (r && r.length >= 4) out = out.split(r).join("***");
  return out;
}

export function execStream(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return resolve({ code: null, signal: "SIGTERM", tail: [], timedOut: false, aborted: true, durationMs: 0 });
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, detached: true, stdio: [opts.input ? "pipe" : "ignore", "pipe", "pipe"] });
    const tailMax = opts.tail ?? 200;
    const tail: string[] = [];
    let timedOut = false;
    let aborted = false;
    let killTimer: NodeJS.Timeout | null = null;

    const kill = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try {
        process.kill(-child.pid!, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
      killTimer = setTimeout(() => {
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }, 5000);
      killTimer.unref();
    };
    const onAbort = () => {
      aborted = true;
      kill();
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          kill();
        }, opts.timeoutMs)
      : null;

    const pipe = (s: NodeJS.ReadableStream, name: "stdout" | "stderr") => {
      let buf = "";
      s.setEncoding("utf8");
      s.on("data", (chunk: string) => {
        buf += chunk;
        let i: number;
        while ((i = buf.search(/\r?\n|\r(?!\n)/)) >= 0) {
          const m = buf.match(/\r?\n|\r(?!\n)/)!;
          const line = redactLine(buf.slice(0, i), opts.redact);
          buf = buf.slice(i + m[0].length);
          emit(line, name);
        }
        if (buf.length > 64 * 1024) {
          emit(redactLine(buf, opts.redact), name);
          buf = "";
        }
      });
      s.on("end", () => {
        if (buf) emit(redactLine(buf, opts.redact), name);
        buf = "";
      });
    };
    const emit = (line: string, name: "stdout" | "stderr") => {
      tail.push(line);
      if (tail.length > tailMax) tail.shift();
      opts.onLine?.(line, name);
    };
    pipe(child.stdout!, "stdout");
    pipe(child.stderr!, "stderr");
    if (opts.input && child.stdin) {
      child.stdin.end(opts.input);
    }
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      reject(e);
    });
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ code, signal, tail, timedOut, aborted, durationMs: Date.now() - started });
    });
  });
}

/** execStream that throws ExecError on non-zero exit / timeout / abort. */
export async function execOk(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  const r = await execStream(cmd, args, opts);
  if (r.aborted) throw new ExecError(`${cmd} canceled`, r);
  if (r.timedOut) throw new ExecError(`${cmd} timed out`, r);
  if (r.code !== 0) throw new ExecError(`${cmd} ${args[0] ?? ""} exited with code ${r.code ?? r.signal}`, r);
  return r;
}

/** Collect stdout (small outputs) */
export async function execCapture(cmd: string, args: string[], opts: Omit<ExecOptions, "onLine"> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const r = await execStream(cmd, args, {
    ...opts,
    tail: 1,
    onLine: (l, s) => {
      if (s === "stdout") stdout += l + "\n";
      else stderr += l + "\n";
    },
  });
  return { code: r.code, stdout, stderr };
}
