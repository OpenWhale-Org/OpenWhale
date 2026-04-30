# OpenWhale 框架设计文档 — 04 Adapter

---

## 一、定位

Adapter 是对特定类型第三方服务的抽象接口层。

**设计哲学：**
- 不强求全部抽象。现实中不可能枚举所有服务，强行抽象反而增加维护成本。
- 优先支持 **Skill 直接接入**：很多项目（Uniswap、Aave、各 DEX）开放了自己的 SDK/Plugin，AI 生成代码时候可以直接基于 Skill 生成，不需要引用 Adapter。
- Adapter 主要覆盖**高频、通用**的服务类型，提供统一接口便于 Monitor 和 Strategy 复用。

---

## 二、内置 Adapter 类型

### 2.1 Exchange Adapter（交易所）

#### SpotExchangeAdapter（现货）

```typescript
interface SpotExchangeAdapter {
  // 行情
  getPrice(symbol: string): Promise<number>
  getOrderBook(symbol: string, depth?: number): Promise<OrderBook>
  getKlines(symbol: string, interval: string, limit?: number): Promise<Kline[]>

  // 账户
  getBalance(): Promise<Balance>
  getOpenOrders(symbol?: string): Promise<Order[]>
  getOrderHistory(symbol?: string, limit?: number): Promise<Order[]>

  // 交易
  placeOrder(params: SpotOrderParams): Promise<OrderResult>
  cancelOrder(orderId: string, symbol: string): Promise<void>
  cancelAllOrders(symbol?: string): Promise<void>
}

interface SpotOrderParams {
  symbol: string
  side: 'buy' | 'sell'
  type: 'market' | 'limit'
  quantity: number
  price?: number          // limit 单必填
  clientOrderId?: string
}
```

#### PerpExchangeAdapter（衍生品/永续合约）

```typescript
interface PerpExchangeAdapter extends SpotExchangeAdapter {
  // 衍生品特有
  getFundingRate(coin: string): Promise<FundingRateData>
  getPositions(coin?: string): Promise<Position[]>
  updateLeverage(coin: string, leverage: number, isCross: boolean): Promise<void>

  // 衍生品下单（扩展参数）
  placeOrder(params: PerpOrderParams): Promise<OrderResult>
}

interface PerpOrderParams extends SpotOrderParams {
  reduceOnly?: boolean
  tif?: 'Gtc' | 'Ioc' | 'Alo'
  slippageBps?: number
  syncLeverage?: { leverage: number; isCross: boolean }
}
```

### 2.2 NFTMarketplaceAdapter

```typescript
interface NFTMarketplaceAdapter {
  getCollectionInfo(collection: string): Promise<CollectionInfo>
  getFloorPrice(collection: string): Promise<number>
  getListings(collection: string, limit?: number): Promise<NFTListing[]>
  getNFTInfo(collection: string, tokenId: string): Promise<NFTInfo>

  listNFT(params: ListNFTParams): Promise<void>
  buyNFT(params: BuyNFTParams): Promise<OrderResult>
  cancelListing(listingId: string): Promise<void>
}
```

### 2.3 PredictionMarketAdapter

```typescript
interface PredictionMarketAdapter {
  getMarkets(filter?: MarketFilter): Promise<Market[]>
  getMarket(marketId: string): Promise<Market>
  getOdds(marketId: string): Promise<Odds>
  getPositions(): Promise<PredictionPosition[]>

  placeBet(params: BetParams): Promise<BetResult>
  redeemWinnings(marketId: string): Promise<RedeemResult>
}
```

### 2.4 BridgeAdapter

```typescript
interface BridgeAdapter {
  getSupportedChains(): Promise<Chain[]>
  getQuote(params: BridgeQuoteParams): Promise<BridgeQuote>
  bridge(params: BridgeParams): Promise<BridgeTxResult>
  getBridgeStatus(txHash: string): Promise<BridgeStatus>
}

interface BridgeQuoteParams {
  fromChain: string
  toChain: string
  token: string
  amount: bigint
}
```

### 2.5 BlockchainAdapter

```typescript
interface BlockchainAdapter {
  // 查询
  getBalance(address: string, token?: string): Promise<bigint>
  getTransaction(txHash: string): Promise<Transaction>
  getBlock(blockNumber?: number): Promise<Block>
  getLogs(filter: LogFilter): Promise<Log[]>

  // 合约交互
  callContract(params: CallParams): Promise<any>
  sendTransaction(params: TxParams): Promise<string>  // 返回 txHash
  waitForTx(txHash: string, confirmations?: number): Promise<TxReceipt>

  // ERC20
  getTokenBalance(address: string, tokenAddress: string): Promise<bigint>
  approveToken(tokenAddress: string, spender: string, amount: bigint): Promise<string>
}
```

---

## 三、Adapter 实现示例（具体实现）

### HyperliquidAdapter

```typescript
class HyperliquidAdapter implements PerpExchangeAdapter {
  constructor(
    private readonly wallet: ethers.Wallet,
    private readonly mainWalletAddress?: string
  ) {}

  async getPrice(coin: string): Promise<number> {
    // 调用 HL REST API /info
  }

  async getFundingRate(coin: string): Promise<FundingRateData> {
    // 调用 HL /info endpoint，获取 fundingHistory
  }

  async placeOrder(params: PerpOrderParams): Promise<OrderResult> {
    // 构造 EIP-712 签名，提交 IOC 或 GTC 订单
  }

  async updateLeverage(coin: string, leverage: number, isCross: boolean): Promise<void> {
    // 调用 HL updateLeverage action
  }
}
```

---

## 四、Adapter 与 Monitor / Executor 的关系

Adapter 同时服务于框架的两端：

```
Monitor 使用 Adapter 查询数据（只读）：
  FundingRateMonitor → PerpExchangeAdapter.getFundingRate()
  PriceMonitor       → SpotExchangeAdapter.getPrice()

Executor 使用 Adapter 执行操作（写操作）：
  PerpTradingExecutor → PerpExchangeAdapter.placeOrder()
  PerpTradingExecutor → PerpExchangeAdapter.closePosition()
```

同一个 Adapter 实例可以同时被 Monitor 和 Executor 复用，避免重复初始化：

```typescript
// Runtime 初始化时创建 Adapter 实例
const hlAdapter = new HyperliquidAdapter(wallet)

// Monitor 和 Executor 共享同一实例
const fundingMonitor = new FundingRateMonitor(hlAdapter)
const hlExecutor     = new PerpTradingExecutor(hlAdapter)
```

Adapter 实例由 Runtime 管理，通过 Credentials 获取私钥/API Key 初始化：

```typescript
const adapter = new HyperliquidAdapter(
  new ethers.Wallet(await credentials.getByName('HL Private Key'))
)
```
