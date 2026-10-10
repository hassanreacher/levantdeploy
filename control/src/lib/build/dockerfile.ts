import type { BuildSettings, Detection } from "./types";
import { DEFAULT_NODE_VERSION, DEFAULT_PYTHON_VERSION } from "./detect";

/**
 * Dockerfile generation from multi-stage templates (one per language family).
 *
 * Every generated image:
 *  - runs as a non-root user, listens on 0.0.0.0:$PORT (PORT defaults to the framework port, runtime may override it)
 *  - uses BuildKit cache mounts for package managers / compilers (npm, pnpm, yarn, bun, pip, uv, go, cargo, maven, gradle, nuget, composer)
 *  - gets project env vars as build args (non secret) and BuildKit secrets (isSecret vars → `--mount=type=secret,id=KEY,env=KEY`,
 *    never written to a layer)
 *  - optionally trusts an extra CA (build proxy) mounted as the `levant_ca` BuildKit secret during install/build steps only
 *  - starts through /app/.levant-start.sh (or a fixed CMD) with `exec` so signals reach the app
 */

export type GenerateOptions = {
  detection: Detection;
  settings?: BuildSettings;
  /** non-secret env keys (declared as ARG in the build stage) */
  buildArgKeys?: string[];
  /** secret env keys (BuildKit secrets exposed as env during install/build RUN steps) */
  secretKeys?: string[];
  /** per-project cache namespace (cargo target / go build caches) */
  cacheKey?: string;
  /** app sub directory inside the build context (monorepo workspace builds), "" = context root */
  appDir?: string;
  /** Docker Hub mirror host for base images (e.g. "mirror.gcr.io"): node:22-alpine → mirror.gcr.io/library/node:22-alpine */
  registryMirror?: string | null;
};

/** apk on Alpine-based images, apt on Debian/Ubuntu ones */
export function systemPackagesScript(image: string, pkgs: string[]): string | null {
  const list = pkgs.filter((p) => /^[a-zA-Z0-9][a-zA-Z0-9+._:=~-]{0,99}$/.test(p));
  if (!list.length) return null;
  if (/alpine|^composer:|^caddy:/.test(image)) return `apk add --no-cache ${list.join(" ")}`;
  return `export DEBIAN_FRONTEND=noninteractive && apt-get update -qq && apt-get install -y -qq --no-install-recommends ${list.join(" ")} && rm -rf /var/lib/apt/lists/*`;
}

export type Generated = { dockerfile: string; dockerignore: string; startScript?: string };

export const CA_SECRET_ID = "levant_ca";

/** POSIX sh prelude: when the build proxy CA secret is mounted, point every common tool at a combined bundle. */
export const CA_PRELUDE = [
  `if [ -s /run/secrets/${CA_SECRET_ID} ]; then`,
  `  { cat /etc/ssl/certs/ca-certificates.crt 2>/dev/null || cat /etc/pki/tls/certs/ca-bundle.crt 2>/dev/null || true; cat /run/secrets/${CA_SECRET_ID}; } > /tmp/levant-ca.crt`,
  `  export NODE_EXTRA_CA_CERTS=/run/secrets/${CA_SECRET_ID} SSL_CERT_FILE=/tmp/levant-ca.crt REQUESTS_CA_BUNDLE=/tmp/levant-ca.crt PIP_CERT=/tmp/levant-ca.crt CURL_CA_BUNDLE=/tmp/levant-ca.crt GIT_SSL_CAINFO=/tmp/levant-ca.crt CARGO_HTTP_CAINFO=/tmp/levant-ca.crt DENO_CERT=/tmp/levant-ca.crt BUNDLE_SSL_CA_CERT=/tmp/levant-ca.crt HEX_CACERTS_PATH=/tmp/levant-ca.crt COMPOSER_CAFILE=/tmp/levant-ca.crt UV_NATIVE_TLS=1`,
  `fi`,
].join("\n");

/** JVM: import the CA (every cert of the bundle) into a temp truststore + proxy system properties from HTTPS_PROXY. */
export const JAVA_PRELUDE = [
  `JOPTS=""`,
  `if [ -s /run/secrets/${CA_SECRET_ID} ]; then`,
  `  cp "$(dirname "$(dirname "$(readlink -f "$(command -v java)")")")/lib/security/cacerts" /tmp/levant-ts 2>/dev/null || true`,
  `  awk 'BEGIN{n=0} /BEGIN CERTIFICATE/{n++} {print > ("/tmp/levant-ca-" n ".pem")}' /run/secrets/${CA_SECRET_ID}`,
  `  for f in /tmp/levant-ca-*.pem; do keytool -importcert -noprompt -alias "levant-$(basename "$f")" -file "$f" -keystore /tmp/levant-ts -storepass changeit >/dev/null 2>&1 || true; done`,
  `  JOPTS="-Djavax.net.ssl.trustStore=/tmp/levant-ts -Djavax.net.ssl.trustStorePassword=changeit"`,
  `fi`,
  `P="\${HTTPS_PROXY:-\${https_proxy:-}}"`,
  `if [ -n "$P" ]; then hp="\${P#*://}"; hp="\${hp#*@}"; hp="\${hp%%/*}"; JOPTS="$JOPTS -Dhttps.proxyHost=\${hp%:*} -Dhttps.proxyPort=\${hp##*:} -Dhttp.proxyHost=\${hp%:*} -Dhttp.proxyPort=\${hp##*:}"; fi`,
  `NP="\${NO_PROXY:-\${no_proxy:-}}"`,
  `if [ -n "$NP" ]; then JOPTS="$JOPTS -Dhttp.nonProxyHosts=$(echo "$NP" | sed 's/,/|/g; s/|\\./|*./g')"; fi`,
  `export JAVA_TOOL_OPTIONS="$JOPTS"`,
].join("\n");

