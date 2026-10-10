import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { detect, resolveNodeVersion, resolvePythonVersion, stripJsonComments } from "./detect";
import { generateDockerfile, mirrorImage } from "./dockerfile";
import { buildSettingsSchema, parseBuildSettings } from "./types";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "levant-detect-"));
afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
let n = 0;

/** create a fixture dir from { "path": "content" } */
function fx(files: Record<string, string | object>): string {
  const dir = path.join(tmpRoot, `f${n++}`);
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, typeof content === "string" ? content : JSON.stringify(content));
  }
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const pkg = (deps: Record<string, string> = {}, extra: Record<string, unknown> = {}) => ({ name: "x", dependencies: deps, ...extra });

describe("node frameworks", () => {
  it("Next.js with pnpm + .nvmrc", () => {
    const d = detect(fx({ "package.json": pkg({ next: "^15.1.0", react: "19" }, { scripts: { build: "next build", start: "next start" } }), "pnpm-lock.yaml": "", ".nvmrc": "v20.11.1" }));
    expect(d).toMatchObject({ framework: "nextjs", kind: "WEB", strategy: "generated", packageManager: "pnpm", nodeVersion: "20", version: "15.1.0", port: 3000 });
    expect(d.installCommand).toBe("pnpm install --frozen-lockfile");
    expect(d.buildCommand).toBe("pnpm run build");
  });
  it("Next.js static export → STATIC out/", () => {
    const d = detect(fx({ "package.json": pkg({ next: "14.2.0" }, { scripts: { build: "next build" } }), "next.config.mjs": "export default { output: 'export' }" }));
    expect(d).toMatchObject({ framework: "nextjs", kind: "STATIC", outputDirectory: "out" });
  });
  it("Nuxt", () => {
    const d = detect(fx({ "package.json": pkg({ nuxt: "^3.13.0" }, { scripts: { build: "nuxt build" } }), "yarn.lock": "" }));
    expect(d).toMatchObject({ framework: "nuxt", kind: "WEB", packageManager: "yarn", startCommand: "node .output/server/index.mjs" });
    expect(d.installCommand).toBe("yarn install --frozen-lockfile");
  });
  it("SvelteKit node vs static adapters", () => {
    expect(detect(fx({ "package.json": pkg({ "@sveltejs/kit": "2", "@sveltejs/adapter-node": "5" }, { scripts: { build: "vite build" } }) })).kind).toBe("WEB");
    const s = detect(fx({ "package.json": pkg({ "@sveltejs/kit": "2", "@sveltejs/adapter-static": "3" }, { scripts: { build: "vite build" } }) }));
    expect(s).toMatchObject({ kind: "STATIC", outputDirectory: "build" });
    const auto = detect(fx({ "package.json": pkg({ "@sveltejs/kit": "2", "@sveltejs/adapter-auto": "3" }, { scripts: { build: "vite build" } }) }));
    expect(auto.meta.adapter).toBe("auto");
  });
  it("Remix and React Router v7", () => {
    expect(detect(fx({ "package.json": pkg({ "@remix-run/node": "2", "@remix-run/react": "2" }, { scripts: { build: "remix vite:build", start: "remix-serve ./build/server/index.js" } }), "vite.config.ts": "" })).framework).toBe("remix");
    const rr = detect(fx({ "package.json": pkg({ "@react-router/dev": "7.1.0", "@react-router/serve": "7" }, { scripts: { build: "react-router build", start: "react-router-serve ./build/server/index.js" } }) }));
    expect(rr).toMatchObject({ framework: "react-router", kind: "WEB", startCommand: "npm start" });
  });
  it("Astro static vs node", () => {
    expect(detect(fx({ "package.json": pkg({ astro: "4" }, { scripts: { build: "astro build" } }) }))).toMatchObject({ framework: "astro", kind: "STATIC", outputDirectory: "dist" });
    const node = detect(fx({ "package.json": pkg({ astro: "5", "@astrojs/node": "9" }), "astro.config.mjs": "export default defineConfig({ output: 'server', adapter: node({ mode: 'standalone' }) })" }));
    expect(node).toMatchObject({ kind: "WEB", startCommand: "node ./dist/server/entry.mjs" });
  });
  it("Vite / CRA / Angular / Vue SPAs", () => {
    expect(detect(fx({ "package.json": pkg({ react: "19" }, { devDependencies: { vite: "6" }, scripts: { build: "vite build" } }) }))).toMatchObject({ framework: "vite", kind: "STATIC", outputDirectory: "dist" });
    expect(detect(fx({ "package.json": pkg({ "react-scripts": "5.0.1" }, { scripts: { build: "react-scripts build" } }) }))).toMatchObject({ framework: "create-react-app", outputDirectory: "build" });
    const ng = detect(
      fx({
        "package.json": pkg({ "@angular/core": "18" }, { scripts: { build: "ng build" } }),
        "angular.json": { projects: { shop: { architect: { build: { builder: "@angular-devkit/build-angular:application", options: { outputPath: "dist/shop" } } } } } },
      }),
    );
    expect(ng).toMatchObject({ framework: "angular", kind: "STATIC", outputDirectory: "dist/shop/browser" });
    expect(detect(fx({ "package.json": pkg({ vue: "3" }, { devDependencies: { "@vue/cli-service": "5" } }) })).framework).toBe("vue");
  });
  it("NestJS / Express / Fastify / generic node", () => {
    expect(detect(fx({ "package.json": pkg({ "@nestjs/core": "10" }, { scripts: { build: "nest build", "start:prod": "node dist/main" } }), "package-lock.json": "{}" }))).toMatchObject({
      framework: "nestjs",
      startCommand: "npm run start:prod",
      installCommand: "npm ci",
    });
    expect(detect(fx({ "package.json": pkg({ express: "^4.19.2" }, { scripts: { start: "node server.js" } }) }))).toMatchObject({ framework: "express", startCommand: "npm start", installCommand: "npm install" });
    expect(detect(fx({ "package.json": pkg({ fastify: "4" }), "index.js": "" })).startCommand).toBe("node index.js");
    expect(detect(fx({ "package.json": pkg({ koa: "2" }, { main: "app.js" }), "app.js": "" })).framework).toBe("koa");
  });
  it("Bun via lockfile", () => {
    const d = detect(fx({ "package.json": pkg({ hono: "4" }, { scripts: { start: "bun run src/index.ts" } }), "bun.lockb": "" }));
    expect(d).toMatchObject({ framework: "bun", language: "bun", packageManager: "bun", startCommand: "bun run start" });
  });
  it("node engines → version", () => {
    expect(detect(fx({ "package.json": pkg({ express: "4" }, { engines: { node: ">=18 <21" }, scripts: { start: "node ." } }) })).nodeVersion).toBe("20");
  });
  it("monorepo: lockfile at the workspace root", () => {
    const root = fx({ "pnpm-lock.yaml": "", "package.json": { private: true }, "apps/web/package.json": pkg({ next: "15" }, { scripts: { build: "next build" } }) });
    const d = detect(path.join(root, "apps/web"), {}, { repoDir: root });
    expect(d.packageManager).toBe("pnpm");
    expect(d.meta.workspaceRoot).toBe("../..");
  });
});

