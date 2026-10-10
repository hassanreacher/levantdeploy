# Domains, DNS and HTTPS

LevantDeploy serves everything through one edge proxy (Caddy) on ports 80/443. Three kinds of hostnames point at
your server:

| hostname | example | what it serves |
|---|---|---|
| dashboard host | `deploy.example.com` | dashboard + REST API + webhooks |
| platform subdomains | `shop.example.com`, `shop-k3x9q2m7a.example.com`, `shop-git-feature-x.example.com` | production, every deployment, the latest preview of each branch |
| custom domains | `www.myshop.com`, `myshop.com` | whatever project you attach them to |
| AI Builder previews | `preview-k3x9q2m7a8b4c1d0e5f6.example.com` | live preview of an app being built (team members only, or via share link) |
| LevantBase backends | `abcdefghijklmnopqrst.base.example.com`, `studio-abcdefghijklmnopqrst.base.example.com` | backend API (`/auth/v1`, `/rest/v1`, `/realtime/v1`, `/storage/v1`, `/functions/v1`) and its Studio (dashboard login required) |

## 1. Point the platform domain at the server

At your DNS provider create:

| type | name | value | why |
|---|---|---|---|
| A | `deploy` (→ `deploy.example.com`) | server IPv4 | dashboard |
| A | `*` (→ `*.example.com`) | server IPv4 | every project / deployment / preview URL |
| A (or CNAME → `deploy.example.com`) | `*.base` (→ `*.base.example.com`) | server IPv4 | LevantBase backends: API + Studio |
| AAAA | same names | server IPv6 | optional, only if the server has public IPv6 |

The wildcard is what makes preview deployments — and the AI Builder's live previews (`preview-{id}.example.com`) — work
without touching DNS again (no extra record needed for the Builder): `anything.example.com` resolves to
the server and Caddy routes it to the right container. **Settings → General** shows these records with your
server's IP filled in (*Detect* finds the public IP).

Check from your PC:

```bash
dig +short deploy.example.com        # → server IP
dig +short anything.example.com      # → server IP (wildcard works)
curl -I https://deploy.example.com   # → HTTP/2 200 (after the first certificate is issued)
```

### The backend wildcard (`*.base.example.com`)

A DNS wildcard matches exactly one label: `*.example.com` answers `shop.example.com` but **not**
`ref.base.example.com`, so backends need their own wildcard record. The base domain defaults to `base.<platform domain>`;
choose another one with `install.sh --base-domain backend.example.org` (it can be in a different zone). Certificates
for backend hosts are issued on demand like every other host. With Cloudflare, keep `*.base` **DNS only**: Universal SSL
only covers `*.example.com`, so a proxied two-level wildcard fails TLS (or needs Advanced Certificate Manager).

Public Postgres connections (when a plan allows them) use plain TCP ports from `BASE_DB_PORT_RANGE` on the server IP
(e.g. `db.example.com:54012`); they are not proxied by Caddy or Cloudflare. Open the range with `install.sh --base-db-ports`
and in your cloud firewall.

### Using a subdomain as the platform domain

The platform domain doesn't have to be a whole zone. With `--domain apps.example.com` create `*.apps.example.com`
(and e.g. `deploy.example.com` for the dashboard). Apps then live at `shop.apps.example.com`.

### Apex domain for the dashboard?

`--dashboard-host` can be any hostname, including one in another zone. It needs its own A record.

## 2. Certificates (HTTPS)

Caddy obtains certificates automatically:

* **dashboard host** — at startup;
* **everything else — on demand**: the first TLS handshake for a hostname triggers issuance, *after* Caddy asks the
  control plane (`/api/internal/tls-ask`) whether the hostname belongs to a project. Random names are refused, so
  nobody can make your server request certificates for arbitrary domains.

Issuers: Let's Encrypt, with ZeroSSL as fallback (`ACME_EMAIL` is used for expiry notices). The first request to a
new hostname takes 1–3 seconds longer while the certificate is issued; later requests are instant. Certificates are
stored in the `caddy_data` volume — keep it, or every restart re-issues certificates and you may hit Let's Encrypt
rate limits (50 certificates per registered domain per week; previews of a very busy project count too).

Requirements for issuance: the hostname resolves to the server **and** port 80 or 443 is reachable from the internet
(cloud firewalls/security groups included).