// ───────────────────────────── Dockerfile builder ─────────────────────────────

type RunOpts = { cache?: string[]; secrets?: boolean; java?: boolean; title?: string };

/** Rewrite a Docker Hub image reference to a pull-through mirror (other registries are left untouched). */
export function mirrorImage(image: string, mirror?: string | null): string {
  if (!mirror) return image;
  const host = mirror.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const first = image.split("/")[0]!;
  const isHub = !image.includes("/") || (!first.includes(".") && !first.includes(":") && first !== "localhost") || first === "docker.io";
  if (!isHub) return image;
  const path = image.replace(/^docker\.io\//, "");
  return `${host}/${path.includes("/") ? path : `library/${path}`}`;
}

class DF {
  lines: string[] = [];
  constructor(private o: Required<Pick<GenerateOptions, "buildArgKeys" | "secretKeys" | "cacheKey">> & { registryMirror?: string | null; systemPackages?: string[] }) {}
  raw(...l: string[]) {
    this.lines.push(...l);
    return this;
  }
  comment(s: string) {
    return this.raw(`# ${s}`);
  }
  blank() {
    return this.raw("");
  }
  from(image: string, as?: string) {
    this.raw(`FROM ${mirrorImage(image, this.o.registryMirror)}${as ? ` AS ${as}` : ""}`);
    const pkgs = systemPackagesScript(image, this.o.systemPackages ?? []);
    if (pkgs) {
      // apt/apk need root; some base images default to a non-root user
      this.raw("USER root");
      this.run(pkgs, { title: `Installing system packages: ${(this.o.systemPackages ?? []).join(" ")}` });
    }
    return this;
  }
  workdir(d: string) {
    return this.raw(`WORKDIR ${d}`);
  }
  env(vars: Record<string, string>) {
    const parts = Object.entries(vars).map(([k, v]) => `${k}=${JSON.stringify(v)}`);
    return parts.length ? this.raw(`ENV ${parts.join(" \\\n    ")}`) : this;
  }
  /** project env vars (non secret) as ARG → available to RUN, not persisted in the final stage */
  buildArgs() {
    for (const k of this.o.buildArgKeys) this.raw(`ARG ${k}`);
    return this;
  }
  run(script: string, opts: RunOpts = {}) {
    const mounts: string[] = [];
    for (const c of opts.cache ?? []) mounts.push(`--mount=type=cache,${c}`);
    if (opts.secrets !== false) {
      mounts.push(`--mount=type=secret,id=${CA_SECRET_ID}`);
      for (const k of this.o.secretKeys) mounts.push(`--mount=type=secret,id=${k},env=${k}`);
    }
    const body = [
      "set -e",
      ...(opts.secrets !== false ? [CA_PRELUDE] : []),
      ...(opts.java ? [JAVA_PRELUDE] : []),
      ...(opts.title ? [`echo ${shq(`▲ ${opts.title}`)}`] : []),
      script,
      ...(opts.secrets !== false ? ["rm -f /tmp/levant-ca.crt /tmp/levant-ts /tmp/levant-ca-*.pem 2>/dev/null || true"] : []),
    ].join("\n");
    const m = mounts.length ? mounts.join(" \\\n    ") + " \\\n    " : "";
    return this.raw(`RUN ${m}${JSON.stringify(["sh", "-c", body])}`);
  }
  /** plain RUN without mounts (user creation etc.) */
  sh(script: string) {
    return this.raw(`RUN ${JSON.stringify(["sh", "-c", script])}`);
  }
  copy(src: string, dst: string, opts: { from?: string; chown?: string } = {}) {
    return this.raw(`COPY ${opts.from ? `--from=${opts.from} ` : ""}${opts.chown ? `--chown=${opts.chown} ` : ""}${src} ${dst}`);
  }
  /** COPY <<EOF heredoc (BuildKit) */
  file(dst: string, content: string, chmod?: string) {
    const tag = "LEVANT_EOF";
    return this.raw(`COPY ${chmod ? `--chmod=${chmod} ` : ""}<<'${tag}' ${dst}`, ...content.replace(/\n$/, "").split("\n"), tag);
  }
  user(u: string) {
    return this.raw(`USER ${u}`);
  }
  expose(p: number) {
    return this.raw(`EXPOSE ${p}`);
  }
  cmd(argv: string[]) {
    return this.raw(`CMD ${JSON.stringify(argv)}`);
  }
  /** shell CMD so $PORT expands; exec replaces the shell */
  shellCmd(command: string) {
    return this.cmd(["sh", "-c", `exec ${command}`]);
  }
  toString() {
    return this.lines.join("\n") + "\n";
  }
}

/** single-quote for sh */
export const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

const ALPINE_USER = "addgroup -S -g 10001 app && adduser -S -D -u 10001 -G app -h /home/app app";
const DEBIAN_USER = "groupadd -r -g 10001 app && useradd -r -m -u 10001 -g app -d /home/app -s /usr/sbin/nologin app";

export const DEFAULT_DOCKERIGNORE = [
  ".git",
  "**/.git",
  "**/node_modules",
  "**/.next",
  "**/.nuxt",
  "**/.output",
  "**/.svelte-kit",
  "**/.turbo",
  "**/.vercel",
  "**/.venv",
  "**/venv",
  "**/__pycache__",
  "**/*.pyc",
  "**/target",
  "**/bin/Debug",
  "**/obj",
  "**/_build",
  "**/deps",
  "**/.DS_Store",
  "**/.env",
  "**/.env.*",
  "!**/.env.example",
  "**/npm-debug.log*",
  "**/coverage",
  "**/.levant",
].join("\n");

// ───────────────────────────── entry ─────────────────────────────

export function generateDockerfile(opts: GenerateOptions): Generated {
  const d = opts.detection;
  const o = {
    buildArgKeys: [...new Set(opts.buildArgKeys ?? [])].filter(validKey),
    secretKeys: [...new Set(opts.secretKeys ?? [])].filter(validKey),
    cacheKey: (opts.cacheKey ?? "default").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40) || "default",
    registryMirror: opts.registryMirror ?? null,
    systemPackages: opts.settings?.systemPackages ?? [],
  };
  const settings = opts.settings ?? {};
  const appDir = (opts.appDir ?? "").replace(/^\/+|\/+$/g, "");
  const ctx: Ctx = { d, o, settings, appDir };
  let df: DF;
  switch (d.language) {
    case "node":
      df = d.kind === "STATIC" ? staticBuilt(ctx) : nodeServer(ctx);
      break;
    case "bun":
      df = bun(ctx);
      break;
    case "deno":
      df = deno(ctx);
      break;
    case "python":
      df = python(ctx);
      break;
    case "php":
      df = php(ctx);
      break;
    case "go":
      df = go(ctx);
      break;
    case "rust":
      df = rust(ctx);
      break;
    case "ruby":
      df = ruby(ctx);
      break;
    case "java":
      df = java(ctx);
      break;
    case "dotnet":
      df = dotnet(ctx);
      break;
    case "elixir":
      df = elixir(ctx);
      break;
    case "static":
      df = staticPlain(ctx);
      break;
    default:
      throw new Error(`No Dockerfile template for ${d.framework}`);
  }
  return { dockerfile: header(d) + df.toString(), dockerignore: DEFAULT_DOCKERIGNORE + "\n" };
}

