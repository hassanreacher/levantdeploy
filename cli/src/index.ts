#!/usr/bin/env node
import { Command, Option } from "commander";
import { Client, CliError } from "./api.js";
import { VERSION } from "./version.js";
import { c, fail } from "./ui.js";
import { login, logout, whoami } from "./commands/auth.js";
import { deploy } from "./commands/deploy.js";
import { linkProject } from "./project.js";
import {
  baseCreate, baseDbDump, baseDbPush, baseDbUrl, baseEnvPull, baseFunctionsDeploy, baseFunctionsInvoke, baseFunctionsLs, baseFunctionsRm, baseGenTypes,
  baseKeys, baseLink, baseLs, baseSecretsLs, baseSecretsSet, baseSecretsUnset, baseSql, baseStatus, baseStudio,
} from "./commands/base.js";
import { domainsAdd, domainsLs, domainsRm, domainsVerify, envAdd, envLs, envPull, envRm, logs, ls, openCmd, rollback } from "./commands/misc.js";

const program = new Command();
program
  .name("levant")
  .description("Deploy any folder to your own LevantDeploy server.")
  .version(VERSION, "-v, --version")
  .option("-s, --server <url>", "LevantDeploy server URL (default: ~/.levant/config.json or $LEVANT_SERVER)")
  .option("-t, --token <token>", "API token (default: ~/.levant/config.json or $LEVANT_TOKEN)")
  .option("--team <slug>", "team slug")
  .option("--debug", "print stack traces")
  .showHelpAfterError();

const client = () => {
  const o = program.opts<{ server?: string; token?: string }>();
  return new Client({ server: o.server, token: o.token });
};
const team = () => program.opts<{ team?: string }>().team;

function run<A extends unknown[]>(fn: (...a: A) => Promise<unknown>) {
  return async (...a: A) => {
    try {
      const code = await fn(...a);
      process.exitCode = typeof code === "number" ? code : 0;
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
      if (program.opts().debug && e instanceof Error) console.error(c.dim(e.stack ?? ""));
      process.exitCode = e instanceof CliError && e.status === 130 ? 130 : 1;
    }
  };
}

program
  .command("deploy [dir]", { isDefault: true })
  .description("deploy a folder (default: current directory) — preview unless --prod")
  .option("--prod", "deploy to production")
  .option("-e, --env <KEY=value...>", "set env vars for the target environment before deploying (repeatable)")
  .option("-y, --yes", "skip questions (link/create the project from the folder name)")
  .option("-p, --project <slug>", "project slug or id (instead of the folder link)")
  .option("--no-wait", "don't wait for the build — print the URL and exit")
  .option("--no-logs", "don't stream build logs")
  .action(run((dir: string | undefined, o) => deploy(client(), dir, { ...o, team: team() })));

program
  .command("login")
  .description("log in through the browser (or with --token)")
  .option("--no-browser", "don't open a browser, just print the URL")
  .action(run((o: { browser?: boolean }) => login({ server: program.opts().server, token: program.opts().token, browser: o.browser })));
program.command("logout").description("forget the stored token").action(run(() => logout()));
program.command("whoami").description("show the current user").action(run(() => whoami(client())));

program
  .command("link [dir]")
  .description("link a folder to a project (or create one)")
  .option("-p, --project <slug>", "project slug or id")
  .option("-y, --yes", "use the folder name, no questions")
  .option("--name <name>", "name for a new project")
  .action(run((dir: string | undefined, o) => linkProject(client(), dir ?? process.cwd(), { ...o, team: team() })));

program
  .command("ls")
  .alias("list")
  .description("list deployments of the linked project")
  .option("--prod", "production only")
  .option("-n, --limit <n>", "how many", "20")
  .option("-p, --project <slug>", "project slug or id")
  .action(run((o) => ls(client(), { ...o, team: team() })));

program
  .command("logs [deployment]")
  .description("show build logs of a deployment (id, URL or production URL; default: latest)")
  .option("-f, --follow", "keep streaming")
  .option("-r, --runtime", "runtime (container) logs instead of build logs")
  .option("-p, --project <slug>", "project slug or id")
  .action(run((ref: string | undefined, o) => logs(client(), ref, { ...o, team: team() })));

