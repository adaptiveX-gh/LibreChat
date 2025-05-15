/**
 * hyperliquid.js
 *
 * LangChain Tool that:
 *   • accepts { addresses: [...], hours?: 1-168 }  
 *   • fetches Hyperliquid fills (userFillsByTime) for each address  
 *   • highlights profit-takes, conviction flips, big position builds, drip scalping
 *   • returns JSON so downstream chains can parse it easily
 *
 * Plug this into LibreChat just like any other Tool:
 *   const HyperliquidTradeAnalyzer = require("./tools/hyperliquidTradeAnalyzer");
 *   const hlTool = new HyperliquidTradeAnalyzer();
 *   agent = new AgentExecutor({ tools: [hlTool, …], llm });
 */

const axios = require("axios");
const { Tool } = require("@langchain/core/tools");
const { z }    = require("zod");

// ─────────────────────────────────────────────────────────────
// 1.  Small built-in concurrency limiter (≈ p-limit in 12 lines)
// ─────────────────────────────────────────────────────────────
function createLimiter(max = 4) {
  let active = 0;
  const queue = [];
  function next() {
    if (active >= max || !queue.length) return;
    const { fn, resolve, reject } = queue.shift();
    active++;
    fn()
      .then(resolve)
      .catch(reject)
      .finally(() => {
        active--;
        next();
      });
  }
  return fn => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    next();
  });
}
const limit = createLimiter(4);     // tweak ↗ if you really need >4 parallel

// ─────────────────────────────────────────────────────────────
// 2.  Helper utilities
// ─────────────────────────────────────────────────────────────
const API_URL      = process.env.HYPERLIQUID_API_URL || "https://api.hyperliquid.xyz";
const MS_PER_HOUR  = 3_600_000;

const ETH_RE = /^0x[0-9a-fA-F]{40}$/;
const big$   = n => (+n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const BIG_NOTIONAL = 50_000;   // “large” trade threshold  (px * size)
const DRIP_COUNT   = 15;       // ≥ this many tiny closes  === “drip strategy”
const DRIP_SIZE    = 500;      // tiny close ≤ $500 notion.

// Analyse a single fills array → summary object
function analyseFills(fills = []) {
  const out = { profitTakes: [], flips: [], newBuilds: [], dripStyle: false };
  if (!fills.length) return out;

  const lastSide = {};  // coin → "long"/"short"

  for (const f of fills) {
    const coin = f.coin.toUpperCase();
    const notional = Math.abs(+f.sz) * +f.px;
    const sideWord = f.dir.includes("Long") ? "long" : "short";

    // 1. major profit-takes
    if (f.dir.startsWith("Close") && notional >= BIG_NOTIONAL) {
      out.profitTakes.push({
        coin, dir: f.dir, size: big$(f.sz), px: big$(f.px),
        pnl: big$(f.closedPnl), ts: f.time
      });
    }

    // 2. conviction flips
    if (f.dir.startsWith("Close")) {
      lastSide[coin] = sideWord;
    } else if (f.dir.startsWith("Open")) {
      if (lastSide[coin] && lastSide[coin] !== sideWord && notional >= BIG_NOTIONAL) {
        out.flips.push({
          coin, from: lastSide[coin], to: sideWord,
          size: big$(f.sz), px: big$(f.px), ts: f.time
        });
      }
      lastSide[coin] = sideWord;
    }

    // 3. new big position builds
    if (f.dir.startsWith("Open") && notional >= BIG_NOTIONAL) {
      out.newBuilds.push({
        coin, dir: f.dir, size: big$(f.sz), px: big$(f.px), ts: f.time
      });
    }
  }

  // 4. drip scalping check
  const tinyCloses = fills.filter(f =>
    f.dir.startsWith("Close") && Math.abs(+f.sz) * +f.px <= DRIP_SIZE
  );
  out.dripStyle = tinyCloses.length >= DRIP_COUNT;

  return out;
}

// ─────────────────────────────────────────────────────────────
// 3.  LangChain Tool
// ─────────────────────────────────────────────────────────────
class HyperliquidAPI extends Tool {
  name = "hyperliquid_trades";
  description = `
Pulls recent Hyperliquid fills for a list of addresses and detects:
• large profit-takes
• conviction flips (close → opposite open)
• large new builds
• drip-scalp behaviour
Returns a JSON array with { address, fills, insights } objects.`;

  schema = z.object({
    addresses: z.array(z.string()).nonempty()
      .describe("Array of Ethereum wallet addresses (0x…)"),
    hours: z.number().int().min(1).max(168).default(1).optional()
      .describe("Look-back window in hours (default 1)"),
  });

  constructor(fields = {}) {
    super();
    this.restBase = fields.HYPERLIQUID_API_URL || API_URL;
  }

  /** @param {{addresses:string[], hours?:number}} args */
  async _call({ addresses, hours = 1 }) {
    const bad = addresses.filter(a => !ETH_RE.test(a));
    if (bad.length) return `❌ Invalid address(es): ${bad.join(", ")}`;

    const now       = Date.now();
    const startTime = now - hours * MS_PER_HOUR;

    // Fetch fills in parallel (limited by our tiny limiter)
    const results = await Promise.all(
      addresses.map(addr => limit(async () => {
        try {
          const { data } = await axios.post(
            `${this.restBase}/info`,
            {
              type: "userFillsByTime",
              user: addr,
              startTime,
              endTime: now,
              aggregateByTime: false
            },
            { headers: { "Content-Type": "application/json" } }
          );
          return { address: addr, fills: data || [] };
        } catch (err) {
          const msg = err.response ? JSON.stringify(err.response.data) : err.message;
          return { address: addr, error: msg };
        }
      }))
    );

    // Analyse each trader’s fills
    const summary = results.map(r => {
      if (r.error) return { address: r.address, error: r.error };
      return { address: r.address, fills: r.fills, insights: analyseFills(r.fills) };
    });

    // Return JSON (easy for further chain parsing)
    return JSON.stringify(summary, null, 2);
  }
}

module.exports = HyperliquidAPI;
