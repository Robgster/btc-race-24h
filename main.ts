// Hold-with-crash-guard: a cbBTC/USDC bot for make.fun's 24-hour live race (agent-fun/bars-replay/v1).
//
// Every round trip costs about 26 bps in fees, slippage and impact, so trading often on 1-minute bars
// bleeds money. This bot trades rarely:
//   - It buys cbBTC with all its cash on the first batch and holds it.
//   - While it holds, it tracks the highest close since it bought. When a close falls more than
//     TRAIL_BPS under that high, it sells everything (a trailing stop: it caps a crash's damage).
//   - Out of the market, it waits at least COOLDOWN_BARS bars, then buys back once the close is more
//     than REENTRY_BPS over the EMA of the last EMA_BARS closes and that EMA is rising (the drop is over).
// Each decision fills at the next bar's open. Only the bars' closes are read, in float64 with + - * /,
// so two runs on the same bars send the same orders.

import { runBars, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const TRAIL_BPS = 150;
const EMA_BARS = 240;
const REENTRY_BPS = 10;
const COOLDOWN_BARS = 60;
const BUY_SLIPPAGE_BPS = 100;
const SELL_SLIPPAGE_BPS = 300;

let ema: number | null = null;
let high = 0;
let wasHolding = false;
let barsSinceExit = Number.MAX_SAFE_INTEGER;
let first = true;

await runBars({
  onBatch(state, batch) {
    const symbol = state.hello.symbols[0].symbol;
    const bar = batch.bars.find((b) => b.symbol === symbol);
    if (bar === undefined) return [];

    const close = Number(bar.c);
    const prevEma = ema;
    ema = ema === null ? close : ema + (2 / (EMA_BARS + 1)) * (close - ema);

    const held = state.positions.get(symbol);
    if (held !== undefined && held.qty > 0n) {
      first = false; // the opening buy has filled; until then it is sent again every bar
      if (!wasHolding) high = close; // a buy just filled: start the trailing high here
      wasHolding = true;
      if (close > high) high = close;
      if (((high - close) / high) * 10_000 > TRAIL_BPS) {
        barsSinceExit = 0;
        const sell: SellInput = { side: 'sell', symbol, qty: held.qty, max_slippage_bps: SELL_SLIPPAGE_BPS };
        return [sell];
      }
      return [];
    }
    wasHolding = false;

    barsSinceExit++;
    const rising = prevEma !== null && ema > prevEma;
    const reentry = barsSinceExit >= COOLDOWN_BARS && ((close - ema) / ema) * 10_000 > REENTRY_BPS && rising;
    if (!first && !reentry) return [];

    const spend = state.cash < state.weightRoom(symbol) ? state.cash : state.weightRoom(symbol);
    if (spend < BigInt(state.hello.fees.min_notional_quote_units)) return [];
    const buy: BuyInput = { side: 'buy', symbol, notional_quote_units: spend, max_slippage_bps: BUY_SLIPPAGE_BPS };
    return [buy];
  },
});