describe("other languages", () => {
  it("Deno", () => {
    expect(detect(fx({ "deno.json": { tasks: { start: "deno run -A main.ts" } }, "main.ts": "" }))).toMatchObject({ framework: "deno", startCommand: "deno task start", port: 8000 });
  });
  it("Django (pip) with runtime.txt", () => {
    const d = detect(fx({ "manage.py": "", "requirements.txt": "Django==5.0\n", "runtime.txt": "python-3.11.9", "proj/settings.py": "", "proj/wsgi.py": "" }));
    expect(d).toMatchObject({ framework: "django", pythonVersion: "3.11", port: 8000 });
    expect(d.startCommand).toContain("gunicorn proj.wsgi:application");
    expect(d.meta.needsGunicorn).toBe(true);
  });
  it("FastAPI (poetry) with app in app/main.py", () => {
    const d = detect(
      fx({ "pyproject.toml": '[tool.poetry]\nname="x"\n[tool.poetry.dependencies]\npython = "^3.12"\nfastapi = "^0.110"\nuvicorn = "*"\n', "poetry.lock": "", "app/main.py": "from fastapi import FastAPI\napp = FastAPI()\n" }),
    );
    expect(d).toMatchObject({ framework: "fastapi", pythonVersion: "3.12" });
    expect(d.meta.depsTool).toBe("poetry");
    expect(d.startCommand).toContain("uvicorn app.main:app");
  });
  it("Flask (uv) + .python-version", () => {
    const d = detect(fx({ "pyproject.toml": '[project]\nname="x"\nrequires-python=">=3.10"\ndependencies=["flask>=3"]\n', "uv.lock": "", ".python-version": "3.13\n", "server.py": "from flask import Flask\napplication = Flask(__name__)\n" }));
    expect(d).toMatchObject({ framework: "flask", pythonVersion: "3.13" });
    expect(d.meta.depsTool).toBe("uv");
    expect(d.startCommand).toContain("gunicorn server:application");
  });
  it("generic python worker via Procfile", () => {
    const d = detect(fx({ "requirements.txt": "requests\n", "Procfile": "worker: python bot.py\n", "bot.py": "" }));
    expect(d).toMatchObject({ framework: "python", kind: "WORKER", startCommand: "python bot.py" });
  });
  it("Procfile web overrides", () => {
    expect(detect(fx({ "requirements.txt": "flask\n", "Procfile": "web: gunicorn wsgi:app -b 0.0.0.0:$PORT\n", "app.py": "" })).startCommand).toBe("gunicorn wsgi:app -b 0.0.0.0:$PORT");
  });
  it("Laravel + plain PHP", () => {
    expect(detect(fx({ "composer.json": { require: { php: "^8.2", "laravel/framework": "^11.0" } }, artisan: "", "public/index.php": "" }))).toMatchObject({ framework: "laravel", outputDirectory: "public", port: 8080 });
    expect(detect(fx({ "index.php": "<?php echo 1;" }))).toMatchObject({ framework: "php", outputDirectory: "." });
  });
  it("Go with cmd/ main package", () => {
    const d = detect(fx({ "go.mod": "module x\n\ngo 1.22\n", "cmd/server/main.go": "package main\nfunc main(){}\n", "internal/a.go": "package internal\n" }));
    expect(d).toMatchObject({ framework: "go", port: 8080 });
    expect(d.meta.mainPackage).toBe("./cmd/server");
  });
  it("Rust binary name", () => {
    expect(detect(fx({ "Cargo.toml": '[package]\nname = "api-server"\nversion="0.1.0"\n', "Cargo.lock": "" })).startCommand).toBe("/app/api-server");
  });
  it("Rails / Rack", () => {
    expect(detect(fx({ Gemfile: 'source "https://rubygems.org"\ngem "rails", "~> 7.1"\n', "app/assets/x": "" }))).toMatchObject({ framework: "rails", buildCommand: "bundle exec rails assets:precompile" });
    expect(detect(fx({ Gemfile: 'gem "sinatra"\ngem "puma"\n', "config.ru": "run App" })).startCommand).toContain("puma");
  });
  it("Spring Boot maven / gradle", () => {
    const m = detect(fx({ "pom.xml": "<project><parent><artifactId>spring-boot-starter-parent</artifactId></parent><properties><java.version>17</java.version></properties></project>", mvnw: "" }));
    expect(m).toMatchObject({ framework: "spring-boot", port: 8080 });
    expect(m.meta).toMatchObject({ buildTool: "maven", javaVersion: "17", wrapper: true });
    expect(detect(fx({ "build.gradle.kts": 'plugins { id("org.springframework.boot") version "3.3.0" }' })).meta.buildTool).toBe("gradle");
  });
  it(".NET web project", () => {
    const d = detect(fx({ "src/Api/Api.csproj": '<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><TargetFramework>net9.0</TargetFramework></PropertyGroup></Project>' }));
    expect(d).toMatchObject({ framework: "dotnet", startCommand: "dotnet Api.dll" });
    expect(d.meta.tfm).toBe("9.0");
  });
  it("Phoenix", () => {
    expect(detect(fx({ "mix.exs": "def project do [app: :my_app, deps: [{:phoenix, \"~> 1.7\"}]] end", assets: "" }))).toMatchObject({ framework: "phoenix", startCommand: "/app/bin/my_app start", port: 4000 });
  });
  it("static html", () => {
    expect(detect(fx({ "index.html": "<h1>x</h1>" }))).toMatchObject({ framework: "static", kind: "STATIC", outputDirectory: "." });
  });
  it("unknown", () => {
    expect(detect(fx({ "README.md": "# hi" })).framework).toBe("unknown");
  });
});

