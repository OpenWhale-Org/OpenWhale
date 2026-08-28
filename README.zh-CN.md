# OpenWhale

<img src="./logo.svg" width="64" height="64" />

**可组合、AI 原生经济策略的可编程层**

![License](https://img.shields.io/badge/license-MIT-blue)
![TypeScript](https://img.shields.io/badge/language-TypeScript-3178c6)
![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)

[English →](./README.md)

OpenWhale 是一个用于构建自动化经济策略的 TypeScript 框架。Monitor、Strategy、Executor 三层解耦，同一份策略代码可运行在不同场地、对接不同数据源，也可由 AI 编写和维护。

---

## 为什么是 OpenWhale

- **三层解耦** —— Monitor 采集、Strategy 决策、Executor 执行，任一层可独立替换。
- **与场地无关** —— 策略代码中不出现交易所名称，只声明账户槽位；实际场地由激活时绑定的账户决定。
- **适配器矩阵** —— 场地以 *(kind × venue)* 矩阵单元的形式接入（`exchange/perp × binance`、`exchange/spot × hyperliquid` 等）。领域包定义接口，场地包提供实现，内置的 ccxt 名册覆盖十二个场地。
- **内建 AI 能力** —— 策略层支持带结构化输出的 LLM 推理。仓库提供 `skills/openwhale-dev`，可让 Claude 按框架契约生成完整的插件包（含测试）。
- **完整的运行轨迹** —— 每次策略运行都记录决策过程：读取的数据、触发的判断分支、发出的指令。实例停用或 gateway 重启后记录仍然保留。
- **PnL 归因** —— 执行器自动认领所下订单，后台收集器将场地成交（已实现盈亏、手续费）与资金费收入归属到对应实例。同账户下交易同一标的的多个实例可分别统计。
- **类型安全的插件架构** —— 各组件实现严格的 TypeScript 接口，支持 IDE 补全、安全重构，AI 生成的代码可由编译器校验。

---

## 核心概念

| 概念 | 是什么 |
|---|---|
| **Monitor（监控）** | 采集数据并发出带键的记录（`venue:symbol` …）。以*契约*形式声明,可有多个*实现*;用户按键创建*实例*,可选绑定凭证。发出的数据以 JSONL 持久化,并驱动触发器。 |
| **Strategy（策略）** | 决策逻辑。按标签声明依赖的 monitor / executor / account，接收触发后返回 `ExecutionInstruction[]`。参数分为 `base`（必填）与 `tunable`（有默认值，可由 AI 优化）两套 zod schema。 |
| **Executor（执行器）** | 通过适配器会话将指令转换为场地动作，包含重试策略、幂等客户端订单号、逐单延迟与滑点采集。凭证槽位可解析为会话（按 kind）或原始凭证数据（`raw: true`，如 bot token）；`optional: true` 的槽位允许实例在未绑定时激活，由执行器降级处理。 |
| **Instance（实例）** | 策略 + 参数 + 账户绑定,作为一个整体激活。所有可观测的东西都挂在实例上:实时事件、执行记录、运行轨迹、日志。 |
| **Account（账户）** | 一个具名实体,把凭证绑定到某个账户实现（通用或场地特化）。策略只能通过自己绑定账户的 Reader 读取余额和仓位。 |
| **Trigger（触发器）** | Cron 计划 + monitor 条件（时间窗内多源 AND）。订阅让 monitor 持续采集而不唤醒策略;运行中的策略可以加入它在运行时发现的新数据源（`addMonitorSource`）。 |
| **Portfolio journal（组合日志）** | 可选的实例级历史记录，由策略维护。策略提交幂等的快照、成交、决策与行情数据，Core 事务性存储并据此计算净值、回撤和交易报告。 |

```
Monitor（数据采集）
    ↓ emit(key, data)
TriggerManager（cron + monitor 条件）
    ↓ StrategyContext
Strategy（规则 / AI 推理）  →  运行轨迹持久化
    ↓ ExecutionInstruction[]
ExecutionQueue
    ↓
Executor（经适配器会话执行场地动作）
```

---

## 控制台

- **实例** —— 卡片式,支持文件夹、拖拽排序、emoji 图标,每张卡片带实时净 PnL 徽标;每个实例四个实时页签（实时事件仅限该实例自己的 monitor、执行、运行、日志）。每个实例还有整页 **Board**,支持点击重命名、账户重绑、可编辑的参数面板和 PnL 面板。创建时可选择**仅保存**或**激活**，便于在启动交易前复核参数与账户绑定。
- **实例级 PnL** —— 已实现 / 手续费 / 资金费 / 净额 / 未实现,数据来自归因账本,可下钻到按标的汇总、原始场地成交、以及由成交推导、按场地标记价计价的持仓。资金费事件按各实例在结算边界时点持有的仓位拆分。
- **运行轨迹** —— 每次运行记录它的步骤:闸门、跳过、计量、发出的指令、捕获的日志行。有指令或有错误的运行落盘;空转的运行按心跳采样。可按结果过滤、按内容搜索。
- **Monitor 看板** —— monitor 通过 `plots()` 约定声明面板:折线 / 柱状 / K 线,外加可排序的 `table` 类型、单选与多选选择器、记录窗口控制。
- **参数表单** —— 由 zod 的 `.meta()` 驱动：分组、滑块、单位后缀、条件可见性、可搜索的市场选择器（单选/多选）、针对绑定场地的逐值可用性校验、用于梯度配置的行表 *list* 参数，以及随输入实时更新的沙箱交互示意图。
- **脚本** —— 插件可以附带运维工具（`scripts: [...]`）,按需对活跃运行时执行并返回等宽报告:计划预览、拟合检查、一次性审计。参数渲染成小表单,运行时值（比如实例 id）用实时解析的下拉框。
- **编译器与助手** —— 实验性的自然语言策略编译器。也可以使用 `skills/openwhale-dev`，由 Claude 直接生成插件。

---

## 代码示例

### 一个最小策略

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
    this.trace('tick:read', { tick })                    // 会进入运行轨迹
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
  credentials: { main: 'My Binance' },       // 账户绑定决定了场地
  params: { base: { symbol: 'BTC/USDT:USDT', threshold: 60000 } },
})
```

### 带结构化输出的 AI 策略

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

### 一个运维脚本

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

## 发布

每次发版前跑 `pnpm check:publish`。

peer 范围在源码中写作 `workspace:^`，由 pnpm 在打包时解析为具体版本号。也就是说，最终发布的版本范围不存在于仓库任何文件中，无法通过代码审查发现错误。

`check:publish` 会逐个打包并从生成的 tarball 中读取 peer 范围进行校验。

---

## 插件

插件是一个默认导出工厂函数的包，工厂函数返回该插件的注册项：

```typescript
export default definePlugin((ctx) => ({
  name: 'my-plugin',
  version: '1.0.0',
  monitorImplementations: [ /* 契约 / 实现 / 实例 模型 */ ],
  executors: [ /* … */ ],
  strategies: [ /* … */ ],
  scripts: [ /* Scripts 页面上的运维工具 */ ],
  credentialTypes: [ /* 场地凭证配方：schema、raw 开关、连通性测试 */ ],
  adapters: [ /* (kind × venue) 矩阵格子 */ ],
  accounts: [ /* 账户实现 */ ],
}))
```

可从控制台 Plugins 页面安装：构建好的 `.js`/`.mjs` bundle、GitHub 仓库（`owner/repo` 或完整地址，可指定分支/tag/commit）、npm 包名或本地路径；也可在代码中调用 `runtime.loadPlugin()`。组件按命名空间注册（`my-plugin/momentum`），支持热重载。

GitHub 安装通过 npm clone 并构建，仅含 TypeScript 源码的仓库需要在 package.json 中提供 `prepare` 脚本（`"prepare": "npm run build"`）；私有仓库需要在引擎侧配置 `OPENWHALE_GITHUB_TOKEN`。

### 命名空间

插件声明的名称作为默认命名空间，即其注册的所有 id 的前缀（`my-plugin/`）。由于插件名称并非全局唯一，实际命名空间在安装时确定。

命名空间被占用时，根据包名判断处理方式：本地 checkout 与其发布版本视为同一插件，提供覆盖安装；不同的包视为同名的不同插件，分配独立命名空间（如 `alice-funding-arb`，由发布者名推导）。命名空间一经确定不可更改，实例按 `<命名空间>/<策略>` 保存。

部分注册项不带命名空间：adapter cell（按 kind 与 venue 寻址）和 credential type（按名称共享）各自只能有一个提供者。因此同一场地的两个 venue 插件无法共存，更换命名空间也不行。该检查在提供命名空间选项之前完成；注册过程为原子操作，失败的安装不会残留。

### 覆盖与卸载

**覆盖安装**替换插件代码，保留实例、账户和凭证。运行中的实例会基于新代码重启；新版本不再提供对应策略的实例会在 Instances 页面标记为异常状态而非删除，重新安装含该策略的版本后可恢复运行。

npm 安装的插件如有新版本会在列表中提示，支持一键更新，走同一套覆盖流程。

**卸载**在存在关联的策略实例、账户或凭证时会拒绝执行，并列出具体项目。插件自身的 monitor 实例会随卸载一并删除。

每次安装从 `plugins/staged/` 下的独立副本加载，因此重新安装后无需重启引擎即可生效。Node 的 ESM 模块按解析后的 URL 缓存且无法清除，使用固定路径会导致始终执行首次加载的版本。

### 用 Claude 写插件

将 `skills/openwhale-dev/` 复制到插件项目的 `.claude/skills/`（或在 Claude Code 中引用本仓库路径），描述所需策略，Claude 会生成完整的插件包（monitor、executor、strategy 及测试），可直接从 Plugins 页面安装。

---

## 适用场景

| 场景 | 说明 |
|----------|-------------|
| **资金费 / 基差捕获** | 围绕结算时刻的 cron 触发周期,按盘口深度计量,依据拟合的市场微观结构择时 |
| **配对 / 价差回归** | 由 z-score 价差 monitor 驱动的双腿对冲梯度,带停留确认和止损纪律 |
| **跟单交易** | 监控目标钱包,按比例镜像其交易,带仓位上限 |
| **AI 行情分析** | 带结构化输出的 LLM 推理,直接写在 `evaluate()` 里 |
| **多条件信号** | 组合价格、成交量、利率 monitor —— 只在所有条件于一个时间窗内同时成立时触发 |

---

## 快速上手

本节是**开发模式**：热重载，改代码即时生效。服务器部署见 [DEPLOYMENT.zh-CN.md](./DEPLOYMENT.zh-CN.md)——`docker compose up -d --build` 是短版本，systemd、nginx、TLS 是长版本。

### 前置

- Node.js ≥ 20、pnpm ≥ 9

### Gateway + Dashboard

后端（gateway）持有运行时和全部密钥;dashboard 是纯前端。

```bash
pnpm install
pnpm build
cp .env.example .env           # 填 OPENWHALE_MASTER_KEY + OPENWHALE_ADMIN_USER/PASSWORD
pnpm dev                       # gateway 在 :3001，dashboard 在 :3000
```

如果既没有已创建的用户账号，也没有配置 `OPENWHALE_ADMIN_USER`/`OPENWHALE_ADMIN_PASSWORD`，gateway 会拒绝启动。配置并登录后可将其从环境变量中移除。

打开 `http://localhost:3000` 管理策略实例、账户、监控、凭证、脚本和 AI 编译器。dashboard 唯一的配置项是 `OPENWHALE_GATEWAY_URL`（默认 `http://localhost:3001`）。