const env = program.command("env").description("manage environment variables");
env.command("ls").description("list variables").option("-p, --project <slug>").action(run((o) => envLs(client(), { ...o, team: team() })));
env
  .command("add <key> [value]")
  .description("add a variable (value from stdin when omitted)")
  .addOption(new Option("--target <envs>", "comma separated: production,preview,development (default: all)"))
  .option("--secret", "write-only secret")
  .option("--branch <branch>", "preview override for one branch")
  .option("--force", "overwrite an existing value")
  .option("-p, --project <slug>")
  .action(run((key: string, value: string | undefined, o) => envAdd(client(), key, value, { ...o, team: team() })));
env
  .command("rm <key>")
  .alias("remove")
  .description("remove a variable")
  .option("--target <envs>", "only from these environments")
  .option("-y, --yes", "no confirmation")
  .option("-p, --project <slug>")
  .action(run((key: string, o) => envRm(client(), key, { ...o, team: team() })));
env
  .command("pull [file]")
  .description("write variables to a .env file (default .env.local)")
  .option("--environment <env>", "development | preview | production", "development")
  .option("-y, --yes", "overwrite without asking")
  .option("-p, --project <slug>")
  .action(run((file: string | undefined, o) => envPull(client(), file, { ...o, team: team() })));

const domains = program.command("domains").alias("domain").description("manage custom domains");
domains.command("ls").description("list domains").option("-p, --project <slug>").action(run((o) => domainsLs(client(), { ...o, team: team() })));
domains
  .command("add <hostname>")
  .description("add a domain")
  .option("--redirect <hostname>", "redirect to another domain")
  .option("--branch <branch>", "serve the latest preview of a branch")
  .option("-p, --project <slug>")
  .action(run((h: string, o) => domainsAdd(client(), h, { ...o, team: team() })));
domains.command("rm <hostname>").description("remove a domain").option("-y, --yes").option("-p, --project <slug>").action(run((h: string, o) => domainsRm(client(), h, { ...o, team: team() })));
domains.command("verify <hostname>").description("check DNS now").option("-p, --project <slug>").action(run((h: string, o) => domainsVerify(client(), h, { ...o, team: team() })));

program
  .command("rollback [deployment]")
  .description("point production back to a previous deployment (default: the one before the current)")
  .option("-y, --yes", "no confirmation")
  .option("-p, --project <slug>")
  .action(run((ref: string | undefined, o) => rollback(client(), ref, { ...o, team: team() })));

program
  .command("open")
  .description("open the production URL (or --dashboard)")
  .option("--dashboard", "open the project in the dashboard")
  .option("-p, --project <slug>")
  .action(run((o) => openCmd(client(), { ...o, team: team() })));


// ── LevantBase ──────────────────────────────────────────────────────────────────────────────────────────────────────
const collect = (v: string, prev: string[] = []) => [...prev, v];
const base = program
  .command("base")
  .description("LevantBase backends: Postgres, Auth, REST, Realtime, Storage, Edge Functions (supabase-js compatible)")
  .option("--ref <ref>", "Base project ref or name (default: .levant/base.json or the linked project's backend)");
const bopts = <T extends object>(o: T) => ({ ...o, ref: base.opts<{ ref?: string }>().ref ?? (o as { ref?: string }).ref, team: team() });
base.command("ls").alias("list").description("list Base projects of the team").option("--json").action(run((o) => baseLs(client(), bopts(o))));
base
  .command("create <name>")
  .description("create a Base project (waits until it is ready, links this folder)")
  .option("-p, --project [slug]", "attach it to a Deploy project (default: the linked one) and add SUPABASE_* env vars")
  .option("--service-role", "also add SUPABASE_SERVICE_ROLE_KEY to the Deploy project (admins)")
  .option("--db-password <password>", "database password (16–128 letters/digits; default: generated)")
  .option("--no-wait", "return immediately")
  .option("--no-link", "don't link this folder")
  .action(run((name: string, o) => baseCreate(client(), name, bopts(o))));
base.command("link [ref]").description("link this folder to a Base project (.levant/base.json)").option("-y, --yes").action(run((ref: string | undefined, o) => baseLink(client(), ref, bopts(o))));
base.command("status").description("status, URL and service health").option("--json").action(run((o) => baseStatus(client(), bopts(o))));
base
  .command("keys")
  .description("API URL + anon key (--service: service_role key, team admins only)")
  .option("--service", "include the service_role key (bypasses RLS — servers only)")
  .option("--json")
  .action(run((o) => baseKeys(client(), bopts(o))));
