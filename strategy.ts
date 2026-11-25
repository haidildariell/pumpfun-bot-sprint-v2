// pumpfun-bot-sprint-v2 — strategy.ts
//
// Dip-buy scalper for the pump.fun replay (agent-fun/replay/v2).
//
// Idea, in one paragraph: every momentum variant tried on the dev window
// loses money (best -2.00 SOL, win rate ~25%) because buys land 2 slots
// late, at the top of an explosive move, and the round trip then bleeds
// through a wide trailing stop while fees eat ~3% + 105k lamports. So this
// bot does the opposite of chasing: it only buys a coin that already proved
// demand (up >= 5% from its first-seen price, buy share >= 55%) AFTER the
// price pulls back >= 2% from its local high, while still holding >= 2%
// above its base. It then exits fast: half out at +8%, the rest at +15%,
// hard stop -7%, a 5% trail once the peak clears +10%, and a 900-slot
// time stop so dead coins cannot bleed slowly. Size is small (0.05 SOL,
// capped at 0.8% of the real SOL reserve) so orders stop tripping the
// 1%-of-reserve max-order-size rejection that killed 178 v1 buys.
//
// Everything is bigint-exact: prices are virtual_sol_reserves scaled by
// 10^12 over virtual_token_reserves, comparisons are integer ratios, there
// is no clock, no randomness, no network and no file access, so two runs
// on the same data produce the same action log.

export type BuyOrder = {
  side: "buy";
  client_id: string;
  mint: string;
  quote_lamports: string;
  max_slippage_bps: number;
};

export type SellOrder = {
  side: "sell";
  client_id: string;
  mint: string;
  token_amount: string;
  max_slippage_bps: number;
};

export type Order = BuyOrder | SellOrder;

export interface TradeEventLike {
  event: string;
  mint: string;
  sol_amount: string;
  token_amount: string;
  is_buy: boolean;
  virtual_sol_reserves: string;
  virtual_token_reserves: string;
  real_sol_reserves: string;
  slot?: number;
}

export interface MarkLike {
  mint: string;
  slot: number;
  virtual_token_reserves: string;
  virtual_quote_reserves: string;
  real_token_reserves: string;
  real_quote_reserves: string;
}

export interface FillLike {
  client_id: string;
  mint: string;
  side: "buy" | "sell";
  status: "filled" | "rejected" | "failed";
  slot: number;
  decided_slot: number;
  quote_lamports: string;
  token_amount: string;
}

export interface AccountPosition {
  mint: string;
  token_amount: string;
  cost_lamports: string;
}

export interface BatchInput {
  seq: number;
  slot: number;
  events: TradeEventLike[];
  marks: MarkLike[];
  fills: FillLike[];
  account: { cash_lamports: string; positions: AccountPosition[] };
}

// ---------------------------------------------------------------------------
// Tunable parameters — one place, all integer. Change these to sweep.
// ---------------------------------------------------------------------------
export const PARAMS = {
  sizeLamports: 50_000_000n, // 0.05 SOL per buy
  sizeMaxBpsOfRealReserve: 80n, // cap size at 0.8% of real SOL reserve (cap is 1%)
  minSizeLamports: 10_000_000n, // guardrail: round trip needs >= 0.01 SOL buys
  maxOpenPositions: 5,
  maxOrdersPerBatch: 16,
  minTrades: 12, // coin needs at least this many observed trades
  maxCoinAgeSlots: 900, // only coins first seen within this many slots
  minRiseBps: 1200, // high must clear base by >= 12%
  pullbackBps: 500, // current price must sit >= 5% below the high
  minHoldAboveBaseBps: 500, // ...while still >= 5% above the base
  minBuyShareBps: 7000, // buy SOL share of total traded SOL, in bps (>= 70%)
  partialBps: 600, // sell half at +6%
  takeProfitBps: 1200, // sell the rest at +12%
  stopLossBps: 500, // sell all at -5%
  trailArmBps: 800, // trailing stop arms once peak clears +8%
  trailBps: 400, // ...then sells if price falls 4% off the peak
  timeStopSlots: 600, // sell all if neither TP nor stop hit by then
  buySlippageBps: 200,
  sellSlippageBps: 800, // wide on sells: executing the exit beats haggling in a dump
};

const SCALE = 1_000_000_000_000n; // price scale factor for bigint ratios

function priceOf(vsol: bigint, vtok: bigint): bigint {
  if (vtok <= 0n) return 0n;
  return (vsol * SCALE) / vtok;
}

function big(s: string | undefined): bigint {
  if (s === undefined || s === "") return 0n;
  return BigInt(s);
}

interface CoinState {
  firstSlot: number;
  basePrice: bigint;
  high: bigint;
  lastPrice: bigint;
  lastRealSol: bigint;
  buySol: bigint;
  sellSol: bigint;
  trades: number;
}

interface PositionState {
  entryPrice: bigint;
  peak: bigint;
  entrySlot: number;
  partialDone: boolean;
  tokens: bigint;
}

