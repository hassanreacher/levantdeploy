const port = Number(Deno.env.get("PORT") ?? 8000);
Deno.serve({ port, hostname: "0.0.0.0" }, () => new Response("Hello from Deno on LevantDeploy\n"));
