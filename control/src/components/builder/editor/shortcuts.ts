export const SHORTCUTS: { label: string; keys: string[] }[] = [
  { label: "Send message", keys: ["Enter"] },
  { label: "New line", keys: ["Shift", "Enter"] },
  { label: "Toggle visual edit", keys: ["Mod", "E"] },
  { label: "Preview / Code / History", keys: ["Alt", "1–3"] },
  { label: "Undo / redo visual edit", keys: ["Mod", "Z"] },
  { label: "Save file (Code)", keys: ["Mod", "S"] },
  { label: "Publish", keys: ["Mod", "Shift", "P"] },
  { label: "Deselect / leave visual edit", keys: ["Esc"] },
  { label: "Show shortcuts", keys: ["?"] },
];

export function modKey(): string {
  if (typeof navigator === "undefined") return "Ctrl";
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? "⌘" : "Ctrl";
}

export function isEditableTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || !!el.closest?.(".cm-editor");
}
