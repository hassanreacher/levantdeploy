/**
 * Repairs for weak models: tolerant JSON parsing and tool calls emitted as text instead of native tool_calls.
 */
import type { ToolCall } from "./types";

/** Strips code fences, leading prose, trailing commas, smart quotes; returns parsed JSON or throws. */
export function parseJsonLoose(text: string): unknown {
  const t = text.trim();
  try {
    return JSON.parse(t);
  } catch {}
  const candidates: string[] = [];
  const fence = /```(?:json|javascript|js|ts)?\s*\n?([\s\S]*?)```/gi;
  for (let m; (m = fence.exec(t)); ) candidates.push(m[1]);
  const obj = extractBalanced(t, "{", "}");
  if (obj) candidates.push(obj);
  const arr = extractBalanced(t, "[", "]");
  if (arr) candidates.push(arr);
  candidates.push(t);
  for (const c of candidates) {
    for (const fix of [(s: string) => s, cleanJson]) {
      try {
        return JSON.parse(fix(c.trim()));
      } catch {}
    }
  }
  throw new Error("Could not parse JSON from the model output");
}

function cleanJson(s: string): string {
  return s
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/,\s*([}\]])/g, "$1")
    .replace(/^﻿/, "");
}

/** First balanced {...} / [...] substring (string-aware). */
export function extractBalanced(s: string, open: string, close: string, from = 0): string | null {
  const start = s.indexOf(open, from);
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

/** Arguments string → object (tolerant). Returns null when hopeless. */
export function parseArgs(args: string | undefined | null): Record<string, unknown> | null {
  if (!args || !args.trim()) return {};
  try {
    const v = parseJsonLoose(args);
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    if (typeof v === "string") return parseArgs(v); // double-encoded
  } catch {}
  return null;
}

let seq = 0;
const newId = () => `call_r${Date.now().toString(36)}${(seq++).toString(36)}`;

/**
 * Finds tool calls written as text by models without (reliable) native tool calling. Recognised shapes:
 *  - <tool_call>{"name": "...", "arguments": {...}}</tool_call>   (Hermes/Qwen)
 *  - ```json {"name"|"tool"|"function": "...", "arguments"|"args"|"parameters"|"input": {...}} ```
 *  - {"tool_calls": [{"function": {"name": ..., "arguments": "..."}}]}
 *  - write_file({"path": ..., ...})                                (function-call syntax)
 * Only names in `known` are accepted.
 */
export function repairToolCalls(content: string, known: Set<string>): ToolCall[] {
  if (!content || !content.trim()) return [];
  const out: ToolCall[] = [];
  const push = (name: unknown, args: unknown) => {
    if (typeof name !== "string" || !known.has(name)) return;
    const a = typeof args === "string" ? args : JSON.stringify(args ?? {});
    out.push({ id: newId(), name, arguments: a });
  };
  const fromObj = (o: unknown) => {
    if (!o || typeof o !== "object") return;
    if (Array.isArray(o)) return o.forEach(fromObj);
    const r = o as Record<string, unknown>;
    if (Array.isArray(r.tool_calls)) return r.tool_calls.forEach(fromObj);
    if (r.function && typeof r.function === "object") {
      const f = r.function as Record<string, unknown>;
      return push(f.name, f.arguments ?? f.parameters);
    }
    const name = r.name ?? r.tool ?? r.tool_name ?? (typeof r.function === "string" ? r.function : undefined) ?? r.action;
    const args = r.arguments ?? r.args ?? r.parameters ?? r.input ?? r.action_input;
    if (name) push(name, args);
  };

  // 1. tagged blocks
  const tag = /<(tool_call|function_call|tool)>([\s\S]*?)<\/\1>/gi;
  for (let m; (m = tag.exec(content)); ) {
    try {
      fromObj(parseJsonLoose(m[2]));
    } catch {}
  }
  if (out.length) return out;

  // 2. fenced / bare JSON objects
  const fence = /```(?:json|tool_call|tool)?\s*\n?([\s\S]*?)```/gi;
  const blocks: string[] = [];
  for (let m; (m = fence.exec(content)); ) blocks.push(m[1]);
  if (!blocks.length) {
    let from = 0;
    for (let k = 0; k < 20; k++) {
      const b = extractBalanced(content, "{", "}", from);
      if (!b) break;
      blocks.push(b);
      from = content.indexOf(b, from) + b.length;
    }
  }
  for (const b of blocks) {
    try {
      fromObj(parseJsonLoose(b));
    } catch {}
  }
  if (out.length) return out;

  // 3. name({...})
  const call = /\b([a-z_][a-z0-9_]*)\s*\(\s*\{/gi;
  for (let m; (m = call.exec(content)); ) {
    if (!known.has(m[1])) continue;
    const obj = extractBalanced(content, "{", "}", m.index + m[0].length - 1);
    if (!obj) continue;
    try {
      push(m[1], parseJsonLoose(obj));
    } catch {}
  }
  return out;
}
