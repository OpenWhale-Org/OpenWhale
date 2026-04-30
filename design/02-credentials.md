# OpenWhale 框架设计文档 — 02 Credentials

---

## 一、定位

Credentials 是 OpenWhale 的敏感信息管理模块，类比 n8n 的 Credentials 系统。

职责：
- 存储钱包私钥、API Key、API Secret 等敏感信息
- AES-256-GCM 加密，密钥通过环境变量注入，不落盘
- 提供统一的访问接口，供 Strategy、Adapter、Monitor 等模块使用

---

## 二、加密方案

使用 AES-256-GCM：

```
存储格式：iv:authTag:encrypted
示例：a1b2c3...:d4e5f6...:7g8h9i...
```

加密密钥通过环境变量 `OPENWHALE_ENCRYPTION_KEY` 注入（32 bytes hex）。

---

## 三、数据结构

```typescript
type CredentialType =
  | 'wallet_private_key'   // EVM 私钥
  | 'api_key'              // 单字段 API Key
  | 'api_key_secret'       // API Key + Secret 对
  | 'custom'               // 自定义 JSON

interface Credential {
  id: string
  name: string                          // 用户自定义名称，如 "Binance Main"
  type: CredentialType
  encryptedData: string                 // AES-256-GCM 加密后的内容
  metadata?: Record<string, string>     // 非敏感元数据，如 address、exchange、network
  createdAt: Date
  updatedAt: Date
}
```

`encryptedData` 的明文内容根据 type 不同：

| type | 明文内容 |
|------|---------|
| `wallet_private_key` | 私钥字符串，如 `0xabc...` |
| `api_key` | API Key 字符串 |
| `api_key_secret` | JSON 字符串，如 `{"key":"...","secret":"..."}` |
| `custom` | 任意 JSON 字符串 |

---

## 四、接口设计

```typescript
interface CredentialStore {
  // 写入
  set(
    name: string,
    type: CredentialType,
    plaintext: string,
    metadata?: Record<string, string>
  ): Promise<string>  // 返回 id

  // 读取（返回解密后明文）
  get(id: string): Promise<string>
  getByName(name: string): Promise<string>

  // 管理
  delete(id: string): Promise<void>
  list(): Promise<Omit<Credential, 'encryptedData'>[]>  // 不返回加密数据
  exists(name: string): Promise<boolean>
}
```

---

## 五、存储方案

存储路径：`~/.openwhale/credentials.enc.json`

文件内容为加密后的 Credential 数组，整个文件用 ENCRYPTION_KEY 加密（而非每条单独加密），减少密钥管理复杂度。

```json
// 文件内容（整体加密，这里展示解密后的结构）
[
  {
    "id": "cred_01",
    "name": "My Binance Key",
    "type": "api_key_secret",
    "encryptedData": "iv:authTag:encrypted",
    "metadata": { "exchange": "binance" },
    "createdAt": "2026-04-30T00:00:00Z",
    "updatedAt": "2026-04-30T00:00:00Z"
  }
]
```

---

## 六、在 Strategy 中使用

Strategy 代码通过 `this.credential(name)` 访问，框架在执行时注入 CredentialStore：

```javascript
class GeneratedStrategy extends Strategy {
  async execute(context) {
    // 获取私钥（解密后的明文）
    const privateKey = await this.credential('My Wallet')

    // 获取 API Key/Secret
    const apiCreds = JSON.parse(await this.credential('Binance Main'))
    // apiCreds = { key: '...', secret: '...' }

    // ...
  }
}
```

---

## 七、安全注意事项

- ENCRYPTION_KEY 不得硬编码，必须通过环境变量注入
- `list()` 接口不返回 `encryptedData` 字段
- Strategy 代码在沙箱中运行，`credential()` 是唯一合法的敏感信息访问路径
- 日志中禁止打印 Credential 明文内容