type Ctx = { d: Detection; o: Required<Pick<GenerateOptions, "buildArgKeys" | "secretKeys" | "cacheKey">> & { registryMirror?: string | null; systemPackages?: string[] }; settings: BuildSettings; appDir: string };

const validKey = (k: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k);

function header(d: Detection) {
  return [
    `# Generated by LevantDeploy for ${d.frameworkName}${d.version ? ` ${d.version}` : ""} (${d.language}${d.packageManager ? `, ${d.packageManager}` : ""})`,
    `# Add a Dockerfile to your repository (or set "Dockerfile path") to take full control.`,
    "",
  ].join("\n");
}

/** writes the start script with `exec` */
function startScript(command: string, cd?: string) {
  return `#!/bin/sh\n${cd ? `cd ${shq(cd)}\n` : ""}exec ${command}\n`;
}

// ───────────────────────────── Node ─────────────────────────────

const pmCache: Record<string, string[]> = {
  npm: ["id=levant-npm,target=/root/.npm"],
  pnpm: ["id=levant-pnpm,target=/root/.local/share/pnpm/store"],
  yarn: ["id=levant-yarn,target=/usr/local/share/.cache/yarn", "id=levant-yarn-berry,target=/root/.yarn/berry/cache"],
  bun: ["id=levant-bun,target=/root/.bun/install/cache"],
};

function pmSetup(d: Detection): string | null {
  const pm = d.packageManager ?? "npm";
  if (pm === "npm") return null;
  const v = typeof d.meta.pmVersion === "string" ? d.meta.pmVersion : null;
  if (pm === "pnpm") return `(corepack enable pnpm 2>/dev/null && pnpm --version >/dev/null) || npm install -g pnpm${v ? `@${v}` : "@9"}`;
  if (pm === "yarn") return d.meta.yarnBerry ? `corepack enable yarn 2>/dev/null || npm install -g yarn` : `yarn --version >/dev/null 2>&1 || npm install -g yarn`;
  if (pm === "bun") return "npm install -g bun";
  return null;
}

function nodeBase(df: DF, ctx: Ctx, nodeVersion: string) {
  const { d, appDir } = ctx;
  df.from(`node:${nodeVersion}-alpine`, "build");
  df.env({ CI: "1", NEXT_TELEMETRY_DISABLED: "1", NUXT_TELEMETRY_DISABLED: "1", ASTRO_TELEMETRY_DISABLED: "1", COREPACK_ENABLE_DOWNLOAD_PROMPT: "0", npm_config_update_notifier: "false" });
  df.workdir("/app");
  df.buildArgs();
  df.copy(".", ".");
  const setup = pmSetup(d);
  const cache = pmCache[d.packageManager ?? "npm"] ?? [];
  const installDir = appDir && d.meta.workspaceRoot ? "/app" : appDir ? `/app/${appDir}` : "/app";
  const install = d.installCommand ?? "npm install";
  df.run([setup, `cd ${installDir}`, install].filter(Boolean).join("\n"), { cache, title: `Installing dependencies: ${install}` });
  if (appDir) df.workdir(`/app/${appDir}`);
  return { setup, cache };
}

