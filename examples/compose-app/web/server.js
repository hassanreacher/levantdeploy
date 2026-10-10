// Tiny web service that counts visits in Redis (raw RESP over TCP, no dependencies).
import http from "node:http";
import net from "node:net";

const port = Number(process.env.PORT) || 3000;
const redisUrl = new URL(process.env.REDIS_URL || "redis://localhost:6379");

function incr(key) {
  return new Promise((resolve) => {
    const s = net.connect(Number(redisUrl.port || 6379), redisUrl.hostname);
    s.setTimeout(1000, () => (s.destroy(), resolve(null)));
    s.on("error", () => resolve(null));
    s.on("data", (d) => {
      const m = d.toString().match(/^:(\d+)/);
      resolve(m ? Number(m[1]) : null);
      s.end();
    });
    s.write(`*2\r\n$4\r\nINCR\r\n$${key.length}\r\n${key}\r\n`);
  });
}

http
  .createServer(async (_req, res) => {
    const n = await incr("visits");
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`${process.env.GREETING || "Hello"} from Docker Compose on LevantDeploy — visits: ${n ?? "redis unavailable"}\n`);
  })
  .listen(port, "0.0.0.0", () => console.log(`web listening on :${port}`));
