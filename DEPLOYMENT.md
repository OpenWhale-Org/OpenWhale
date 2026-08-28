# Deploying OpenWhale

[中文版 →](./DEPLOYMENT.zh-CN.md)

Two paths: Docker (compose, one image) or from source (systemd + nginx). Both run the same two processes.

The gateway holds decrypted exchange credentials, places orders and installs plugins (arbitrary code). There are no roles: any signed-in user can move money. Restrict host access accordingly.

---

## Processes

| Process | Default port | Holds |
|---|---|---|
| **Gateway** (`@openwhaleorg/gateway`) | 3001 (`OPENWHALE_GATEWAY_PORT`) | Runtime, SQLite database, master key, decrypted credentials. Places orders, installs plugins. |
| **Dashboard** (`@openwhaleorg/dashboard`) | 3000 (`PORT`) | Next.js frontend. Proxies `/api/*` to the gateway; holds no secrets. |

Authentication is enforced by the gateway: every `/api/*` route requires a session, the dashboard only carries the cookie. **Publish the dashboard; keep port 3001 off the public internet.**

---

## Docker

```sh
cp .env.example .env        # OPENWHALE_MASTER_KEY, OPENWHALE_ADMIN_USER, OPENWHALE_ADMIN_PASSWORD
docker compose up -d --build
open http://localhost:3000
```

- One image (`node:22`, no apt — git and a toolchain come with the base) runs the gateway and the dashboard as two containers.
- State lives in the `openwhale-data` volume, mounted at `/data` = the container's `HOME`; the layout in §1 applies under `/data/.openwhale`. `docker compose down` keeps it, `down -v` deletes it.
- Only the dashboard is published, on `127.0.0.1:3000` (`OPENWHALE_PORT` to change). The gateway is reachable only on the compose network. Terminate TLS in front of 3000 before exposing it (§5).
- `OPENWHALE_PUBLIC_URL` sets the origin the gateway accepts (default `http://localhost:3000`).
- Plugins install from npm and GitHub as on a bare server. For a plugin developed on the host, mount its folder (the commented `./plugins` volume) and install by its container path `/plugins/<name>`.
- Upgrade: `git pull && docker compose up -d --build`. `.env` is read at start; a key rotation needs no rebuild. The dashboard's `/api/*` target is baked at build time (`--build-arg OPENWHALE_GATEWAY_URL`, default `http://gateway:3001`).
- Small hosts: `NODE_OPTIONS=--max-old-space-size=1536` in `.env` (§3).

---

## From source

Prerequisites: Node.js ≥ 20, pnpm ≥ 9, a domain with TLS, ~2 GB RAM to run.

### 1. Data directory

```
~/.openwhale/
├── openwhale.db          instances, credentials (encrypted), accounts, runs, PnL ledger
├── monitors/             monitor history, JSONL — the largest item; regenerable
└── plugins/
    ├── plugins.json      install manifest
    ├── node_modules/     npm- and GitHub-installed plugins
    └── staged/           the copy each install is loaded from
```

A deploy must never overwrite this directory. Back up `openwhale.db` on a schedule; prune `monitors/` when the disk fills.

### 2. Configuration

```bash
cp .env.example .env
```

```bash
OPENWHALE_MASTER_KEY=          # encrypts stored credentials; unrecoverable — back it up off the host
OPENWHALE_ADMIN_USER=          # creates the first user; remove both after signing in
OPENWHALE_ADMIN_PASSWORD=
```

The gateway refuses to start with no user account and no admin variables.

Optional:

```bash
OPENWHALE_ALLOWED_ORIGIN=https://openwhale.example.com   # cross-origin frontends only
OPENWHALE_HTTPS_PROXY=http://127.0.0.1:7897              # venue traffic proxy (see README)
OPENWHALE_GITHUB_TOKEN=                                  # plugins from private repos
```

### 3. Build

Build on a workstation, not on the server: a Next.js build needs more memory than a trading host, and an OOM during the build can take the running engine with it.

```bash
pnpm install
pnpm -r --filter '!@openwhaleorg/dashboard' build
cd packages/apps/dashboard && NEXT_DIST_DIR=.next-deploy npx next build   # keep the production build out of `next dev`'s .next
```

