# OpenWhale

<img src="./logo.svg" width="64" height="64" />

**可组合、AI 原生经济策略的可编程层**

![License](https://img.shields.io/badge/license-MIT-blue)
![TypeScript](https://img.shields.io/badge/language-TypeScript-3178c6)
![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)

[English →](./README.md)

OpenWhale 是一个用于构建自动化经济策略的 TypeScript 框架。Monitor、Strategy、Executor 三层完全解耦 —— 同一份策略代码可以跑在任何场地上、接任何数据源,并且能被 AI 编写、审计和演化。

---

## 为什么是 OpenWhale

- **彻底解耦的三层** —— Monitor 收集、Strategy 决策、Executor 执行。换掉任何一层都不用动其他两层。
- **构造上就与场地无关** —— 策略代码里**永远不出现交易所名字**。它声明的是*账户槽位*,场地由你在激活时绑定的账户推导出来。一份策略,任意平台。
- **适配器矩阵** —— 场地作为 *(kind × venue)* 矩阵中的格子接入(`exchange/perp × binance`、`exchange/spot × hyperliquid` …)。领域包定义词汇表,场地包填格子,数据驱动的 ccxt 名册开箱带来十二个场地。
- **AI 作为程序员** —— 带结构化输出的 LLM 推理内建在策略层;仓库自带 `skills/openwhale-dev` skill,能把完整的框架契约教给任何一个 Claude,让它产出可直接安装、带测试的插件。
- **深度可观测** —— 每一次策略运行都留下持久化的决策轨迹:它看到了什么、哪个闸门说了不、发出了什么指令。停用实例或重启 gateway,审计轨迹依然在。
- **内建 PnL 归因** —— 执行器自动认领它下的订单;后台收集器把场地成交(真实的已实现盈亏和手续费)与资金费收入接回到认领它的实例上。同一账户上交易同一标的的两个实例,依然分得开。
- **类型安全的插件架构** —— 每个组件都实现严格的 TypeScript 接口。IDE 支持、安全重构,以及编译器能验证的 AI 生成代码。

---

## 核心概念

| 概念 | 是什么 |
|---|---|
| **Monitor（监控）** | 采集数据并发出带键的记录（`venue:symbol` …）。以*契约*形式声明,可有多个*实现*;用户按键创建*实例*,可选绑定凭证。发出的数据以 JSONL 持久化,并驱动触发器。 |
| **Strategy（策略）** | 纯决策逻辑。按标签声明它依赖的 monitor / executor / account,接收触发,返回 `ExecutionInstruction[]`。参数拆成 `base`（必填）和 `tunable`（有默认值、可被 AI 优化）两套 zod schema。 |
| **Executor（执行器）** | 通过适配器会话把指令变成场地动作:重试纪律、幂等的客户端订单号、逐单延迟与滑点采集。凭证槽位可解析成会话（按 kind）或原始凭证数据（`raw: true`,比如一个 bot token）;`optional: true` 的槽位允许实例在未绑定时也能激活,执行器优雅降级。策略保持纯粹。 |
| **Instance（实例）** | 策略 + 参数 + 账户绑定,作为一个整体激活。所有可观测的东西都挂在实例上:实时事件、执行记录、运行轨迹、日志。 |
| **Account（账户）** | 一个具名实体,把凭证绑定到某个账户实现（通用或场地特化）。策略只能通过自己绑定账户的 Reader 读取余额和仓位。 |
| **Trigger（触发器）** | Cron 计划 + monitor 条件（时间窗内多源 AND）。订阅让 monitor 持续采集而不唤醒策略;运行中的策略可以加入它在运行时发现的新数据源（`addMonitorSource`）。 |
| **Portfolio journal（组合日志）** | 策略拥有的、可选的实例级历史。策略提交幂等的快照、成交、决策和行情;Core 事务性地存储它们,并在不了解策略轨迹格式的前提下推导出净值、回撤和交易报告。 |

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

- **实例** —— 卡片式,支持文件夹、拖拽排序、emoji 图标,每张卡片带实时净 PnL 徽标;每个实例四个实时页签（实时事件仅限该实例自己的 monitor、执行、运行、日志）。每个实例还有整页 **Board**,支持点击重命名、账户重绑、可编辑的参数面板和 PnL 面板。创建时会问你是哪一种 —— **仅保存**还是**激活**:停止状态的实例参数和绑定还能回头细看,一旦开始交易就不能了。
- **实例级 PnL** —— 已实现 / 手续费 / 资金费 / 净额 / 未实现,数据来自归因账本,可下钻到按标的汇总、原始场地成交、以及由成交推导、按场地标记价计价的持仓。资金费事件按各实例在结算边界时点持有的仓位拆分。
- **运行轨迹** —— 每次运行记录它的步骤:闸门、跳过、计量、发出的指令、捕获的日志行。有指令或有错误的运行落盘;空转的运行按心跳采样。可按结果过滤、按内容搜索。
- **Monitor 看板** —— monitor 通过 `plots()` 约定声明面板:折线 / 柱状 / K 线,外加可排序的 `table` 类型、单选与多选选择器、记录窗口控制。
- **参数即表单** —— zod 的 `.meta()` 驱动 UI:分组、滑块、单位后缀、条件可见性、可搜索的市场选择器（单选与多选）、针对绑定场地的逐值可用性判定、给梯度用的可编辑行表 *list* 参数,以及随输入实时重绘的**沙箱交互示意图**。
- **脚本** —— 插件可以附带运维工具（`scripts: [...]`）,按需对活跃运行时执行并返回等宽报告:计划预览、拟合检查、一次性审计。参数渲染成小表单,运行时值（比如实例 id）用实时解析的下拉框。
- **编译器与助手** —— 实验性的自然语言策略编译器;以及更推荐的路径:把 Claude 指向 `skills/openwhale-dev`,让它来写这个插件。

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

peer 范围写的是 `workspace:^`,而它**不是一个范围,是一条指令** —— pnpm 在打包那一刻拿它去工作区求值。所以真正上传的那个数字**在仓库里任何地方都不存在**,读 diff 也看不见。这个检查会把每个包真的打一遍,然后从 **tarball** 里读 peer 范围 —— 在 npm 把它变成永久事实之前,那是它唯一存在的地方。

---

## 插件

插件就是一个默认导出工厂函数、返回自身注册项的包:

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

从控制台的 Plugins 页面安装 —— 构建好的 `.js`/`.mjs` bundle、**GitHub 仓库**（`owner/repo`,或者直接粘地址栏;分支/tag/commit 可选）、npm 包名或本地路径 —— 也可以在代码里 `runtime.loadPlugin()`。组件按命名空间注册（`my-plugin/momentum`）,支持热重载。

GitHub 安装是由 npm clone 并构建的,所以只带 TypeScript 源码的仓库需要在 package.json 里有 `prepare` 脚本（`"prepare": "npm run build"`）;私有仓需要引擎侧设置 `OPENWHALE_GITHUB_TOKEN`。

### 命名空间

插件声明的名字是它的默认**命名空间** —— 也就是它注册的每个 id 前面那个 `my-plugin/`。但**名字不是全局唯一的**,所以命名空间是在安装时决定的。

当一个命名空间已被占用,**由包名决定这是在问什么**:本地 checkout 和它发布出去的版本是同一个插件,提供**覆盖**;不同的包则是一个碰巧同名的陌生插件,给它**自己的命名空间**（`alice-funding-arb`,从发布者推导）。命名空间一旦选定就固定 —— 实例是按 `<命名空间>/<策略>` 保存的。

**不是所有东西都带命名空间**,而这决定了两个同名插件到底能不能共存:adapter cell（按 kind 和 venue 寻址）和 credential type（按名字共享）各自**只能有一个提供者**,所以同一个场地的两个 venue 插件是二选一,换名字也分不开。这一点在提供命名空间选项**之前**就检查掉了,而且注册是全有或全无 —— 被拒绝的安装不留任何残骸。

### 覆盖与卸载

**覆盖**替换代码,保留实例、账户和凭证:正在运行的会在新代码上重启,而新版本删掉了对应策略的那些实例会在 Instances 页面**标记为损坏而不是删除** —— 把带有该策略的版本装回去,它们会重新跑起来。

npm 装的插件如果注册表上有新版本,会在列表里标出来并支持一键更新 —— 走的是同一条覆盖路径,所以实例照样存活。

**卸载**则相反:只要还有任何策略实例、账户或凭证属于这个插件,它就拒绝,并把它们**列出来** —— 每一个都装着你配置过的东西。插件自己的 monitor 实例会跟着一起删掉。

每次安装都从 `plugins/staged/` 下**自己那份副本**加载,所以重新安装能跑上新代码而不用重启引擎:Node 的 ESM 注册表按解析后的 URL 做键且无法驱逐,固定路径会导致永远执行第一次加载的那个版本。

### 用 Claude 写插件

把 `skills/openwhale-dev/` 复制到你插件项目的 `.claude/skills/`（或者在 Claude Code 里引用本仓库的路径）,描述你想要的策略,Claude 会产出一个完整的插件包 —— monitor、executor、strategy、测试 —— 可以直接从 Plugins 页面安装。

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

这里说的是**本地**环境。服务器部署 —— Docker 或 systemd、TLS,以及那些没吃过亏就不明显的运维规则 —— 见 **[DEPLOYMENT.zh-CN.md](./DEPLOYMENT.zh-CN.md)**。

赶时间的话:`cp .env.example .env`,填好主密钥和管理员账号,然后 `docker compose up -d --build`。

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

gateway 是**失败即关闭**的:既没有用户账号、又没有 `OPENWHALE_ADMIN_USER`/`OPENWHALE_ADMIN_PASSWORD` 时,它宁可拒绝启动,也不会提供一个无认证的交易 API。设一次、登录,然后把它们从环境里拿掉。

打开 `http://localhost:3000` 管理策略实例、账户、监控、凭证、脚本和 AI 编译器。dashboard 唯一的配置项是 `OPENWHALE_GATEWAY_URL`（默认 `http://localhost:3001`）。

### 走代理

交易所直连不通时,把场地流量指向代理:

```bash
OPENWHALE_HTTPS_PROXY=http://127.0.0.1:7897        # REST + WebSocket，所有场地
OPENWHALE_HTTPS_PROXY_BINANCEUSDM=off              # …这个除外
```

逐场地的后缀是 **ccxt 的 exchange id** 大写 —— Binance 永续是 `BINANCEUSDM`,现货是 `BINANCE`。`off` 让某个场地保持直连,这比看上去重要:结算是按毫秒抢的,一个你**能**直连的场地,不该为了那些连不上的场地而付代理跳数。

自己 debug 之前,有两件事值得先知道。标准的 `HTTPS_PROXY` **不起作用** —— ccxt 不读它。Node 24 的 `NODE_USE_ENV_PROXY` 也不行,它只接管 undici 的**全局** fetch,而 ccxt 调的是它自己打包的那个;同一个进程里裸 `fetch()` 会成功,让这个故障看起来像任何东西,就是不像代理问题。而这个变量**故意不叫** `HTTPS_PROXY`:很多机器出于无关的原因带着那个变量,而下单流量绝不该因为意外而改变路由。

### 认证

认证由 **gateway** 强制,不是 dashboard:那个进程持有解密后的场地凭证、能下单、能安装插件（也就是任意代码),所以只做在前端的登录,任何能碰到 3001 端口的人绕一下就没了。每条 `/api/*` 都要求会话,dashboard 只是把 cookie 带过去,它的路由守卫是给人看的跳转,不是安全边界。

会话是 SQLite 里的不透明 token（可吊销、7 天过期),密码用 scrypt 哈希。账号在 **Users** 页面管理 —— **没有角色划分:任何能登录的人都能动真钱。**

