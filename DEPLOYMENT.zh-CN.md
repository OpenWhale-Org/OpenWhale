# 部署 OpenWhale

[English →](./DEPLOYMENT.md)

两条路径：Docker（compose，单镜像）或源码部署（systemd + nginx）。两者运行的都是同样的两个进程。

网关持有解密后的交易所凭证，会下单、会安装插件（即执行任意代码）。没有角色：任何登录用户都能动钱。请据此限制主机访问。

---

## 进程

| 进程 | 默认端口 | 持有 |
|---|---|---|
| **Gateway**（`@openwhaleorg/gateway`） | 3001（`OPENWHALE_GATEWAY_PORT`） | 运行时、SQLite 数据库、主密钥、解密后的凭证。下单、安装插件。 |
| **Dashboard**（`@openwhaleorg/dashboard`） | 3000（`PORT`） | Next.js 前端。把 `/api/*` 反代给网关，不持有任何密钥。 |

认证由网关强制：每个 `/api/*` 路由都需要会话，看板只负责携带 cookie。**发布看板，3001 端口不上公网。**

---

## Docker

```sh
cp .env.example .env        # OPENWHALE_MASTER_KEY、OPENWHALE_ADMIN_USER、OPENWHALE_ADMIN_PASSWORD
docker compose up -d --build
open http://localhost:3000
```

- 一个镜像（`node:22`，不用 apt——基础镜像自带 git 和编译工具链）以两个容器分别运行网关和看板。
- 状态在 `openwhale-data` 卷里，挂载于 `/data` = 容器的 `HOME`；§1 的目录布局位于 `/data/.openwhale`。`docker compose down` 保留它，`down -v` 删除它。
- 只发布看板，绑定 `127.0.0.1:3000`（`OPENWHALE_PORT` 可改）。网关只在 compose 网络内可达。对外开放前先在 3000 前面终止 TLS（§5）。
- `OPENWHALE_PUBLIC_URL` 设置网关接受的来源地址（默认 `http://localhost:3000`）。
- 从 npm / GitHub 安装插件与裸机一致。本机开发中的插件：挂载其目录（compose 中注释掉的 `./plugins` 卷），按容器内路径 `/plugins/<name>` 安装。
- 升级：`git pull && docker compose up -d --build`。`.env` 在启动时读取，换密钥无需重新构建。看板的 `/api/*` 目标在构建时固化（`--build-arg OPENWHALE_GATEWAY_URL`，默认 `http://gateway:3001`）。
- 小内存主机：`.env` 中设置 `NODE_OPTIONS=--max-old-space-size=1536`（§3）。

---

## 源码部署

前置条件：Node.js ≥ 20，pnpm ≥ 9，带 TLS 证书的域名，运行约需 2 GB 内存。

### 1. 数据目录

```
~/.openwhale/
├── openwhale.db          实例、凭证（加密）、账户、运行记录、PnL 账本
├── monitors/             监控历史，JSONL——体积最大；可再生
└── plugins/
    ├── plugins.json      安装清单
    ├── node_modules/     从 npm / GitHub 安装的插件
    └── staged/           每次安装实际加载的副本
```

部署绝不能覆盖这个目录。定期备份 `openwhale.db`；磁盘满时清理 `monitors/`。

### 2. 配置

```bash
cp .env.example .env
```

```bash
OPENWHALE_MASTER_KEY=          # 加密所有存储的凭证；不可恢复——在主机之外备份
OPENWHALE_ADMIN_USER=          # 创建首个用户；登录后移除这两项
OPENWHALE_ADMIN_PASSWORD=
```

没有用户账号且没有管理员变量时，网关拒绝启动。

可选：

```bash
OPENWHALE_ALLOWED_ORIGIN=https://openwhale.example.com   # 仅跨域前端需要
OPENWHALE_HTTPS_PROXY=http://127.0.0.1:7897              # 场地流量代理（见 README）
OPENWHALE_GITHUB_TOKEN=                                  # 从私有仓库安装插件
```

### 3. 构建

在工作机上构建，不要在服务器上：Next.js 构建的内存需求超过交易主机的配置，构建期间的 OOM 可能连带杀掉正在运行的引擎。

```bash
pnpm install
pnpm -r --filter '!@openwhaleorg/dashboard' build
cd packages/apps/dashboard && NEXT_DIST_DIR=.next-deploy npx next build   # 生产构建与 `next dev` 的 .next 隔离
```

