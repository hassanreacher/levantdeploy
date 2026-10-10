import { z } from "zod";

/**
 * Build area shared types — client-safe (no node imports): used by the API, the worker and the
 * Build & Development settings form.
 */

export type BuildKind = "WEB" | "WORKER" | "STATIC" | "COMPOSE";
export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";
export type Language =
  | "node"
  | "bun"
  | "deno"
  | "python"
  | "php"
  | "go"
  | "rust"
  | "ruby"
  | "java"
  | "dotnet"
  | "elixir"
  | "static"
  | "docker";

export type FrameworkPreset = {
  id: string;
  name: string;
  language: Language;
  kind: BuildKind;
  /** default listening port inside the container (all generated images honour $PORT) */
  port: number;
  /** short glyph shown in the preset picker (2 letters) + tailwind-safe tone */
  glyph: string;
};

/** Every framework the detector knows about (also the "Framework preset" select). Order = display order. */
export const FRAMEWORK_PRESETS: FrameworkPreset[] = [
  { id: "nextjs", name: "Next.js", language: "node", kind: "WEB", port: 3000, glyph: "N" },
  { id: "nuxt", name: "Nuxt", language: "node", kind: "WEB", port: 3000, glyph: "Nx" },
  { id: "sveltekit", name: "SvelteKit", language: "node", kind: "WEB", port: 3000, glyph: "Sk" },
  { id: "remix", name: "Remix", language: "node", kind: "WEB", port: 3000, glyph: "Rx" },
  { id: "react-router", name: "React Router", language: "node", kind: "WEB", port: 3000, glyph: "RR" },
  { id: "astro", name: "Astro", language: "node", kind: "WEB", port: 3000, glyph: "As" },
  { id: "vite", name: "Vite (SPA)", language: "node", kind: "STATIC", port: 3000, glyph: "Vi" },
  { id: "create-react-app", name: "Create React App", language: "node", kind: "STATIC", port: 3000, glyph: "Re" },
  { id: "angular", name: "Angular", language: "node", kind: "STATIC", port: 3000, glyph: "Ng" },
  { id: "vue", name: "Vue CLI", language: "node", kind: "STATIC", port: 3000, glyph: "Vu" },
  { id: "solid", name: "SolidStart / Solid", language: "node", kind: "STATIC", port: 3000, glyph: "So" },
  { id: "nestjs", name: "NestJS", language: "node", kind: "WEB", port: 3000, glyph: "Ns" },
  { id: "express", name: "Express", language: "node", kind: "WEB", port: 3000, glyph: "Ex" },
  { id: "fastify", name: "Fastify", language: "node", kind: "WEB", port: 3000, glyph: "Fy" },
  { id: "koa", name: "Koa", language: "node", kind: "WEB", port: 3000, glyph: "Ko" },
  { id: "hono", name: "Hono", language: "node", kind: "WEB", port: 3000, glyph: "Ho" },
  { id: "node", name: "Node.js", language: "node", kind: "WEB", port: 3000, glyph: "JS" },
  { id: "bun", name: "Bun", language: "bun", kind: "WEB", port: 3000, glyph: "Bn" },
  { id: "deno", name: "Deno", language: "deno", kind: "WEB", port: 8000, glyph: "De" },
  { id: "django", name: "Django", language: "python", kind: "WEB", port: 8000, glyph: "Dj" },
  { id: "fastapi", name: "FastAPI", language: "python", kind: "WEB", port: 8000, glyph: "FA" },
  { id: "flask", name: "Flask", language: "python", kind: "WEB", port: 8000, glyph: "Fl" },
  { id: "python", name: "Python", language: "python", kind: "WEB", port: 8000, glyph: "Py" },
  { id: "laravel", name: "Laravel", language: "php", kind: "WEB", port: 8080, glyph: "La" },
  { id: "php", name: "PHP", language: "php", kind: "WEB", port: 8080, glyph: "Ph" },
  { id: "go", name: "Go", language: "go", kind: "WEB", port: 8080, glyph: "Go" },
  { id: "rust", name: "Rust", language: "rust", kind: "WEB", port: 8080, glyph: "Rs" },
  { id: "rails", name: "Ruby on Rails", language: "ruby", kind: "WEB", port: 3000, glyph: "Ra" },
  { id: "ruby", name: "Ruby (Rack/Sinatra)", language: "ruby", kind: "WEB", port: 3000, glyph: "Rb" },
  { id: "spring-boot", name: "Spring Boot", language: "java", kind: "WEB", port: 8080, glyph: "Sp" },
  { id: "dotnet", name: ".NET / ASP.NET Core", language: "dotnet", kind: "WEB", port: 8080, glyph: ".N" },
  { id: "phoenix", name: "Elixir / Phoenix", language: "elixir", kind: "WEB", port: 4000, glyph: "Px" },
  { id: "static", name: "Static HTML", language: "static", kind: "STATIC", port: 3000, glyph: "<>" },
  { id: "dockerfile", name: "Dockerfile", language: "docker", kind: "WEB", port: 3000, glyph: "Dk" },
  { id: "compose", name: "Docker Compose", language: "docker", kind: "COMPOSE", port: 3000, glyph: "Dc" },
];

export const presetById = (id: string | null | undefined) => FRAMEWORK_PRESETS.find((p) => p.id === id) ?? null;

const cmd = z.string().trim().max(4000);
const relPath = z
  .string()
  .trim()
  .max(500)
  .refine((s) => !s.startsWith("/") && !s.split(/[\\/]/).includes(".."), "Must be a relative path inside the repository");

/**
 * `Project.buildSettings` JSON. Every field is optional: null/undefined = use the detected default.
 * Project build settings override everything detected.
 */