在把 gateway 暴露到网络之前:

- 在它前面终结 TLS（会话 cookie 只有在请求经由 https 到达时才带 `Secure`）
- 如果 dashboard 已经替你转发,就把 3001 端口挡在公网之外;`OPENWHALE_ALLOWED_ORIGIN` 只给真正跨域的前端设置

[DEPLOYMENT.zh-CN.md](./DEPLOYMENT.zh-CN.md) 里有 nginx 配置块、systemd 单元,以及**为什么少了 `X-Forwarded-Proto` 会导致一个无限循环、且任何日志里都没有一行说明原因的登录**。

---

## 包结构

按角色分组 —— `framework/`（引擎、领域、编译器）、`venues/`（交易所集成）、`apps/`（gateway、dashboard）、`strategies/`（参考策略与私有策略插件）。

| 包 | 说明 |
|---------|-------------|
| [`@openwhaleorg/core`](./packages/framework/core) | 领域无关的引擎:凭证物化、适配器矩阵、一等公民 Account、monitor 的契约/实现/实例模型、Strategy/Executor/Trigger、运行轨迹持久化、PnL 归因（订单认领 + 成交/资金费收集器）、Scripts、`definePlugin` + `@Ow*` 装饰器、CompiledLoader |
| [`@openwhaleorg/exchange`](./packages/framework/exchange) | 交易所领域包:`exchange/perp` + `exchange/spot` 两个 kind、Perp/SpotAccount 读视图、共享交易执行器、公开行情 monitor（ticker/orderbook/volume/kline/funding-rates）及其看板图表 |
| [`@openwhaleorg/ccxt-adapter`](./packages/venues/ccxt-adapter) | 交易所适配器接口的通用 ccxt 实现 + 数据驱动的场地名册 |
| [`@openwhaleorg/hyperliquid`](./packages/venues/hyperliquid) / [`binance`](./packages/venues/binance) / [`aster`](./packages/venues/aster) | 场地插件:凭证类型 + 适配器格子（以及场地特化账户,Binance 支持组合保证金） |
| [`@openwhaleorg/gateway`](./packages/apps/gateway) | 常驻后端:运行时单例、认证、REST + SSE API、编译器服务、插件安装 —— **所有密钥都住在这里** |
| [`@openwhaleorg/dashboard`](./packages/apps/dashboard) | Next.js 前端:实例（文件夹/看板）、账户（净值曲线）、监控看板、执行器、凭证、插件、脚本、AI 编译器 |
| [`@openwhaleorg/examples`](./packages/strategies/examples) | 参考策略,构造上与场地无关:动量突破、z-score 均值回归、定投（DCA）、把风控写在代码里的 LLM 分析师、跟单交易。**读它们,抄它们** |
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

OpenWhale 正处于活跃的早期开发阶段。核心引擎已经能用,其余部分我们在公开地建。

- 开 issue 讨论想法或报告 bug
- 提 PR 修 bug、加新场地插件、或贡献策略示例
- 觉得有用就点个 star —— 这能帮到其他人发现这个项目

---

## 许可

MIT
