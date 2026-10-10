/** Formatting helpers for usage values (plans area; client + server). */
export type UsageUnit = "count" | "MB" | "GB" | "min";

export function fmtValue(n: number, unit: UsageUnit): string {
  if (unit === "MB" && n >= 1024) return `${trim(n / 1024)} GB`;
  if (unit === "GB" && n >= 1024) return `${trim(n / 1024)} TB`;
  if (unit === "GB" && n > 0 && n < 1) return `${trim(n * 1024)} MB`;
  if (unit === "count") return compact(n);
  return `${trim(n)} ${unit}`;
}

export function fmtLimit(n: number | null, unit: UsageUnit): string {
  return n === null ? "Unlimited" : fmtValue(n, unit);
}

function trim(n: number) {
  return n >= 100 ? Math.round(n).toLocaleString("en-US") : String(Math.round(n * 10) / 10);
}
function compact(n: number) {
  if (n >= 1_000_000) return `${trim(n / 1_000_000)}M`;
  if (n >= 10_000) return `${trim(n / 1000)}k`;
  return n.toLocaleString("en-US");
}

/** bar tone by ratio */
export function tone(ratio: number, limited: boolean): "accent" | "warning" | "danger" | "muted" {
  if (!limited) return "muted";
  if (ratio >= 1) return "danger";
  if (ratio >= 0.8) return "warning";
  return "accent";
}
