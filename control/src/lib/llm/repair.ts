import { randomBytes } from "node:crypto";
import type { LlmToolCall } from "./types";

/**
 * JSON / tool-call repair for weaker models: strips markdown fences, extracts the first JSON value from prose,
 * fixes trailing commas, smart quotes, Python literals, single-quoted strings, unquoted keys and truncated output
 * (closes open strings/brackets). Never throws.
 */
export function repairJson(input: string): { ok: true; value: unknown; text: string } | { ok: false; error: string } {
  const raw = (input ?? "").trim();
  if (!raw) return { ok: false, error: "empty" };
  const direct = tryParse(raw);
  if (direct.ok) return { ok: true, value: direct.value, text: raw };

  let s = stripFences(raw);
  const extracted = extractJson(s);
  if (extracted) s = extracted;
  for (const candidate of [s, fixCommon(s), closeOpen(fixCommon(s))]) {
    const r = tryParse(candidate);
    if (r.ok) return { ok: true, value: r.value, text: candidate };
  }
  return { ok: false, error: "could not repair JSON" };
}

function tryParse(s: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch {
    return { ok: false };
  }
}

export function stripFences(s: string): string {
  const m = s.match(/```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)(?:```|$)/);
  return m ? m[1].trim() : s.trim();
}

/** First balanced {...} or [...] (string-aware); if unbalanced, everything from the first opener. */
export function extractJson(s: string): string | null {
  const start = s.search(/[{[]/);
  if (start < 0) return null;
  let depth = 0;
  let inStr: string | null = null;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"') inStr = c;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return s.slice(start);
}

function fixCommon(s: string): string {
  let out = s
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/,\s*([}\]])/g, "$1");
  // Python literals / undefined outside strings
  out = mapOutsideStrings(out, (chunk) =>
    chunk
      .replace(/\bTrue\b/g, "true")
      .replace(/\bFalse\b/g, "false")
      .replace(/\bNone\b/g, "null")
      .replace(/\bundefined\b/g, "null")
      // unquoted keys: { foo: 1, bar_baz: 2 }
      .replace(/([{,]\s*)([A-Za-z_$][\w$-]*)(\s*:)/g, '$1"$2"$3'),
  );
  // single-quoted strings → double-quoted
  if (!/"/.test(out) || /'[^']*'\s*:/.test(out)) {
    out = out.replace(/'((?:[^'\\]|\\.)*)'/g, (_m, inner: string) => JSON.stringify(inner.replace(/\\'/g, "'")));
  }
  return out;
}

function mapOutsideStrings(s: string, fn: (chunk: string) => string): string {
  let out = "";
  let buf = "";
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      out += c;
      if (c === "\\" && i + 1 < s.length) out += s[++i];
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      out += fn(buf) + c;
      buf = "";
      inStr = true;
    } else buf += c;
  }
  return out + fn(buf);
}

/** Close an unterminated string and any open brackets (truncated output). */
function closeOpen(s: string): string {
  const stack: string[] = [];
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") stack.push("}");
    else if (c === "[") stack.push("]");
    else if (c === "}" || c === "]") stack.pop();
  }
  let out = s;
  if (inStr) out += '"';
  out = out.replace(/,\s*$/, "").replace(/:\s*$/, ": null");
  return out + stack.reverse().join("");
}

export const newCallId = () => `call_${randomBytes(9).toString("base64url")}`;

/** Normalise raw tool calls (arguments as string or object) into repaired LlmToolCalls. */
export function normalizeToolCalls(raw: { id?: string | null; name?: string | null; arguments?: unknown }[]): LlmToolCall[] {
  const out: LlmToolCall[] = [];
  for (const r of raw) {
    const name = (r.name ?? "").trim();
    if (!name) continue;
    out.push(toCall(name, r.arguments, r.id ?? undefined));
  }
  return out;
}

