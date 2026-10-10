import http from "node:http";
const port = Number(process.env.PORT) || 8080;
http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("Hello from a custom Dockerfile on LevantDeploy\n");
}).listen(port, "0.0.0.0", () => console.log(`listening on :${port}`));
