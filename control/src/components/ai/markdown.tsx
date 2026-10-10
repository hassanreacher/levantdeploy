"use client";

import { Fragment, memo, type ReactNode } from "react";
import { CopyButton } from "@/components/ui/copy-button";
import { cn } from "@/lib/utils";

/**
 * Small, dependency-free Markdown renderer for agent output (no HTML injection: everything becomes React text).
 * Supports headings, paragraphs, lists, block quotes, rules, pipe tables, fenced code (with copy) and
 * inline code / bold / italic / links. Tolerates partial input while streaming (an open fence renders as code).
 */
type Node =
  | { t: "code"; lang: string; text: string }
  | { t: "h"; level: number; text: string }
  | { t: "p"; text: string }
  | { t: "ul" | "ol"; items: string[]; start?: number }
  | { t: "quote"; text: string }
  | { t: "hr" }
  | { t: "table"; head: string[]; rows: string[][] };

function parse(src: string): Node[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: Node[] = [];
  let i = 0;
  const isBlockStart = (l: string) => /^(```|~~~)/.test(l) || /^#{1,6}\s/.test(l) || /^\s*([-*+]|\d+[.)])\s+/.test(l) || /^>\s?/.test(l) || /^(\s*[-*_]){3,}\s*$/.test(l);
  while (i < lines.length) {
    const line = lines[i]!;
    const fence = /^(```|~~~)\s*([\w+#.-]*)/.exec(line);
    if (fence) {
      const close = fence[1]!;
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith(close)) body.push(lines[i++]!);
      i++;
      out.push({ t: "code", lang: fence[2] ?? "", text: body.join("\n") });
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      out.push({ t: "h", level: h[1]!.length, text: h[2]! });
      i++;
      continue;
    }
    if (/^(\s*[-*_]){3,}\s*$/.test(line)) {
      out.push({ t: "hr" });
      i++;
      continue;
    }
    if (/^>\s?/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]!)) body.push(lines[i++]!.replace(/^>\s?/, ""));
      out.push({ t: "quote", text: body.join("\n") });
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1]!)) {
      const cells = (l: string) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]!)) rows.push(cells(lines[i++]!));
      out.push({ t: "table", head, rows });
      continue;
    }
    const li = /^\s*([-*+]|(\d+)[.)])\s+(.*)$/.exec(line);
    if (li) {
      const ordered = !!li[2];
      const items: string[] = [];
      const start = ordered ? Number(li[2]) : undefined;
      while (i < lines.length) {
        const m = /^\s*([-*+]|(\d+)[.)])\s+(.*)$/.exec(lines[i]!);
        if (m && !!m[2] === ordered) {
          items.push(m[3]!);
          i++;
        } else if (lines[i]!.trim() && /^\s{2,}/.test(lines[i]!) && items.length) {
          items[items.length - 1] += " " + lines[i]!.trim();
          i++;
        } else break;
      }
      out.push({ t: ordered ? "ol" : "ul", items, start });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !(para.length && isBlockStart(lines[i]!))) para.push(lines[i++]!);
    out.push({ t: "p", text: para.join("\n") });
  }
  return out;
}

const SAFE_URL = /^(https?:\/\/|\/(?!\/)|mailto:)/i;

/** Inline: `code`, **bold**, *italic* / _italic_, [text](url), bare https URLs. */
export function inline(text: string, keyBase = "i"): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`+)([^`]+?)\1|\*\*([^*]+?)\*\*|__([^_]+?)__|(?<![\w*])\*([^*\n]+?)\*(?!\w)|(?<![\w_])_([^_\n]+?)_(?!\w)|\[([^\]]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const key = `${keyBase}-${k++}`;
    if (m[2] !== undefined) out.push(<code key={key} className="rounded border border-border bg-surface-2 px-1 py-px font-mono text-[12.5px] text-fg">{m[2]}</code>);
    else if (m[3] !== undefined || m[4] !== undefined) out.push(<strong key={key} className="font-semibold text-fg">{inline(m[3] ?? m[4]!, key)}</strong>);
    else if (m[5] !== undefined || m[6] !== undefined) out.push(<em key={key}>{inline(m[5] ?? m[6]!, key)}</em>);
    else if (m[7] !== undefined) {
      const href = m[8]!;
      out.push(
        SAFE_URL.test(href) ? (
          <a key={key} href={href} target={href.startsWith("/") ? undefined : "_blank"} rel="noopener noreferrer" className="text-accent underline-offset-2 hover:underline">
            {inline(m[7], key)}
          </a>
        ) : (
          <span key={key}>{m[7]}</span>
        ),
      );
    } else if (m[9] !== undefined)
      out.push(
        <a key={key} href={m[9]} target="_blank" rel="noopener noreferrer" className="break-all text-accent underline-offset-2 hover:underline">
          {m[9]}
        </a>,
      );
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function withBreaks(text: string, key: string) {
  const parts = text.split("\n");
  return parts.map((p, i) => (
    <Fragment key={`${key}-${i}`}>
      {inline(p, `${key}-${i}`)}
      {i < parts.length - 1 && <br />}
    </Fragment>
  ));
}

export function CodeFence({ code, lang }: { code: string; lang?: string }) {
  return (
    <div className="group relative my-2 overflow-hidden rounded-lg border border-border bg-bg-subtle">
      <div className="flex h-8 items-center justify-between border-b border-border px-3">
        <span className="font-mono text-[11px] text-subtle">{lang || "text"}</span>
        <CopyButton value={code} className="-mr-1.5 h-6" />
      </div>
      <pre className="overflow-x-auto p-3 font-mono text-[12.5px] leading-relaxed text-fg">{code}</pre>
    </div>
  );
}

export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }) {
  const nodes = parse(text);
  return (
    <div className={cn("space-y-2 text-[14px] leading-relaxed text-fg", className)}>
      {nodes.map((n, i) => {
        const key = `n${i}`;
        switch (n.t) {
          case "code":
            return <CodeFence key={key} code={n.text} lang={n.lang} />;
          case "h":
            return (
              <p key={key} className={cn("font-semibold tracking-tight text-fg", n.level <= 2 ? "pt-1 text-[15px]" : "text-[14px]")}>
                {inline(n.text, key)}
              </p>
            );
          case "p":
            return <p key={key}>{withBreaks(n.text, key)}</p>;
          case "ul":
            return (
              <ul key={key} className="ml-5 list-disc space-y-1 marker:text-subtle">
                {n.items.map((it, j) => (
                  <li key={j}>{inline(it, `${key}-${j}`)}</li>
                ))}
              </ul>
            );
          case "ol":
            return (
              <ol key={key} start={n.start} className="ml-5 list-decimal space-y-1 marker:text-subtle">
                {n.items.map((it, j) => (
                  <li key={j}>{inline(it, `${key}-${j}`)}</li>
                ))}
              </ol>
            );
          case "quote":
            return (
              <blockquote key={key} className="border-l-2 border-border-strong pl-3 text-muted">
                {withBreaks(n.text, key)}
              </blockquote>
            );
          case "hr":
            return <hr key={key} className="border-border" />;
          case "table":
            return (
              <div key={key} className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-left text-[13px]">
                  <thead className="bg-surface-2 text-muted">
                    <tr>
                      {n.head.map((h, j) => (
                        <th key={j} className="px-3 py-1.5 font-medium">
                          {inline(h, `${key}-h${j}`)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {n.rows.map((r, j) => (
                      <tr key={j} className="border-t border-border">
                        {r.map((c, k) => (
                          <td key={k} className="px-3 py-1.5">
                            {inline(c, `${key}-${j}-${k}`)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
        }
      })}
    </div>
  );
});
