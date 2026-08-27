# Deploying OpenWhale

Running OpenWhale on a server you own — the layout, the rules, and the two or
three things that will bite you if nobody tells you first.

[中文版 →](./DEPLOYMENT.zh-CN.md)

This describes a real deployment: one small VPS behind nginx, two systemd
units, a SQLite data directory, and a build that happens on your laptop rather
than on the box. It is not the only shape that works, but everything here is in
production rather than imagined.

> **Before anything else.** This process holds decrypted exchange credentials
> and can place real orders. There are no roles — anyone who can sign in can
> move money. Treat the host the way you would treat a hardware wallet with a
> keyboard attached.

---

## What you are deploying

Two processes, and the split is not cosmetic:

| Process | Port | Holds |
|---|---|---|
| **Gateway** (`@openwhaleorg/gateway`) | 3001 | The runtime, the SQLite database, the master key, every decrypted credential. Places orders. Installs plugins, which is to say: runs arbitrary code. |
| **Dashboard** (`@openwhaleorg/dashboard`) | 3002 | Nothing. A Next.js frontend that proxies `/api/*` to the gateway. |

Authentication is enforced by the **gateway**, not the dashboard. A
frontend-only login would be walked around by anyone who can reach port 3001,
so every `/api/*` route requires a session and the dashboard merely carries the
cookie. Its route guard is a redirect for humans, not a security boundary.

The practical consequence: **port 3001 must not be reachable from the
internet.** Publish the dashboard, keep the gateway on loopback.

---

## Two ways in

**Docker** if you want it running in one command and do not intend to hack on
it. **From source** if you build the code you deploy, want the engine on the
host rather than behind a container boundary, or already run systemd.

