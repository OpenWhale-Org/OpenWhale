# @openwhaleorg/exchange

The exchange domain for OpenWhale: the `exchange/perp` and `exchange/spot` kinds, their adapter contracts, the generic `PerpAccount` / `SpotAccount` read views, the shared funding-rate monitor and the `perp-trading` / `spot-trading` executors. Venue plugins (Binance, Hyperliquid, …) fill the matrix with cells; strategies declare slots of these kinds.

Part of [OpenWhale](https://github.com/OpenWhale-Org/OpenWhale).
