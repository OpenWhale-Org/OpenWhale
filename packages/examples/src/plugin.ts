import { definePlugin } from '@openwhaleorg/core'
import { CopyTradingStrategy } from './strategies/CopyTradingStrategy.js'
import { MomentumBreakoutStrategy } from './strategies/MomentumBreakoutStrategy.js'
import { MeanReversionStrategy } from './strategies/MeanReversionStrategy.js'
import { ScheduledAccumulationStrategy } from './strategies/ScheduledAccumulationStrategy.js'
import { AiAnalystStrategy } from './strategies/AiAnalystStrategy.js'

/**
 * Example strategies — a reference library, not a venue plugin.
 *
 * Every strategy here is venue-agnostic by construction: it reads the shared
 * public monitors from `@openwhaleorg/exchange`, trades through the shared
 * `exchange/perp-trading` executor, and takes its venue from whichever perp
 * account you bind at activation. Nothing is hard-wired to an exchange.
 *
 * Registers (as `examples/<id>`):
 *   - `momentum-breakout`       — Donchian breakout, trend following
 *   - `mean-reversion`          — z-score fade, the opposite regime bet
 *   - `scheduled-accumulation`  — cron DCA with dip sizing
 *   - `ai-analyst`              — LLM verdict, code-enforced risk
 *   - `copy-trading`            — mirrors another address's fills
 *
 * They are meant to be read and copied. Each file is self-contained apart
 * from `indicators.ts`, so lifting one into your own plugin is a copy, a
 * rename, and an edit — not an untangling.
 *
 * Requires the `exchange` domain plugin. `copy-trading` additionally needs
 * `@openwhaleorg/hyperliquid` for its fills feed.
 */
export const examplesPlugin = definePlugin({
  name: 'examples',
  version: '1.0.0',

  strategies: [
    MomentumBreakoutStrategy,
    MeanReversionStrategy,
    ScheduledAccumulationStrategy,
    AiAnalystStrategy,
    CopyTradingStrategy,
  ],
})

export default examplesPlugin