Both end at the same place: a gateway on loopback, a dashboard behind TLS, and
one directory holding everything the engine owns. The rules in
[Operating it](#operating-it) apply to both.

---

## Docker

```bash
cp .env.example .env          # OPENWHALE_MASTER_KEY + OPENWHALE_ADMIN_USER/PASSWORD
docker compose up -d --build
```

`http://localhost:3000`. Sign in with the admin pair, then remove it from
`.env` — it exists to create the first user, not to stand as a credential.

Three things the compose file does on purpose:

**The gateway is not published.** It is `expose`d to the compose network and no
further. That process holds decrypted exchange keys, places orders, and installs
plugins — which is to say runs arbitrary code. Publishing it would make the
dashboard's login a formality, since auth is enforced by the gateway precisely
because it is the process with something to protect.

**The dashboard binds to loopback.** `127.0.0.1:3000`, not `0.0.0.0`. Put a TLS
terminator in front before it is reachable from anywhere else — see
[TLS is not optional](#tls-is-not-optional), which is the same trap by a
different route.

**The data volume is named, not bind-mounted.** `docker compose down` removes
containers; it does not remove a named volume. A bind mount to a directory you
later tidy up takes the credential store with it.

```bash
docker compose logs -f gateway
docker compose exec gateway sh          # /data is everything
docker compose up -d --build            # upgrade: rebuild, recreate, volume untouched
```

Back up the volume the way you would back up any database:

```bash
docker run --rm \
  -v openwhale_openwhale-data:/data -v "$PWD":/out \
  alpine tar czf /out/openwhale-backup.tgz -C /data .
```

### Docker notes

The image carries `git` and `npm` because plugin installs need them — a
GitHub install clones through npm, and the failure without git reads as a
network problem rather than a missing binary.

`HOME` is set to `/data`. The database can be moved with `OPENWHALE_DB_PATH`,
but monitor history resolves through the home directory independently, so
overriding one splits the state in two and leaves weeks of monitor JSONL inside
the container. Moving `HOME` moves all of it, and one volume holds the lot.

It is a large image. `node_modules` is copied whole because pnpm's store is a
web of symlinks into `node_modules/.pnpm` — copying a subset breaks it, and
pruning to production takes the dashboard's runtime dependencies with it.
Correct and starts, over small and does not.

---

## From source

Prerequisites: **Node.js ≥ 20** (22 in production here), **pnpm ≥ 9**, a domain
with a TLS certificate, and ~2 GB of RAM to *run*. More than that to build,
which is why you should not build here.

### 1. The data directory

Everything the engine owns lives in `~/.openwhale`:

```
~/.openwhale/
├── openwhale.db          instances, credentials (encrypted), accounts, runs, PnL ledger
├── monitors/             monitor history — JSONL, the largest thing here by far
└── plugins/
    ├── plugins.json      the install manifest
    ├── node_modules/     npm- and GitHub-installed plugins
    └── staged/           the copy each install is actually loaded from
```

This directory is **the server's own state**, not a copy of yours. A routine
deploy must never overwrite it: it holds positions the engine believes it has,
execution records not yet written anywhere else, and monitor history that took
weeks to accumulate.

Back up `openwhale.db` on a schedule. `monitors/` is regenerable and grows
without bound — it is the first thing to prune when the disk fills.

---

### 2. Configuration

```bash
cp .env.example .env
```

The two that matter on a first boot:

```bash
OPENWHALE_MASTER_KEY=          # encrypts every stored credential
OPENWHALE_ADMIN_USER=          # bootstrap login
OPENWHALE_ADMIN_PASSWORD=
```

**The master key is not recoverable.** Lose it and every stored credential is
unreadable — you re-enter every API key by hand. Back it up somewhere that is
not the server.

The gateway **fails closed**: with no user account and no admin variables it
refuses to start rather than serve an unauthenticated trading API. Set them
once, sign in, then take them back out of the environment — they exist to
create the first user, not to be a standing credential.

Optional, in the same file:

```bash
OPENWHALE_ALLOWED_ORIGIN=https://openwhale.example.com   # genuinely cross-origin frontends only
OPENWHALE_HTTPS_PROXY=http://127.0.0.1:7897              # where venues are unreachable directly
OPENWHALE_GITHUB_TOKEN=                                  # installing plugins from private repos
```

---

### 3. Build somewhere else

```bash
pnpm install
pnpm -r --filter '!@openwhaleorg/dashboard' build
cd packages/apps/dashboard && NEXT_DIST_DIR=.next-deploy npx next build
```

Two reasons this happens on your machine and not the server.

A Next.js build is the heaviest thing in the repo, and a box sized for a
trading engine is not sized for a compiler. More importantly, the engine is
*running* while you deploy — an OOM killer that arrives mid-build does not
politely stop at the build.

`NEXT_DIST_DIR=.next-deploy` keeps the production build out of `.next`, which
your local `next dev` overwrites in place. Sharing one directory between them
produces a deployment that works until the moment you run the dev server.

Then sync — sources and build output, never `node_modules`, never `.env`,
never the data directory:

```bash
rsync -az --delete \
  --exclude node_modules --exclude .git --exclude .next --exclude .next-deploy --exclude .env \
  ./ user@host:openwhale/

rsync -az --delete --exclude cache \
  packages/apps/dashboard/.next-deploy/ user@host:openwhale/packages/apps/dashboard/.next/
```

On the server, install runtime dependencies only:

```bash
cd ~/openwhale && pnpm install --frozen-lockfile
```

`scripts/deploy.sh` in this repo does all of the above, plus the health check.
Read it before adapting it — it encodes the operational rules below.

---

### 4. systemd

`/etc/systemd/system/openwhale-gateway.service`:

```ini
[Unit]
Description=OpenWhale Gateway
After=network-online.target

[Service]
User=openwhale
WorkingDirectory=/home/openwhale/openwhale/packages/apps/gateway
EnvironmentFile=/home/openwhale/openwhale/.env
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=5
Environment=NODE_OPTIONS=--max-old-space-size=4096

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/openwhale-dashboard.service`:

```ini
[Unit]
Description=OpenWhale Dashboard
After=openwhale-gateway.service

[Service]
User=openwhale
WorkingDirectory=/home/openwhale/openwhale/packages/apps/dashboard
Environment=PORT=3002
Environment=OPENWHALE_GATEWAY_URL=http://127.0.0.1:3001
ExecStart=/home/openwhale/openwhale/packages/apps/dashboard/node_modules/.bin/next start -p 3002
Restart=always
RestartSec=5
MemoryHigh=400M

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now openwhale-gateway openwhale-dashboard
```

`Restart=always` matters more than it looks. A monitor that dies takes its
subscriptions with it, and a strategy holding a position needs the engine
running to close it — the synthetic stops some strategies use protect only
while the process is alive.

---

### 5. nginx and TLS

Publish the dashboard. Never the gateway.

```nginx
server {
    listen 443 ssl;
    server_name openwhale.example.com;

    ssl_certificate     /etc/letsencrypt/live/openwhale.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/openwhale.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3002;
        proxy_http_version 1.1;
        proxy_set_header Upgrade    $http_upgrade;   # SSE: live events, log tails
        proxy_set_header Connection '';
        proxy_set_header Host       $host;
        proxy_set_header X-Forwarded-Proto $scheme;  # see below
        proxy_buffering off;                          # or SSE arrives in lumps
    }
}
```

`certbot --nginx -d openwhale.example.com` for the certificate.

### TLS is not optional

The session cookie is marked `Secure`, which the browser honours by **silently
dropping it** over plain http. The symptom is not an error: you sign in, the
page reloads, and you are signed out again, for ever, with nothing in any log
to say why.

`X-Forwarded-Proto` is what tells the gateway the request arrived over TLS. Get
it wrong and you reproduce the same loop from behind a working certificate.

`proxy_buffering off` is for the live-event and log-tail streams; with
buffering on they arrive in batches and look frozen.

---

### 6. Verify

```bash
systemctl is-active openwhale-gateway openwhale-dashboard
curl -s -o /dev/null -w '%{http_code}\n' https://openwhale.example.com/login
curl -s -o /dev/null -w '%{http_code}\n' https://openwhale.example.com/api/auth/status
```

Two 200s and both services active. The second URL goes through the dashboard's
proxy to the gateway, so it fails differently from the first — a 200 on `/login`
with a failure on `/api/auth/status` means the frontend is up and the engine is
not.

```bash
journalctl -u openwhale-gateway -f
```

---

## Operating it

### Never run two engines against one set of credentials

A gateway on your laptop and a gateway on the server, both holding the same API
keys with the same instances enabled, will each place the full order at the same
instant. The venue is happy to fill both.

This is the single easiest way to lose money with this tool, and it does not
announce itself: both engines log a clean, successful cycle.

Before starting a local gateway, check what the server is running. If you are
migrating state between machines, disable the instances on one side *before*
the other side comes up.

### Do not deploy into a settlement window

Restarting the gateway cuts whatever is executing in half.

For a funding-arbitrage strategy the open ladder starts around T−30s and the
close ladder runs past T+several seconds. A restart in that window leaves
positions opened with no close ladder to close them, and execution records that
never reached disk. This has happened: 2026-08-10 20:59:52, 5325 contracts left
naked for 52 seconds until a restarted engine's sweep caught them.

`scripts/deploy.sh` refuses to run between **XX:54 and XX:01 UTC** for exactly
this reason. If your strategies have their own cycle, put its window in the
same guard. A rule that lives only in documentation is a rule that gets
forgotten at 20:59.

### Upgrading

A routine deploy is: build locally, rsync, `pnpm install --frozen-lockfile`,
restart. It does not touch `~/.openwhale`, which is what makes it routine.

Instances marked `enabled` come back up on their own — that is boot's rule, and
plugin reloads follow it too. Instances you deactivated stay down.

### Rolling back

The code is a git checkout and the build is reproducible, so rolling back is
`git checkout <sha>`, rebuild, redeploy. **The database is not covered by
this.** A release that migrates the schema is a release you cannot roll back
without a backup taken beforehand — take one.

### Plugins on a server

Installing a plugin runs third-party code inside the gateway, with access to
every credential. The Plugins page says so; it is worth repeating for a machine
that is unattended.

npm-installed plugins can be updated in place from the dashboard. GitHub
installs are cloned and built by npm, so a source-only repo needs a `prepare`
script; private repos need `OPENWHALE_GITHUB_TOKEN` in the environment.

Plugins are loaded from their own copy under `plugins/staged/`, so reinstalling
runs the new code without a restart — Node's module registry is keyed by
resolved URL and cannot be evicted, so a fixed path would keep executing the
first version ever loaded.

---

## When something is wrong

| Symptom | Where to look |
|---|---|
| Sign-in loops back to the login page | TLS. The `Secure` cookie is being dropped — check the certificate and `X-Forwarded-Proto`. |
| Dashboard renders empty everywhere | The gateway is down or unreachable. `systemctl status openwhale-gateway`, then `OPENWHALE_GATEWAY_URL`. |
| A venue times out, everything else is fine | Reachability. See the proxy section of the main README — `HTTPS_PROXY` does nothing here, and neither does `NODE_USE_ENV_PROXY`. |
| An instance shows a red strategy chip | Its plugin is gone or was replaced by a version without that strategy. The row is kept on purpose; reinstalling the version that has it brings it back. |
| Live events and log tails freeze | `proxy_buffering off` is missing. |
| Disk filling | `~/.openwhale/monitors/`. Regenerable; prune the oldest. |

---

## See also

- [中文部署指南](./DEPLOYMENT.zh-CN.md)
- [README](./README.md) — what OpenWhale is, and the local development quick start
- [`scripts/deploy.sh`](./scripts/deploy.sh) — the deployment this document describes
- `.env.example` — every environment variable, with the reasoning
