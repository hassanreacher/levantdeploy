import type { Project } from "@prisma/client";

/**
 * Fallback Dockerfile templates for `generate_dockerfile` when the build area's generator
 * (src/lib/build) isn't available. Deliberately small and conventional; the agent adapts them.
 */
export type DockerfileHints = {
  framework?: string | null;
  /** files at the repo root (from the source snapshot), used for detection */
  files?: string[];
  packageJson?: { scripts?: Record<string, string>; engines?: { node?: string }; dependencies?: Record<string, string>; devDependencies?: Record<string, string> } | null;
  nodeVersion?: string | null;
  port: number;
};

export function detectStack(h: DockerfileHints): string {
  const f = (h.framework || "").toLowerCase();
  const files = new Set((h.files ?? []).map((x) => x.replace(/\/$/, "")));
  const deps = { ...(h.packageJson?.dependencies ?? {}), ...(h.packageJson?.devDependencies ?? {}) };
  if (f.includes("next") || "next" in deps) return "nextjs";
  if (["vite", "react", "vue", "svelte", "angular", "static"].some((x) => f.includes(x)) && !h.packageJson?.scripts?.start) return "static-spa";
  if (files.has("package.json") || f.includes("node") || f.includes("express") || f.includes("nest")) return "node";
  if (files.has("requirements.txt") || files.has("pyproject.toml") || f.includes("python") || f.includes("django") || f.includes("flask") || f.includes("fastapi")) return "python";
  if (files.has("go.mod") || f.includes("go")) return "go";
  if (files.has("index.html")) return "static";
  return "node";
}

export function templateDockerfile(project: Pick<Project, "port" | "framework">, h: Partial<DockerfileHints> = {}): { stack: string; dockerfile: string } {
  const hints: DockerfileHints = { port: project.port, framework: project.framework, ...h };
  const stack = detectStack(hints);
  const node = (hints.nodeVersion || hints.packageJson?.engines?.node || "20").replace(/[^\d.]/g, "").split(".")[0] || "20";
  const port = hints.port;
  const T: Record<string, string> = {
    nextjs: `# Next.js (standalone output recommended: next.config → output: "standalone")
FROM node:${node}-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM node:${node}-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:${node}-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=${port}
COPY --from=build /app ./
EXPOSE ${port}
CMD ["npm", "start", "--", "-p", "${port}"]
`,
    node: `FROM node:${node}-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN npm run build --if-present
ENV NODE_ENV=production PORT=${port}
EXPOSE ${port}
CMD ["npm", "start"]
`,
    "static-spa": `FROM node:${node}-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM caddy:2-alpine
COPY --from=build /app/dist /srv
EXPOSE ${port}
CMD ["caddy", "file-server", "--root", "/srv", "--listen", ":${port}"]
`,
    python: `FROM python:3.12-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PORT=${port}
COPY requirements*.txt ./
RUN pip install --no-cache-dir -r requirements.txt gunicorn
COPY . .
EXPOSE ${port}
CMD ["sh", "-c", "gunicorn --bind 0.0.0.0:${port} app:app"]
`,
    go: `FROM golang:1.23-alpine AS build
WORKDIR /src
COPY go.* ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /out/app .

FROM gcr.io/distroless/static
COPY --from=build /out/app /app
ENV PORT=${port}
EXPOSE ${port}
ENTRYPOINT ["/app"]
`,
    static: `FROM caddy:2-alpine
COPY . /srv
EXPOSE ${port}
CMD ["caddy", "file-server", "--root", "/srv", "--listen", ":${port}"]
`,
  };
  return { stack, dockerfile: T[stack] ?? T.node! };
}