describe("Dockerfile / compose / overrides", () => {
  it("repo Dockerfile wins and reads EXPOSE", () => {
    const d = detect(fx({ Dockerfile: "FROM nginx\nEXPOSE 8081\n", "package.json": pkg({ next: "15" }), "docker-compose.yml": "services: {}" }));
    expect(d).toMatchObject({ framework: "dockerfile", strategy: "dockerfile", port: 8081, dockerfilePath: "Dockerfile" });
    expect(d.notes.join(" ")).toContain("ignored");
  });
  it("custom Dockerfile path", () => {
    expect(detect(fx({ "docker/prod.Dockerfile": "FROM x" }), { dockerfilePath: "docker/prod.Dockerfile" })).toMatchObject({ strategy: "dockerfile", dockerfilePath: "docker/prod.Dockerfile" });
  });
  it("compose file → COMPOSE", () => {
    expect(detect(fx({ "compose.yaml": "services:\n  web:\n    image: nginx\n" }))).toMatchObject({ kind: "COMPOSE", strategy: "compose", composeFile: "compose.yaml" });
  });
  it("project settings override everything", () => {
    const d = detect(fx({ "package.json": pkg({ express: "4" }, { scripts: { start: "node a.js" } }) }), {
      installCommand: "npm ci --omit=optional",
      startCommand: "node dist/server.js",
      buildCommand: "npm run compile",
      nodeVersion: "20",
    });
    expect(d).toMatchObject({ installCommand: "npm ci --omit=optional", startCommand: "node dist/server.js", buildCommand: "npm run compile", nodeVersion: "20" });
    expect(d.overridden).toEqual(expect.arrayContaining(["installCommand", "startCommand", "buildCommand", "nodeVersion"]));
  });
  it("forced preset", () => {
    const d = detect(fx({ "package.json": pkg({ vite: "5" }), "index.html": "" }), { framework: "static", outputDirectory: "public" });
    expect(d).toMatchObject({ framework: "static", outputDirectory: "public" });
    expect(detect(fx({ "package.json": pkg({ express: "4" }, { scripts: { start: "x" } }), Dockerfile: "FROM x" }), { framework: "express" }).framework).toBe("express");
  });
  it("IMAGE source", () => {
    expect(detect(fx({}), {}, { image: "nginx:alpine" })).toMatchObject({ strategy: "image", framework: "image" });
  });
});

