// pumpfun-bot-sprint-v2 — main.ts
//
// Wire protocol for agent-fun/replay/v2: newline-delimited JSON on stdin.
// The harness sends one `hello`, then one `batch` per slot, then `done`.
// This bot answers every batch with exactly one `reply` line on stdout
// echoing the batch seq and carrying that batch's orders (possibly none).
// Nothing else is written to stdout; diagnostics, if any, go to stderr.
//
// Determinism: the strategy keeps no clock, no randomness and no file or
// network access, so the same replay always yields the same replies.

import * as readline from "node:readline";
import { DipBuyStrategy, PARAMS } from "./strategy.ts";

const strategy = new DipBuyStrategy();
let maxOpenPositions = PARAMS.maxOpenPositions;
let maxOrdersPerBatch = PARAMS.maxOrdersPerBatch;

const rl = readline.createInterface({
  input: process.stdin,
  terminal: false,
});

rl.on("line", (line: string) => {
  if (line.trim() === "") return;
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg === null || typeof msg !== "object") return;

  if (msg.type === "hello") {
    // Adopt the harness caps when present; fall back to the strategy's own.
    if (msg.caps && typeof msg.caps.max_open_positions === "number") {
      maxOpenPositions = msg.caps.max_open_positions;
    }
    if (msg.caps && typeof msg.caps.max_orders_per_batch === "number") {
      maxOrdersPerBatch = msg.caps.max_orders_per_batch;
    }
    return;
  }

  if (msg.type === "batch") {
    const orders = strategy.onBatch({
      seq: msg.seq,
      slot: msg.slot,
      events: Array.isArray(msg.events) ? msg.events : [],
      marks: Array.isArray(msg.marks) ? msg.marks : [],
      fills: Array.isArray(msg.fills) ? msg.fills : [],
      account: msg.account ?? { cash_lamports: "0", positions: [] },
    });
    // The harness caps orders per batch; exits were ordered first inside
    // the strategy, so a trim here can only drop the lowest-priority buys.
    const capped =
      orders.length > maxOrdersPerBatch
        ? orders.slice(0, maxOrdersPerBatch)
        : orders;
    void maxOpenPositions;
    process.stdout.write(
      JSON.stringify({ type: "reply", seq: msg.seq, orders: capped }) + "\n",
    );
    return;
  }

  if (msg.type === "done") {
    process.exit(0);
  }
});

rl.on("close", () => {
  process.exit(0);
});
