# OpenWhale 框架设计文档 — 02 Credentials

---

## 一、定位

Credentials 是 OpenWhale 的敏感信息管理模块，参考 n8n Credentials 系统设计。

职责：
- 存储钱包私钥、API Key、API Secret 等敏感信息
- AES-256-GCM 加密，所有字段统一加密存入 `data`
- 提供统一访问接口，供 Strategy、Account、Monitor 等模块使用
- 兼作 Account 模块的密钥来源（`type` 字段决定是否可实例化为 Account）

---

## 二、数据结构

```typescript
interface Credential {
  id: string
  name: string      // 用户自定义名称，如 "HL Main"、"OpenAI Key"
  type: string      // 类型标识，如 'hyperliquid'、'openai'、'binance'
  data: string      // AES-256-GCM 加密的 JSON 字符串
  createdAt: string
  updatedAt: string
}

// list() 返回的摘要（不含敏感数据）
interface CredentialInfo {
  id: string
  name: string
  type: string
  createdAt: string
  updatedAt: string
}
```

`data` 解密后是一个 JSON 对象，字段由 `type` 决定：

| type | data 内容示例 |
|------|-------------|
| `openai` | `{ "apiKey": "sk-..." }` |
| `anthropic` | `{ "apiKey": "sk-ant-..." }` |
| `hyperliquid` | `{ "privateKey": "0x...", "address": "0x..." }` |
| `binance` | `{ "apiKey": "...", "apiSecret": "..." }` |

**`type` 的语义：**
- 是否为账户类型由 AccountFactory 注册决定，不靠命名区分
- 注册了 AccountFactory 的 `type` 可被实例化为 `IAccount`
- 未注册 AccountFactory 的 `type` 是普通密钥（LLM Key、API Key 等）

---

## 三、加密方案

使用 AES-256-GCM，每条 Credential 独立加密：

```
存储格式：iv:authTag:encrypted（均为 hex）
示例：a1b2c3...:d4e5f6...:7g8h9i...
```

加密密钥通过环境变量 `OPENWHALE_ENCRYPTION_KEY` 注入（32 bytes hex）。

---

## 四、接口设计

```typescript
interface CredentialStore {
  // 写入（data 为明文 JSON 对象，内部加密存储）
  set(name: string, type: string, data: Record<string, unknown>): Promise<void>

  // 读取（返回解密后的完整信息）
  getByName(name: string): Promise<{ type: string; data: Record<string, unknown> }>

  // 管理
  delete(name: string): Promise<void>
  list(): Promise<CredentialInfo[]>   // 不返回加密数据
}
```

---

## 五、存储方案

统一使用 SQLite（`DBCredentialStore`），存储在 `openwhale.db`：

```sql
CREATE TABLE IF NOT EXISTS credentials (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  type       TEXT NOT NULL,
  data       TEXT NOT NULL,   -- AES-256-GCM 加密的 JSON
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

不再支持文件存储（`FileCredentialStore` 已废弃）。

---

## 六、在 Strategy 中使用

Strategy 通过 `this.credential(name)` 访问原始解密数据（适用于不需要 Account 抽象的场景）：

```typescript
class MyStrategy extends BaseStrategy {
  async evaluate(context: StrategyContext) {
    // 获取解密后的 data 对象
    const { data } = await this.credential('OpenAI Key')
    const apiKey = data.apiKey as string
  }
}
```

更常见的是通过 Account 模块访问账户类 Credential，见 `15-account.md`。

---

## 七、安全注意事项

- `OPENWHALE_ENCRYPTION_KEY` 不得硬编码，必须通过环境变量注入
- `list()` 不返回 `data` 字段
- 日志中禁止打印 Credential 明文内容