describe("helpers", () => {
  it("version resolution", () => {
    expect(resolveNodeVersion("^18.17.0")).toBe("18");
    expect(resolveNodeVersion(">=20")).toBe("22");
    expect(resolveNodeVersion(">=23")).toBe("24");
    expect(resolveNodeVersion("lts/*")).toBe("22");
    expect(resolveNodeVersion("18.x || 20.x")).toBe("20");
    expect(resolvePythonVersion("python-3.10.4")).toBe("3.10");
    expect(resolvePythonVersion(">=3.9,<3.12")).toBe("3.11");
    expect(resolvePythonVersion("^3.11")).toBe("3.12");
  });
  it("jsonc", () => {
    expect(JSON.parse(stripJsonComments('{ // c\n "a": "http://x", /* b */ "b": [1,2,], }'))).toEqual({ a: "http://x", b: [1, 2] });
  });
  it("build settings schema", () => {
    expect(buildSettingsSchema.safeParse({ outputDirectory: "../etc" }).success).toBe(false);
    expect(buildSettingsSchema.safeParse({ framework: "nope" }).success).toBe(false);
    expect(parseBuildSettings({ framework: "nextjs", outputDirectory: "/abs", nodeVersion: "22" })).toEqual({ framework: "nextjs", nodeVersion: "22" });
  });
});

