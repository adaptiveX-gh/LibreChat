/**
 * hyperliquid.js  —  LangChain Tool
 *
 * v2  ·  2025-05-16
 * ─────────────────────────────────────────────────────────────
 * ➊ Whale-analysis of trader wallets
 * ➋ Ticker-lookup (“Is SOL tradable, spot or perp?”)
 * ─────────────────────────────────────────────────────────────
 */

const axios  = require("axios");
const { Tool } = require("@langchain/core/tools");
const { z }    = require("zod");

// ─────────────────────────────────────────────────────────────
// 0.  ENV & constants
// ─────────────────────────────────────────────────────────────
const API_HL   = process.env.HYPERLIQUID_API_URL || "https://api.hyperliquid.xyz";
const API_BAI  = "https://api.browse.ai/v2";
const MS_HOUR  = 3_600_000;

const ETH_RE   = /^0x[0-9a-fA-F]{40}$/;
const big$     = n => (+n).toLocaleString("en-US",
                    { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Browse AI creds
const { BROWSEAI_API_KEY:  BAI_KEY,
        BROWSEAI_TEAM_ID:  BAI_TEAM,
        BROWSEAI_ROBOT_ID: BAI_ROBOT } = process.env;

// Google Sheet creds
const { GOOGLE_SHEET_ID:  GS_ID,
        GOOGLE_SHEET_GID: GS_GID = 0 } = process.env;

// thresholds for Hyperliquid insight detection
const BIG_NOTIONAL = 50_000;   // USD
const DRIP_COUNT   = 15;
const DRIP_SIZE    = 500;

// ─────────────────────────────────────────────────────────────
// 1.  Tiny concurrency limiter (≈ p-limit in 12 lines)
// ─────────────────────────────────────────────────────────────
function limiter(max = 4) {
  let active = 0;
  const q = [];
  function next() {
    if (active >= max || !q.length) return;
    const { fn, res, rej } = q.shift();
    active++;
    fn().then(res).catch(rej).finally(() => {
      active--; next();
    });
  }
  return fn => new Promise((res, rej) => { q.push({ fn, res, rej }); next(); });
}
const limit = limiter(4);

// ─────────────────────────────────────────────────────────────
// 2A.  Browse AI helper (unchanged)
// ─────────────────────────────────────────────────────────────
async function fetchBrowseRows() {
  if (!BAI_KEY || !BAI_TEAM || !BAI_ROBOT) {
    throw new Error("Browse AI creds missing in env");
  }

  // most-recent successful task
  const taskList = await axios.get(
    `${API_BAI}/robots/${BAI_ROBOT}/tasks`,
    { params: { teamId: BAI_TEAM, status: "successful", limit: 1, page: 1 },
      headers: { Authorization: `Bearer ${BAI_KEY}` } }
  );
  if (!taskList.data.tasks?.length) return [];

  const taskId = taskList.data.tasks[0].id;
  const task   = await axios.get(
    `${API_BAI}/tasks/${taskId}`,
    { headers: { Authorization: `Bearer ${BAI_KEY}` } }
  );

  const rows = task.data.result?.tables?.[0]?.rows || [];
  return rows.map(r => ({
      addr:    (r["Origin URL"] || "").match(ETH_RE)?.[0] || null,
      winrate: Number((r["Winrate"] || "").match(/([\d.]+)/)?.[1] || 0),
      duration: (() => {
        const [h, m] = (r["Duration"] || "").split(/[hm]/).filter(Boolean);
        return (+h || 0) + (+m || 0) / 60;
      })()
  })).filter(r => r.addr);
}

// ─────────────────────────────────────────────────────────────
// 2B.  Google Sheet helper (no external deps)
// ─────────────────────────────────────────────────────────────
async function fetchSheetRows() {
  if (!GS_ID) throw new Error("GOOGLE_SHEET_ID env var missing");

  const url = `https://docs.google.com/spreadsheets/d/${GS_ID}/gviz/tq?tqx=out:csv&gid=${GS_GID}`;
  const { data: csv } = await axios.get(url);

  const lines   = csv.trim().split(/\r?\n/);
  const headers = lines[0].split(",").map(h => h.trim().toLowerCase());

  return lines.slice(1).map(line => {
    const cols = line.split(",").map(c => c.trim());
    const obj  = Object.fromEntries(headers.map((h, i) => [h, cols[i] || ""]));

    // expected cols: wallet | winrate | duration
    const addr = obj.wallet?.toLowerCase() || "";
    if (!ETH_RE.test(addr)) return null;

    const win = Number((obj.winrate || "").replace("%", ""));
    const dur = (() => {
      const hr = (obj.duration.match(/(\d+)\s*h/i) || [])[1];
      const mn = (obj.duration.match(/(\d+)\s*m/i) || [])[1];
      if (hr || mn) return (+hr || 0) + (+mn || 0) / 60;
      return Number(obj.duration) || 0;
    })();

    return { addr, winrate: win, duration: dur };
  }).filter(Boolean);
}

// ─────────────────────────────────────────────────────────────
// 3.  Hyperliquid insight helpers
// ─────────────────────────────────────────────────────────────
function analyseFills(fills = []) {
  const out = { profitTakes: [], flips: [], newBuilds: [], dripStyle: false };
  if (!fills.length) return out;

  const lastSide = {}; // coin → "long"/"short"

  for (const f of fills) {
    const coin     = f.coin.toUpperCase();
    const notional = Math.abs(+f.sz) * +f.px;
    const sideWord = f.dir.includes("Long") ? "long" : "short";

    // profit takes
    if (f.dir.startsWith("Close") && notional >= BIG_NOTIONAL) {
      out.profitTakes.push({
        coin, dir: f.dir, size: big$(f.sz), px: big$(f.px),
        pnl: big$(f.closedPnl), ts: f.time
      });
    }

    // flips
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

    // new builds
    if (f.dir.startsWith("Open") && notional >= BIG_NOTIONAL) {
      out.newBuilds.push({
        coin, dir: f.dir, size: big$(f.sz), px: big$(f.px), ts: f.time
      });
    }
  }

  // drip scalping
  const tinyCloses = fills.filter(
    f => f.dir.startsWith("Close") && Math.abs(+f.sz) * +f.px <= DRIP_SIZE
  );
  out.dripStyle = tinyCloses.length >= DRIP_COUNT;

  return out;
}

async function fetchOpenPositions(base, addr) {
  try {
    const { data } = await axios.post(
      `${base}/info`,
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
Analyse Hyperliquid whale activity **or** query whether a ticker is tradable.

Source modes (choose one):
• "addresses": [...]  – explicit wallet list
• "useBrowse": true   – pull from Browse AI robot table
• "useSheet":  true   – pull from Google Sheet CSV
• "ticker":    "SOL"  – lookup mode (returns perp/spot availability)

Optional filters (browse / sheet):
• minWinrate – %  (default 0)
• minDuration – h (default 0)

Other options:
• hours     – look-back window for fills (default 1)
• positions – include open positions in the output

Returns either:
• Ticker info → { ticker, available, perp, spot, spotPairs[] }
• Wallet summary → [{ address, fills, insights, openPositions? }]`;

  schema = z.object({
    addresses:   z.array(z.string()).optional(),
    useBrowse:   z.boolean().optional().default(false),
    useSheet:    z.boolean().optional().default(false),
    minWinrate:  z.number().optional().default(0),
    minDuration: z.number().optional().default(0),
    hours:       z.number().int().min(1).max(168).default(1).optional(),
    positions:   z.boolean().optional().default(false),
    ticker:      z.string().optional()
  });

  constructor(fields = {}) {
    super();
    this.restBase = fields.HYPERLIQUID_API_URL || API_HL;
  }

  /** @param {{
   *   addresses?: string[],
   *   useBrowse?: boolean,
   *   useSheet?:  boolean,
   *   minWinrate?: number,
   *   minDuration?: number,
   *   hours?: number,
   *   positions?: boolean,
   *   ticker?: string
   * }} args */
  async _call(args) {
    const {
      addresses = [],
      useBrowse = false,
      useSheet  = false,
      minWinrate = 0,
      minDuration = 0,
      hours = 1,
      positions = false,
      ticker
    } = args;

    // ─────────────── ticker lookup branch ───────────────
    if (ticker) {
      const raw     = ticker.toUpperCase().trim();             // user input
      const clean   = raw.replace(/[-_ ]?(PERP)$/i, "");        // strip -PERP
      const baseSym = clean.split(/[\/\-_ ]/)[0];              // "SOL" in "SOL/USDC"

      // 1. perp list
      const { data: perpMeta } = await axios.post(
        `${this.restBase}/info`,
        { type: "meta" },
        { headers: { "Content-Type": "application/json" } }
      );
      const perpCoins = (perpMeta.universe ?? []).map(u => u.name.toUpperCase());

      // 2. spot list
      const { data: spotMeta } = await axios.post(
        `${this.restBase}/info`,
        { type: "spotMeta" },
        { headers: { "Content-Type": "application/json" } }
      );
      const spotPairs = (spotMeta.universe ?? []).map(u => u.name.toUpperCase());

      // 3. membership tests
      const inPerp = perpCoins.includes(baseSym);
      const inSpot = spotPairs.some(
        p => p === clean ||
             p.startsWith(`${baseSym}/`) ||
             p.endsWith(`/${baseSym}`)
      );
      return JSON.stringify({
        ticker:     raw,
        available:  inPerp || inSpot,
        perp:       inPerp,
        spot:       inSpot,
        spotPairs:  inSpot ? spotPairs
                              .filter(p => p.includes(baseSym))
                              .sort() : []
      }, null, 2);
    }

    // ─────────────── whale-analysis branch ───────────────
    let addrList = addresses;

    if (useBrowse || useSheet || !addrList.length) {
      let rows = [];

      if (useBrowse) rows = await fetchBrowseRows();
      else if (useSheet) rows = await fetchSheetRows();

      addrList = rows
        .filter(r => r.winrate >= minWinrate && r.duration >= minDuration)
        .map(r => r.addr);

      if (!addrList.length) {
        return JSON.stringify({ error: "No traders passed the filter." }, null, 2);
      }
    }

    // sanity check
    const bad = addrList.filter(a => !ETH_RE.test(a));
    if (bad.length) return `❌ Invalid address(es): ${bad.join(", ")}`;

    const now       = Date.now();
    const startTime = now - hours * MS_HOUR;

    // pull fills
    const fills = await Promise.all(
      addrList.map(addr =>
        limit(async () => {
          try {
            const { data } = await axios.post(
              `${this.restBase}/info`,
              { type: "userFillsByTime",
                user: addr, startTime, endTime: now, aggregateByTime: false },
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

    // analyse & optional open positions
    const summary = await Promise.all(
      fills.map(async r => {
        if (r.error) return { address: r.address, error: r.error };

        const o = {
          address:  r.address,
          fills:    r.fills,
          insights: analyseFills(r.fills)
        };

        if (positions) {
          o.openPositions = await fetchOpenPositions(this.restBase, r.address);
        }
        return o;
      })
    );

    return JSON.stringify(summary, null, 2);
  }
}

module.exports = HyperliquidAPI;