export const buildSettingsSchema = z.object({
  /** preset id from FRAMEWORK_PRESETS, or null for auto-detect */
  framework: z
    .string()
    .nullable()
    .optional()
    .refine((v) => v == null || !!presetById(v), "Unknown framework preset"),
  installCommand: cmd.nullable().optional(),
  buildCommand: cmd.nullable().optional(),
  startCommand: cmd.nullable().optional(),
  outputDirectory: relPath.nullable().optional(),
  /** custom Dockerfile path (relative to the root directory) */
  dockerfilePath: relPath.nullable().optional(),
  /** custom compose file (relative to the root directory) */
  composeFile: relPath.nullable().optional(),
  nodeVersion: z
    .string()
    .trim()
    .regex(/^(\d{1,2}(\.\d+){0,2}|lts)$/, "e.g. 20, 22 or 22.11.0")
    .nullable()
    .optional(),
  pythonVersion: z
    .string()
    .trim()
    .regex(/^3\.\d{1,2}(\.\d+)?$/, "e.g. 3.12")
    .nullable()
    .optional(),
  packageManager: z.enum(["npm", "pnpm", "yarn", "bun"]).nullable().optional(),
  /** extra --build-arg values (non secret) */
  buildArgs: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(4000)).optional(),
  /** static sites: rewrite unknown paths to /index.html (default true for SPAs) */
  spaFallback: z.boolean().nullable().optional(),
  /** docker build --target (custom Dockerfiles) */
  dockerTarget: z.string().trim().max(100).nullable().optional(),
  /** inline Dockerfile (≤ 64 KB): written to the work dir and used instead of the repo / generated Dockerfile */
  dockerfileInline: z
    .string()
    .max(64 * 1024, "Inline Dockerfile must be 64 KB or less")
    .refine((v) => !v.trim() || /^\s*(#.*\n\s*)*(ARG|FROM)\b/im.test(v), "Must start with FROM (or ARG / comments)")
    .nullable()
    .optional(),
  /** OS packages (apt on Debian/Ubuntu images, apk on Alpine) installed in the build and runtime stages of generated Dockerfiles */
  systemPackages: z
    .array(z.string().trim().regex(/^[a-zA-Z0-9][a-zA-Z0-9+._:=~-]{0,99}$/, "Invalid package name"))
    .max(50)
    .nullable()
    .optional(),
});

export type BuildSettings = z.infer<typeof buildSettingsSchema>;

export function parseBuildSettings(raw: unknown): BuildSettings {
  const r = buildSettingsSchema.safeParse(raw ?? {});
  if (r.success) return r.data;
  // tolerate bad stored data: keep only the valid keys
  const out: Record<string, unknown> = {};
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(obj)) {
    const one = buildSettingsSchema.safeParse({ [k]: v });
    if (one.success && k in one.data) out[k] = (one.data as Record<string, unknown>)[k];
  }
  return out as BuildSettings;
}

/** Result of framework detection — what the build will do. */
export type Detection = {
  framework: string;
  frameworkName: string;
  /** detected framework version (from the lockfile-free package.json range, best effort) */
  version?: string | null;
  language: Language;
  kind: BuildKind;
  /** dockerfile = repo Dockerfile, generated = template, compose = docker compose services, image = prebuilt image */
  strategy: "dockerfile" | "generated" | "compose" | "image";
  packageManager?: PackageManager | null;
  installCommand?: string | null;
  buildCommand?: string | null;
  startCommand?: string | null;
  outputDirectory?: string | null;
  port: number;
  nodeVersion?: string | null;
  pythonVersion?: string | null;
  dockerfilePath?: string | null;
  composeFile?: string | null;
  /** which settings came from the project overrides */
  overridden: string[];
  /** human readable hints shown in the UI / build log */
  notes: string[];
  /** template-specific facts (python deps tool, go main package, rust binary name, next standalone, …) */
  meta: Record<string, string | number | boolean | null>;
};

/** Written to Deployment.meta.build by the build engine (read by runtime / dashboard). */
export type BuildMeta = {
  framework: string;
  frameworkName: string;
  kind: BuildKind;
  strategy: Detection["strategy"];
  /** port the image listens on by default (PORT env is honoured by generated images) */
  port: number;
  exposedPorts?: number[];
  imageTag?: string;
  imageSize?: number;
  durationMs?: number;
  /** COMPOSE only: services with their built image tags */
  compose?: ComposeServiceMeta[];
  composeFile?: string;
  /** COMPOSE only: service receiving HTTP traffic */
  composePrimary?: string;
  /** COMPOSE only: encryptJson(normalized compose spec with built image tags) — contains env values */
  composeSpecEnc?: string;
};

export type ComposeServiceMeta = {
  name: string;
  /** image to run (built: levant/{projectId}-{service}:{shortId}; or the upstream image) */
  image: string;
  built: boolean;
  ports: number[];
  /** the compose service definition as normalized by `docker compose config` (env/volumes/depends_on/command…) */
  definition: Record<string, unknown>;
};

/**
 * Kind a deployment must run as: the kind detected at build time (Deployment.meta.build.kind) wins over Project.kind,
 * so a compose repo deployed to a WEB project still runs as a COMPOSE stack (and vice versa). Older deployments
 * without build meta fall back to the project kind.
 */
export function effectiveKind(meta: unknown, projectKind: BuildKind): BuildKind {
  const k = (meta as { build?: { kind?: string } } | null)?.build?.kind;
  if (k !== "WEB" && k !== "STATIC" && k !== "WORKER" && k !== "COMPOSE") return projectKind; // no build meta
  if (k === "COMPOSE") return "COMPOSE";
  if (projectKind === "COMPOSE") return k; // single image built for a project still marked COMPOSE
  if (k === "WORKER") return "WORKER";
  return projectKind; // WEB/STATIC/WORKER chosen by the user
}