describe("Dockerfile generation", () => {
  it("node: non-root, cache mounts, secrets never as ARG, CA mount, standalone handling", () => {
    const d = detect(fx({ "package.json": pkg({ next: "15" }, { scripts: { build: "next build", start: "next start" } }), "package-lock.json": "{}" }));
    const { dockerfile } = generateDockerfile({ detection: d, buildArgKeys: ["NEXT_PUBLIC_API"], secretKeys: ["DATABASE_URL"], cacheKey: "p1" });
    expect(dockerfile).toContain("FROM node:22-alpine AS build");
    expect(dockerfile).toContain("ARG NEXT_PUBLIC_API");
    expect(dockerfile).not.toContain("ARG DATABASE_URL");
    expect(dockerfile).toContain("--mount=type=secret,id=DATABASE_URL,env=DATABASE_URL");
    expect(dockerfile).toContain("--mount=type=secret,id=levant_ca");
    expect(dockerfile).toContain("--mount=type=cache,id=levant-npm,target=/root/.npm");
    expect(dockerfile).toContain(".next/standalone");
    expect(dockerfile).toMatch(/USER node/);
    expect(dockerfile).toContain('CMD ["/app/.levant-start.sh"]');
  });
  it("registry mirror rewrites Docker Hub images only", () => {
    expect(mirrorImage("node:22-alpine", "mirror.gcr.io")).toBe("mirror.gcr.io/library/node:22-alpine");
    expect(mirrorImage("oven/bun:1", "https://mirror.gcr.io/")).toBe("mirror.gcr.io/oven/bun:1");
    expect(mirrorImage("docker.io/library/redis:7", "m.io")).toBe("m.io/library/redis:7");
    expect(mirrorImage("mcr.microsoft.com/dotnet/sdk:8.0", "m.io")).toBe("mcr.microsoft.com/dotnet/sdk:8.0");
    expect(mirrorImage("node:22", null)).toBe("node:22");
  });
  it("every language template renders", () => {
    const cases: Record<string, Record<string, string | object>> = {
      static: { "index.html": "x" },
      vite: { "package.json": pkg({ vite: "5" }, { scripts: { build: "vite build" } }) },
      python: { "requirements.txt": "flask\n", "app.py": "from flask import Flask\napp = Flask(__name__)\n" },
      php: { "index.php": "" },
      laravel: { "composer.json": { require: { "laravel/framework": "11" } }, artisan: "", "package.json": pkg({}, { scripts: { build: "vite build" } }) },
      go: { "go.mod": "module x\ngo 1.22\n", "main.go": "package main\n" },
      rust: { "Cargo.toml": '[package]\nname="a"\n' },
      ruby: { Gemfile: 'gem "sinatra"', "config.ru": "" },
      java: { "pom.xml": "<spring-boot>" },
      dotnet: { "A.csproj": '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>' },
      elixir: { "mix.exs": "app: :a, :phoenix" },
      deno: { "main.ts": "", "deno.json": {} },
      bun: { "package.json": pkg({}, { scripts: { start: "bun x.ts" } }), "bun.lockb": "" },
    };
    for (const [name, files] of Object.entries(cases)) {
      const d = detect(fx(files));
      const g = generateDockerfile({ detection: d, cacheKey: "p" });
      expect(g.dockerfile, name).toMatch(/^FROM /m);
      expect(g.dockerfile, name).toMatch(/^USER /m);
      expect(g.dockerfile, name).toMatch(/^CMD /m);
    }
  });
});

describe("examples/", () => {
  const examples = path.resolve(__dirname, "../../../../examples");
  const expected: Record<string, string> = {
    "node-express": "express",
    nextjs: "nextjs",
    "vite-react": "vite",
    "python-fastapi": "fastapi",
    "python-django-min": "django",
    flask: "flask",
    "php-plain": "php",
    "go-http": "go",
    "rust-axum": "rust",
    "static-html": "static",
    "dockerfile-custom": "dockerfile",
    "compose-app": "compose",
    "ruby-sinatra": "ruby",
    "java-spring-min": "spring-boot",
    "dotnet-min": "dotnet",
    "deno-min": "deno",
    "bun-min": "bun",
  };
  for (const [dir, fw] of Object.entries(expected)) {
    it.skipIf(!fs.existsSync(path.join(examples, dir)))(`${dir} → ${fw}`, () => {
      expect(detect(path.join(examples, dir)).framework).toBe(fw);
    });
  }
});

describe("error summary", () => {
  it("keeps the real cause, drops BuildKit noise", async () => {
    const { summarizeError } = await import("./log");
    const tail = [
      "#9 8.753 cp: write error: No space left on device",
      "#9 8.754 cp: write error: No space left on device",
      '#9 ERROR: process "sh -c set -e ..." did not complete successfully: exit code: 1',
      "------",
      ' > [build 6/6] RUN ["sh","-c","..."]:',
      "Dockerfile.levant:27",
      'ERROR: failed to build: failed to solve: process "sh -c ..." did not complete successfully: exit code: 1',
    ];
    expect(summarizeError(tail, "x")).toBe("cp: write error: No space left on device");
  });
});

