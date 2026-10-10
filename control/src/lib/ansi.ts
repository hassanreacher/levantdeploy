/**
 * Minimal ANSI SGR parser for log lines → styled segments (no HTML, safe to render as text).
 * Supports reset, bold, dim, italic, underline, 16 colours (30–37, 90–97, 40–47, 100–107),
 * 256-colour (38;5;n / 48;5;n) and truecolor (38;2;r;g;b). Other escape sequences are stripped.
 */
export type AnsiStyle = { fg?: string; bg?: string; bold?: boolean; dim?: boolean; italic?: boolean; underline?: boolean };
export type AnsiSegment = { text: string; style: AnsiStyle };

const BASE = ["#4d4d4d", "#ff5f56", "#4ec27c", "#f5a623", "#3291ff", "#c678dd", "#2fb8c7", "#d4d4d4"];
const BRIGHT = ["#808080", "#ff7b72", "#7ee2a2", "#ffd479", "#79b8ff", "#e29ef5", "#6be3f0", "#ffffff"];

function color256(n: number): string {
  if (n < 8) return BASE[n]!;
  if (n < 16) return BRIGHT[n - 8]!;
  if (n < 232) {
    const i = n - 16;
    const c = [Math.floor(i / 36), Math.floor((i % 36) / 6), i % 6].map((v) => (v ? v * 40 + 55 : 0));
    return `rgb(${c[0]},${c[1]},${c[2]})`;
  }
  const g = (n - 232) * 10 + 8;
  return `rgb(${g},${g},${g})`;
}

// eslint-disable-next-line no-control-regex
const ESC_RE = /\u001b\[([0-9;]*)([A-Za-z])|\u001b\][^\u0007]*\u0007|\u001b[()][A-Za-z0-9]|\r/g;

export function parseAnsi(input: string): AnsiSegment[] {
  const out: AnsiSegment[] = [];
  let style: AnsiStyle = {};
  let last = 0;
  ESC_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ESC_RE.exec(input))) {
    if (m.index > last) out.push({ text: input.slice(last, m.index), style });
    last = ESC_RE.lastIndex;
    if (m[2] !== "m") continue; // non-SGR: strip
    const codes = (m[1] || "0").split(";").map((x) => Number(x || 0));
    style = { ...style };
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i]!;
      if (c === 0) style = {};
      else if (c === 1) style.bold = true;
      else if (c === 2) style.dim = true;
      else if (c === 3) style.italic = true;
      else if (c === 4) style.underline = true;
      else if (c === 22) style.bold = style.dim = false;
      else if (c === 23) style.italic = false;
      else if (c === 24) style.underline = false;
      else if (c >= 30 && c <= 37) style.fg = BASE[c - 30];
      else if (c >= 90 && c <= 97) style.fg = BRIGHT[c - 90];
      else if (c >= 40 && c <= 47) style.bg = BASE[c - 40];
      else if (c >= 100 && c <= 107) style.bg = BRIGHT[c - 100];
      else if (c === 39) style.fg = undefined;
      else if (c === 49) style.bg = undefined;
      else if ((c === 38 || c === 48) && codes[i + 1] === 5) {
        const col = color256(codes[i + 2] ?? 0);
        if (c === 38) style.fg = col;
        else style.bg = col;
        i += 2;
      } else if ((c === 38 || c === 48) && codes[i + 1] === 2) {
        const col = `rgb(${codes[i + 2] ?? 0},${codes[i + 3] ?? 0},${codes[i + 4] ?? 0})`;
        if (c === 38) style.fg = col;
        else style.bg = col;
        i += 4;
      }
    }
  }
  if (last < input.length) out.push({ text: input.slice(last), style });
  return out.filter((s) => s.text.length > 0);
}

export function stripAnsi(input: string): string {
  return input.replace(ESC_RE, "");
}
