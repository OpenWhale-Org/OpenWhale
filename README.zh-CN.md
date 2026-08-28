# OpenWhale

<img src="./logo.svg" width="64" height="64" />

**可组合、AI 原生的经济策略编程层**

![License](https://img.shields.io/badge/license-MIT-blue)
![TypeScript](https://img.shields.io/badge/language-TypeScript-3178c6)
![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)

[English →](./README.md)

OpenWhale 是一个 TypeScript 自动化交易策略框架。Monitor 采集、Strategy 决策、Executor 执行，三层解耦：同一个策略可以运行在任何交易场地、接入任何数据源，并且可以由 AI 编写、审计和迭代。

---

## 为什么是 OpenWhale

- **分层解耦** — Monitor → Strategy → Executor，替换任一层不影响其它层。
- **场地无关** — 策略只声明账户槽位，场地在激活时由绑定的账户决定。
- **适配器矩阵** — 场地是 *(kind × venue)* 矩阵中的一个格（`exchange/perp × binance` …）。领域包定义 kind，场地包填充格；数据驱动的 ccxt 名册内置十二个场地。
- **AI 作为程序员** — 策略内置结构化输出的 LLM 推理；仓库自带 `skills/openwhale-dev`，让 Claude 掌握框架契约。
- **运行追踪** — 每次运行都持久化：看到了什么、哪道门拒绝了、发出了什么。重启不丢。
- **PnL 归因** — 执行器认领自己下的单；成交、手续费、资金费回接到实例。同一账户上的两个实例可分开核算。
- **类型安全的插件** — 每个组件实现严格的 TypeScript 接口。

---

## 核心概念

| 概念 | 定义 |
|---|---|
| **Monitor** | 采集数据并按 key 发出记录（`venue:symbol`）。一个 *contract* 对应一个或多个 *implementation*；用户按 key 创建 *instance*。记录以 JSONL 持久化并驱动触发器。 |
| **Strategy** | 纯决策逻辑。按标签声明依赖的 monitor / executor / account，接收触发，返回 `ExecutionInstruction[]`。参数分 `base`（必填）和 `tunable`（带默认值）两个 zod schema。 |
| **Executor** | 通过适配器会话把指令变成场地动作：重试、幂等的客户端订单 id、延迟与滑点采集。凭证槽位解析为会话（按 kind）或原始凭证数据（`raw: true`）；`optional: true` 的槽位可以不绑定。 |
| **Instance** | 策略 + 参数 + 账户绑定，作为一个整体激活。实时事件、执行记录、运行和日志都挂在它上面。 |
| **Account** | 凭证与账户实现（通用或场地特化）的具名绑定。策略通过它读取余额和仓位。 |
| **Trigger** | Cron 计划和 monitor 条件（多源 AND，限定时间窗）。订阅让 monitor 持续采集而不唤醒策略；`addMonitorSource` 可在运行时添加新发现的数据源。 |
| **Portfolio journal** | 可选的实例级历史：幂等快照、成交、决策、行情 K 线。Core 负责存储并推导净值、回撤和交易报告。 |

```
Monitor ──emit(key, data)──▶ TriggerManager ──StrategyContext──▶ Strategy ──ExecutionInstruction[]──▶ ExecutionQueue ──▶ Executor
                                                                     └─ 运行追踪持久化
```

---

## 看板

| 页面 | 功能 |
|---|---|
| **Instances** | 卡片式实例：文件夹、拖拽排序、实时净 PnL；每个实例的 Live Events、Executions、Runs、Logs；Board 视图支持参数编辑、账户重绑、PnL 面板。 |
| **PnL** | 归因账本得出的已实现 / 手续费 / 资金费 / 净值 / 未实现；按品种、原始成交、按场地标记价的持仓。资金费按结算时刻各实例的仓位拆分。 |
| **Runs** | 每次运行的门控、跳过、仓位计算、指令和日志。有指令或报错的运行持久化，空转运行抽样。 |
| **Monitor boards** | 由 `plots()` 声明的面板：折线、柱状、K 线、可排序表格；单选 / 多选 key。 |
| **参数表单** | 由 zod `.meta()` 生成：分节、滑块、单位、条件字段、市场选择器、可用性校验、行表格式的 list 参数、随输入实时重绘的交互示意图。 |
| **Scripts** | 插件自带的运维脚本，按需对运行时执行；输出等宽报告，可附 JSON 和文件。 |
| **Compiler / Assistant** | 自然语言策略编译器（实验性）。推荐路径：Claude + `skills/openwhale-dev`。 |

---

## 代码示例

### 最小策略

```typescript
const decls = {
  monitors: [{ name: 'exchange/ticker', label: 'price' }],
  executors: [{ name: 'exchange/perp-trading', label: 'perp' }],
  accounts: [{ account: PerpAccount, label: 'main' }],
} as const satisfies StrategyDeclarations

class MomentumStrategy extends BaseStrategy<typeof decls> {
  readonly strategyId = 'momentum'
  override readonly monitors = decls.monitors
  override readonly executors = decls.executors
  override readonly accounts = decls.accounts

  readonly baseParamsSchema = z.object({
    symbol: z.string().meta({ displayName: 'Symbol' }),
    threshold: z.number().meta({ displayName: 'Entry price' }),
  })

  async evaluate(context: StrategyContext) {
    const { symbol, threshold } = this.baseParamsSchema.parse(this.params.base)
    const tick = context.getData('price', `${this.accountVenue('main')}:${symbol}`)
    this.trace('tick:read', { tick })                    // 记入运行追踪
    if (!tick || tick.price < threshold) return []

    return [
      this.instruction('perp', 'placeOrder', {
        symbol, side: 'buy', type: 'market', amount: 0.01,
      }),
    ]
  }
}
```

### 组装运行时

```typescript
const runtime = new OpenWhaleRuntime({ database, credentialStore })
runtime.loadPlugin(binancePlugin, {})
runtime.loadPlugin(hyperliquidPlugin, {})
await runtime.start()
await runtime.activate({
  strategyId: 'my-plugin/momentum',
  credentials: { main: 'My Binance' },       // 账户绑定决定场地
  params: { base: { symbol: 'BTC/USDT:USDT', threshold: 60000 } },
})
```

### 结构化输出的 AI 策略

```typescript
async evaluate(context: StrategyContext) {
  const data = await this.monitorData('market')?.readLatest(this.accountVenue('main'))

  const { action, confidence } = await this.llm({
    messages: [{ role: 'user', content: JSON.stringify(data) }],
    schema: z.object({
      action: z.enum(['buy', 'sell', 'hold']),
      confidence: z.number(),
    }),
  })
  if (action === 'hold' || confidence < 0.7) return []

  return [
    this.instruction('perp', 'placeOrder', {
      symbol: 'BTC/USDC:USDC', side: action, type: 'market', amount: 0.01,
    }),
  ]
}
```

### 运维脚本

```typescript
export const planPreview: ScriptDefinition = {
  id: 'plan-preview',
  name: 'Plan preview',
  paramsSchema: z.object({ instance: z.string().default('') }),
  paramOptions: async (runtime) => ({ instance: await listMyInstances(runtime) }),
  run: async ({ params, runtime }) => ({ text: await renderPlan(runtime, params) }),
}
```

---

## 插件

插件是一个默认导出工厂函数的包，工厂返回它的注册项：

```typescript
export default definePlugin((ctx) => ({
  name: 'my-plugin',
  version: '1.0.0',
  monitorImplementations: [ /* contract / implementation / instance */ ],
  executors: [ /* … */ ],
  strategies: [ /* … */ ],
  scripts: [ /* 运维脚本 */ ],
  credentialTypes: [ /* schema、raw 选项、连通性测试 */ ],
  adapters: [ /* (kind × venue) 格 */ ],
  accounts: [ /* 账户实现 */ ],
}))
```

**安装**：在 Plugins 页填 npm 包名、GitHub `owner/repo`（可带 ref）、本地路径，或上传构建好的 `.js`/`.mjs` bundle；代码里用 `runtime.loadPlugin()`。GitHub 安装由 npm 构建，只含源码的仓库需要 `prepare` 脚本；私有仓库需要 `OPENWHALE_GITHUB_TOKEN`。

**规则：**

- 插件名即命名空间（`my-plugin/momentum`）。名字被占用时安装期分配新命名空间（`alice-funding-arb`）；一旦有实例引用，命名空间不再变更。
- 适配器格和凭证类型是全局的：提供同一场地的两个插件不能共存。注册要么全部成功要么全部不做。
- 覆盖安装保留实例、账户和凭证；新版本删掉的策略对应的实例标记为损坏，不删除。
- npm 安装的插件在列表中显示注册表上的新版本，一键更新（同一条覆盖路径）。
- 仍有实例、账户或凭证引用时拒绝卸载；插件的 monitor 实例随卸载删除。
- 每次安装从 `plugins/staged/` 下自己的副本加载，重装不需要重启。

### 用 Claude 写插件

把 `skills/openwhale-dev/` 复制到插件项目的 `.claude/skills/`（或引用本仓库路径），描述策略，Claude 产出完整的插件包——monitor、executor、strategy、测试——可直接从 Plugins 页安装。

---

## 使用场景

| 场景 | 形态 |
|---|---|
| **资金费 / 基差捕获** | 围绕结算时刻的 cron 周期，按盘口深度定量 |
| **配对 / 价差回归** | 基于 z-score 价差 monitor 的双腿对冲梯子，带驻留确认和止损 |
| **跟单** | 监控目标钱包，按比例镜像交易，带仓位上限 |
| **AI 行情分析** | `evaluate()` 内的结构化输出 LLM 推理 |
| **多条件信号** | 价格、成交量、费率 monitor 在同一时间窗内组合触发 |
| **链上挂单奖励** | 在链上利率市场（Boros）的激励带边缘挂 post-only 单，随激励带移动重挂，每 tick 通过委托 agent 密钥中继一笔交易 |
| **链上收益** | 基于 `web3/chain` kind 的钱包账户：PT/YT 与 LP 头寸（Pendle），余额和持仓从链上读取，交易本地签名 |

---

## 快速开始

开发模式，热重载。服务器部署见 [DEPLOYMENT.zh-CN.md](./DEPLOYMENT.zh-CN.md)（`docker compose up -d --build`，或 systemd + nginx）。

前置条件：Node.js ≥ 20，pnpm ≥ 9。

```bash
pnpm install
pnpm build
cp .env.example .env           # OPENWHALE_MASTER_KEY、OPENWHALE_ADMIN_USER、OPENWHALE_ADMIN_PASSWORD
pnpm dev                       # 网关 :3001，看板 :3000
```

网关持有运行时和全部密钥；看板是纯前端，把 `/api/*` 反代到网关（`OPENWHALE_GATEWAY_URL`，默认 `http://localhost:3001`）。没有用户账号且没有管理员变量时网关拒绝启动；设置一次、登录后即可移除。

### 场地代理

```bash
OPENWHALE_HTTPS_PROXY=http://127.0.0.1:7897        # REST + WebSocket，所有场地
OPENWHALE_HTTPS_PROXY_BINANCEUSDM=off              # 按场地覆盖：ccxt id 大写；`off` = 直连
```

`HTTPS_PROXY` 和 `NODE_USE_ENV_PROXY` 无效——ccxt 使用自己的 fetch。变量单独命名，避免订单流量因无关的代理设置改道。

### 认证

由网关强制：每个 `/api/*` 路由都需要会话，看板只负责携带 cookie。会话是 SQLite 中的不透明令牌（7 天有效，可撤销）；密码 scrypt 哈希；没有角色。对外暴露网关前：在前面终止 TLS（会话 cookie 为 `Secure`）、3001 端口不上公网、仅跨域前端才设置 `OPENWHALE_ALLOWED_ORIGIN`。详见 [DEPLOYMENT.zh-CN.md](./DEPLOYMENT.zh-CN.md)。

---

## 包

`framework/` 引擎与领域 · `venues/` 交易所集成 · `apps/` 网关与看板 · `strategies/` 参考策略。

| 包 | 职责 |
|---|---|
| [`@openwhaleorg/core`](./packages/framework/core) | 引擎：适配器矩阵、账户、monitor 模型、strategy/executor/trigger、运行追踪、PnL 归因、scripts、`definePlugin` 与装饰器 |
| [`@openwhaleorg/exchange`](./packages/framework/exchange) | kind `exchange/perp` 与 `exchange/spot`：账户视图、交易执行器、行情 monitor |
| [`@openwhaleorg/web3`](./packages/framework/web3) | kind `web3/chain`：EVM 会话、钱包账户、`web3/evm` 与 `web3/rpc` 凭证类型 |
| [`@openwhaleorg/ccxt-adapter`](./packages/venues/ccxt-adapter) | 交易所适配器的 ccxt 实现与数据驱动的场地名册 |
| [`@openwhaleorg/hyperliquid`](./packages/venues/hyperliquid) / [`binance`](./packages/venues/binance) / [`aster`](./packages/venues/aster) | 场地插件：凭证类型、适配器格、场地特化账户 |
| [`@openwhaleorg/gateway`](./packages/apps/gateway) | 后端：运行时、认证、REST + SSE API、编译服务、插件安装 |
| [`@openwhaleorg/dashboard`](./packages/apps/dashboard) | Next.js 前端 |
| [`@openwhaleorg/examples`](./packages/strategies/examples) | 参考策略：动量、均值回归、定投、LLM 分析、跟单 |
| [`@openwhaleorg/compiler`](./packages/framework/compiler) | 自然语言 → 代码 → 校验阶梯 → 人工审阅 → 热加载 |

发布检查：`pnpm check:publish` 打包每个包并核对 tarball 内的 peer 范围（`workspace:^` 在打包时解析，仓库里看不到实际版本号）。

---

## 参与

想法和 bug 提 issue；修复、场地插件、策略示例提 PR。

## 许可证

MIT
