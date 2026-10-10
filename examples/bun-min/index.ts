const server = Bun.serve({
  port: Number(process.env.PORT) || 3000,
  hostname: "0.0.0.0",
  fetch: () => new Response("Hello from Bun on LevantDeploy\n"),
});
console.log(`listening on :${server.port}`);
