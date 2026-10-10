const express = require("express");
const app = express();
const port = Number(process.env.PORT) || 3000;
app.get("/", (_req, res) => res.send(`Hello from Express on LevantDeploy (${process.env.LEVANT_ENV || "local"})`));
app.get("/health", (_req, res) => res.json({ ok: true }));
app.listen(port, "0.0.0.0", () => console.log(`listening on :${port}`));