同步源码和构建产物——不含 `node_modules`、`.env` 和数据目录——然后在服务器上安装运行时依赖：

```bash
rsync -az --delete --exclude node_modules --exclude .git --exclude .next --exclude .next-deploy --exclude .env ./ user@host:openwhale/
rsync -az --delete --exclude cache packages/apps/dashboard/.next-deploy/ user@host:openwhale/packages/apps/dashboard/.next/
ssh user@host 'cd openwhale && pnpm install --frozen-lockfile'
```

`scripts/deploy.sh` 完成以上全部步骤外加重启和健康检查。配置在 `scripts/deploy.env`（从 `deploy.env.example` 复制）：主机、路径、密钥、公网 URL、本地插件包，以及 `DEPLOY_BLACKOUT`。

### 4. systemd

`/etc/systemd/system/openwhale-gateway.service`：

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

`/etc/systemd/system/openwhale-dashboard.service`：

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

`Restart=always` 是必需的：策略的合成止损只在进程运行期间存在。

### 5. nginx 与 TLS

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
        proxy_set_header X-Forwarded-Proto $scheme;  # 必需：告知网关请求经过 TLS
        proxy_buffering off;                          # SSE（实时事件、日志尾随）必需
    }
}
```

证书：`certbot --nginx -d openwhale.example.com`。

TLS 是必需的。会话 cookie 为 `Secure`：纯 http 下，或缺少 `X-Forwarded-Proto` 时，浏览器会丢弃它，登录循环且没有任何日志。

### 6. 验证

```bash
systemctl is-active openwhale-gateway openwhale-dashboard
curl -s -o /dev/null -w '%{http_code}\n' https://openwhale.example.com/login             # 看板
curl -s -o /dev/null -w '%{http_code}\n' https://openwhale.example.com/api/auth/status   # 看板 → 网关
journalctl -u openwhale-gateway -f
```

---

## 运维

**一套凭证只跑一个引擎。** 两个网关持有相同 API 密钥并启用相同实例，会各下一份订单；两边都记录成功。让另一侧启动前先停用这一侧的实例。

**重启会打断执行。** 部署重启网关时若处于周期中途，在计划事件前开出的仓位可能失去负责平掉它的那一腿。在 `scripts/deploy.env` 设置 `DEPLOY_BLACKOUT=FROM-TO`（每小时的分钟数，UTC，可跨越整点），`deploy.sh` 在该窗口内拒绝执行；`--force-window` 可覆盖。

**升级。** 构建、rsync、`pnpm install --frozen-lockfile`、重启。`~/.openwhale` 不受影响。标记为 `enabled` 的实例开机自动恢复；已停用的保持停用。

**回滚。** `git checkout <sha>`，重新构建，重新部署。数据库不在回滚范围内：涉及 schema 迁移的版本发布前先备份。

**插件。** 插件在网关内运行，能访问所有凭证。npm 安装的插件可在看板内原地更新。GitHub 安装由 npm 构建（只含源码的仓库需要 `prepare` 脚本；私有仓库需要 `OPENWHALE_GITHUB_TOKEN`）。每次安装从 `plugins/staged/` 下自己的副本加载，重装无需重启。

---

## 排障

| 症状 | 原因 |
|---|---|
| 登录后跳回登录页 | `Secure` cookie 被丢弃：没有 TLS，或缺少 `X-Forwarded-Proto`。 |
| 看板各页空白 | 网关未启动或不可达：`systemctl status openwhale-gateway`，再查 `OPENWHALE_GATEWAY_URL`。 |
| 某个场地超时 | 网络可达性。`OPENWHALE_HTTPS_PROXY`（见 README）；`HTTPS_PROXY` 与 `NODE_USE_ENV_PROXY` 无效。 |
| 实例显示红色策略标签 | 插件已卸载或新版本删掉了该策略。重装含该策略的版本即可恢复。 |
| 实时事件 / 日志尾随卡住 | 缺少 `proxy_buffering off`。 |
| 磁盘占满 | `~/.openwhale/monitors/`——可再生，删除最旧的。 |

---

## 另见

- [English deployment guide](./DEPLOYMENT.md)
- [README](./README.zh-CN.md) —— 概念与本地开发
- [`scripts/deploy.sh`](./scripts/deploy.sh) —— 上述源码部署的脚本化
- `.env.example` —— 全部环境变量
