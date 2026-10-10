/** Platform settings sections (plain module: imported by the server layout and the client nav). */
export const SETTINGS_SECTIONS = [
  { href: "/settings", label: "General" },
  { href: "/settings/limits", label: "Limits" },
  { href: "/settings/plans", label: "Plans" },
  { href: "/settings/signups", label: "Sign-ups" },
  { href: "/settings/build", label: "Build" },
  { href: "/settings/github", label: "GitHub" },
  { href: "/settings/ai-providers", label: "AI providers" },
  { href: "/settings/email", label: "Email" },
  { href: "/settings/backups", label: "Backups" },
  { href: "/settings/updates", label: "Updates" },
] as const;