### 走代理

交易所直连不通时,把场地流量指向代理:

```bash
OPENWHALE_HTTPS_PROXY=http://127.0.0.1:7897        # REST + WebSocket，所有场地
OPENWHALE_HTTPS_PROXY_BINANCEUSDM=off              # …这个除外
```

逐场地的后缀是 ccxt 的 exchange id 大写形式：Binance 永续为 `BINANCEUSDM`，现货为 `BINANCE`。`off` 表示该场地保持直连。结算类策略对延迟敏感，能直连的场地不必经过代理。

两点说明：

标准的 `HTTPS_PROXY` 对 ccxt 无效，ccxt 不读取该变量。Node 24 的 `NODE_USE_ENV_PROXY` 同样无效，它只作用于 undici 的全局 fetch，而 ccxt 使用自带的 fetch 实现——同进程中普通 `fetch()` 可以成功，容易造成误判。

变量未使用 `HTTPS_PROXY` 这一名称，是为了避免机器上因其他用途设置的该变量影响下单流量的路由。

### 认证

认证在 gateway 层实现，不在 dashboard。gateway 持有解密后的场地凭证，可以下单和安装插件（即执行第三方代码），因此所有 `/api/*` 路由都要求有效会话。dashboard 仅负责携带 cookie，其路由守卫用于页面跳转，不构成安全边界。