`TLS_MODE=internal` uses Caddy's local CA instead (for testing on machines without public DNS — browsers will warn).

## 3. Custom domains

Project → **Domains** → *Add*. Then create the record LevantDeploy shows:

| domain | record |
|---|---|
| subdomain (`www.myshop.com`, `app.myshop.com`) | `CNAME` → `deploy.example.com` *(or the platform domain host shown)* — or an `A` record → server IP |
| apex (`myshop.com`) | `A` → server IP (most DNS providers don't allow a CNAME at the apex; Cloudflare's CNAME flattening works too) |

The domain switches to **Active** once DNS points at the server; the certificate is issued on the first visit.

* **Redirects** — add both `myshop.com` and `www.myshop.com` and set one to redirect to the other (308 by default).
* **Branch domains** — pin a domain to a git branch (`staging.myshop.com` → branch `staging`) to always serve that
  branch's latest preview.
* **Moving from another host** — lower the TTL to 300 a day before, add the domain in LevantDeploy, deploy, then
  switch the record. Visitors see the old host until their resolver picks up the change.

### Wildcard custom domains (`*.example.com`)

For multi-tenant apps (every customer at `name.example.com`) add `*.example.com` as a domain of the project.

| record | value |
|---|---|
| `CNAME *` (or `A *` → server IP) | `cname.<platform domain>` |
| `TXT _levant-verify` | the token shown in the dashboard (ownership of `example.com`) |

* Exactly one leading `*.` label; `*.com`, `*.co.uk` and wildcards on the platform domain are refused.
* Matches **one level**: `shop.example.com` yes, `a.b.example.com` and `example.com` itself no (add the apex separately).
* Exact hostnames always win — `www.example.com` or `admin.example.com` can belong to another project.
* Certificates are **per hostname, on demand** (first visit of each subdomain), gated by `tls-ask`, which accepts any
  single-label subdomain of an *Active* wildcard. A single wildcard certificate would require the ACME DNS-01 challenge
  with your DNS provider's API; that is not configured by default. Let's Encrypt allows 50 new certificates per
  registered domain per week.
* Wildcards can't redirect; pin them to a branch like any other domain if needed.

## 4. Cloudflare

Both modes work:

**DNS only (grey cloud) — recommended.** Caddy terminates TLS and obtains certificates itself, exactly as above.

**Proxied (orange cloud).** Cloudflare terminates TLS for visitors and connects to your server.

* SSL/TLS mode must be **Full** or **Full (strict)** — *Flexible* causes redirect loops (LevantDeploy redirects HTTP
  to HTTPS).
* Certificates: Caddy still needs a certificate for the origin side. HTTP-01 challenges on port 80 pass through
  the Cloudflare proxy, so on-demand issuance and renewals keep working. If a first issuance fails while proxied,
  grey-cloud the record for a minute, open the site once, then turn the proxy back on. *Full* (not strict) also
  accepts Caddy's fallback certificate.
* **Wildcard proxying** (`*.example.com` orange-clouded) is available on all Cloudflare plans for DNS but
  Universal SSL only covers one level (`*.example.com`, not `*.apps.example.com`). Keep the platform domain one level
  deep, or use DNS-only.
* WebSockets work through Cloudflare. Uploads through the proxy are limited to 100 MB on the Free plan — use the
  dashboard host DNS-only (grey) if you deploy large folders with the CLI.
* Real visitor IPs: Cloudflare sends `CF-Connecting-IP`; LevantDeploy's rate limits and audit log already read it.

## 5. Troubleshooting

| symptom | cause / fix |
|---|---|
| `ERR_SSL_PROTOCOL_ERROR` / certificate error on a new hostname | DNS not resolving to the server yet, or ports blocked. `docker compose logs caddy \| grep -i acme` |
| certificate error only on preview URLs | wildcard record missing — `dig +short random.example.com` must return the server IP |
| `This deployment could not be found` | the hostname resolves to the server but no project/deployment owns it (typo, or the domain isn't added) |
| custom domain stuck in *Verifying* | the record points elsewhere (old host, Cloudflare proxied with another origin); `dig +short www.myshop.com` |
| `too many certificates already issued` | Let's Encrypt rate limit — wait (limits reset weekly); ZeroSSL fallback is used meanwhile |
| redirect loop behind Cloudflare | SSL mode *Flexible* → set *Full* |