export class DipBuyStrategy {
  private coins = new Map<string, CoinState>();
  private positions = new Map<string, PositionState>();
  private traded = new Set<string>();
  private pendingBuys = new Map<string, string>(); // client_id -> mint
  private orderSeq = 0;
  private cash = 0n;

  // Exit decision for one open position at the current price. Returns the
  // single sell order for this batch, or null when the position is held.
  // Order of checks matters: partial profit first, then full take-profit,
  // hard stop, trailing stop, and finally the time stop. Exactly one order
  // per position per batch, so a partial fill can never collide with a
  // full exit in the same reply.
  private exitOrder(
    mint: string,
    pos: PositionState,
    price: bigint,
    slot: number,
  ): SellOrder | null {
    if (price > pos.peak) pos.peak = price;
    const mk = (amount: bigint): SellOrder => {
      this.orderSeq += 1;
      return {
        side: "sell",
        client_id: `s${this.orderSeq}`,
        mint,
        token_amount: amount.toString(),
        max_slippage_bps: PARAMS.sellSlippageBps,
      };
    };

    // Partial take-profit at +6% (once per position).
    if (
      !pos.partialDone &&
      price * 100n >=
        (pos.entryPrice * BigInt(10000 + PARAMS.partialBps)) / 100n
    ) {
      const half = pos.tokens / 2n;
      if (half > 0n) {
        pos.partialDone = true;
        return mk(half);
      }
    }
    // Full take-profit at +12%.
    if (
      price * 100n >=
      (pos.entryPrice * BigInt(10000 + PARAMS.takeProfitBps)) / 100n
    ) {
      return mk(pos.tokens);
    }
    // Hard stop at -5%.
    if (
      price * 100n <=
      (pos.entryPrice * BigInt(10000 - PARAMS.stopLossBps)) / 100n
    ) {
      return mk(pos.tokens);
    }
    // Trailing stop: armed past +8% peak, fires 4% off the peak.
    if (
      pos.peak * 100n >=
        (pos.entryPrice * BigInt(10000 + PARAMS.trailArmBps)) / 100n &&
      price * 100n <=
        (pos.peak * BigInt(10000 - PARAMS.trailBps)) / 100n
    ) {
      return mk(pos.tokens);
    }
    // Time stop: flat after the window, win or lose.
    if (slot - pos.entrySlot >= PARAMS.timeStopSlots) {
      return mk(pos.tokens);
    }
    return null;
  }

