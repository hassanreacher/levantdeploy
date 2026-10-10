// runtime test app: replica info, health, slow responses, websockets-free; DB checks via pg (DATABASE_URL) and raw RESP (REDIS_URL)
const http = require("http");
const os = require("os");
const net = require("net");
const port = Number(process.env.PORT || 3000);
let pg = null;
try { pg = require("pg"); } catch {}
function redisPing(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const s = net.connect(Number(u.port || 6379), u.hostname);
    let buf = "";
    s.setTimeout(3000, () => { s.destroy(); reject(new Error("timeout")); });
    s.on("connect", () => s.write(`*2\r\n$4\r\nAUTH\r\n$${decodeURIComponent(u.password).length}\r\n${decodeURIComponent(u.password)}\r\n*1\r\n$4\r\nPING\r\n`));
    s.on("data", (d) => { buf += d; if (buf.includes("PONG")) { s.end(); resolve(buf.trim().split("\r\n").join(" ")); } else if (buf.startsWith("-")) { s.end(); reject(new Error(buf)); } });
    s.on("error", reject);
  });
}
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
  if (u.pathname === "/health") return send(200, { ok: true });
  if (u.pathname === "/slow") return setTimeout(() => send(200, { slow: true }), Number(u.searchParams.get("ms") || 500));
  if (u.pathname === "/boom") return send(500, { error: "boom" });
  if (u.pathname === "/env") return send(200, { LEVANT_ENV: process.env.LEVANT_ENV, GREETING: process.env.GREETING || null, NODE_ENV: process.env.NODE_ENV });
  if (u.pathname === "/db") {
    try {
      if (!pg || !process.env.DATABASE_URL) return send(500, { error: "no DATABASE_URL / pg" });
      const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
      await c.connect();
      await c.query("CREATE TABLE IF NOT EXISTS visits (id serial primary key, at timestamptz default now())");
      await c.query("INSERT INTO visits DEFAULT VALUES");
      const r = await c.query("SELECT count(*)::int AS n, version() AS v FROM visits");
      await c.end();
      return send(200, { visits: r.rows[0].n, server: r.rows[0].v.split(" ").slice(0, 2).join(" ") });
    } catch (e) { return send(500, { error: e.message }); }
  }
  if (u.pathname === "/redis") {
    try { return send(200, { redis: await redisPing(process.env.REDIS_URL) }); } catch (e) { return send(500, { error: e.message }); }
  }
  if (u.pathname === "/cron") { console.log(`[cron-hit] ${new Date().toISOString()}`); return send(200, { cron: "ok" }); }
  console.log(`${req.method} ${req.url} replica=${process.env.LEVANT_REPLICA}`);
  if (u.pathname === "/warn") console.warn("WARN something odd happened");
  if (u.pathname === "/err") console.error("ERROR something failed");
  send(200, { app: "node", version: process.env.APP_VERSION || "v1", replica: process.env.LEVANT_REPLICA, host: os.hostname(), env: process.env.LEVANT_ENV });
});
server.listen(port, "0.0.0.0", () => console.log(`node test app listening on ${port} (replica ${process.env.LEVANT_REPLICA})`));
process.on("SIGTERM", () => { console.log("SIGTERM: draining"); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000); });