会话为存储在 SQLite 中的不透明 token（可吊销，7 天过期），密码使用 scrypt 哈希。账号在 **Users** 页面管理。系统不区分角色，任何能登录的账号都有完整权限。

在把 gateway 暴露到网络之前:

- 在它前面终结 TLS（会话 cookie 只有在请求经由 https 到达时才带 `Secure`）
- 如果 dashboard 已经替你转发,就把 3001 端口挡在公网之外;`OPENWHALE_ALLOWED_ORIGIN` 只给真正跨域的前端设置

[DEPLOYMENT.zh-CN.md](./DEPLOYMENT.zh-CN.md) 提供了完整的 nginx 配置、systemd 单元文件，以及 TLS 相关的常见问题。

---

## 包结构

按角色分组 —— `framework/`（引擎、领域、编译器）、`venues/`（交易所集成）、`apps/`（gateway、dashboard）、`strategies/`（参考策略与私有策略插件）。

| 包 | 说明 |
|---------|-------------|
| [`@openwhaleorg/core`](./packages/framework/core) | 领域无关的引擎:凭证物化、适配器矩阵、一等公民 Account、monitor 的契约/实现/实例模型、Strategy/Executor/Trigger、运行轨迹持久化、PnL 归因（订单认领 + 成交/资金费收集器）、Scripts、`definePlugin` + `@Ow*` 装饰器、CompiledLoader |
| [`@openwhaleorg/exchange`](./packages/framework/exchange) | 交易所领域包:`exchange/perp` + `exchange/spot` 两个 kind、Perp/SpotAccount 读视图、共享交易执行器、公开行情 monitor（ticker/orderbook/volume/kline/funding-rates）及其看板图表 |
| [`@openwhaleorg/ccxt-adapter`](./packages/venues/ccxt-adapter) | 交易所适配器接口的通用 ccxt 实现 + 数据驱动的场地名册 |
| [`@openwhaleorg/hyperliquid`](./packages/venues/hyperliquid) / [`binance`](./packages/venues/binance) / [`aster`](./packages/venues/aster) | 场地插件:凭证类型 + 适配器格子（以及场地特化账户,Binance 支持组合保证金） |
| [`@openwhaleorg/gateway`](./packages/apps/gateway) | 常驻后端：运行时单例、认证、REST + SSE API、编译器服务、插件安装。所有密钥均存储于此 |
| [`@openwhaleorg/dashboard`](./packages/apps/dashboard) | Next.js 前端:实例（文件夹/看板）、账户（净值曲线）、监控看板、执行器、凭证、插件、脚本、AI 编译器 |
| [`@openwhaleorg/examples`](./packages/strategies/examples) | 参考策略，均与场地无关：动量突破、z-score 均值回归、定投（DCA）、风控逻辑写在代码中的 LLM 分析策略、跟单交易 |
| [`@openwhaleorg/compiler`](./packages/framework/compiler) | AI 策略编译器:自然语言 → 分析 → 代码生成 → L1–L4 验证阶梯 → 人工审核 → 热加载 |

---

## 路线图

### M1 — 编译器 *(已交付)*

对话式编译器,一步步引导用户定义策略逻辑,然后把 Monitor / Strategy / Executor 组件编译成类型安全的 TypeScript。自动跑一条确定性的验证阶梯（构建 → 类型检查 → 注册探测 → 模拟空跑）。人工审核后,热加载进运行时。

### M2 — 优化器

双 agent 优化闭环:分析 agent 读取运行时表现和历史监控数据,生成优化方案;执行 agent 调整参数或重写策略代码,并通过回测验证结果。

### M3 — 助手

覆盖策略全生命周期的统一对话界面:创建和管理实例、触发编译器与优化器、接收主动告警和绩效报告。

### M4 — MCP Server

把核心引擎能力暴露为标准 MCP 工具,让外部 AI agent 直接驱动策略的创建、激活和优化。

---

## 参与贡献

OpenWhale 处于早期开发阶段，核心引擎已可用，其余部分正在开发中。

- 开 issue 讨论想法或报告 bug
- 提 PR 修 bug、加新场地插件、或贡献策略示例
- 如果项目对你有帮助，欢迎 star

---

## 许可

MIT
