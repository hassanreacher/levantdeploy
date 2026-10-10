import type { NavTab } from "@/components/ui/tabs";

/** Team-level tabs. Areas add entries here (e.g. "Domains", "Notifications") — keep the order stable. */
export function teamTabs(team: string): NavTab[] {
  return [
    { href: `/${team}`, label: "Overview", exact: true },
    { href: `/${team}/build`, label: "Build" }, // builder-ui: AI app builder
    { href: `/${team}/base`, label: "Base" },
    { href: `/${team}/activity`, label: "Activity" },
    { href: `/${team}/usage`, label: "Usage" },
    { href: `/${team}/members`, label: "Members" },
    { href: `/${team}/tokens`, label: "Tokens" },
    { href: `/${team}/audit`, label: "Audit log" },
    { href: `/${team}/settings`, label: "Settings" },
  ];
}

/** Project sub-tabs. The route folders live in src/app/(dashboard)/[team]/[project]/<tab>/. */
export const PROJECT_TABS = [
  { seg: "", label: "Overview", area: "dashboard" },
  { seg: "deployments", label: "Deployments", area: "dashboard" },
  { seg: "logs", label: "Logs", area: "runtime" },
  { seg: "observability", label: "Observability", area: "runtime" },
  { seg: "domains", label: "Domains", area: "runtime" },
  { seg: "environment", label: "Environment", area: "dashboard" },
  { seg: "backend", label: "Backend", area: "base-dashboard" },
  { seg: "storage", label: "Storage", area: "runtime" },
  { seg: "databases", label: "Databases", area: "runtime" },
  { seg: "cron", label: "Cron", area: "runtime" },
  { seg: "settings", label: "Settings", area: "dashboard" },
  { seg: "ai", label: "AI", area: "ai" },
] as const;

export function projectTabs(team: string, project: string): NavTab[] {
  return PROJECT_TABS.map((t) => ({ href: `/${team}/${project}${t.seg ? `/${t.seg}` : ""}`, label: t.label, exact: t.seg === "" }));
}
