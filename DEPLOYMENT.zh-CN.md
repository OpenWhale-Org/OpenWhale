# 部署 OpenWhale

把 OpenWhale 跑在你自己的服务器上 —— 布局、规则,以及那两三件没人提前告诉你就会吃亏的事。

[English →](./DEPLOYMENT.md)

这份文档描述的是一套**真在跑**的部署:一台小 VPS、nginx、两个 systemd 单元、一个 SQLite 数据目录,构建在你的笔记本上而不是服务器上。这不是唯一可行的形态,但这里写的每一条都来自生产环境,不是想象出来的。

> **动手之前。** 这个进程持有**解密后**的交易所凭证,能下**真实订单**。系统里没有角色划分 —— 任何能登录的人都能动钱。把这台机器当成一个插着键盘的硬件钱包来对待。

---

## 你在部署什么

两个进程,而且这个拆分不是为了好看:

| 进程 | 端口 | 持有什么 |
|---|---|---|
| **Gateway**（`@openwhaleorg/gateway`） | 3001 | 运行时、SQLite 数据库、主密钥、所有解密后的凭证。下单。安装插件 —— 也就是说,**执行任意代码**。 |
| **Dashboard**（`@openwhaleorg/dashboard`） | 3002 | 什么都不持有。一个把 `/api/*` 转发给 gateway 的 Next.js 前端。 |

**认证由 gateway 强制,不是 dashboard。** 只做在前端的登录,任何能碰到 3001 端口的人绕一下就没了。所以每条 `/api/*` 都要求会话,dashboard 只是把 cookie 带过去而已 —— 它的路由守卫是给人看的跳转,不是安全边界。

直接后果:**3001 端口绝不能对公网可达。** 只暴露 dashboard,gateway 留在回环地址上。

---

## Docker

**计划中,尚未提供。** 一个要装插件的容器,里面得有 `npm` 和 `git`,还需要一个能挺过 `docker compose down` 的数据卷 —— 而发布一份没人端到端跑通过的 compose 文件,比不发布更糟:第一个来试的人会去 debug 部署,而不是使用它。在那之前,用下面这套。

---

## 源码部署

前置:**Node.js ≥ 20**(生产用的是 22)、**pnpm ≥ 9**、一个带 TLS 证书的域名,以及约 2 GB 内存来**跑**。构建要的更多 —— 这正是不该在这台机器上构建的原因。

### 1. 数据目录

引擎拥有的一切都在 `~/.openwhale`:

```
~/.openwhale/
├── openwhale.db          实例、凭证（加密）、账户、运行记录、PnL 账本
├── monitors/             监控历史 —— JSONL，这里最大的东西
└── plugins/
    ├── plugins.json      安装清单
    ├── node_modules/     npm 和 GitHub 装的插件
    └── staged/           每次安装真正被加载的那份副本
```

这个目录是**服务器自己的状态**,不是你本地的副本。例行部署**绝不能**覆盖它:里面有引擎认为自己持有的仓位、还没落到别处的执行记录、以及积累了几周的监控历史。

给 `openwhale.db` 排定期备份。`monitors/` 可以重新生成,而且会**无上限增长** —— 磁盘满的时候第一个该清的就是它。

### 2. 配置

```bash
cp .env.example .env
```

首次启动只有两项是必须的:

```bash
OPENWHALE_MASTER_KEY=          # 加密所有存储的凭证
OPENWHALE_ADMIN_USER=          # 引导登录
OPENWHALE_ADMIN_PASSWORD=
```

**主密钥不可恢复。** 丢了它,所有存下来的凭证都读不出来 —— 每个 API key 都要手工重录一遍。**备份到服务器以外的地方。**

gateway 是**失败即关闭**的:既没有用户账号、又没有管理员变量时,它宁可拒绝启动,也不会提供一个无认证的交易 API。设一次、登录、然后从环境里拿掉。

同一个文件里的可选项:

```bash
OPENWHALE_ALLOWED_ORIGIN=https://openwhale.example.com   # 只给真正跨域的前端
OPENWHALE_HTTPS_PROXY=http://127.0.0.1:7897              # 交易所直连不通时
OPENWHALE_GITHUB_TOKEN=                                  # 从私有仓装插件
```

### 3. 在别的机器上构建

```bash
pnpm install
pnpm -r --filter '!@openwhaleorg/dashboard' build
cd packages/apps/dashboard && NEXT_DIST_DIR=.next-deploy npx next build
```

在自己机器上构建而不是服务器上,有两个原因。

Next.js 构建是整个仓库里最重的一件事,而一台按交易引擎规格配的机器不是按编译器规格配的。**更要紧的是:部署时引擎正在运行** —— 构建中途来的 OOM killer 不会礼貌地只杀构建进程。

`NEXT_DIST_DIR=.next-deploy` 把生产构建从 `.next` 里挪开,因为本地 `next dev` 会**就地覆写** `.next`。两者共用一个目录,部署会一直好好的 —— 直到你跑起 dev server 的那一刻。

然后同步 —— 源码和产物一起走,`node_modules` 不走,`.env` 不走,数据目录不走:

```bash
rsync -az --delete \
  --exclude node_modules --exclude .git --exclude .next --exclude .next-deploy --exclude .env \
  ./ user@host:openwhale/

rsync -az --delete --exclude cache \
  packages/apps/dashboard/.next-deploy/ user@host:openwhale/packages/apps/dashboard/.next/
```

服务器上只装运行时依赖:

```bash
cd ~/openwhale && pnpm install --frozen-lockfile
```

仓库里的 `scripts/deploy.sh` 把上面这些连同健康检查一起做了。**改用它之前先读一遍** —— 下面那些运维规则都编在里面。

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

