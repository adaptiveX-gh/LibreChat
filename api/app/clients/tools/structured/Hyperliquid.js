/**
 * hyperliquid.js  —  LangChain Tool
 *
 * v3  ·  2025-05-16
 * ─────────────────────────────────────────────────────────────
 *  modes:
 *   • walletSummary   (default)   – existing whale-analysis
 *   • tickerLookup                – “is SOL tradable?”
 *   • divergenceRadar             – profit-take vs build divergence
 *   • liquidationSniper           – whales fade liquidations
 *   • compressionRadar            – tight range + heavy build
 *   • topMoverPulse               – biggest 5-min net change
 *   • mode:"flowSweep"             → net whale flow for all coins (last N min)
 *   • mode:"microFlowPulse"        → every coin touched in last N min (no size filter)
 *   • mode:"divergenceRadar"       → whales closing ≥ $X while others open ≥ $Y same side
 *   • mode:"compressionRadar"      → tight range ≤ bp + whale build ≥ $X
 *   • mode:"trendBias" → ranked net build over last N minutes (default 15 m) params: { windowMs, minNotional, topN }
 *   • mode:"liquidationSweep"      → list all liquidations in the last N seconds
 *   • mode:"openInterestPulse"     → OI jump ≥ $X + wallets net same side
 *   • mode:"positionDeltaPulse"
 * ─────────────────────────────────────────────────────────────
 */

const axios = require("axios");
const { Tool } = require("@langchain/core/tools");
const { z } = require("zod");

// ─────────────────────────────────────────────────────────────
// 0. ENV & constants
// ─────────────────────────────────────────────────────────────
const API_HL = process.env.HYPERLIQUID_API_URL || "https://api.hyperliquid.xyz";
const API_BAI = "https://api.browse.ai/v2";
const MS_HOUR = 3_600_000;

const ETH_RE = /^0x[0-9a-fA-F]{40}$/;
const big$ = n =>
  (+n).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });

// Browse AI creds
const {
  BROWSEAI_API_KEY: BAI_KEY,
  BROWSEAI_TEAM_ID: BAI_TEAM,
  BROWSEAI_ROBOT_ID: BAI_ROBOT
} = process.env;

// Google Sheet creds
const {
  GOOGLE_SHEET_ID: GS_ID,
  GOOGLE_SHEET_GID: GS_GID = 0
} = process.env;

// insight thresholds
const BIG_NOTIONAL = 50_000; // USD
const DRIP_COUNT = 15;
const DRIP_SIZE = 500;
const MAX_FILLS = 400; // slice fills returned

// ─────────────────────────────────────────────────────────────
// 1. small helpers
// ─────────────────────────────────────────────────────────────
function limiter(max = 4) {
  let active = 0;
  const q = [];
  function next() {
    if (active >= max || !q.length) return;
    const { fn, res, rej } = q.shift();
    active++;
    fn().then(res).catch(rej).finally(() => {
      active--;
      next();
    });
  }
  return fn => new Promise((res, rej) => {
    q.push({ fn, res, rej });
    next();
  });
}
const limit = limiter(6);

// simple in-memory ttl cache
const cached = (fn, ttlMs = 60_000) => {
  let value, expiry = 0;
  return async (...a) => {
    if (Date.now() < expiry) return value;
    value = await fn(...a);
    expiry = Date.now() + ttlMs;
    return value;
  };
};

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// retry wrapper (handles 429 / 5xx briefly)
async function hlPost(body, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await axios.post(
        `${API_HL}/info`,
        body,
        { headers: { "Content-Type": "application/json" }, timeout: 6000 }
      );
    } catch (e) {
      if (i === retries - 1) throw e;
      const shouldBackoff = e.response?.status === 429 || e.code === "ECONNABORTED";
      if (shouldBackoff) await new Promise(r => setTimeout(r, 500 * (i + 1)));
    }
  }
}

// bucket utility
const bucketize = (ts, sizeMs) => Math.floor(ts / sizeMs) * sizeMs;

// ─────────────────────────────────────────────────────────────
// 2. cached meta + extra endpoints
// ─────────────────────────────────────────────────────────────
const getPerpMeta = cached(async () => {
  const { data } = await hlPost({ type: "meta" });
  return data.universe ?? [];
});

const getSpotMeta = cached(async () => {
  const { data } = await hlPost({ type: "spotMeta" });
  return data.universe ?? [];
});

async function fetchLiquidations(startMs, endMs) {
  const start = Math.floor(startMs / 1000);   // seconds, not ms
  const end   = Math.floor(endMs   / 1000);
  try {
    const { data } = await hlPost({ type: "liquidations", startTime: start, endTime: end });
    return data.events ?? [];
  } catch (e) {
    if (e.response?.status === 422) return [];   // treat as “no events”, not an error
    throw e;
  }
}


/**
 * Sum liquidations by coin & side in a time-window
 * Returns: { "<COIN>": { longs: notionalUSD, shorts: notionalUSD } }
 */
async function aggregateLiquidations(start, end) {
  const events = await fetchLiquidations(start, end);
  const out = {};
  for (const ev of events) {
    // ev.side is "long" when long positions are liquidated (forced sells)
    const coin = ev.coin;
    const side = ev.side === "long" ? "longs" : "shorts";
    const notional = Math.abs(+ev.sz) * +ev.px;
    if (!out[coin]) out[coin] = { longs: 0, shorts: 0 };
    out[coin][side] += notional;
  }
  return out;
}

async function fetchOpenInterests() {
  const { data } = await hlPost({ type: "openInterests" });
  return data ?? {};
}

