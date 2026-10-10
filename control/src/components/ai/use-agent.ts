"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiClientError } from "@/lib/client/api";
import type { AgentEvent, RunState, UiAction, UiBlock, UiConversation, UiMessage } from "@/lib/ai/types";

export type DraftBlock = { index: number } & UiBlock;
export type AgentNotice = { id: number; code: string; message: string; transient?: boolean };

/** POST that returns a text/event-stream of AgentEvent; calls onEvent for each `data:` line. */
async function postStream(path: string, payload: unknown, onEvent: (ev: AgentEvent) => void, signal: AbortSignal) {
  const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), credentials: "same-origin", signal });
  if (!res.ok || !res.body) {
    let err: { code?: string; message?: string; fields?: Record<string, string> } | undefined;
    try {
      err = ((await res.json()) as { error?: typeof err }).error;
    } catch {}
    throw new ApiClientError(res.status, err?.code ?? `HTTP_${res.status}`, err?.message ?? `Request failed (${res.status})`, err?.fields);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let sep: number;
    while ((sep = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      const data = chunk
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      try {
        onEvent(JSON.parse(data) as AgentEvent);
      } catch {}
    }
  }
}

let noticeSeq = 0;

export function useAgent(opts: { team: string; project?: string | null; conversationId?: string | null; onConversation?: (c: UiConversation) => void }) {
  const [conversation, setConversation] = useState<UiConversation | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [actions, setActions] = useState<Record<string, UiAction>>({});
  const [draft, setDraft] = useState<DraftBlock[]>([]);
  const [state, setState] = useState<RunState>("idle");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [notices, setNotices] = useState<AgentNotice[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const onConv = useRef(opts.onConversation);
  onConv.current = opts.onConversation;
  /** id of the conversation currently shown (so selecting the one we just created doesn't reload it mid-stream) */
  const currentId = useRef<string | null>(null);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    currentId.current = null;
    setConversation(null);
    setMessages([]);
    setActions({});
    setDraft([]);
    setNotices([]);
    setState("idle");
    setBusy(false);
  }, []);

  const load = useCallback(async (id: string) => {
    setLoading(true);
    try {
      const r = await api<{ conversation: UiConversation; messages: UiMessage[]; actions: UiAction[]; state: RunState }>(`/api/v1/ai/conversations/${id}`);
      currentId.current = r.conversation.id;
      setConversation(r.conversation);
      setMessages(r.messages);
      setActions(Object.fromEntries(r.actions.map((a) => [a.id, a])));
      setState(r.state === "running" ? "idle" : r.state);
      setDraft([]);
      setNotices([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (opts.conversationId) {
      if (opts.conversationId !== currentId.current) void load(opts.conversationId).catch(() => reset());
    } else reset();
  }, [opts.conversationId, load, reset]);

  const onEvent = useCallback((ev: AgentEvent) => {
    switch (ev.type) {
      case "message_start":
        setDraft([]);
        break;
      case "text_delta":
      case "thinking_delta":
        setDraft((d) => {
          const kind = ev.type === "text_delta" ? "text" : "thinking";
          const i = d.findIndex((b) => b.index === ev.index);
          if (i < 0) return [...d, { index: ev.index, type: kind, text: ev.text } as DraftBlock];
          const cur = d[i]!;
          const next = [...d];
          next[i] = { ...cur, text: ("text" in cur ? cur.text : "") + ev.text } as DraftBlock;
          return next;
        });
        break;
      case "tool_use_start":
        setDraft((d) => [...d, { index: ev.index, type: "tool_use", id: ev.id, name: ev.name, input: {} }]);
        break;
      case "fallback":
        setDraft((d) => [...d, { index: 10_000 + d.length, type: "fallback", from: ev.from, to: ev.to }]);
        break;
      case "message":
        if (ev.message.role === "assistant") setDraft([]);
        setMessages((m) => (m.some((x) => x.id === ev.message.id) ? m : [...m, ev.message]));
        break;
      case "action":
        setActions((a) => ({ ...a, [ev.action.id]: ev.action }));
        break;
      case "awaiting_approval":
        setState("awaiting_approval");
        break;
      case "title":
        setConversation((c) => (c ? { ...c, title: ev.title } : c));
        break;
      case "refusal":
        break; // rendered from the stored message (stop_reason refusal)
      case "error":
        setNotices((n) => [...n.filter((x) => !x.transient), { id: ++noticeSeq, code: ev.code, message: ev.message, transient: ev.code === "RETRYING" }]);
        break;
      case "done":
        setState(ev.state);
        setDraft([]);
        setNotices((n) => n.filter((x) => !x.transient));
        break;
    }
  }, []);

  const runStream = useCallback(
    async (path: string, payload: unknown) => {
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      setBusy(true);
      setState("running");
      try {
        await postStream(path, payload, onEvent, ac.signal);
      } catch (e) {
        if ((e as Error).name !== "AbortError") {
          setNotices((n) => [...n, { id: ++noticeSeq, code: (e as ApiClientError).code ?? "ERROR", message: (e as Error).message }]);
          throw e;
        }
      } finally {
        setBusy(false);
        setDraft([]);
        setState((s) => (s === "running" ? "idle" : s));
        if (abortRef.current === ac) abortRef.current = null;
      }
    },
    [onEvent],
  );

  const ensureConversation = useCallback(async () => {
    if (conversation) return conversation;
    const r = await api<{ conversation: UiConversation }>("/api/v1/ai/conversations", { body: { team: opts.team, project: opts.project ?? null } });
    currentId.current = r.conversation.id;
    setConversation(r.conversation);
    onConv.current?.(r.conversation);
    return r.conversation;
  }, [conversation, opts.team, opts.project]);

  const send = useCallback(
    async (content: string, page?: { deploymentId?: string | null; path?: string | null }) => {
      const c = await ensureConversation();
      setNotices([]);
      await runStream(`/api/v1/ai/conversations/${c.id}/messages`, { content, page });
    },
    [ensureConversation, runStream],
  );

  const approve = useCallback((actionId: string, confirmText?: string) => runStream(`/api/v1/ai/actions/${actionId}/approve`, { confirmText }), [runStream]);
  const reject = useCallback((actionId: string, reason?: string) => runStream(`/api/v1/ai/actions/${actionId}/reject`, { reason }), [runStream]);
  const stop = useCallback(() => abortRef.current?.abort(), []);
  const dismissNotice = useCallback((id: number) => setNotices((n) => n.filter((x) => x.id !== id)), []);

  return { conversation, messages, actions, draft, state, busy, loading, notices, send, approve, reject, stop, reset, load, dismissNotice };
}

export type AgentHandle = ReturnType<typeof useAgent>;
