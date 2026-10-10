import os from "node:os";
import open from "open";
import { Client, CliError } from "../api.js";
import { normalizeServer, readConfig, writeConfig } from "../config.js";
import { ask, c, info, isTTY, ok } from "../ui.js";

export async function login(opts: { server?: string; token?: string; browser?: boolean }) {
  const cfg = readConfig();
  let server = opts.server || process.env.LEVANT_SERVER || cfg.server;
  if (!server) server = isTTY() ? await ask("LevantDeploy server URL?", "https://") : "";
  if (!server || server === "https://") throw new CliError("Pass --server https://deploy.example.com");
  server = normalizeServer(server);

  let token = opts.token;
  if (!token) {
    const anon = new Client({ server, token: "-" });
    const start = await anon.request<{ deviceCode: string; userCode: string; verificationUrl: string; interval: number; expiresIn: number }>("POST", "/api/v1/cli/login", {
      auth: false,
      body: { clientName: "levant CLI", hostname: os.hostname() },
    });
    info(`\n  Confirm this code in your browser: ${c.bold(c.cyan(start.userCode))}\n  ${c.underline(start.verificationUrl)}\n`);
    if (opts.browser !== false) await open(start.verificationUrl).catch(() => {});
    const until = Date.now() + start.expiresIn * 1000;
    process.stderr.write(c.dim("  Waiting for approval…"));
    for (;;) {
      if (Date.now() > until) throw new CliError("\nThe code expired. Run `levant login` again.");
      await new Promise((r) => setTimeout(r, start.interval * 1000));
      try {
        const r = await anon.request<{ status: string; token?: string; team?: string | null }>("POST", "/api/v1/cli/login/poll", { auth: false, body: { deviceCode: start.deviceCode } });
        if (r.status === "approved" && r.token) {
          token = r.token;
          if (r.team) cfg.team = r.team;
          break;
        }
      } catch (e) {
        const s = (e as CliError).status;
        if (s === 403) throw new CliError("\nLogin was denied in the browser.");
        if (s === 410) throw new CliError("\nThe code expired. Run `levant login` again.");
        if (s !== 202) throw e;
      }
    }
    process.stderr.write("\r\x1b[K");
  }
  const client = new Client({ server, token });
  const me = await client.request<{ user: { email: string; name: string } }>("GET", "/api/v1/me");
  writeConfig({ ...cfg, server, token, user: { email: me.user.email, name: me.user.name } });
  ok(`Logged in to ${c.bold(server)} as ${c.bold(me.user.email)}`);
}

export async function logout() {
  const cfg = readConfig();
  writeConfig({ server: cfg.server });
  ok("Logged out (token removed from ~/.levant/config.json). Revoke it in the dashboard under Tokens if needed.");
}

export async function whoami(client: Client) {
  const me = await client.request<{ user: { email: string; name: string }; teams?: Array<{ slug: string; name: string; role?: string }> }>("GET", "/api/v1/me");
  console.log(`${me.user.name} <${me.user.email}>`);
  info(c.dim(`server ${client.server}`));
  if (me.teams?.length) info(c.dim(`teams  ${me.teams.map((t) => `${t.slug}${t.role ? ` (${t.role.toLowerCase()})` : ""}`).join(", ")}`));
}