// ─────────────────────────────────────────────────────────────
// 3. existing helpers (browse, sheet, analyseFills, openPositions)
// ─────────────────────────────────────────────────────────────
async function fetchBrowseRows() {
  if (!BAI_KEY || !BAI_TEAM || !BAI_ROBOT) throw new Error("Browse AI creds missing");
  const taskList = await axios.get(
    `${API_BAI}/robots/${BAI_ROBOT}/tasks`,
    { params: { teamId: BAI_TEAM, status: "successful", limit: 1, page: 1 },
      headers: { Authorization: `Bearer ${BAI_KEY}` } }
  );
  if (!taskList.data.tasks?.length) return [];
  const taskId = taskList.data.tasks[0].id;
  const task = await axios.get(
    `${API_BAI}/tasks/${taskId}`,
    { headers: { Authorization: `Bearer ${BAI_KEY}` } }
  );
  const rows = task.data.result?.tables?.[0]?.rows || [];
  return rows.map(r => ({
    addr: (r["Origin URL"] || "").match(ETH_RE)?.[0] || null,
    winrate: Number((r["Winrate"] || "").match(/([\d.]+)/)?.[1] || 0),
    duration: (() => {
      const [h, m] = (r["Duration"] || "").split(/[hm]/).filter(Boolean);
      return (+h || 0) + (+m || 0) / 60;
    })()
  })).filter(r => r.addr);
}

