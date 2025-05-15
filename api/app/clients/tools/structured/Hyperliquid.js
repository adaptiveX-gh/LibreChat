/**
 * hyperliquid.js  –  LangChain Tool
 *
 * NEW FEATURES
 *   • If { useBrowse: true } is passed (or no addresses supplied),
 *     the tool calls Browse AI → pulls the latest “Trader Details” table
 *     → extracts wallet addresses → applies optional filters.
 *   • Optional filters: minWinrate %, minDuration h.
 *   • Keeps all previous functionality (profit-takes, flips, drip scalping,
 *     open-position detection, JSON output).
 *
 * USAGE EXAMPLES
 *   // 1️⃣  Provide your own addresses (same as before)
 *   hlTool.call({ addresses: [...], hours: 24, positions: true });
 *
 *   // 2️⃣  Auto-pull from Browse AI and analyse
 *   hlTool.call({
 *     useBrowse: true,
 *     minWinrate: 70,
 *     minDuration: 15,
 *     hours: 24,
 *     positions: true
 *   });
 */

const axios    = require("axios");
const { Tool } = require("@langchain/core/tools");
const { z }    = require("zod");

// ─────────────────────────────────────────────────────────────
// 0.  ENV & Constants
// ─────────────────────────────────────────────────────────────
const API_HL   = process.env.HYPERLIQUID_API_URL || "https://api.hyperliquid.xyz";
const API_BAI  = "https://api.browse.ai/v2";
const MS_HOUR  = 3_600_000;

