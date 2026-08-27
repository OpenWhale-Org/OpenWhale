# 部署 OpenWhale

在自己的服务器上部署 OpenWhale：架构、步骤和运维注意事项。

[English →](./DEPLOYMENT.md)

本文描述的部署形态：一台 VPS、nginx 反向代理、两个 systemd 单元、SQLite 数据目录，构建在本地机器完成后同步到服务器。

> **安全提示**：gateway 进程持有解密后的交易所凭证，可以下真实订单。系统不区分角色，任何能登录的账号都有完整权限。

---

## 架构

| 进程 | 默认端口 | 职责 |
|---|---|---|
| **Gateway**（`@openwhaleorg/gateway`） | 3001 | 运行时、SQLite 数据库、主密钥、凭证解密、下单、插件安装 |
| **Dashboard**（`@openwhaleorg/dashboard`） | 3000 | Next.js 前端，将 `/api/*` 转发给 gateway，不持有任何密钥 |

端口均可配置：gateway 用 `OPENWHALE_GATEWAY_PORT`，dashboard 用 `PORT`。下文 systemd 示例中 dashboard 使用 3002，是因为那台机器的 3000 已被其他服务占用；按实际情况调整即可，nginx 的 `proxy_pass` 指向所选端口。

认证在 gateway 层实现，不在 dashboard。所有 `/api/*` 路由都要求有效会话；dashboard 只负责携带 cookie，其路由守卫仅用于页面跳转，不构成安全边界。

因此：**3001 端口不应对公网开放**。对外只暴露 dashboard。

---

## Docker

计划中，尚未提供。当前的 Dockerfile 未经完整验证，暂不随仓库发布。请使用下面的源码部署方式。

---

## 源码部署

**前置条件**

- Node.js ≥ 20（生产环境使用 22）
- pnpm ≥ 9
- 域名及 TLS 证书
- 服务器内存 ≥ 2 GB（仅运行；构建在本地完成）

### 1. 数据目录

引擎的全部状态位于 `~/.openwhale`：

```
~/.openwhale/
├── openwhale.db          实例、凭证（加密）、账户、运行记录、PnL 账本
├── monitors/             监控历史数据（JSONL，占用空间最大）
└── plugins/
    ├── plugins.json      安装清单
    ├── node_modules/     npm 与 GitHub 安装的插件
    └── staged/           每次安装实际加载的副本
```

该目录属于服务器运行状态，例行部署不应覆盖。其中包含引擎记录的持仓、尚未落盘到别处的执行记录，以及长期累积的监控历史。

建议对 `openwhale.db` 做定期备份。`monitors/` 可重新生成，且会持续增长，磁盘空间不足时可优先清理。

### 2. 配置

```bash
cp .env.example .env
```

首次启动需要配置：

```bash
OPENWHALE_MASTER_KEY=          # 用于加密存储的凭证
OPENWHALE_ADMIN_USER=          # 初始管理员账号
OPENWHALE_ADMIN_PASSWORD=
```

**主密钥无法恢复。** 丢失后所有已存储的凭证都无法解密，需要重新录入全部 API key。请在服务器之外单独备份。

如果既没有已创建的用户账号，也没有配置管理员变量，gateway 会拒绝启动。管理员变量用于创建首个账号，创建完成后可从环境中移除。

可选配置：

```bash
OPENWHALE_ALLOWED_ORIGIN=https://openwhale.example.com   # 跨域前端时设置
OPENWHALE_HTTPS_PROXY=http://127.0.0.1:7897              # 交易所需经代理访问时
OPENWHALE_GITHUB_TOKEN=                                  # 从私有仓库安装插件时
```

### 3. 本地构建

```bash
pnpm install
pnpm -r --filter '!@openwhaleorg/dashboard' build
cd packages/apps/dashboard && NEXT_DIST_DIR=.next-deploy npx next build
```

在本地而非服务器构建的原因：Next.js 构建内存开销较大，而部署时引擎正在运行，服务器上构建可能触发 OOM 影响运行中的进程。

`NEXT_DIST_DIR=.next-deploy` 将生产构建产物与 `.next` 分开。本地 `next dev` 会覆写 `.next`，共用同一目录会导致部署产物被开发服务器破坏。

同步代码与产物，排除 `node_modules`、`.env` 和数据目录：

```bash
rsync -az --delete \
  --exclude node_modules --exclude .git --exclude .next --exclude .next-deploy --exclude .env \
  ./ user@host:openwhale/

rsync -az --delete --exclude cache \
  packages/apps/dashboard/.next-deploy/ user@host:openwhale/packages/apps/dashboard/.next/
```

服务器上安装运行时依赖：

```bash
cd ~/openwhale && pnpm install --frozen-lockfile
```

仓库中的 `scripts/deploy.sh` 已包含上述流程和部署后健康检查，可参考或直接使用。

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