async function fetchSheetRows() {
  if (!GS_ID) throw new Error("GOOGLE_SHEET_ID missing");
  const url = `https://docs.google.com/spreadsheets/d/${GS_ID}/gviz/tq?tqx=out:csv&gid=${GS_GID}`;
  const { data: csv } = await axios.get(url);
  const lines = csv.trim().split(/\r?\n/);
  const headers = lines[0].split(",").map(h => h.trim().toLowerCase());
  return lines.slice(1).map(line => {
    const cols = line.split(",").map(c => c.trim());
    const obj = Object.fromEntries(headers.map((h, i) => [h, cols[i] || ""]));
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

function analyseFills(fills = []) {
  const out = { profitTakes: [], flips: [], newBuilds: [], dripStyle: false };
  if (!fills.length) return out;
  const lastSide = {};
  for (const f of fills) {
    const coin = f.coin.toUpperCase();
    const notional = Math.abs(+f.sz) * +f.px;
    const sideWord = f.dir.includes("Long") ? "long" : "short";
    if (f.dir.startsWith("Close") && notional >= BIG_NOTIONAL) {
      out.profitTakes.push({
        coin, dir: f.dir, size: big$(f.sz), px: big$(f.px),
        pnl: big$(f.closedPnl), ts: f.time
      });
    }
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
    if (f.dir.startsWith("Open") && notional >= BIG_NOTIONAL) {
      out.newBuilds.push({
        coin, dir: f.dir, size: big$(f.sz), px: big$(f.px), ts: f.time
      });
    }
  }
  const tinyCloses = fills.filter(
    f => f.dir.startsWith("Close") && Math.abs(+f.sz) * +f.px <= DRIP_SIZE
  );
  out.dripStyle = tinyCloses.length >= DRIP_COUNT;
  return out;
}

async function fetchOpenPositions(base, addr) {
  try {
    const { data } = await hlPost({ type: "clearinghouseState", user: addr });
    return (data.assetPositions || [])
      .filter(p => +p.position.szi !== 0)
      .map(p => ({
        coin: p.position.coin,
        side: +p.position.szi > 0 ? "long" : "short",
        size: big$(p.position.szi),
        entry: big$(p.position.entryPx),
        upnl: big$(p.position.unrealizedPnl),
        liqPx: big$(p.position.liquidationPx)
      }));
  } catch (e) {
    const msg = e.response ? JSON.stringify(e.response.data) : e.message;
    return { error: msg };
  }
}

// ─────────────────────────────────────────────────────────────
// 4. strategy implementations (simplified but functional)
// ─────────────────────────────────────────────────────────────
async function runTickerLookup({ ticker }) {
  const raw = ticker.toUpperCase().trim();
  const clean = raw.replace(/[-_ ]?(PERP)$/i, "");
  const baseSym = clean.split(/[\/\-_ ]/)[0];

  const [perpMeta, spotMeta] = await Promise.all([getPerpMeta(), getSpotMeta()]);
  const perpCoins = perpMeta.map(u => u.name.toUpperCase());
  const spotPairs = spotMeta.map(u => u.name.toUpperCase());

  const inPerp = perpCoins.includes(baseSym);
  const inSpot = spotPairs.some(
    p => p === clean || p.startsWith(`${baseSym}/`) || p.endsWith(`/${baseSym}`)
  );
  return {
    ticker: raw,
    available: inPerp || inSpot,
    perp: inPerp,
    spot: inSpot,
    spotPairs: inSpot ? spotPairs.filter(p => p.includes(baseSym)).sort() : []
  };
}

// walletSummary is the legacy path (implemented later)

// very-light “topMoverPulse” proof-of-concept
async function runTopMover({ addrList, windowMs = 300_000 }) {
  const end = Date.now();
  const start = end - windowMs;

  const fillsResp = await Promise.all(
    addrList.map(addr =>
      limit(async () => {
        try {
          const { data } = await hlPost({
            type: "userFillsByTime",
            user: addr,
            startTime: start,
            endTime: end,
            aggregateByTime: false
          });
          return { addr, fills: data || [] };
        } catch (e) {
          return { addr, fills: [] };
        }
      })
    )
  );

  /**
   * runFlowSweep  – net whale flow for all coins in the look-back window
   * params:
   *   windowMs       (default 300 000  = 5 min)
   *   minNotional    (default 50 000   = $ threshold to list a coin)
   * returns: [{ coin, net, side, walletCount, topWallets[] }]
   */
  async function runFlowSweep({ addrList }, p = {}) {
    const {
      windowMs    = 300_000,
      minNotional = 50_000
    } = p;

    const end   = Date.now();
    const start = end - windowMs;

    // 1. pull fills
    const fillsResp = await Promise.all(
      addrList.map(addr =>
        limit(async () => {
          try {
            const { data } = await hlPost({
              type: "userFillsByTime",
              user: addr,
              startTime: start,
              endTime:   end,
              aggregateByTime: false
            });
            return { addr, fills: data || [] };
          } catch { return { addr, fills: [] }; }
        })
      )
    );

    // 2. aggregate by coin
    const agg = {};   // coin -> { net, wallets: {} }
    for (const r of fillsResp) {
      for (const f of r.fills) {
        const n    = Math.abs(+f.sz) * +f.px;
        const sign = f.dir.includes("Long")
                      ? (f.dir.startsWith("Close") ? -1 : +1)
                      : (f.dir.startsWith("Close") ? +1 : -1);
        if (!agg[f.coin]) agg[f.coin] = { net: 0, wallets: {} };
        agg[f.coin].net += n * sign;
        agg[f.coin].wallets[r.addr] = (agg[f.coin].wallets[r.addr] || 0) + n * sign;
      }
    }

    // 3. build result list
    return Object.entries(agg)
      .filter(([, v]) => Math.abs(v.net) >= minNotional)
      .map(([coin, v]) => ({
        coin:        `${coin}-PERP`,
        netNotional: big$(Math.abs(v.net)),
        side:        v.net > 0 ? "net long" : "net short",
        walletCount: Object.keys(v.wallets).length,
        topWallets:  Object.entries(v.wallets)
                      .sort((a,b)=>Math.abs(b[1])-Math.abs(a[1]))
                      .slice(0,3)
                      .map(([addr, flow]) => ({ addr, flow: big$(flow) }))
      }))
      .sort((a,b)=>Math.abs(b.net) - Math.abs(a.net));
  }


  async function runLiquidationSweep({ windowMs = 60_000 } = {}) {
    const end   = Date.now();
    const start = end - Math.min(windowMs, 119_000);
    const liqAgg = await aggregateLiquidations(start, end);

    return Object.entries(liqAgg).map(([coin, s]) => ({
      coin: `${coin}-PERP`,
      longLiq: big$(s.longs || 0),
      shortLiq: big$(s.shorts || 0)
    })).sort((a, b) =>
        (Math.max(+b.longLiq.replace(/,/g,''), +b.shortLiq.replace(/,/g,'')) -
        Math.max(+a.longLiq.replace(/,/g,''), +a.shortLiq.replace(/,/g,''))));
  }


  const coinNet = {}; // coin → { side, notional, wallets: Set }
  for (const r of fillsResp) {
    for (const f of r.fills) {
      const n = Math.abs(+f.sz) * +f.px;
      const side = f.dir.includes("Long") ? (f.dir.startsWith("Close") ? -1 : +1)
                                          : (f.dir.startsWith("Close") ? +1 : -1);
      if (!coinNet[f.coin]) coinNet[f.coin] = { net: 0, wallets: {}, side: 0 };
      coinNet[f.coin].net += n * side;
      coinNet[f.coin].wallets[r.addr] = (coinNet[f.coin].wallets[r.addr] || 0) + n * side;
    }
  }

  const sorted = Object.entries(coinNet)
    .sort((a, b) => Math.abs(b[1].net) - Math.abs(a[1].net));
  const [topCoin, info] = sorted[0] || [];
  if (!topCoin) return { note: "no-fills" };

  const topMovers = Object.entries(info.wallets)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, 3)
    .map(([addr, delta]) => ({ addr, delta: big$(delta) }));

  return {
    coin: `${topCoin}-PERP`,
    netDelta: `${big$(Math.abs(info.net))} ${info.net > 0 ? "longs" : "shorts"}`,
    walletCount: Object.keys(info.wallets).length,
    topMovers
  };
}

/**
 * runTrendBias – same-side accumulation table
 * params:
 *   windowMs       default 900_000  (15 min)
 *   minNotional    default 75_000   (abs(net) ≥ this to list)
 *   topN           default 6        (# of rows to return)
 */
async function runTrendBias({ addrList }, p = {}) {
  const {
    windowMs    = 900_000,
    minNotional = 75_000,
    topN        = 6
  } = p;

  const end   = Date.now();
  const start = end - windowMs;

  // 1️⃣ pull fills for every wallet
  const fillsResp = await Promise.all(
    addrList.map(addr =>
      limit(async () => {
        try {
          const { data } = await hlPost({
            type: "userFillsByTime",
            user: addr,
            startTime: start,
            endTime:   end,
            aggregateByTime: false
          });
          return { addr, fills: data || [] };
        } catch { return { addr, fills: [] }; }
      })
    )
  );

  // 2️⃣ aggregate net build by coin
  const agg = {}; // coin → { net, wallets:Set, details:{} }
  for (const r of fillsResp) {
    let perCoin = {};
    for (const f of r.fills) {
      const n = Math.abs(+f.sz) * +f.px;
      const sign = f.dir.includes("Long")
                    ? (f.dir.startsWith("Close") ? -1 : +1)
                    : (f.dir.startsWith("Close") ? +1 : -1);
      perCoin[f.coin] = (perCoin[f.coin] || 0) + n * sign;
    }
    for (const [coin, delta] of Object.entries(perCoin)) {
      if (!agg[coin]) agg[coin] = { net: 0, wallets:new Set(), details:{} };
      agg[coin].net += delta;
      agg[coin].wallets.add(r.addr);
      agg[coin].details[r.addr] = delta;
    }
  }

  // 3️⃣ build sorted list
  const ranked = Object.entries(agg)
    .filter(([,v]) => Math.abs(v.net) >= minNotional)
    .map(([coin,v]) => ({
      coin:         `${coin}-PERP`,
      side:         v.net > 0 ? "long" : "short",
      netNotional:  big$(Math.abs(v.net)),
      walletCount:  v.wallets.size,
      topWallets:   Object.entries(v.details)
                     .sort((a,b)=>Math.abs(b[1])-Math.abs(a[1]))
                     .slice(0,3)
                     .map(([addr,delta])=>({ addr, delta:big$(delta) }))
    }))
    .sort((a,b)=>Math.abs(+b.netNotional.replace(/,/g,'')) -
                 Math.abs(+a.netNotional.replace(/,/g,'')))
    .slice(0, topN);

  return ranked.length ? ranked : { result: "no-trend" };
}


async function runLiquidationSniper({ addrList }, p = {}) {
  // ---------- configurable knobs ----------
  const {
    liqThreshold    = 1_000_000,   // $ total liquidations on one side
    buildThreshold  = 100_000,     // $ min notional per whale to count
    minWallets      = 5,           // whales fading the cascade
    lookbackLiqMs   = 90_000,      // liquidation window
    lookbackBuildMs = 120_000      // whale build window
  } = p;

  const end = Date.now();
  const startLiq  = end - Math.min(lookbackLiqMs, 119_000); // API hard-limit
  const startFill = end - lookbackBuildMs;

  // ---- 1. fetch liquidations in the window ----
  const liqAgg = await aggregateLiquidations(startLiq, end);

  // ---- 2. fetch whale fills in the window ----
  const fillsResp = await Promise.all(
    addrList.map(addr =>
      limit(async () => {
        try {
          const { data } = await hlPost({
            type: "userFillsByTime",
            user: addr,
            startTime: startFill,
            endTime: end,
            aggregateByTime: false
          });
          return { addr, fills: data || [] };
        } catch {
          return { addr, fills: [] };
        }
      })
    )
  );

  // ---- 3. evaluate each coin for the pattern ----
  for (const [coin, liq] of Object.entries(liqAgg)) {
    const cascadeSide = liq.longs >= liqThreshold ? "longs" :
                        liq.shorts >= liqThreshold ? "shorts" : null;
    if (!cascadeSide) continue;                       // no big cascade

    const wantBuildSide = cascadeSide === "longs" ? "long" : "short";

    // aggregate whale builds
    let buildNotional = 0;
    const walletAdds = {};

    for (const r of fillsResp) {
      let net = 0;
      for (const f of r.fills.filter(f => f.coin === coin)) {
        const n = Math.abs(+f.sz) * +f.px;
        const isOpen = f.dir.startsWith("Open");
        const isLong = f.dir.includes("Long");
        const side   = isLong ? "long" : "short";
        // only count *opens* (or adds) on the fading side
        if (isOpen && side === wantBuildSide) net += n;
      }
      if (net >= buildThreshold) {
        walletAdds[r.addr] = net;
        buildNotional += net;
      }
    }

    if (Object.keys(walletAdds).length >= minWallets) {
      // ---- 4. build result object ----
      const topBuilders = Object.entries(walletAdds)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([addr, add]) => ({ addr, add: big$(add) }));

      return {
        coin: `${coin}-PERP`,
        cascadeSide: cascadeSide === "longs" ? "longsLiquidated" : "shortsLiquidated",
        liqNotional: big$((cascadeSide === "longs" ? liq.longs : liq.shorts)),
        whaleBuild:  `${big$(buildNotional)} net ${wantBuildSide}`,
        walletCount: Object.keys(walletAdds).length,
        topBuilders
      };
    }
  }

  return { result: "no-setup" };
}

/**
 * runMicroFlowPulse – lightest-weight activity scan
 * params:
 *   windowMs (default  300_000 = 5 min)
 *   maxCoins (default  15)   // return top-N coins by |netNotional|
 */
async function runMicroFlowPulse({ addrList }, p = {}) {
  const { windowMs = 300_000, maxCoins = 15 } = p;
  const end   = Date.now();
  const start = end - windowMs;

  // 1️⃣ pull fills for every wallet
  const fillsResp = await Promise.all(
    addrList.map(addr =>
      limit(async () => {
        try {
          const { data } = await hlPost({
            type: "userFillsByTime",
            user: addr,
            startTime: start,
            endTime:   end,
            aggregateByTime: false
          });
          return { addr, fills: data || [] };
        } catch { return { addr, fills: [] }; }
      })
    )
  );

  // 2️⃣ aggregate by coin
  const agg = {};   // coin → stats
  for (const r of fillsResp) {
    for (const f of r.fills) {
      const coin = f.coin;
      const n    = Math.abs(+f.sz) * +f.px;
      const longSide  = f.dir.includes("Long");
      const isOpen    = f.dir.startsWith("Open");

      if (!isOpen) continue;                 // count opens only (directional intent)

      if (!agg[coin]) {
        agg[coin] = {
          notionalLong: 0, notionalShort: 0,
          countLong: 0,    countShort: 0,
          wallets: new Set(),
          latestFillTs: 0
        };
      }
      const c = agg[coin];

      if (longSide) {
        c.notionalLong += n;
        c.countLong    += 1;
      } else {
        c.notionalShort += n;
        c.countShort    += 1;
      }
      c.wallets.add(r.addr);
      c.latestFillTs = Math.max(c.latestFillTs, f.time);
    }
  }

  // 3️⃣ build output
  return Object.entries(agg)
    .map(([coin, s]) => ({
      coin: `${coin}-PERP`,
      notionalLong:  big$(s.notionalLong),
      notionalShort: big$(s.notionalShort),
      netNotional:   big$(s.notionalLong - s.notionalShort),
      countLong:     s.countLong,
      countShort:    s.countShort,
      walletsActive: s.wallets.size,
      latestFillTs:  s.latestFillTs
    }))
    .sort((a,b) => Math.abs(+b.netNotional.replace(/,/g,'')) -
                   Math.abs(+a.netNotional.replace(/,/g,'')))
    .slice(0, maxCoins);
}

/**
 * runDivergence – profit-take vs new build on the same side
 * params:
 *   windowMs        default 300 000 (5 min)
 *   closeNotional   $ closed per wallet to count  (default 50 000)
 *   buildNotional   $ opened per wallet to count  (default 50 000)
 *   minClosers      wallets closing ≥ closeNotional (default 2)
 *   minBuilders     wallets opening ≥ buildNotional (default 2)
 */
async function runDivergence({ addrList }, p = {}) {
  const {
    windowMs      = 300_000,
    closeNotional = 50_000,
    buildNotional = 50_000,
    minClosers    = 2,
    minBuilders   = 2
  } = p;

  const end   = Date.now();
  const start = end - windowMs;

  // 1️⃣ pull fills
  const fillsResp = await Promise.all(
    addrList.map(addr =>
      limit(async () => {
        try {
          const { data } = await hlPost({
            type: "userFillsByTime",
            user: addr,
            startTime: start,
            endTime:   end,
            aggregateByTime: false
          });
          return { addr, fills: data || [] };
        } catch { return { addr, fills: [] }; }
      })
    )
  );

  // 2️⃣ aggregate per coin who closed vs opened
  const book = {};   // coin → { closers:{}, builders:{} }
  for (const r of fillsResp) {
    for (const f of r.fills) {
      const coin = f.coin;
      const n    = Math.abs(+f.sz) * +f.px;          // USD
      const isLong = f.dir.includes("Long");
      const side   = isLong ? "long" : "short";
      const bucket = f.dir.startsWith("Close") ? "closers" :
                     f.dir.startsWith("Open")  ? "builders" : null;
      if (!bucket) continue;                         // ignore partials etc.

      if (!book[coin]) book[coin] = { closers:{}, builders:{} };
      book[coin][bucket][r.addr] = (book[coin][bucket][r.addr] || 0) + n;
      book[coin].side = side;                        // same side for both buckets
    }
  }

  // 3️⃣ find first coin meeting thresholds
  for (const [coin, data] of Object.entries(book)) {
    const cAddrs = Object.entries(data.closers)
                    .filter(([,v]) => v >= closeNotional);
    const bAddrs = Object.entries(data.builders)
                    .filter(([,v]) => v >= buildNotional)
                    .filter(([addr]) => !data.closers[addr]); // must be different wallets

    if (cAddrs.length >= minClosers && bAddrs.length >= minBuilders) {
      const totalClose = cAddrs.reduce((s,[,v])=>s+v,0);
      const totalBuild = bAddrs.reduce((s,[,v])=>s+v,0);

      return {
        coin: `${coin}-PERP`,
        side: data.side,                       // long or short
        closers:  {
          walletCount: cAddrs.length,
          notional:    big$(totalClose),
          top: cAddrs.sort((a,b)=>b[1]-a[1]).slice(0,3)
                .map(([addr,v])=>({ addr, closed: big$(v) }))
        },
        builders: {
          walletCount: bAddrs.length,
          notional:    big$(totalBuild),
          top: bAddrs.sort((a,b)=>b[1]-a[1]).slice(0,3)
                .map(([addr,v])=>({ addr, opened: big$(v) }))
        }
      };
    }
  }

  return { result: "no-divergence" };
}

/**
 * runCompressionRadar – tight range + whale build
 * params:
 *   windowMs      default 480_000  (8 min)
 *   rangeBp       default 30       (0.30 % range)
 *   netBuildUsd   default 75_000   (abs(net) ≥ this)
 *   minWallets    default 3
 *   minTicks      default 50  – minimum candle count to accept
 */
async function runCompressionRadar({ addrList }, p = {}) {
  const {
    windowMs    = 480_000,
    rangeBp     = 30,
    netBuildUsd = 75_000,
    minWallets  = 3,
    minTicks    = 50
  } = p;

  const end   = Date.now();
  const start = end - windowMs;

  // 1️⃣ pull 1-second candles (HL supports "1s" since 2025-02)
  const { data: candles } = await hlPost({
    type: "candles",
    coin: "all",                 // special arg: every perp
    resolution: "1s",
    startTime: Math.floor(start/1000),
    endTime:   Math.floor(end  /1000)
  });

  // reshape: coin → [{h,l}]
  const coinStats = {};
  for (const c of candles) {
    if (!coinStats[c.coin]) coinStats[c.coin] = { hi: -1e9, lo: 1e9, ticks: 0 };
    const s = coinStats[c.coin];
    s.hi = Math.max(s.hi, +c.high);
    s.lo = Math.min(s.lo, +c.low);
    s.ticks++;
  }

  // 2️⃣ pull wallet fills in the same window
  const fillsResp = await Promise.all(
    addrList.map(addr =>
      limit(async () => {
        try {
          const { data } = await hlPost({
            type: "userFillsByTime",
            user: addr,
            startTime: start,
            endTime:   end,
            aggregateByTime: false
          });
          return { addr, fills: data || [] };
        } catch { return { addr, fills: [] }; }
      })
    )
  );

  // 3️⃣ aggregate net build per coin
  const flow = {}; // coin → { net, wallets: Set, details:{} }
  for (const r of fillsResp) {
    let perCoin = {};
    for (const f of r.fills) {
      const n = Math.abs(+f.sz) * +f.px;
      const sign = f.dir.includes("Long")
                    ? (f.dir.startsWith("Close") ? -1 : +1)
                    : (f.dir.startsWith("Close") ? +1 : -1);
      perCoin[f.coin] = (perCoin[f.coin] || 0) + n * sign;
    }
    for (const [coin, delta] of Object.entries(perCoin)) {
      if (!flow[coin]) flow[coin] = { net: 0, wallets:new Set(), details:{} };
      flow[coin].net += delta;
      flow[coin].wallets.add(r.addr);
      flow[coin].details[r.addr] = delta;
    }
  }

  // 4️⃣ evaluate coins for compression + build
  for (const [coin, stat] of Object.entries(coinStats)) {
    if (stat.ticks < minTicks) continue;              // too few trades
    const rangePct = 10000 * (stat.hi - stat.lo) / stat.lo; // bps

    if (rangePct > rangeBp) continue;                 // not tight enough
    const f = flow[coin];
    if (!f) continue;

    if (Math.abs(f.net) < netBuildUsd) continue;
    if (f.wallets.size  < minWallets) continue;

    const side = f.net > 0 ? "long" : "short";
    const topBuilders = Object.entries(f.details)
      .sort((a,b)=>Math.abs(b[1])-Math.abs(a[1]))
      .slice(0,5)
      .map(([addr,delta])=>({ addr, delta: big$(delta) }));

    return {
      coin: `${coin}-PERP`,
      windowMinutes: (windowMs/60000).toFixed(1),
      rangeBps: rangePct.toFixed(1),
      netBuild: big$(Math.abs(f.net)),
      side,
      walletCount: f.wallets.size,
      topBuilders
    };
  }

  return { result: "no-compression" };
}

/**
 * runOpenInterestPulse – OI jump + whale confirmation
 * params:
 *   windowMs       default 600_000  (10 min)
 *   deltaUsd       default 250_000  (minimum OI change)
 *   minWallets     default 3        (wallets on same side)
 *   side           "long" | "short" | "both" (default "long")
 */
async function runOpenInterestPulse({ addrList }, p = {}) {
  const {
    windowMs   = 600_000,
    deltaUsd   = 250_000,
    minWallets = 3,
    side       = "long"   // or "short" or "both"
  } = p;

  const end   = Date.now();
  const start = end - windowMs;

  /* ----------------------------------------------------- *
   * 1️⃣  Open-interest Δ
   * Hyperliquid supports type:"openInterestsHistory"
   *    { coin, startOi, endOi }
   * ----------------------------------------------------- */
  const { data: oiHist } = await hlPost({
    type: "openInterestHistory",
    startTime: Math.floor(start / 1000),
    endTime:   Math.floor(end   / 1000)
  });
  if (!Array.isArray(oiHist) || !oiHist.length) return { result: "no-data" };

  // map coin → { Δusd, pct }
  const oiChange = {};
  for (const row of oiHist) {
    const d = +row.endOi.usd - +row.startOi.usd;
    if (Math.abs(d) >= deltaUsd) {
      oiChange[row.coin] = {
        deltaUsd: d,
        pct: (+row.startOi.usd === 0 ? 0 :
              100 * d / +row.startOi.usd)
      };
    }
  }
  if (!Object.keys(oiChange).length) return { result: "no-oi-move" };

  /* ----------------------------------------------------- *
   * 2️⃣  Wallet net flow in same window
   * ----------------------------------------------------- */
  const fillsResp = await Promise.all(
    addrList.map(addr =>
      limit(async () => {
        try {
          const { data } = await hlPost({
            type: "userFillsByTime",
            user: addr,
            startTime: start,
            endTime:   end,
            aggregateByTime: false
          });
          return { addr, fills: data || [] };
        } catch { return { addr, fills: [] }; }
      })
    )
  );

  const flow = {}; // coin → { net, wallets:Set, details:{} }
  for (const r of fillsResp) {
    let perCoin = {};
    for (const f of r.fills) {
      const n = Math.abs(+f.sz) * +f.px;
      const sign = f.dir.includes("Long")
                    ? (f.dir.startsWith("Close") ? -1 : +1)
                    : (f.dir.startsWith("Close") ? +1 : -1);
      perCoin[f.coin] = (perCoin[f.coin] || 0) + n * sign;
    }
    for (const [coin, delta] of Object.entries(perCoin)) {
      if (!flow[coin]) flow[coin] = { net: 0, wallets:new Set(), details:{} };
      flow[coin].net += delta;
      flow[coin].wallets.add(r.addr);
      flow[coin].details[r.addr] = delta;
    }
  }

  /* ----------------------------------------------------- *
   * 3️⃣  Cross-check OI jump + wallet bias
   * ----------------------------------------------------- */
  for (const [coin, change] of Object.entries(oiChange)) {
    const f = flow[coin];
    if (!f) continue;

    const wantedLong  = side === "long"  || side === "both";
    const wantedShort = side === "short" || side === "both";

    const bias = f.net > 0 ? "long" : (f.net < 0 ? "short" : "flat");
    if ((bias === "long"  && !wantedLong)  ||
        (bias === "short" && !wantedShort)) continue;

    if (f.wallets.size < minWallets) continue;

    const topBuilders = Object.entries(f.details)
      .sort((a,b)=>Math.abs(b[1])-Math.abs(a[1]))
      .slice(0,5)
      .map(([addr,delta])=>({ addr, delta: big$(delta) }));

    return {
      coin: `${coin}-PERP`,
      deltaOiUsd: big$(Math.abs(change.deltaUsd)),
      pctChange:  `${change.pct.toFixed(1)}%`,
      side: bias,
      walletCount: f.wallets.size,
      topBuilders
    };
  }

  return { result: "no-setup" };
}

/**
 * runPositionDeltaPulse – detect large position changes by the wallets list
 *
 * params:
 *   windowMs   (default 600 000 ms  = 10 min look-back)
 *   trimUsd    (default 250 000)    – “reduced” threshold
 *   addUsd     (default 250 000)    – “added”   threshold
 *   newUsd     (default 250 000)    – “opened”  threshold
 *   maxHits    (default Infinity)   – stop after N matches (set 0/Infinity for all)
 */
async function runPositionDeltaPulse({ addrList }, p = {}) {
  const {
    windowMs = 600_000,
    trimUsd  = 250_000,
    addUsd   = 250_000,
    newUsd   = 250_000,
    maxHits  = Infinity           // ← new knob
  } = p;

  const end   = Date.now();
  const start = end - windowMs;
  const results = [];

  for (const addr of addrList) {
    /* ── 1️⃣  fetch fills + current positions ───────────────────────── */
    let fills = [], positions = [];
    try {
      const [fillsResp, chResp] = await Promise.all([
        hlPost({
          type: "userFillsByTime",
          user: addr,
          startTime: start,
          endTime:   end,
          aggregateByTime: false
        }),
        hlPost({ type: "clearinghouseState", user: addr })
      ]);
      fills     = fillsResp?.data || [];
      positions = chResp?.data?.assetPositions || [];
    } catch {
      continue;   // skip wallet on network/API hiccup
    }

    /* ── 2️⃣  snapshot of open positions *now* ──────────────────────── */
    const openNow = {}; // coin → { side, sizeUsd, entry, liqPx }
    for (const pos of positions) {
      const sz = +pos.position.szi;
      if (sz === 0) continue;
      openNow[pos.position.coin] = {
        side:    sz > 0 ? "long" : "short",
        sizeUsd: Math.abs(sz) * +pos.position.entryPx,
        entry:   +pos.position.entryPx,
        liqPx:   +pos.position.liquidationPx
      };
    }

    /* ── 3️⃣  USD opened / closed per coin + side in the window ─────── */
    const opened = {}, closed = {};  // coin → { longUsd, shortUsd }
    const bump = (table, coin, field, usd) =>
      (table[coin] = { ...(table[coin] || { longUsd:0, shortUsd:0 }),
                       [field]: (table[coin]?.[field] || 0) + usd });

    for (const f of fills) {
      const usd  = Math.abs(+f.sz) * +f.px;
      const coin = f.coin;
      const fld  = f.dir.includes("Long") ? "longUsd" : "shortUsd";

      if (f.dir.startsWith("Open"))  bump(opened, coin, fld, usd);
      if (f.dir.startsWith("Close")) bump(closed, coin, fld, usd);
    }

    /* ── 4️⃣  evaluate every coin touched ───────────────────────────── */
    const allCoins = new Set([...Object.keys(opened), ...Object.keys(closed)]);
    for (const coin of allCoins) {
      const state   = openNow[coin];          // undefined ⇒ flat now
      const sideNow = state?.side;

      const openLong   = opened[coin]?.longUsd  || 0;
      const openShort  = opened[coin]?.shortUsd || 0;
      const closeLong  = closed[coin]?.longUsd  || 0;
      const closeShort = closed[coin]?.shortUsd || 0;

      const reduced = (sideNow === "long"  && closeLong  >= trimUsd) ||
                      (sideNow === "short" && closeShort >= trimUsd) ||
                      (!state && (closeLong + closeShort) >= trimUsd);

      const added   = state && (
                      (sideNow === "long"  && openLong  >= addUsd) ||
                      (sideNow === "short" && openShort >= addUsd));

      const openedFresh = !state && (openLong + openShort) >= newUsd;

      if (reduced || added || openedFresh) {
        results.push({
          wallet: addr,
          action: reduced ? "reduced" : added ? "added" : "opened",
          coin:   `${coin}-PERP`,
          side:   state ? sideNow
                        : (openLong > 0 ? "long" : "short"),
          sizeUsd: state ? big$(state.sizeUsd) : "0.00",
          avgEntry: state ? big$(state.entry)  : "—",
          liqPx:    state ? big$(state.liqPx)  : "—"
        });
        if (results.length >= maxHits) return results;
      }
    }
  }

  return results.length ? results : { result: "no-setup" };
}



// strategy registry
const strategies = {
  tickerLookup: async (_args, params) => runTickerLookup(params),
  topMoverPulse: async (args, params) => runTopMover({ ...params, ...args }),
  microFlowPulse:   async (a,p)=>runMicroFlowPulse(a,p),
  flowSweep:        async (a, p) => runFlowSweep(a, p),  
  liquidationSweep: async (_a, p) => runLiquidationSweep(p),
  divergenceRadar: async (a,p)=>runDivergence(a,p),
  liquidationSniper: async (a, p) => runLiquidationSniper(a, p),
  compressionRadar: async (a,p)=>runCompressionRadar(a,p),
  trendBias: async (a,p)=>runTrendBias(a,p),
  openInterestPulse: async (a,p)=>runOpenInterestPulse(a,p),
  positionDeltaPulse: async (a,p)=>runPositionDeltaPulse(a,p)

};

// ─────────────────────────────────────────────────────────────
// 5. LangChain Tool
// ─────────────────────────────────────────────────────────────
class HyperliquidAPI extends Tool {
  name = "hyperliquid";
  description = `
Query Hyperliquid blockchain data.

• mode:"tickerLookup"              → { ticker, available, perp, spot, spotPairs[] }
• mode:"walletSummary"  (default)  → [{ address, fills, insights, openPositions? }]
• mode:"topMoverPulse"             → biggest net move last 5m
• mode:"divergenceRadar"           → profit-take vs build (cluster)
• mode:"liquidationSniper"         → whales fade liquidation cascade
• mode:"compressionRadar"          → tight range + accumulation
• mode:"trendBias"                 → same-side build 15 min

Common optional fields:
addresses[], useBrowse, useSheet, minWinrate, minDuration, hours, positions,
ticker (tickerLookup), params{} (mode-specific knobs).`;

  schema = z.object({
    mode: z.enum([
      "walletSummary",
      "tickerLookup",
      "divergenceRadar",
      "liquidationSniper",
      "compressionRadar",
      "topMoverPulse",
      "openInterestPulse",
      "trendBias",
      "positionDeltaPulse"  
    ]).default("walletSummary").optional(),
    params: z.record(z.any()).optional(),

    addresses: z.array(z.string()).optional(),
    useBrowse: z.boolean().optional().default(false),
    useSheet: z.boolean().optional().default(false),
    minWinrate: z.number().optional().default(0),
    minDuration: z.number().optional().default(0),
    hours: z.number().int().min(0).max(168).default(1).optional(),
    minutes: z.number().int().min(1).max(59).optional(),
    positions: z.boolean().optional().default(false),
    

    ticker: z.string().optional() // legacy convenience
  });

  constructor(fields = {}) {
    super();
    this.restBase = fields.HYPERLIQUID_API_URL || API_HL;
  }

  

  /* ────────────────────────────────────────────────────────────
   *  _call – unified entry
   *    • accepts hours ≥ 0  (minutes overrides hours when present)
   *    • silently chunks >20 addresses (HL hard-fails on long arrays)
   *    • pushes addrList through to every strategy in the same shape
   * ──────────────────────────────────────────────────────────── */
  async _call(raw) {
    // ① pull out top-level args, leave the rest in raw for later
    const {
      mode       = "walletSummary",
      params     = {},
      addresses  = [],
      useBrowse  = false,
      useSheet   = false,
      minWinrate = 0,
      minDuration= 0,
      hours      = 1,
      minutes,
      positions  = false,
      ticker
    } = raw;

    /* -------------------------------------------------------- *
     * Build the wallet universe
     * -------------------------------------------------------- */
    let addrList = [...addresses];                     // shallow copy

    if (useBrowse || useSheet || !addrList.length) {
      const rows = useBrowse ? await fetchBrowseRows()
                             : await fetchSheetRows();
      addrList = rows
        .filter(r => r.winrate >= minWinrate && r.duration >= minDuration)
        .map(r => r.addr);
    }

    if (!addrList.length)
      return JSON.stringify({ error: "No wallets to analyse." }, null, 2);

    const bad = addrList.filter(a => !ETH_RE.test(a));
    if (bad.length)
      return `❌ Invalid address(es): ${bad.join(", ")}`;

    /* -------------------------------------------------------- *
     * Decide the time window
     * -------------------------------------------------------- */
    const lookbackMs = typeof minutes === "number"
      ? minutes * 60_000
      : Math.max(0, hours) * MS_HOUR;

    /* -------------------------------------------------------- *
     * Fast-path: any advanced mode except walletSummary
     * -------------------------------------------------------- */
    if (mode !== "walletSummary") {
      const runner = strategies[mode];
      if (!runner) return `❌ unknown mode ${mode}`;

      // Each strategy gets addrList but **internally** they chunk
      // if they call /info userFillsByTime
      const out = await runner({ addrList }, { ...params, ticker, windowMs: lookbackMs });
      return JSON.stringify(out, null, 2);
    }

    /* -------------------------------------------------------- *
     * Legacy walletSummary (uses chunk() helper)
     * -------------------------------------------------------- */
    const now       = Date.now();
    const startTime = now - lookbackMs;

    const batches   = chunk(addrList, 20);             // HL happy size
    const fillsRaw  = [];

    for (const batch of batches) {
      const fillsBatch = await Promise.all(
        batch.map(addr =>
          limit(async () => {
            try {
              const { data } = await hlPost({
                type:       "userFillsByTime",
                user:       addr,
                startTime,
                endTime:    now,
                aggregateByTime: false
              });
              return {
                address:    addr,
                fills:      (data || []).slice(-MAX_FILLS),
                truncated:  (data || []).length > MAX_FILLS
              };
            } catch (e) {
              const msg = e.response ? JSON.stringify(e.response.data) : e.message;
              return { address: addr, error: msg };
            }
          })
        )
      );
      fillsRaw.push(...fillsBatch);
    }

    // attach insights & open positions
    const summary = await Promise.all(
      fillsRaw.map(async r => {
        if (r.error) return r;
        const o = {
          ...r,
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