`Restart=always` 比看起来重要。monitor 挂掉会把它的订阅一起带走,而**持有仓位的策略需要引擎活着才能平掉它** —— 某些策略用的合成止损只在进程存活期间有效。

### 5. nginx 与 TLS

**只发布 dashboard,永远不要发布 gateway。**

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
        proxy_set_header X-Forwarded-Proto $scheme;  # 见下
        proxy_buffering off;                          # 否则 SSE 会一坨一坨地到
    }
}
```

证书用 `certbot --nginx -d openwhale.example.com`。

#### TLS 不是可选项

会话 cookie 带 `Secure` 标记,而浏览器对此的执行方式是**静默丢弃** —— 走明文 http 时它压根不发。症状不是报错:你登录、页面刷新、又变回未登录,**无限循环,而且任何日志里都没有一行说明原因**。

`X-Forwarded-Proto` 是 gateway 判断请求是否经由 TLS 到达的依据。**配错了,你会在一张正常工作的证书后面复现完全相同的循环。**

`proxy_buffering off` 是为了实时事件流和日志流;开着缓冲它们会成批到达,看起来像卡死了。

### 6. 验证

```bash
systemctl is-active openwhale-gateway openwhale-dashboard
curl -s -o /dev/null -w '%{http_code}\n' https://openwhale.example.com/login
curl -s -o /dev/null -w '%{http_code}\n' https://openwhale.example.com/api/auth/status
```

两个 200、两个服务 active。第二个 URL 是穿过 dashboard 的代理打到 gateway 的,所以它和第一个的失败方式不同 —— `/login` 是 200 而 `/api/auth/status` 失败,说明**前端起来了、引擎没有**。

```bash
journalctl -u openwhale-gateway -f
```

---

## 运维

### 绝不要用同一套凭证跑两个引擎

你笔记本上一个 gateway、服务器上一个 gateway,持有同一套 API key、同样的实例是启用的 —— 它们会**在同一时刻各下一份全量订单**。交易所很乐意两笔都成交。

这是用这个工具亏钱最容易的一条路,而且**它不会声张**:两边的日志都是干净、成功的一个周期。

启动本地 gateway 之前,先确认服务器在跑什么。要在机器之间迁移状态,**先**在一边停用实例,**再**让另一边起来。

### 不要在结算窗口里部署

重启 gateway 会把正在执行的东西拦腰砍断。

以资金费套利为例:开仓梯大约在 T−30s 就开始下单,平仓梯要跑到 T+若干秒。这段时间里重启,会留下**已开但没有平仓梯去平的仓位**,以及来不及落盘的执行记录。这真的发生过:2026-08-10 20:59:52,5325 张合约裸放了 52 秒,直到重启后的引擎兜底扫单才收拾掉。

`scripts/deploy.sh` 因此**拒绝在 UTC 的 XX:54–XX:01 之间运行**。如果你的策略有自己的周期,把它的窗口也加进同一个守卫里 —— **只写在文档里的规则,就是 20:59 会被忘掉的规则。**

### 升级

例行部署就是:本地构建 → rsync → `pnpm install --frozen-lockfile` → 重启。它**不碰** `~/.openwhale`,这正是它之所以"例行"的原因。

标记为 `enabled` 的实例会自己起来 —— 这是开机的规则,插件重载也遵循同一条。你主动停用的实例保持停用。

### 回滚

代码是一个 git checkout、构建可复现,所以回滚就是 `git checkout <sha>` → 重新构建 → 重新部署。

**但数据库不在这个范围内。** 一个改了 schema 的版本,**没有事先备份就回滚不了** —— 发版前先备份。

### 服务器上的插件

装插件会在 gateway 进程里执行第三方代码,而它能碰到每一个凭证。Plugins 页面上写了这句话;对一台无人值守的机器,值得再说一遍。

npm 装的插件可以在界面上一键更新。GitHub 安装是由 npm clone 并构建的,所以只有源码的仓库需要一个 `prepare` 脚本;私有仓需要环境里有 `OPENWHALE_GITHUB_TOKEN`。

插件是从 `plugins/staged/` 下**自己那份副本**加载的,所以重新安装能跑上新代码而不用重启 —— Node 的模块注册表按解析后的 URL 做键且无法驱逐,固定路径会导致永远执行进程里第一次加载的那个版本。

---

## 出问题时看哪里

| 症状 | 该看什么 |
|---|---|
| 登录后又跳回登录页 | TLS。`Secure` cookie 被丢弃了 —— 检查证书和 `X-Forwarded-Proto`。 |
| 界面到处都是空的 | gateway 挂了或连不上。`systemctl status openwhale-gateway`,然后查 `OPENWHALE_GATEWAY_URL`。 |
| 某个交易所超时,其他都正常 | 可达性。见主 README 的代理章节 —— 标准的 `HTTPS_PROXY` 在这里**不起作用**,`NODE_USE_ENV_PROXY` 也一样。 |
| 实例上的策略标签变红 | 它的插件没了,或被一个不再提供该策略的版本替换了。这一行是**故意保留**的;把带有该策略的版本装回去,它会恢复。 |
| 实时事件和日志流卡住 | 少了 `proxy_buffering off`。 |
| 磁盘满了 | `~/.openwhale/monitors/`。可重新生成,从最旧的开始清。 |

---

## 另见

- [English deployment guide](./DEPLOYMENT.md)
- [README](./README.zh-CN.md) —— OpenWhale 是什么,以及本地开发的快速上手
- [`scripts/deploy.sh`](./scripts/deploy.sh) —— 本文描述的那套部署
- `.env.example` —— 所有环境变量,附带取舍理由
