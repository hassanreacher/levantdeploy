"use client";

import { cn } from "@/lib/utils";

export function Switch({
  checked,
  onCheckedChange,
  disabled,
  label,
  id,
  size = "md",
}: {
  checked: boolean;
  onCheckedChange?: (v: boolean) => void;
  disabled?: boolean;
  label?: string;
  id?: string;
  size?: "sm" | "md";
}) {
  const dims = size === "sm" ? { track: "h-4 w-7", thumb: "h-3 w-3", on: "translate-x-3" } : { track: "h-5 w-9", thumb: "h-4 w-4", on: "translate-x-4" };
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onCheckedChange?.(!checked)}
      className={cn(
        "relative inline-flex shrink-0 items-center rounded-full border border-transparent p-0.5 transition-colors disabled:opacity-50",
        dims.track,
        checked ? "bg-accent" : "bg-border-strong",
      )}
    >
      <span className={cn("rounded-full bg-white shadow transition-transform", dims.thumb, checked ? dims.on : "translate-x-0")} />
    </button>
  );
}