function toCall(name: string, args: unknown, id?: string): LlmToolCall {
  let input: Record<string, unknown> | null = null;
  let text = "{}";
  if (args && typeof args === "object" && !Array.isArray(args)) {
    input = args as Record<string, unknown>;
    text = JSON.stringify(input);
  } else if (typeof args === "string" && args.trim()) {
    const r = repairJson(args);
    if (r.ok && r.value && typeof r.value === "object" && !Array.isArray(r.value)) {
      input = r.value as Record<string, unknown>;
      text = JSON.stringify(input);
    } else if (r.ok && typeof r.value === "string") {
      // double-encoded arguments ("{\"a\":1}")
      const inner = repairJson(r.value);
      if (inner.ok && inner.value && typeof inner.value === "object") {
        input = inner.value as Record<string, unknown>;
        text = JSON.stringify(input);
      } else text = args;
    } else text = args;
  } else {
    input = {};
  }
  return { id: id || newCallId(), name, arguments: text, input };
}

type Loose = Record<string, unknown>;

function fromObject(o: unknown, names: Set<string> | null): LlmToolCall[] {
  if (Array.isArray(o)) return o.flatMap((x) => fromObject(x, names));
  if (!o || typeof o !== "object") return [];
  const obj = o as Loose;
  if (Array.isArray(obj.tool_calls)) return fromObject(obj.tool_calls, names);
  const fn = (obj.function && typeof obj.function === "object" ? obj.function : obj) as Loose;
  const name = (fn.name ?? fn.tool ?? fn.tool_name ?? fn.function) as unknown;
  if (typeof name !== "string" || !name) return [];
  if (names && !names.has(name)) return [];
  const args = fn.arguments ?? fn.parameters ?? fn.args ?? fn.input ?? {};
  return [toCall(name, args, typeof obj.id === "string" ? obj.id : undefined)];
}

/**
 * Tool calls written as text by models without native tool calling. Recognises:
 *   <tool_call>{"name":…,"arguments":…}</tool_call>   (Hermes / Qwen)
 *   <function=name>{…}</function>                     (Llama)
 *   [TOOL_CALLS] [{"name":…,"arguments":…}]           (Mistral)
 *   ```json {"name"|"tool":…, "arguments"|"parameters"|"args"|"input":…} ```   and bare JSON / {"tool_calls":[…]}
 * With `toolNames`, only calls to known tools are accepted (prevents treating ordinary JSON answers as calls).
 * Returns the calls and the remaining text.
 */
export function parseToolCallsFromText(text: string, toolNames?: string[]): { calls: LlmToolCall[]; text: string } {
  const names = toolNames?.length ? new Set(toolNames) : null;
  if (!text || !/[{[<]/.test(text)) return { calls: [], text };
  let rest = text;
  const calls: LlmToolCall[] = [];

  rest = rest.replace(/<tool_call>\s*([\s\S]*?)\s*(?:<\/tool_call>|$)/g, (m, body: string) => {
    const r = repairJson(body);
    const c = r.ok ? fromObject(r.value, names) : [];
    calls.push(...c);
    return c.length ? "" : m;
  });
  rest = rest.replace(/<function=([\w.-]+)>\s*([\s\S]*?)\s*(?:<\/function>|$)/g, (m, name: string, body: string) => {
    if (names && !names.has(name)) return m;
    calls.push(toCall(name, body.trim() || "{}"));
    return "";
  });
  rest = rest.replace(/\[TOOL_CALLS\]\s*(\[[\s\S]*\])/g, (m, body: string) => {
    const r = repairJson(body);
    const c = r.ok ? fromObject(r.value, names) : [];
    calls.push(...c);
    return c.length ? "" : m;
  });
  if (calls.length) return { calls, text: rest.trim() };

  // fenced blocks
  rest = rest.replace(/```(?:json|tool_call|tool)?\s*\n?([\s\S]*?)```/g, (m, body: string) => {
    const r = repairJson(body);
    const c = r.ok ? fromObject(r.value, names) : [];
    calls.push(...c);
    return c.length ? "" : m;
  });
  if (calls.length) return { calls, text: rest.trim() };

  // bare JSON object(s) in the text
  const json = extractJson(text);
  if (json) {
    const r = repairJson(json);
    const c = r.ok ? fromObject(r.value, names) : [];
    if (c.length) return { calls: c, text: text.replace(json, "").trim() };
  }
  return { calls: [], text };
}