Sync sources and build output — not `node_modules`, `.env` or the data directory — then install runtime dependencies on the server:

```bash
rsync -az --delete --exclude node_modules --exclude .git --exclude .next --exclude .next-deploy --exclude .env ./ user@host:openwhale/
rsync -az --delete --exclude cache packages/apps/dashboard/.next-deploy/ user@host:openwhale/packages/apps/dashboard/.next/
ssh user@host 'cd openwhale && pnpm install --frozen-lockfile'
```

`scripts/deploy.sh` does all of the above plus restart and health check. Configure it in `scripts/deploy.env` (copy `deploy.env.example`): host, path, key, public URL, local plugin packages, and `DEPLOY_BLACKOUT`.

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

`Restart=always` is required: strategies' synthetic stops exist only while the process runs.

### 5. nginx and TLS

```nginx
server {
    listen 443 ssl;
    server_name openwhale.example.com;

    ssl_certificate     /etc/letsencrypt/live/openwhale.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/openwhale.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3002;
        proxy_http_version 1.1;
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection '';
        proxy_set_header Host       $host;
        proxy_set_header X-Forwarded-Proto $scheme;  # required: tells the gateway the request is TLS
        proxy_buffering off;                          # required for SSE (live events, log tails)
    }
}
```

`certbot --nginx -d openwhale.example.com` for the certificate.

TLS is required. The session cookie is `Secure`: over plain http, or with a missing `X-Forwarded-Proto`, the browser drops it and sign-in loops with nothing logged.

### 6. Verify

```bash
systemctl is-active openwhale-gateway openwhale-dashboard
curl -s -o /dev/null -w '%{http_code}\n' https://openwhale.example.com/login             # dashboard
curl -s -o /dev/null -w '%{http_code}\n' https://openwhale.example.com/api/auth/status   # dashboard → gateway
journalctl -u openwhale-gateway -f
```

---

## Operations

**One engine per credential set.** Two gateways holding the same API keys with the same instances enabled place duplicate orders; both log success. Disable instances on one side before the other starts.

**Restarts interrupt execution.** A deploy restarts the gateway mid-cycle: positions opened before a scheduled event may be left without the leg that closes them. `DEPLOY_BLACKOUT=FROM-TO` in `scripts/deploy.env` (minutes past the hour, UTC, wrapping) makes `deploy.sh` refuse inside that window; `--force-window` overrides.

**Upgrade.** Build, rsync, `pnpm install --frozen-lockfile`, restart. `~/.openwhale` is untouched. Instances marked `enabled` come back on boot; deactivated ones stay down.

**Rollback.** `git checkout <sha>`, rebuild, redeploy. The database is not covered: back it up before a release that migrates the schema.

**Plugins.** A plugin runs inside the gateway with access to every credential. npm installs update in place from the dashboard. GitHub installs are built by npm (source-only repos need a `prepare` script; private repos need `OPENWHALE_GITHUB_TOKEN`). Each install loads from its own copy under `plugins/staged/`, so a reinstall needs no restart.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| Sign-in loops back to the login page | `Secure` cookie dropped: no TLS, or `X-Forwarded-Proto` missing. |
| Dashboard renders empty | Gateway down or unreachable: `systemctl status openwhale-gateway`, then `OPENWHALE_GATEWAY_URL`. |
| One venue times out | Reachability. `OPENWHALE_HTTPS_PROXY` (README); `HTTPS_PROXY` and `NODE_USE_ENV_PROXY` are not honoured. |
| Instance shows a red strategy chip | Its plugin is gone or the new version dropped the strategy. Reinstall the version that has it. |
| Live events / log tails freeze | `proxy_buffering off` missing. |
| Disk filling | `~/.openwhale/monitors/` — regenerable; prune the oldest. |

---

## See also

- [中文部署指南](./DEPLOYMENT.zh-CN.md)
- [README](./README.md) — concepts and local development
- [`scripts/deploy.sh`](./scripts/deploy.sh) — the source deployment above, scripted
- `.env.example` — every environment variable