function nodeServer(ctx: Ctx): DF {
  const { d, o, appDir } = ctx;
  const df = new DF(o);
  const nodeVersion = d.nodeVersion ?? DEFAULT_NODE_VERSION;
  const { setup, cache } = nodeBase(df, ctx, nodeVersion);
  const workdir = appDir ? `/app/${appDir}` : "/app";

  // SvelteKit without adapter-node: swap the adapter so `node build` works
  if (d.framework === "sveltekit" && d.meta.adapter === "auto") {
    df.run(
      [
        setup,
        `${d.packageManager === "pnpm" ? "pnpm add -D" : d.packageManager === "yarn" ? "yarn add -D" : d.packageManager === "bun" ? "bun add -d" : "npm install -D"} @sveltejs/adapter-node`,
        `for f in svelte.config.js svelte.config.mjs svelte.config.ts; do [ -f "$f" ] && sed -i "s#@sveltejs/adapter-auto#@sveltejs/adapter-node#g" "$f"; done`,
      ]
        .filter(Boolean)
        .join("\n"),
      { cache, title: "Switching SvelteKit to @sveltejs/adapter-node" },
    );
  }

  if (d.buildCommand) {
    const env = d.framework === "nextjs" ? "export NEXT_PRIVATE_STANDALONE=true\n" : "";
    df.run(`${setup ? setup + "\n" : ""}${env}export NODE_ENV=production\n${d.buildCommand}`, {
      cache: d.framework === "nextjs" ? [...cache, `id=levant-next-${o.cacheKey},target=${workdir}/.next/cache`] : cache,
      title: `Building: ${d.buildCommand}`,
    });
  }

  // runtime tree: /levant-out is a symlink (followed by COPY) to either the Next.js standalone output (only the
  // traced files, no copy of node_modules) or the whole /app
  const start = d.startCommand ?? "npm start";
  const assemble: string[] = [];
  if (d.framework === "nextjs" && !d.overridden.includes("startCommand")) {
    assemble.push(
      `S=$(find .next/standalone -name server.js -not -path '*/node_modules/*' 2>/dev/null | head -n 1)`,
      `if [ -n "$S" ]; then`,
      `  echo "▲ Next.js standalone output: $S"`,
      `  SA="$(pwd)/.next/standalone"`,
      `  REL=$(dirname "\${S#.next/standalone/}")`,
      `  mkdir -p "$SA/$REL/.next" && cp -a .next/static "$SA/$REL/.next/static"`,
      `  [ -d public ] && cp -a public "$SA/$REL/public" || true`,
      `  printf '#!/bin/sh\\ncd "/app/%s"\\nexec node server.js\\n' "$REL" > "$SA/.levant-start.sh"`,
      `  chmod +x "$SA/.levant-start.sh" && ln -s "$SA" /levant-out`,
      `else`,
      `  echo "▲ Next.js: no standalone output, shipping node_modules"`,
      `  printf '#!/bin/sh\\ncd %s\\nexec %s\\n' ${shq(shq(workdir))} ${shq(start)} > /app/.levant-start.sh`,
      `  chmod +x /app/.levant-start.sh && ln -s /app /levant-out`,
      `fi`,
    );
  } else {
    assemble.push(`printf '%s' ${shq(startScript(start, workdir))} > /app/.levant-start.sh`, `chmod +x /app/.levant-start.sh && ln -s /app /levant-out`);
  }
  df.run(assemble.join("\n"), { secrets: false, title: "Preparing runtime files" });

  df.blank();
  df.from(`node:${nodeVersion}-alpine`, "runtime");
  df.env({ NODE_ENV: "production", PORT: String(d.port), HOSTNAME: "0.0.0.0", HOST: "0.0.0.0", NEXT_TELEMETRY_DISABLED: "1" });
  df.workdir("/app");
  df.copy("/levant-out/", "/app/", { from: "build", chown: "node:node" });
  df.user("node");
  df.expose(d.port);
  df.cmd(["/app/.levant-start.sh"]);
  return df;
}

// ───────────────────────────── Static (Caddy) ─────────────────────────────

function caddyfile(spa: boolean) {
  return [
    "{",
    "\tadmin off",
    "\tauto_https off",
    "\tpersist_config off",
    "\tlog {",
    "\t\tformat console",
    "\t}",
    "}",
    "",
    ":{$PORT:3000} {",
    "\troot * /srv",
    "\tencode zstd gzip",
    "\t@immutable path /assets/* /_astro/* /_next/static/* /static/* *.woff2",
    '\theader @immutable Cache-Control "public, max-age=31536000, immutable"',
    spa ? "\ttry_files {path} {path}/ /index.html" : "\ttry_files {path} {path}/index.html {path}.html",
    "\tfile_server",
    ...(spa
      ? []
      : ["\thandle_errors {", "\t\t@404 expression {err.status_code} == 404", "\t\thandle @404 {", "\t\t\trewrite * /404.html", "\t\t\tfile_server", "\t\t}", "\t}"]),
    "}",
  ].join("\n");
}

