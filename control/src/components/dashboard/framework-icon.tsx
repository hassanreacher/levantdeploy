import { cn } from "@/lib/utils";

/** Monochrome framework mark (abbreviation tile) + human label. Server-safe. */
const FRAMEWORKS: Record<string, { label: string; short: string }> = {
  nextjs: { label: "Next.js", short: "N" },
  next: { label: "Next.js", short: "N" },
  nuxt: { label: "Nuxt", short: "Nx" },
  sveltekit: { label: "SvelteKit", short: "Sv" },
  svelte: { label: "Svelte", short: "Sv" },
  remix: { label: "Remix", short: "R" },
  astro: { label: "Astro", short: "A" },
  vite: { label: "Vite", short: "V" },
  react: { label: "React", short: "Re" },
  cra: { label: "Create React App", short: "Re" },
  vue: { label: "Vue", short: "Vu" },
  angular: { label: "Angular", short: "Ng" },
  express: { label: "Express", short: "Ex" },
  nestjs: { label: "NestJS", short: "Ne" },
  fastify: { label: "Fastify", short: "Fy" },
  node: { label: "Node.js", short: "JS" },
  bun: { label: "Bun", short: "Bn" },
  deno: { label: "Deno", short: "De" },
  django: { label: "Django", short: "Dj" },
  fastapi: { label: "FastAPI", short: "Fa" },
  flask: { label: "Flask", short: "Fl" },
  python: { label: "Python", short: "Py" },
  laravel: { label: "Laravel", short: "La" },
  php: { label: "PHP", short: "Ph" },
  go: { label: "Go", short: "Go" },
  rust: { label: "Rust", short: "Rs" },
  rails: { label: "Rails", short: "Rb" },
  ruby: { label: "Ruby", short: "Rb" },
  spring: { label: "Spring", short: "Sp" },
  java: { label: "Java", short: "Jv" },
  dotnet: { label: ".NET", short: ".N" },
  phoenix: { label: "Phoenix", short: "Ph" },
  elixir: { label: "Elixir", short: "Ex" },
  static: { label: "Static HTML", short: "<>" },
  dockerfile: { label: "Dockerfile", short: "D" },
  docker: { label: "Dockerfile", short: "D" },
  compose: { label: "Docker Compose", short: "DC" },
  "docker-compose": { label: "Docker Compose", short: "DC" },
};

export function frameworkLabel(fw: string | null | undefined) {
  if (!fw) return "Other";
  return FRAMEWORKS[fw.toLowerCase()]?.label ?? fw;
}

export function FrameworkIcon({ framework, size = 32, className }: { framework: string | null | undefined; size?: number; className?: string }) {
  const f = FRAMEWORKS[(framework ?? "").toLowerCase()] ?? { label: framework ?? "Other", short: (framework ?? "?").slice(0, 2) };
  return (
    <span
      title={f.label}
      aria-label={f.label}
      style={{ width: size, height: size, fontSize: Math.max(10, size * (f.short.length > 1 ? 0.36 : 0.46)) }}
      className={cn("inline-flex shrink-0 items-center justify-center rounded-full border border-border-strong bg-bg font-mono font-semibold tracking-tight text-fg", className)}
    >
      {f.short}
    </span>
  );
}