const ETH_RE   = /^0x[0-9a-fA-F]{40}$/;
const big$     = n =>
  (+n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Browse AI creds
const BAI_KEY   = process.env.BROWSEAI_API_KEY;
const BAI_TEAM  = process.env.BROWSEAI_TEAM_ID;
const BAI_ROBOT = process.env.BROWSEAI_ROBOT_ID;

// thresholds for Hyperliquid insight detection
const BIG_NOTIONAL = 50_000; // usd
const DRIP_COUNT   = 15;
const DRIP_SIZE    = 500;    // usd

// ─────────────────────────────────────────────────────────────
// 1.  Tiny concurrency limiter  (≈ p-limit in 12 lines)
// ─────────────────────────────────────────────────────────────
function limiter(max = 4) {
  let active = 0;
  const q = [];
  function next() {
    if (active >= max || !q.length) return;
    const { fn, res, rej } = q.shift();
    active++;
    fn()
      .then(res)
      .catch(rej)
      .finally(() => {
        active--;
        next();
      });
  }
  return fn => new Promise((res, rej) => {
    q.push({ fn, res, rej });
    next();
  });
}
const limit = limiter(4);

// ─────────────────────────────────────────────────────────────
// 2.  Browse AI helpers
// ─────────────────────────────────────────────────────────────
async function fetchBrowseTable() {
  if (!BAI_KEY || !BAI_TEAM || !BAI_ROBOT) {
    throw new Error("Browse AI creds missing in env");
  }

  // 1️⃣  Get the most-recent successful task for this robot
  const tsRes = await axios.get(
    `${API_BAI}/robots/${BAI_ROBOT}/tasks`,
    {
      params: {
        teamId: BAI_TEAM,
        status: "successful",
        limit: 1,
        page: 1
      },
      headers: { Authorization: `Bearer ${BAI_KEY}` }
    }
  );
  if (!tsRes.data.tasks?.length) return [];

  const taskId = tsRes.data.tasks[0].id;

  // 2️⃣  Pull that task’s output (tables)
  const task = await axios.get(
    `${API_BAI}/tasks/${taskId}`,
    { headers: { Authorization: `Bearer ${BAI_KEY}` } }
  );

  const rows =
    task.data.result?.tables?.[0]?.rows || []; // robot has one table → rows[]

  /* Row sample (based on your screenshot):
     {
       "Origin URL": "https://hyperdash.info/traders/0x863b…",
       "Total PnL":  "$472,797.61",
       "Winrate":    "Winrate: 80%",
       "Duration":   "136h 22m"
     }
  */
  return rows.map(r => ({
    addr: (r["Origin URL"] || "").match(ETH_RE)?.[0] || null,
    winrate: Number((r["Winrate"] || "").match(/([\d.]+)/)?.[1] || 0),
    duration:
      (() => {
        const [h, m] = (r["Duration"] || "").split(/[hm]/).filter(Boolean);
        return (+h || 0) + ((+m || 0) / 60);
      })(),
    row: r
  })).filter(r => r.addr);
}

// ─────────────────────────────────────────────────────────────
// 3.  Hyperliquid insight helpers  (unchanged)
// ─────────────────────────────────────────────────────────────
function analyseFills(fills = []) {
  const out = { profitTakes: [], flips: [], newBuilds: [], dripStyle: false };
  if (!fills.length) return out;

  const lastSide = {}; // coin → "long"/"short"

  for (const f of fills) {
    const coin     = f.coin.toUpperCase();
    const notional = Math.abs(+f.sz) * +f.px;
    const sideWord = f.dir.includes("Long") ? "long" : "short";

    // 1. profit-takes
    if (f.dir.startsWith("Close") && notional >= BIG_NOTIONAL) {
      out.profitTakes.push({
        coin, dir: f.dir, size: big$(f.sz), px: big$(f.px),
        pnl: big$(f.closedPnl), ts: f.time
      });
    }

    // 2. flips
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

    // 3. new builds
    if (f.dir.startsWith("Open") && notional >= BIG_NOTIONAL) {
      out.newBuilds.push({
        coin, dir: f.dir, size: big$(f.sz), px: big$(f.px), ts: f.time
      });
    }
  }

  // 4. drip scalping
  const tinyCloses = fills.filter(
    f => f.dir.startsWith("Close") && Math.abs(+f.sz) * +f.px <= DRIP_SIZE
  );
  out.dripStyle = tinyCloses.length >= DRIP_COUNT;

  return out;
}

async function fetchOpenPositions(restBase, addr) {
  try {
    const { data } = await axios.post(
      `${restBase}/info`,
      { type: "clearinghouseState", user: addr },
      { headers: { "Content-Type": "application/json" } }
    );

    return (data.assetPositions || [])
      .filter(p => +p.position.szi !== 0)
      .map(p => ({
        coin:  p.position.coin,
        side:  +p.position.szi > 0 ? "long" : "short",
        size:  big$(p.position.szi),
        entry: big$(p.position.entryPx),
        upnl:  big$(p.position.unrealizedPnl),
        liqPx: big$(p.position.liquidationPx)
      }));
  } catch (e) {
    const msg = e.response ? JSON.stringify(e.response.data) : e.message;
    return { error: msg };
  }
}

// ─────────────────────────────────────────────────────────────
// 4.  LangChain Tool
// ─────────────────────────────────────────────────────────────
class HyperliquidAPI extends Tool {
  name = "hyperliquid";

  description = `
Analyse Hyperliquid whale activity.

Input options:
• provide "addresses": [...] (array of 0x wallets)   – OR –
• set  "useBrowse": true  to auto-download the latest Trader table
  from your Browse AI robot.

Optional filters when useBrowse=true:
• minWinrate  – percent  (default 0)
• minDuration – hours    (default 0)

Other options (both modes):
• hours       – look-back window for fills   (1 - 168, default 1)
• positions   – boolean. if true, include live open positions

Returns JSON array [{ address, fills, insights, openPositions?, meta? }].`;

  schema = z.object({
    addresses:   z.array(z.string()).optional()
      .describe("Direct list of Ethereum addresses"),
    useBrowse:   z.boolean().optional().default(false)
      .describe("If true, pull list from Browse AI robot"),
    minWinrate:  z.number().optional().default(0)
      .describe("Filter (Browse AI): keep traders with win-rate ≥ this"),
    minDuration: z.number().optional().default(0)
      .describe("Filter (Browse AI): keep traders with avg duration ≥ this"),
    hours:       z.number().int().min(1).max(168).default(1).optional(),
    positions:   z.boolean().optional().default(false)
  });

  constructor(fields = {}) {
    super();
    this.restBase = fields.HYPERLIQUID_API_URL || API_HL;
  }

  /** @param {{
   *   addresses?: string[],
   *   useBrowse?: boolean,
   *   minWinrate?: number,
   *   minDuration?: number,
   *   hours?: number,
   *   positions?: boolean
   * }} args */
  async _call(args) {
    const {
      addresses = [],
      useBrowse = false,
      minWinrate = 0,
      minDuration = 0,
      hours = 1,
      positions = false
    } = args;

    // 0️⃣  If Browse AI mode requested → pull & filter
    let addrList = addresses;
    if (useBrowse || !addrList.length) {
      const rows = await fetchBrowseTable();

      addrList = rows
        .filter(r => r.winrate >= minWinrate && r.duration >= minDuration)
        .map(r => r.addr);

      if (!addrList.length) {
        return JSON.stringify(
          { error: "No traders passed the filter from Browse AI table." },
          null,
          2
        );
      }
    }

    // sanity check
    const bad = addrList.filter(a => !ETH_RE.test(a));
    if (bad.length) return `❌ Invalid address(es): ${bad.join(", ")}`;

    const now       = Date.now();
    const startTime = now - hours * MS_HOUR;

    // 1️⃣  fetch fills concurrently
    const fillResults = await Promise.all(
      addrList.map(addr =>
        limit(async () => {
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
          } catch (e) {
            const msg = e.response ? JSON.stringify(e.response.data) : e.message;
            return { address: addr, error: msg };
          }
        })
      )
    );

    // 2️⃣  analyse + open-positions
    const summary = await Promise.all(
      fillResults.map(async r => {
        if (r.error) return { address: r.address, error: r.error };

        const obj = {
          address:  r.address,
          fills:    r.fills,
          insights: analyseFills(r.fills)
        };

        if (positions) {
          obj.openPositions = await fetchOpenPositions(this.restBase, r.address);
        }
        return obj;
      })
    );

    return JSON.stringify(summary, null, 2);
  }
}

module.exports = HyperliquidAPI;
