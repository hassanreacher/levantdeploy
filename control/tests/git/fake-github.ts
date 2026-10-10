/**
 * Fake GitHub for git-area tests (REST API subset + git smart HTTP).
 *   tsx tests/git/fake-github.ts <port> <reposRoot> <publicKeyPem>
 * - Verifies app JWTs (RS256) with the given public key, issues installation tokens "ghs_fake_*".
 * - Serves bare repos under <reposRoot>/<owner>/<repo>.git through `git http-backend` (Basic auth with an issued token).
 * - Records every mutating call; GET /__calls returns them, DELETE /__calls clears.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { jwtVerify } from "jose";

const port = Number(process.argv[2] || 4103);
const root = path.resolve(process.argv[3] || "./fake-gh");
const pubPem = fs.readFileSync(process.argv[4]!, "utf8");
const pub = crypto.createPublicKey(pubPem);

const APP = { id: 4242, slug: "levant-test-app" };
const tokens = new Set<string>();
const calls: Array<{ method: string; path: string; body: unknown; at: number }> = [];
let nextId = 1000;
const comments = new Map<number, { id: number; body: string; issue: string }>();
const INSTALL = { id: 77, account: { login: "acme", type: "Organization", avatar_url: "https://avatars.example/acme" }, repository_selection: "all", suspended_at: null };

function repos() {
  const out: Array<Record<string, unknown>> = [];
  if (!fs.existsSync(root)) return out;
  for (const owner of fs.readdirSync(root)) {
    for (const r of fs.readdirSync(path.join(root, owner))) {
      if (!r.endsWith(".git")) continue;
      const name = r.slice(0, -4);
      const id = Math.abs(crypto.createHash("md5").update(`${owner}/${name}`).digest().readInt32BE(0));
      out.push({
        id,
        name,
        full_name: `${owner}/${name}`,
        private: true,
        default_branch: "main",
        html_url: `http://localhost:${port}/${owner}/${name}`,
        clone_url: `http://localhost:${port}/${owner}/${name}.git`,
        pushed_at: new Date().toISOString(),
        description: null,
        language: "HTML",
        owner: { login: owner, avatar_url: null },
      });
    }
  }
  return out;
}

const send = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString();
}

async function appAuth(req: http.IncomingMessage) {
  const h = req.headers.authorization ?? "";
  if (!h.startsWith("Bearer ")) return false;
  try {
    const { payload } = await jwtVerify(h.slice(7), pub, { algorithms: ["RS256"] });
    return payload.iss === String(APP.id);
  } catch {
    return false;
  }
}
const tokenAuth = (req: http.IncomingMessage) => {
  const h = req.headers.authorization ?? "";
  return h.startsWith("token ") && tokens.has(h.slice(6));
};

function gitBackend(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  // Basic auth: x-access-token:<installation token>
  const h = req.headers.authorization ?? "";
  const basic = h.startsWith("Basic ") ? Buffer.from(h.slice(6), "base64").toString() : "";
  const tok = basic.split(":")[1];
  if (!tok || !tokens.has(tok)) {
    res.writeHead(401, { "www-authenticate": 'Basic realm="fake"' });
    return res.end("auth required");
  }
  const env = {
    ...process.env,
    GIT_PROJECT_ROOT: root,
    GIT_HTTP_EXPORT_ALL: "1",
    PATH_INFO: decodeURIComponent(url.pathname),
    QUERY_STRING: url.search.slice(1),
    REQUEST_METHOD: req.method!,
    CONTENT_TYPE: req.headers["content-type"] ?? "",
    REMOTE_USER: "x-access-token",
    REMOTE_ADDR: "127.0.0.1",
    GIT_HTTP_MAX_REQUEST_BUFFER: "100M",
    HTTP_CONTENT_ENCODING: (req.headers["content-encoding"] as string) ?? "",
  };
  const p = spawn("git", ["http-backend"], { env });
  req.pipe(p.stdin);
  let head = Buffer.alloc(0);
  let headerDone = false;
  p.stdout.on("data", (chunk: Buffer) => {
    if (headerDone) return void res.write(chunk);
    head = Buffer.concat([head, chunk]);
    const idx = head.indexOf("\r\n\r\n");
    if (idx < 0) return;
    headerDone = true;
    const lines = head.subarray(0, idx).toString().split("\r\n");
    let status = 200;
    const headers: Record<string, string> = {};
    for (const l of lines) {
      const [k, ...v] = l.split(":");
      if (k!.toLowerCase() === "status") status = parseInt(v.join(":").trim());
      else headers[k!] = v.join(":").trim();
    }
    res.writeHead(status, headers);
    res.write(head.subarray(idx + 4));
  });
  p.stdout.on("end", () => res.end());
  p.stderr.on("data", (d) => process.stderr.write(d));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url!, `http://localhost:${port}`);
  const p = url.pathname;
  const m = req.method!;
  if (/\.git(\/|$)/.test(p)) return gitBackend(req, res, url);
  const raw = m === "GET" ? "" : await readBody(req);
  const body = raw ? JSON.parse(raw) : null;
  if (m !== "GET" && !p.startsWith("/__")) calls.push({ method: m, path: p, body, at: Date.now() });
  let mm: RegExpMatchArray | null;

  if (p === "/__calls") {
    if (m === "DELETE") calls.length = 0;
    return send(res, 200, calls);
  }
  if (p === "/__health") return send(res, 200, { ok: true });
  // manifest conversion (no auth)
  if ((mm = p.match(/^\/app-manifests\/([^/]+)\/conversions$/)) && m === "POST") {
    return send(res, 201, { id: APP.id, slug: APP.slug, client_id: "Iv1.fake", client_secret: "fake-secret", webhook_secret: "whsec-from-manifest", pem: fs.readFileSync(process.env.FAKE_GH_PRIVATE_KEY!, "utf8"), html_url: `http://localhost:${port}/apps/${APP.slug}` });
  }
  if (p.startsWith("/app")) {
    if (!(await appAuth(req))) return send(res, 401, { message: "Bad credentials (JWT)" });
    if (p === "/app") return send(res, 200, { id: APP.id, slug: APP.slug, html_url: `http://localhost:${port}/apps/${APP.slug}` });
    if ((mm = p.match(/^\/app\/installations\/(\d+)\/access_tokens$/)) && m === "POST") {
      const t = "ghs_fake_" + crypto.randomBytes(12).toString("hex");
      tokens.add(t);
      return send(res, 201, { token: t, expires_at: new Date(Date.now() + 3600_000).toISOString() });
    }
    if ((mm = p.match(/^\/app\/installations\/(\d+)$/))) return send(res, 200, { ...INSTALL, id: Number(mm[1]) });
  }
  if (!tokenAuth(req)) return send(res, 401, { message: "Bad credentials" });
  if (p === "/installation/repositories") {
    const r = repos();
    return send(res, 200, { total_count: r.length, repositories: r });
  }
  if ((mm = p.match(/^\/repositories\/(\d+)$/))) {
    const r = repos().find((x) => String(x.id) === mm![1]);
    return r ? send(res, 200, r) : send(res, 404, { message: "Not Found" });
  }
  if ((mm = p.match(/^\/repos\/([^/]+)\/([^/]+)$/))) {
    const r = repos().find((x) => x.full_name === `${mm![1]}/${mm![2]}`);
    return r ? send(res, 200, r) : send(res, 404, { message: "Not Found" });
  }
  if ((mm = p.match(/^\/repos\/([^/]+)\/([^/]+)\/branches\/(.+)$/))) {
    try {
      const dir = path.join(root, mm[1]!, `${mm[2]}.git`);
      const sha = execFileSync("git", ["-C", dir, "rev-parse", `refs/heads/${decodeURIComponent(mm[3]!)}`]).toString().trim();
      const msg = execFileSync("git", ["-C", dir, "log", "-1", "--format=%s", sha]).toString().trim();
      return send(res, 200, { name: mm[3], commit: { sha, commit: { message: msg, author: { name: "Tester" } }, author: { login: "tester", avatar_url: null } } });
    } catch {
      return send(res, 404, { message: "Branch not found" });
    }
  }
  if ((mm = p.match(/^\/repos\/[^/]+\/[^/]+\/statuses\/[0-9a-f]+$/)) && m === "POST") return send(res, 201, { id: nextId++, ...body });
  if (p.match(/^\/repos\/[^/]+\/[^/]+\/deployments$/) && m === "POST") return send(res, 201, { id: nextId++ });
  if (p.match(/^\/repos\/[^/]+\/[^/]+\/deployments\/\d+\/statuses$/) && m === "POST") return send(res, 201, { id: nextId++ });
  if ((mm = p.match(/^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments$/))) {
    const issue = `${mm[1]}#${mm[2]}`;
    if (m === "GET") return send(res, 200, [...comments.values()].filter((c) => c.issue === issue));
    const c = { id: nextId++, body: body.body, issue };
    comments.set(c.id, c);
    return send(res, 201, c);
  }
  if ((mm = p.match(/^\/repos\/[^/]+\/[^/]+\/issues\/comments\/(\d+)$/)) && m === "PATCH") {
    const c = comments.get(Number(mm[1]));
    if (!c) return send(res, 404, { message: "Not Found" });
    c.body = body.body;
    return send(res, 200, c);
  }
  return send(res, 404, { message: `fake: no route ${m} ${p}` });
});

server.listen(port, () => console.log(`fake github on :${port}, repos at ${root}`));