  onBatch(batch: BatchInput): Order[] {
    const slot = batch.slot;
    const orders: Order[] = [];
    this.cash = big(batch.account.cash_lamports);

    // 1. Apply fills first: a filled buy opens a position (entry price is
    //    the executed quote per token); a filled sell shrinks or closes it.
    for (const fill of batch.fills) {
      if (fill.side === "buy") {
        const mint = this.pendingBuys.get(fill.client_id);
        this.pendingBuys.delete(fill.client_id);
        if (fill.status === "filled" && mint !== undefined) {
          const tokens = big(fill.token_amount);
          const quote = big(fill.quote_lamports);
          if (tokens > 0n && quote > 0n) {
            const entry = priceOf(quote, tokens);
            const prev = this.positions.get(mint);
            if (prev !== undefined) {
              // Top-up of an existing position: keep the earlier entry.
              prev.tokens += tokens;
            } else {
              this.positions.set(mint, {
                entryPrice: entry,
                peak: entry,
                entrySlot: fill.slot,
                partialDone: false,
                tokens,
              });
            }
          }
        }
      }
    }

    // 2. Reconcile positions with the harness account (authoritative).
    //    Adopt any position we missed, drop any that is fully gone, and
    //    refresh token balances after partial sells.
    const live = new Map<string, AccountPosition>();
    for (const p of batch.account.positions) live.set(p.mint, p);
    for (const [mint, pos] of [...this.positions.entries()]) {
      const acc = live.get(mint);
      if (acc === undefined) {
        this.positions.delete(mint);
      } else {
        pos.tokens = big(acc.token_amount);
        if (pos.tokens <= 0n) this.positions.delete(mint);
      }
    }
    for (const [mint, acc] of live.entries()) {
      if (!this.positions.has(mint)) {
        const tokens = big(acc.token_amount);
        const cost = big(acc.cost_lamports);
        if (tokens > 0n && cost > 0n) {
          const entry = priceOf(cost, tokens);
          this.positions.set(mint, {
            entryPrice: entry,
            peak: entry,
            entrySlot: slot,
            partialDone: false,
            tokens,
          });
        }
      }
    }

    // 3. Fold this batch's trade events into per-coin flow state.
    for (const ev of batch.events) {
      if (ev.event !== "TradeEvent") continue;
      const mint = ev.mint;
      const vsol = big(ev.virtual_sol_reserves);
      const vtok = big(ev.virtual_token_reserves);
      const price = priceOf(vsol, vtok);
      if (price <= 0n) continue;
      let coin = this.coins.get(mint);
      if (coin === undefined) {
        coin = {
          firstSlot: slot,
          basePrice: price,
          high: price,
          lastPrice: price,
          lastRealSol: big(ev.real_sol_reserves),
          buySol: 0n,
          sellSol: 0n,
          trades: 0,
        };
        this.coins.set(mint, coin);
      }
      coin.trades += 1;
      coin.lastPrice = price;
      coin.lastRealSol = big(ev.real_sol_reserves);
      if (price > coin.high) coin.high = price;
      const amt = big(ev.sol_amount);
      if (ev.is_buy) coin.buySol += amt;
      else coin.sellSol += amt;
    }

    // 4. Marks are the freshest reserves snapshot: refresh last price and
    //    high (a mark can carry a new high the events in this batch missed).
    for (const mark of batch.marks) {
      const coin = this.coins.get(mark.mint);
      if (coin === undefined) continue;
      const price = priceOf(
        big(mark.virtual_quote_reserves),
        big(mark.virtual_token_reserves),
      );
      if (price <= 0n) continue;
      coin.lastPrice = price;
      if (price > coin.high) coin.high = price;
      coin.lastRealSol = big(mark.real_quote_reserves);
    }

    // 5. Exits first (they free slots and cash). One order per position,
    //    partial first, then full exits; deterministic mint order.
    const openMints = [...this.positions.keys()].sort();
    for (const mint of openMints) {
      if (orders.length >= PARAMS.maxOrdersPerBatch) break;
      const pos = this.positions.get(mint);
      const coin = this.coins.get(mint);
      if (pos === undefined || coin === undefined) continue;
      if (pos.tokens <= 0n) continue;
      const price = coin.lastPrice;
      if (price <= 0n) continue;
      const order = this.exitOrder(mint, pos, price, slot);
      if (order !== null) orders.push(order);
    }

    // 6. Entries: scan coins in deterministic mint order, buy the dip.
    const openCount =
      this.positions.size + this.pendingBuys.size;
    if (openCount < PARAMS.maxOpenPositions) {
      const candidates = [...this.coins.keys()].sort();
      for (const mint of candidates) {
        if (orders.length >= PARAMS.maxOrdersPerBatch) break;
        if (this.positions.size + this.pendingBuys.size >= PARAMS.maxOpenPositions) break;
        if (this.positions.has(mint)) continue;
        if (this.traded.has(mint)) continue;
        const coin = this.coins.get(mint);
        if (coin === undefined) continue;
        if ([...this.pendingBuys.values()].includes(mint)) continue;
        if (coin.trades < PARAMS.minTrades) continue;
        if (slot - coin.firstSlot > PARAMS.maxCoinAgeSlots) continue;
        if (slot - coin.firstSlot < 0) continue;
        const price = coin.lastPrice;
        if (price <= 0n) continue;
        // High cleared base by >= minRiseBps.
        if (coin.high * 10000n < coin.basePrice * BigInt(10000 + PARAMS.minRiseBps)) continue;
        // Price pulled back >= pullbackBps from the high ...
        if (price * 10000n > coin.high * BigInt(10000 - PARAMS.pullbackBps)) continue;
        // ... but still holds >= minHoldAboveBaseBps over the base.
        if (price * 10000n < coin.basePrice * BigInt(10000 + PARAMS.minHoldAboveBaseBps)) continue;
        // Buy flow dominates: buy share >= minBuyShareBps.
        const total = coin.buySol + coin.sellSol;
        if (total <= 0n) continue;
        if (coin.buySol * 10000n < total * BigInt(PARAMS.minBuyShareBps)) continue;
        // Size: small, and capped below the 1%-of-reserve rejection line.
        let size = PARAMS.sizeLamports;
        const reserveCap = (coin.lastRealSol * PARAMS.sizeMaxBpsOfRealReserve) / 10000n;
        if (reserveCap < size) size = reserveCap;
        if (size < PARAMS.minSizeLamports) continue;
        if (size > this.cash) continue;

        this.orderSeq += 1;
        const clientId = `b${this.orderSeq}`;
        this.pendingBuys.set(clientId, mint);
        this.traded.add(mint);
        orders.push({
          side: "buy",
          client_id: clientId,
          mint,
          quote_lamports: size.toString(),
          max_slippage_bps: PARAMS.buySlippageBps,
        });
      }
    }

    // 7. Prune stale coin state so memory stays bounded: coins first seen
    //    long ago can never trigger again (age gate) and hold no position.
    if (this.coins.size > 20000) {
      for (const [mint, coin] of [...this.coins.entries()]) {
        if (
          slot - coin.firstSlot > PARAMS.maxCoinAgeSlots &&
          !this.positions.has(mint)
        ) {
          this.coins.delete(mint);
        }
      }
    }

    return orders;
  }
}