建议保留 `Restart=always`。gateway 退出会中断 monitor 订阅；部分策略的止损由策略进程主动执行，进程不在时不生效。

### 5. nginx 与 TLS

对外只代理 dashboard。

```nginx
server {
    listen 443 ssl;
    server_name openwhale.example.com;

    ssl_certificate     /etc/letsencrypt/live/openwhale.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/openwhale.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3002;
        proxy_http_version 1.1;
        proxy_set_header Upgrade    $http_upgrade;   # SSE：实时事件、日志流
        proxy_set_header Connection '';
        proxy_set_header Host       $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;                          # SSE 需要关闭缓冲
    }
}
```

证书申请：`certbot --nginx -d openwhale.example.com`。

#### 必须启用 TLS

会话 cookie 带 `Secure` 标记，明文 HTTP 下浏览器不会发送该 cookie。表现为登录后立即回到登录页，反复循环，且日志中没有相关错误。

`X-Forwarded-Proto` 用于让 gateway 判断请求是否经 TLS 到达。该头未正确传递时，即使证书正常也会出现同样的登录循环。

`proxy_buffering off` 用于实时事件流和日志流，否则数据会成批到达。

### 6. 验证

```bash
systemctl is-active openwhale-gateway openwhale-dashboard
curl -s -o /dev/null -w '%{http_code}\n' https://openwhale.example.com/login
curl -s -o /dev/null -w '%{http_code}\n' https://openwhale.example.com/api/auth/status
```

两个接口都应返回 200。第二个接口经 dashboard 代理到 gateway，若 `/login` 正常而它失败，说明 gateway 未启动或不可达。

查看日志：

```bash
journalctl -u openwhale-gateway -f
```

---

## 运维

### 避免同一套凭证运行多个引擎

本地和服务器各运行一个 gateway、使用同一套 API key 且启用了相同实例时，两个引擎会在同一时刻分别下单，交易所会分别成交，形成双倍仓位。

两边日志都会显示正常完成，不会有异常提示。

启动本地 gateway 前请确认服务器状态。跨机器迁移状态时，先停用一侧的实例，再启动另一侧。

### 避免在结算窗口部署

重启 gateway 会中断正在执行的策略周期。

以资金费套利为例：开仓在 T−30s 左右开始，平仓会持续到 T+若干秒。此期间重启会导致已开仓位没有对应的平仓流程，执行记录也可能丢失。2026-08-10 20:59:52 发生过一次，5325 张合约在无对冲状态下持续 52 秒，直到重启后的兜底扫单处理。

`scripts/deploy.sh` 会拒绝在 UTC 每小时的 XX:54–XX:01 之间执行。如果自有策略有其他周期，建议在同一处加入对应窗口。

### 升级

本地构建 → rsync → `pnpm install --frozen-lockfile` → 重启服务。该流程不修改 `~/.openwhale`。

`enabled` 状态的实例会在启动时自动激活，手动停用的实例保持停用。

### 回滚

代码回滚：`git checkout <sha>` → 重新构建 → 重新部署。

数据库不在回滚范围内。包含 schema 变更的版本需要在发布前备份数据库，否则无法回滚。

### 服务器上的插件

安装插件会在 gateway 进程内执行第三方代码，该进程可访问全部凭证。

npm 安装的插件支持在界面上一键更新。GitHub 安装通过 npm clone 并构建，仅含源码的仓库需要在 package.json 中提供 `prepare` 脚本；私有仓库需要配置 `OPENWHALE_GITHUB_TOKEN`。

插件从 `plugins/staged/` 下的独立副本加载，因此重新安装后无需重启即可生效。Node 的 ESM 模块按解析后的 URL 缓存且无法清除，固定路径会导致始终执行首次加载的版本。

---

## 常见问题

| 现象 | 排查方向 |
|---|---|
| 登录后跳回登录页 | TLS 未启用或 `X-Forwarded-Proto` 未正确传递 |
| 页面数据为空 | gateway 未运行或不可达，检查服务状态和 `OPENWHALE_GATEWAY_URL` |
| 单个交易所超时 | 网络可达性，见主 README 的代理章节（`HTTPS_PROXY` 和 `NODE_USE_ENV_PROXY` 对 ccxt 均无效） |
| 实例的策略标签显示为红色 | 对应插件已卸载，或被不含该策略的版本替换。重新安装含该策略的版本即可恢复 |
| 实时事件、日志流不更新 | nginx 缺少 `proxy_buffering off` |
| 磁盘空间不足 | 清理 `~/.openwhale/monitors/` 中较早的数据 |

---

## 相关文档

- [English deployment guide](./DEPLOYMENT.md)
- [README](./README.zh-CN.md) —— 项目介绍与本地开发
- [`scripts/deploy.sh`](./scripts/deploy.sh) —— 本文对应的部署脚本
- `.env.example` —— 全部环境变量说明