function caddyRuntime(df: DF, ctx: Ctx, from: { stage?: string; dir: string }) {
  const { d, settings } = ctx;
  const spa = settings.spaFallback ?? (d.meta.spa === true);
  df.blank();
  df.from("caddy:2-alpine", "runtime");
  df.env({ PORT: String(d.port), XDG_CONFIG_HOME: "/tmp/caddy/config", XDG_DATA_HOME: "/tmp/caddy/data" });
  df.file("/etc/caddy/Caddyfile", caddyfile(spa));
  df.copy(from.dir.endsWith("/") ? from.dir : from.dir + "/", "/srv/", { ...(from.stage ? { from: from.stage } : {}), chown: "10001:10001" });
  df.user("10001:10001");
  df.expose(d.port);
  df.cmd(["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]);
}

function staticBuilt(ctx: Ctx): DF {
  const { d, o, appDir } = ctx;
  const df = new DF(o);
  const { setup, cache } = nodeBase(df, ctx, d.nodeVersion ?? DEFAULT_NODE_VERSION);
  const out = d.outputDirectory ?? "dist";
  const workdir = appDir ? `/app/${appDir}` : "/app";
  if (d.buildCommand) df.run(`${setup ? setup + "\n" : ""}export NODE_ENV=production\n${d.buildCommand}`, { cache, title: `Building: ${d.buildCommand}` });
  // collect the output into /levant-out (fallback to common names when the configured one is missing)
  df.run(
    [
      `OUT=${shq(out)}`,
      `if [ ! -d "$OUT" ]; then for c in dist build out public _site; do if [ -f "$c/index.html" ]; then echo "▲ output directory $OUT not found, using $c"; OUT=$c; break; fi; done; fi`,
      `[ -d "$OUT" ] || { echo "Output directory \\"$OUT\\" not found after the build" >&2; exit 1; }`,
      `mkdir -p /levant-out && cp -a "$OUT"/. /levant-out/`,
      `echo "▲ static output: ${workdir}/$OUT ($(du -sh /levant-out | cut -f1))"`,
    ].join("\n"),
    { secrets: false, title: "Collecting static output" },
  );
  caddyRuntime(df, ctx, { stage: "build", dir: "/levant-out" });
  return df;
}

function staticPlain(ctx: Ctx): DF {
  const { d, o } = ctx;
  const df = new DF(o);
  const out = d.outputDirectory && d.outputDirectory !== "." ? d.outputDirectory : ".";
  if (d.buildCommand) {
    // a build command on a plain static site → run it in a node image
    df.from(`node:${d.nodeVersion ?? DEFAULT_NODE_VERSION}-alpine`, "build");
    df.workdir("/app");
    df.buildArgs();
    df.copy(".", ".");
    if (d.installCommand) df.run(d.installCommand, { cache: pmCache.npm, title: `Installing: ${d.installCommand}` });
    df.run(`export NODE_ENV=production\n${d.buildCommand}`, { cache: pmCache.npm, title: `Building: ${d.buildCommand}` });
    caddyRuntime(df, ctx, { stage: "build", dir: out === "." ? "/app" : `/app/${out}` });
  } else {
    caddyRuntime(df, ctx, { dir: out === "." ? "." : out });
  }
  return df;
}

// ───────────────────────────── Bun / Deno ─────────────────────────────

function bun(ctx: Ctx): DF {
  const { d, o } = ctx;
  const df = new DF(o);
  df.from("oven/bun:1-alpine", "build");
  df.workdir("/app");
  df.buildArgs();
  df.copy(".", ".");
  if (d.installCommand) df.run(d.installCommand, { cache: pmCache.bun, title: `Installing dependencies: ${d.installCommand}` });
  if (d.buildCommand) df.run(`export NODE_ENV=production\n${d.buildCommand}`, { cache: pmCache.bun, title: `Building: ${d.buildCommand}` });
  df.run(`printf '%s' ${shq(startScript(d.startCommand ?? "bun run start", "/app"))} > /app/.levant-start.sh && chmod +x /app/.levant-start.sh`, { secrets: false });
  df.blank();
  df.from("oven/bun:1-alpine", "runtime");
  df.env({ NODE_ENV: "production", PORT: String(d.port), HOSTNAME: "0.0.0.0", HOST: "0.0.0.0" });
  df.workdir("/app");
  df.copy("/app", "/app", { from: "build", chown: "bun:bun" });
  df.user("bun");
  df.expose(d.port);
  df.cmd(["/app/.levant-start.sh"]);
  return df;
}

function deno(ctx: Ctx): DF {
  const { d, o } = ctx;
  const df = new DF(o);
  df.from("denoland/deno:alpine", "build");
  df.env({ DENO_DIR: "/deno-dir" });
  df.workdir("/app");
  df.buildArgs();
  df.copy(".", ".");
  if (d.installCommand) df.run(d.installCommand, { title: `Caching dependencies: ${d.installCommand}` });
  if (d.buildCommand) df.run(d.buildCommand, { title: `Building: ${d.buildCommand}` });
  df.run(`printf '%s' ${shq(startScript(d.startCommand ?? "deno task start", "/app"))} > /app/.levant-start.sh && chmod +x /app/.levant-start.sh && chown -R deno:deno /deno-dir /app`, { secrets: false });
  df.blank();
  df.from("denoland/deno:alpine", "runtime");
  df.env({ DENO_DIR: "/deno-dir", PORT: String(d.port), HOSTNAME: "0.0.0.0" });
  df.workdir("/app");
  df.copy("/deno-dir", "/deno-dir", { from: "build", chown: "deno:deno" });
  df.copy("/app", "/app", { from: "build", chown: "deno:deno" });
  df.user("deno");
  df.expose(d.port);
  df.cmd(["/app/.levant-start.sh"]);
  return df;
}

// ───────────────────────────── Python ─────────────────────────────

const PY_EXTRACT_DEPS = `python - <<'PY'
import sys
try:
    import tomllib
except ImportError:
    import tomli as tomllib
d = tomllib.load(open("pyproject.toml", "rb"))
deps = d.get("project", {}).get("dependencies", [])
open("/tmp/levant-req.txt", "w").write("\\n".join(deps) + "\\n")
print("▲ %d dependencies from pyproject.toml" % len(deps))
PY`;

function pythonInstall(d: Detection): string {
  if (d.overridden.includes("installCommand") && d.installCommand) return d.installCommand;
  switch (d.meta.depsTool) {
    case "uv":
      return "pip install uv && UV_PROJECT_ENVIRONMENT=/opt/venv uv sync --frozen --no-dev --no-install-project";
    case "poetry":
      return "pip install poetry && poetry config virtualenvs.create false && poetry install --only main --no-root --no-interaction";
    case "pipenv":
      return "pip install pipenv && PIPENV_VERBOSITY=-1 pipenv install --system --deploy";
    case "pip":
      return "pip install -r requirements.txt";
    case "pyproject":
      return `(${PY_EXTRACT_DEPS}\n) && pip install -r /tmp/levant-req.txt || pip install .`;
    default:
      return "echo 'no Python dependency manifest found'";
  }
}

function python(ctx: Ctx): DF {
  const { d, o } = ctx;
  const df = new DF(o);
  const v = d.pythonVersion ?? DEFAULT_PYTHON_VERSION;
  const pyEnv = { PIP_DISABLE_PIP_VERSION_CHECK: "1", PYTHONDONTWRITEBYTECODE: "1", PYTHONUNBUFFERED: "1", VIRTUAL_ENV: "/opt/venv", PATH: "/opt/venv/bin:/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin" };
  df.from(`python:${v}-slim`, "build");
  df.env(pyEnv);
  df.sh("python -m venv /opt/venv");
  df.workdir("/app");
  df.buildArgs();
  df.copy(".", ".");
  const extras = [d.meta.needsGunicorn ? "gunicorn" : null, d.meta.needsUvicorn ? "uvicorn[standard]" : null].filter(Boolean);
  const install = pythonInstall(d) + (extras.length ? `\npip install ${extras.map((e) => shq(e!)).join(" ")}` : "");
  df.run(install, { cache: ["id=levant-pip,target=/root/.cache/pip", "id=levant-uv,target=/root/.cache/uv"], title: "Installing dependencies" });
  if (d.buildCommand) {
    const tolerant = d.framework === "django" && !d.overridden.includes("buildCommand");
    df.run(tolerant ? `${d.buildCommand} || echo "▲ collectstatic skipped (configure STATIC_ROOT to enable it)"` : d.buildCommand, { title: `Building: ${d.buildCommand}` });
  }
  df.run(`printf '%s' ${shq(startScript(d.startCommand ?? "python main.py", "/app"))} > /app/.levant-start.sh && chmod +x /app/.levant-start.sh`, { secrets: false });
  df.blank();
  df.from(`python:${v}-slim`, "runtime");
  df.env({ ...pyEnv, PORT: String(d.port) });
  df.sh(DEBIAN_USER);
  df.workdir("/app");
  df.copy("/opt/venv", "/opt/venv", { from: "build" });
  df.copy("/app", "/app", { from: "build", chown: "app:app" });
  df.user("app");
  df.expose(d.port);
  df.cmd(["/app/.levant-start.sh"]);
  return df;
}

// ───────────────────────────── PHP ─────────────────────────────

function php(ctx: Ctx): DF {
  const { d, o } = ctx;
  const df = new DF(o);
  const v = (d.meta.phpVersion as string) || "8.3";
  const docRoot = (d.meta.docRoot as string) || ".";
  const laravel = d.framework === "laravel";
  if (d.meta.composer) {
    df.from("composer:2", "vendor");
    df.workdir("/app");
    df.buildArgs();
    df.copy(".", ".");
    df.run(d.installCommand ?? "composer install --no-dev --optimize-autoloader --no-interaction --no-progress", {
      cache: ["id=levant-composer,target=/tmp/cache"],
      title: "Installing Composer dependencies",
    });
  }
  if (d.meta.nodeAssets && d.buildCommand) {
    df.blank();
    df.from(`node:${DEFAULT_NODE_VERSION}-alpine`, "assets");
    df.workdir("/app");
    df.buildArgs();
    df.copy(".", ".");
    if (d.meta.composer) df.copy("/app/vendor", "/app/vendor", { from: "vendor" });
    df.run(`(npm ci || npm install)\n${d.buildCommand}`, { cache: pmCache.npm, title: `Building assets: ${d.buildCommand}` });
  }
  df.blank();
  df.from(`php:${v}-apache`, "runtime");
  df.env({ PORT: String(d.port), APACHE_DOCUMENT_ROOT: docRoot === "." ? "/var/www/html" : `/var/www/html/${docRoot}` });
  df.sh(
    [
      ...(laravel ? [`docker-php-ext-install -j"$(nproc)" pdo_mysql opcache bcmath >/dev/null`] : []),
      `a2enmod rewrite headers >/dev/null`,
      `sed -ri 's/Listen 80$/Listen \${PORT}/' /etc/apache2/ports.conf`,
      `sed -ri 's/<VirtualHost \\*:80>/<VirtualHost *:\${PORT}>/' /etc/apache2/sites-available/000-default.conf`,
      `sed -ri 's!/var/www/html!\${APACHE_DOCUMENT_ROOT}!g' /etc/apache2/sites-available/*.conf /etc/apache2/conf-available/*.conf`,
      `printf '<Directory ${"${APACHE_DOCUMENT_ROOT}"}>\\n  AllowOverride All\\n  Require all granted\\n</Directory>\\nServerName localhost\\n' > /etc/apache2/conf-available/levant.conf && a2enconf levant >/dev/null`,
      `mv "$PHP_INI_DIR/php.ini-production" "$PHP_INI_DIR/php.ini"`,
      `chown -R www-data:www-data /var/run/apache2 /var/log/apache2 /var/lock/apache2 2>/dev/null || true`,
    ].join(" && "),
  );
  df.workdir("/var/www/html");
  df.copy(".", "/var/www/html", { chown: "www-data:www-data" });
  if (d.meta.composer) df.copy("/app/vendor", "/var/www/html/vendor", { from: "vendor", chown: "www-data:www-data" });
  if (d.meta.nodeAssets && d.buildCommand) df.copy("/app/public", "/var/www/html/public", { from: "assets", chown: "www-data:www-data" });
  if (laravel) {
    df.sh("mkdir -p storage/framework/cache storage/framework/sessions storage/framework/views storage/logs bootstrap/cache && chown -R www-data:www-data storage bootstrap/cache");
  }
  df.user("www-data");
  df.expose(d.port);
  if (laravel) df.shellCmd(`sh -c 'php artisan config:cache >/dev/null 2>&1; php artisan route:cache >/dev/null 2>&1; php artisan view:cache >/dev/null 2>&1; exec apache2-foreground'`);
  else df.cmd(["apache2-foreground"]);
  return df;
}

// ───────────────────────────── Go ─────────────────────────────

function go(ctx: Ctx): DF {
  const { d, o } = ctx;
  const df = new DF(o);
  const v = (d.meta.goVersion as string) || "1.23";
  const caches = ["id=levant-gomod,target=/go/pkg/mod", `id=levant-gobuild-${o.cacheKey},target=/root/.cache/go-build`];
  df.from(`golang:${v}-alpine`, "build");
  df.env({ CGO_ENABLED: "0", GOFLAGS: "-mod=mod", GOTOOLCHAIN: "auto" });
  df.workdir("/src");
  df.buildArgs();
  df.copy(".", ".");
  if (d.installCommand) df.run(d.installCommand, { cache: caches, title: `Downloading modules: ${d.installCommand}` });
  df.run(`mkdir -p /out\n${d.buildCommand ?? "go build -o /out/app ."}`, { cache: caches, title: `Building: ${d.buildCommand}` });
  df.blank();
  df.from("alpine:3.20", "runtime");
  df.sh(ALPINE_USER);
  df.env({ PORT: String(d.port) });
  df.workdir("/app");
  df.copy("/out/", "/app/", { from: "build" });
  df.user("app");
  df.expose(d.port);
  if (d.startCommand && d.startCommand !== "/app/app") df.shellCmd(d.startCommand);
  else df.cmd(["/app/app"]);
  return df;
}

// ───────────────────────────── Rust ─────────────────────────────

function rust(ctx: Ctx): DF {
  const { d, o } = ctx;
  const df = new DF(o);
  const bin = (d.meta.binary as string) || "app";
  const caches = ["id=levant-cargo-registry,target=/usr/local/cargo/registry", "id=levant-cargo-git,target=/usr/local/cargo/git", `id=levant-cargo-target-${o.cacheKey},target=/src/target`];
  df.from("rust:1-slim-bookworm", "build");
  df.workdir("/src");
  df.buildArgs();
  df.copy(".", ".");
  const build = (d.buildCommand ?? "cargo build --release").replace(/--locked/, d.meta.locked ? "--locked" : "");
  df.run(`${build}\nmkdir -p /out && cp target/release/${shq(bin)} /out/ 2>/dev/null || find target/release -maxdepth 1 -type f -perm -u+x -exec cp {} /out/ \\;`, {
    cache: caches,
    title: `Building: ${build}`,
  });
  df.blank();
  df.from("debian:bookworm-slim", "runtime");
  df.sh(DEBIAN_USER);
  df.env({ PORT: String(d.port), RUST_LOG: "info" });
  df.workdir("/app");
  df.copy("/out/", "/app/", { from: "build" });
  df.user("app");
  df.expose(d.port);
  df.shellCmd(d.startCommand ?? `/app/${bin}`);
  return df;
}

// ───────────────────────────── Ruby ─────────────────────────────

function ruby(ctx: Ctx): DF {
  const { d, o } = ctx;
  const df = new DF(o);
  const v = (d.meta.rubyVersion as string) || "3.3";
  const env = { BUNDLE_WITHOUT: "development:test", BUNDLE_DEPLOYMENT: "0", BUNDLE_PATH: "/usr/local/bundle", RAILS_ENV: "production", RACK_ENV: "production", RAILS_LOG_TO_STDOUT: "1", RAILS_SERVE_STATIC_FILES: "1" };
  // full image for the build stage: native gems (puma/nio4r, bcrypt, pg, nokogiri…) need gcc/make + headers
  df.from(`ruby:${v}`, "build");
  df.env(env);
  df.workdir("/app");
  df.buildArgs();
  df.copy(".", ".");
  if (d.installCommand) df.run(`${d.installCommand} --jobs 4`, { cache: ["id=levant-gems,target=/root/.cache/bundle"], title: `Installing gems: ${d.installCommand}` });
  if (d.buildCommand) df.run(`SECRET_KEY_BASE_DUMMY=1 ${d.buildCommand}`, { title: `Building: ${d.buildCommand}` });
  df.run(`printf '%s' ${shq(startScript(d.startCommand ?? "bundle exec rackup -o 0.0.0.0 -p $PORT", "/app"))} > /app/.levant-start.sh && chmod +x /app/.levant-start.sh`, { secrets: false });
  df.blank();
  df.from(`ruby:${v}-slim`, "runtime");
  df.env({ ...env, PORT: String(d.port) });
  df.sh(DEBIAN_USER);
  df.workdir("/app");
  df.copy("/usr/local/bundle", "/usr/local/bundle", { from: "build" });
  df.copy("/app", "/app", { from: "build", chown: "app:app" });
  df.user("app");
  df.expose(d.port);
  df.cmd(["/app/.levant-start.sh"]);
  return df;
}

// ───────────────────────────── Java ─────────────────────────────

function java(ctx: Ctx): DF {
  const { d, o } = ctx;
  const df = new DF(o);
  const jv = (d.meta.javaVersion as string) || "21";
  const maven = d.meta.buildTool === "maven";
  df.from(maven ? `maven:3-eclipse-temurin-${jv}` : `gradle:8-jdk${jv}`, "build");
  df.workdir("/src");
  df.buildArgs();
  df.copy(".", ".");
  const cache = maven ? ["id=levant-m2,target=/root/.m2"] : ["id=levant-gradle,target=/root/.gradle"];
  df.run(
    [
      d.meta.wrapper ? `chmod +x ${maven ? "mvnw" : "gradlew"} 2>/dev/null || true` : null,
      maven ? `export MAVEN_OPTS="$JAVA_TOOL_OPTIONS"` : `export GRADLE_USER_HOME=/root/.gradle`,
      d.buildCommand,
      `mkdir -p /out`,
      `J=$(ls ${maven ? "target" : "build/libs"}/*.jar 2>/dev/null | grep -v -E '(-plain|-sources|-javadoc|original-).*\\.jar$' | head -n 1)`,
      `[ -n "$J" ] || { echo "No runnable jar found" >&2; exit 1; }`,
      `cp "$J" /out/app.jar && echo "▲ jar: $J"`,
    ]
      .filter(Boolean)
      .join("\n"),
    { cache, java: true, title: `Building: ${d.buildCommand}` },
  );
  df.blank();
  df.from(`eclipse-temurin:${jv}-jre`, "runtime");
  df.sh("groupadd -r -g 10001 app && useradd -r -u 10001 -g app -m -d /home/app app");
  df.env({ PORT: String(d.port), JAVA_OPTS: "-XX:MaxRAMPercentage=75 -XX:+ExitOnOutOfMemoryError" });
  df.workdir("/app");
  df.copy("/out/app.jar", "/app/app.jar", { from: "build" });
  df.user("app");
  df.expose(d.port);
  df.shellCmd(d.startCommand ?? "java $JAVA_OPTS -Dserver.port=$PORT -jar /app/app.jar");
  return df;
}

// ───────────────────────────── .NET ─────────────────────────────

function dotnet(ctx: Ctx): DF {
  const { d, o } = ctx;
  const df = new DF(o);
  const tfm = (d.meta.tfm as string) || "8.0";
  df.from(`mcr.microsoft.com/dotnet/sdk:${tfm}`, "build");
  df.env({ DOTNET_CLI_TELEMETRY_OPTOUT: "1", DOTNET_NOLOGO: "1" });
  df.workdir("/src");
  df.buildArgs();
  df.copy(".", ".");
  const cache = ["id=levant-nuget,target=/root/.nuget/packages"];
  if (d.installCommand) df.run(d.installCommand, { cache, title: `Restoring: ${d.installCommand}` });
  df.run(d.buildCommand ?? "dotnet publish -c Release -o /out", { cache, title: `Publishing: ${d.buildCommand}` });
  df.blank();
  df.from(`mcr.microsoft.com/dotnet/aspnet:${tfm}`, "runtime");
  df.env({ PORT: String(d.port), DOTNET_CLI_TELEMETRY_OPTOUT: "1", ASPNETCORE_ENVIRONMENT: "Production" });
  df.workdir("/app");
  df.copy("/out/", "/app/", { from: "build" });
  df.user("app");
  df.expose(d.port);
  df.shellCmd(`env ASPNETCORE_URLS=http://0.0.0.0:$PORT ${d.startCommand ?? "dotnet app.dll"}`);
  return df;
}

// ───────────────────────────── Elixir ─────────────────────────────

function elixir(ctx: Ctx): DF {
  const { d, o } = ctx;
  const df = new DF(o);
  const app = (d.meta.app as string) || "app";
  df.from("elixir:1.17-slim", "build");
  df.env({ MIX_ENV: "prod" });
  df.workdir("/app");
  df.buildArgs();
  df.copy(".", ".");
  df.run(`mix local.hex --force && mix local.rebar --force\n${d.installCommand ?? "mix deps.get --only prod"}`, {
    cache: ["id=levant-hex,target=/root/.hex"],
    title: "Fetching dependencies",
  });
  df.run(`mix compile\n${d.buildCommand ?? "mix release"}\nmkdir -p /out && cp -a _build/prod/rel/${app}/. /out/`, { title: `Building: ${d.buildCommand}` });
  df.blank();
  df.from("elixir:1.17-slim", "runtime");
  df.sh(DEBIAN_USER);
  df.env({ PORT: String(d.port), MIX_ENV: "prod", PHX_SERVER: "true", LANG: "C.UTF-8" });
  df.workdir("/app");
  df.copy("/out/", "/app/", { from: "build", chown: "app:app" });
  df.user("app");
  df.expose(d.port);
  df.shellCmd(d.startCommand ?? `/app/bin/${app} start`);
  return df;
}