describe("inline Dockerfile + system packages", () => {
  it("dockerfileInline takes precedence over repo Dockerfile and templates", () => {
    const d = detect(fx({ Dockerfile: "FROM nginx\nEXPOSE 80\n", "package.json": pkg({ next: "15" }) }), { dockerfileInline: "FROM busybox\nEXPOSE 9000\n" });
    expect(d).toMatchObject({ strategy: "dockerfile", dockerfilePath: "(inline)", port: 9000 });
    expect(d.meta.inline).toBe(true);
  });
  it("dockerfileInline validation", () => {
    expect(buildSettingsSchema.safeParse({ dockerfileInline: "x".repeat(70_000) }).success).toBe(false);
    expect(buildSettingsSchema.safeParse({ dockerfileInline: "echo hi" }).success).toBe(false);
    expect(buildSettingsSchema.safeParse({ dockerfileInline: "# syntax=docker/dockerfile:1\nARG V=1\nFROM alpine:$V\n" }).success).toBe(true);
  });
  it("systemPackages: apk on alpine, apt on debian stages, invalid names rejected", () => {
    expect(buildSettingsSchema.safeParse({ systemPackages: ["libpq-dev", "build-base"] }).success).toBe(true);
    expect(buildSettingsSchema.safeParse({ systemPackages: ["ok; rm -rf /"] }).success).toBe(false);
    const settings = { systemPackages: ["libpq-dev"] };
    const py = generateDockerfile({ detection: detect(fx({ "requirements.txt": "flask\n", "app.py": "from flask import Flask\napp = Flask(__name__)\n" })), settings }).dockerfile;
    expect(py.match(/apt-get install -y -qq --no-install-recommends libpq-dev/g)?.length).toBe(2); // build + runtime
    const node = generateDockerfile({ detection: detect(fx({ "package.json": pkg({ express: "4" }, { scripts: { start: "node a.js" } }) })), settings }).dockerfile;
    expect(node.match(/apk add --no-cache libpq-dev/g)?.length).toBe(2);
    expect(generateDockerfile({ detection: detect(fx({ "index.html": "x" })) }).dockerfile).not.toMatch(/apk add|apt-get/);
  });
});

describe("error summary (explicit errors)", () => {
  it("prefers Error: lines", async () => {
    const { summarizeError } = await import("./log");
    const tail = ["#8 760.5 Error: Missing required env var SESSION_SECRET", "#8 760.5     at c (.next/server/webpack-runtime.js:1:128)", "#8 760.5 > Build error occurred", "#8 760.6 [Error: Failed to collect page data for /api/files/[id]] {", "#8 760.6   type: 'Error'", "#8 760.6 }"];
    expect(summarizeError(tail, "x")).toBe("Error: Missing required env var SESSION_SECRET\n[Error: Failed to collect page data for /api/files/[id]] {");
  });
});

describe("docker build args", () => {
  it("noCache disables cache-from; secrets never in argv", async () => {
    const { buildArgsList } = await import("./docker-build");
    const base = { contextDir: "/c", dockerfile: "/d", tag: "t", tmpDir: "/tmp", onLine: () => {}, cacheFrom: ["levant/p:old"], secrets: { DB_PASS: "s3cret-value" }, buildArgs: { A: "1" } };
    const on = buildArgsList({ ...base, noCache: true });
    expect(on.args).toContain("--no-cache");
    expect(on.args).not.toContain("--cache-from");
    const off = buildArgsList({ ...base, proxy: { httpsProxy: "http://p:1", network: "host" } });
    expect(off.args).toEqual(expect.arrayContaining(["--cache-from", "levant/p:old", "--network", "host", "--build-arg", "HTTPS_PROXY=http://p:1", "--secret", "id=DB_PASS,env=LEVANT_SECRET_DB_PASS"]));
    expect(off.args.join(" ")).not.toContain("s3cret-value");
    expect(off.env.LEVANT_SECRET_DB_PASS).toBe("s3cret-value");
  });
});

describe("effective kind", () => {
  it("build-detected kind wins for compose / workers", async () => {
    const { effectiveKind } = await import("./types");
    expect(effectiveKind({ build: { kind: "COMPOSE" } }, "WEB")).toBe("COMPOSE");
    expect(effectiveKind({ build: { kind: "WEB" } }, "COMPOSE")).toBe("WEB");
    expect(effectiveKind({ build: { kind: "WORKER" } }, "WEB")).toBe("WORKER");
    expect(effectiveKind({ build: { kind: "WEB" } }, "WORKER")).toBe("WORKER");
    expect(effectiveKind({}, "STATIC")).toBe("STATIC");
  });
});
