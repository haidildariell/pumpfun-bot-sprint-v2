[![make.fun](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/haidildariell/pumpfun-bot-sprint-v2/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/haidildariell/pumpfun-bot-sprint-v2/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed

# pumpfun-bot-sprint-v2 — Dip-Buy Scalper

A Solana trading bot for the make.fun "Pump.fun Bot Sprint: Make Bot And Win"
competition. It trades paper money on a replay of pump.fun bonding-curve
events (protocol `agent-fun/replay/v2`) and is ranked on net PnL in lamports.

## Strategy

Momentum-chasing loses on this tape: fills land 2 slots late, at the top of
an explosive move, and the round trip then bleeds through a wide trailing
stop while fees take ~3% + 105,000 lamports. This bot does the opposite:

- **Entry (buy the dip, not the top):** a coin must first prove demand —
  up >= 12% from its first-seen price with buy SOL share >= 70% over at
  least 12 trades, seen within the last 900 slots — and only then, after
  the price pulls back >= 5% from its local high while still holding >= 5%
  above its base. One entry per mint, ever.
- **Size:** 0.05 SOL per buy, capped at 0.8% of the coin's real SOL reserve
  so orders stay under the 1%-of-reserve max-order-size rejection.
- **Exits (fast, no bag-holding):** sell half at +6%, the rest at +12%,
  hard stop at -5%, a 4% trailing stop once the peak clears +8%, and a
  600-slot time stop.
- **Slippage:** 200 bps on buys, 800 bps on sells (executing the exit
  beats haggling while the price dumps).

## Determinism

All prices are bigint ratios of virtual reserves (scaled by 10^12); there
is no clock, no randomness, no network and no file access. Two runs on the
same replay produce identical action logs.

## Files

- `main.ts` — wire protocol: reads `hello` / `batch` / `done` JSONL on
  stdin, answers each batch with one `reply` on stdout.
- `strategy.ts` — the dip-buy scalper: per-coin flow tracking, entries,
  exits, position reconciliation from fills and the harness account.

## Grade locally

```sh
node cli/makefun.mjs grade-local --kit <kit-dir> --bot . --driver process --worktree
```

License: MIT. See `LICENSE`.