const benv = base.command("env").description("environment files");
benv
  .command("pull [file]")
  .description("write SUPABASE_URL / NEXT_PUBLIC_… / VITE_… / EXPO_PUBLIC_… URL + anon key to .env.local (merged)")
  .option("--service", "also write SUPABASE_SERVICE_ROLE_KEY (admins)")
  .action(run((file: string | undefined, o) => baseEnvPull(client(), file, bopts(o))));
const bdb = base.command("db").description("database");
bdb.command("url").description("connection string (password hidden unless --reveal)").option("--reveal", "show the password (admins, audited)").action(run((o) => baseDbUrl(client(), bopts(o))));
bdb
  .command("dump")
  .description("pg_dump of auth, public, storage + your schemas (SQL) to stdout or -f file (admins)")
  .option("-f, --file <file>", "write to a file instead of stdout")
  .action(run((o) => baseDbDump(client(), bopts(o))));
bdb
  .command("push [dir]")
  .description("apply new migrations (*.sql, in order) from supabase/migrations or [dir]; tracked in levant.levant_migrations")
  .option("--dry-run", "only list pending migrations")
  .option("-y, --yes", "no confirmation")
  .action(run((dir: string | undefined, o) => baseDbPush(client(), dir, bopts(o))));
base
  .command("sql [statement]")
  .description("run SQL (statement, --file or stdin) and print the result")
  .option("-f, --file <file>")
  .option("--json")
  .action(run((sql: string | undefined, o) => baseSql(client(), sql, bopts(o))));
const bfn = base.command("functions").alias("fn").description("edge functions");
bfn.command("ls").alias("list").description("list functions").option("--json").action(run((o) => baseFunctionsLs(client(), bopts(o))));
bfn
  .command("deploy [slug]")
  .description("deploy supabase/functions/<slug> (or --dir); all functions when no slug is given")
  .option("--dir <dir>", "function folder (default supabase/functions/<slug>)")
  .option("--no-verify-jwt", "allow calls without a JWT (webhooks); default from supabase/config.toml")
  .action(run((slug: string | undefined, o) => baseFunctionsDeploy(client(), slug, bopts(o))));
bfn.command("rm <slug>").alias("delete").description("delete a function").option("-y, --yes").action(run((slug: string, o) => baseFunctionsRm(client(), slug, bopts(o))));
bfn
  .command("invoke <slug>")
  .description("call a function through the platform (prints status + body)")
  .option("-d, --data <body>", "request body (default: stdin when piped)")
  .option("-X, --method <method>", "HTTP method", "POST")
  .option("--service", "authorize with the service_role key (admins)")
  .option("--no-auth", "send no Authorization header")
  .action(run((slug: string, o: { auth?: boolean }) => baseFunctionsInvoke(client(), slug, bopts({ ...o, noAuth: o.auth === false }))));
const bsec = base.command("secrets").description("edge function secrets (env vars)");
bsec.command("ls").alias("list").description("list secret names").option("--json").action(run((o) => baseSecretsLs(client(), bopts(o))));
bsec
  .command("set [pairs...]")
  .description("set secrets: KEY=value … or --env-file .env")
  .option("--env-file <file>", "read KEY=value lines from a file")
  .action(run((pairs: string[], o) => baseSecretsSet(client(), pairs ?? [], bopts(o))));
bsec.command("unset <names...>").alias("rm").description("remove secrets").action(run((names: string[], o) => baseSecretsUnset(client(), names, bopts(o))));
const bgen = base.command("gen").description("code generation");
bgen
  .command("types <lang>")
  .description("database types (`typescript`) to stdout — e.g. levant base gen types typescript > src/database.types.ts")
  .option("-s, --schema <schema>", "schema to include (repeatable, default public)", collect)
  .action(run((lang: string, o) => baseGenTypes(client(), lang, bopts(o))));
base.command("studio").description("open Studio (database editor) in the browser").option("--no-browser", "only print the URL").action(run((o) => baseStudio(client(), bopts(o))));

program.parseAsync(process.argv);
