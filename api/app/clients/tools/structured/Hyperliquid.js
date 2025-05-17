// hyperliquid.js  —  LangChain Tool for Whale-Level Alpha Strategies

const axios = require('axios');
const { Tool } = require('@langchain/core/tools');
const { z } = require('zod');
const { logger } = require('~/config');

class HyperliquidAPI extends Tool {
  constructor(fields = {}) {
    super();
    this.name = 'hyperliquid';
    this.description = `
      Provides on-chain “whale” trading signals via Hyperliquid’s public API.
      Available modes:
      • positionDeltaPulse    – Detect large position opens/adds/reductions by wallet
      • openInterestPulse     – Spot coins with OI jumps + wallet flows
      • trendBias             – Rank coins by net build (long vs short)
      • divergenceRadar       – Profit-take vs build divergences
      • compressionRadar      – Tight range + accumulation
      • liquidationSniper     – Fade large liquidations
    `;
    this.schema = z.object({
      mode: z.enum([
        'positionDeltaPulse',
        'openInterestPulse',
        'trendBias',
        'divergenceRadar',
        'compressionRadar',
        'liquidationSniper'
      ]),
      addresses: z.array(z.string()).optional(),
      // window definitions
      minutes: z.number().int().min(1).optional(),
      hours:   z.number().int().min(0).max(168).optional(),
      params:  z.record(z.any()).optional()
    });
    logger.info('✅ HyperliquidAPI tool initialized.');
  }

  // ── Internal helper to POST /info with retries ─────────────────────────
  async hlPost(body, retries = 2) {
    try {
      return (await axios.post('https://api.hyperliquid.xyz/info', body, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 6000
      })).data;
    } catch (err) {
      if (retries > 0) {
        await new Promise(r => setTimeout(r, 500));
        return this.hlPost(body, retries - 1);
      }
      throw err;
    }
  }

  // ── 1. Position Delta Pulse ───────────────────────────────────────────
  async positionDeltaPulse({ addresses = [], minutes = 10, params = {} }) {
    const {
      trimUsd = 250_000,
      addUsd  = 250_000,
      newUsd  = 250_000,
      maxHits = Infinity
    } = params;
    const windowMs = minutes * 60_000;
    const end = Date.now(), start = end - windowMs;
    const results = [];

    for (const wallet of addresses) {
      // fetch fills & positions
      const fills = await this.hlPost({
        type: 'userFillsByTime',
        user: wallet,
        startTime: start,
        endTime: end,
        aggregateByTime: false
      }).then(d => d || []).catch(() => []);
      const state = await this.hlPost({ type: 'clearinghouseState', user: wallet })
        .then(d => d.assetPositions || []).catch(() => []);

      // build current open positions map
      const openNow = {};
      for (const p of state) {
        const sz = +p.position.szi;
        if (sz === 0) continue;
        openNow[p.position.coin] = {
          side: sz > 0 ? 'long' : 'short',
          sizeUsd: Math.abs(sz) * +p.position.entryPx,
          entry: +p.position.entryPx,
          liqPx: +p.position.liquidationPx
        };
      }

      // aggregate opened/closed USD per coin/side
      const opened = {}, closed = {};
      const bump = (tbl, coin, fld, usd) =>
        (tbl[coin] = { ...(tbl[coin]||{longUsd:0,shortUsd:0}), [fld]: (tbl[coin]?.[fld]||0) + usd });

      for (const f of fills) {
        const usd  = Math.abs(+f.sz) * +f.px;
        const coin = f.coin;
        const fld  = f.dir.includes('Long') ? 'longUsd' : 'shortUsd';
        if (f.dir.startsWith('Open'))  bump(opened, coin, fld, usd);
        if (f.dir.startsWith('Close')) bump(closed, coin, fld, usd);
      }

      for (const coin of new Set([...Object.keys(opened), ...Object.keys(closed)])) {
        const stateNow = openNow[coin];
        const sideNow  = stateNow?.side;
        const oL = opened[coin]?.longUsd  || 0;
        const oS = opened[coin]?.shortUsd || 0;
        const cL = closed[coin]?.longUsd  || 0;
        const cS = closed[coin]?.shortUsd || 0;

        const reduced    = (sideNow==='long'  && cL>=trimUsd)
                          ||(sideNow==='short' && cS>=trimUsd)
                          ||(!stateNow && (cL+cS)>=trimUsd);
        const added      = stateNow && ((sideNow==='long'  && oL>=addUsd)
                                     ||(sideNow==='short' && oS>=addUsd));
        const openedFresh= !stateNow && (oL+oS)>=newUsd;

        if (reduced || added || openedFresh) {
          results.push({
            wallet,
            action: reduced ? 'reduced' : added ? 'added' : 'opened',
            coin: `${coin}-PERP`,
            side: stateNow ? sideNow : (oL>oS?'long':'short'),
            sizeUsd: stateNow ? Number(stateNow.sizeUsd.toFixed(2)) : 0,
            avgEntry: stateNow ? Number(stateNow.entry.toFixed(2)) : null,
            liqPx: stateNow ? Number(stateNow.liqPx.toFixed(2)) : null
          });
          if (results.length >= maxHits) return results;
        }
      }
    }
    return results.length ? results : { result: 'no-setup' };
  }

  // ── 2. Open Interest Pulse ────────────────────────────────────────────
  async openInterestPulse({ addresses = [], minutes = 10, params = {} }) {
    const { deltaUsd = 250_000, minWallets = 3, side = 'both' } = params;
    const windowMs = minutes * 60_000;
    const end = Date.now(), start = end - windowMs;

    // 1️⃣ fetch historical OI
    const oiHist = await this.hlPost({
      type: 'openInterestHistory',
      startTime: Math.floor(start/1000),
      endTime:   Math.floor(end/1000)
    }).catch(() => []);
    if (!Array.isArray(oiHist) || !oiHist.length) return { result: 'no-data' };

    const oiChange = {};
    for (const row of oiHist) {
      const d = +row.endOi.usd - +row.startOi.usd;
      if (Math.abs(d) >= deltaUsd) {
        oiChange[row.coin] = { deltaUsd: d, pct: +row.startOi.usd ? 100*d/+row.startOi.usd : 0 };
      }
    }
    if (!Object.keys(oiChange).length) return { result: 'no-oi-move' };

    // 2️⃣ wallet fills in window
    const fillsByWallet = await Promise.all(
      addresses.map(addr =>
        this.hlPost({
          type: 'userFillsByTime',
          user: addr,
          startTime: start,
          endTime: end,
          aggregateByTime: false
        })
        .then(d => ({ addr, fills: d||[] }))
        .catch(() => ({ addr, fills: [] }))
      )
    );

    // 3️⃣ cross-check OI jump + wallet bias
    for (const [coin, change] of Object.entries(oiChange)) {
      // aggregate wallet flow per coin
      let flow = { net: 0, wallets: new Set(), details: {} };
      for (const r of fillsByWallet) {
        let per = 0;
        for (const f of r.fills.filter(f=>f.coin===coin)) {
          const n = Math.abs(+f.sz)*+f.px;
          const sign = f.dir.includes('Long')
            ? (f.dir.startsWith('Close')?-1:+1)
            : (f.dir.startsWith('Close')?+1:-1);
          per += n*sign;
        }
        if (per !== 0) {
          flow.net += per;
          flow.wallets.add(r.addr);
          flow.details[r.addr] = per;
        }
      }
      const bias = flow.net>0?'long':flow.net<0?'short':'flat';
      const wantLong  = side==='long'||side==='both';
      const wantShort = side==='short'||side==='both';
      if ((bias==='long'&&!wantLong)||(bias==='short'&&!wantShort)) continue;
      if (flow.wallets.size < minWallets) continue;

      const top = Object.entries(flow.details)
        .sort((a,b)=>Math.abs(b[1])-Math.abs(a[1]))
        .slice(0,5)
        .map(([addr,v])=>({ addr, deltaUsd: Number(Math.abs(v).toFixed(2)) }));

      return {
        coin: `${coin}-PERP`,
        deltaOiUsd: Number(Math.abs(change.deltaUsd).toFixed(2)),
        pctChange: `${change.pct.toFixed(1)}%`,
        side: bias,
        walletCount: flow.wallets.size,
        topBuilders: top
      };
    }

    return { result: 'no-setup' };
  }

  // ── 3. Trend Bias ───────────────────────────────────────────────────
  async trendBias({ addresses = [], minutes = 15, params = {} }) {
    const { topN = 5, minNotional = 0 } = params;
    const windowMs = minutes * 60_000;
    const end = Date.now(), start = end - windowMs;

    // gather fills
    const fillsByWallet = await Promise.all(
      addresses.map(addr =>
        this.hlPost({
          type: 'userFillsByTime',
          user: addr,
          startTime: start,
          endTime: end,
          aggregateByTime: false
        })
        .then(d => ({ addr, fills: d||[] }))
        .catch(() => ({ addr, fills: [] }))
      )
    );

    // aggregate net build per coin
    const agg = {};
    for (const r of fillsByWallet) {
      const perCoin = {};
      for (const f of r.fills) {
        const n = Math.abs(+f.sz)*+f.px;
        const sign = f.dir.includes('Long')
          ? (f.dir.startsWith('Close')?-1:+1)
          : (f.dir.startsWith('Close')?+1:-1);
        perCoin[f.coin] = (perCoin[f.coin]||0) + n*sign;
      }
      for (const [coin, delta] of Object.entries(perCoin)) {
        if (!agg[coin]) agg[coin] = { net:0, wallets:new Set() };
        agg[coin].net += delta;
        agg[coin].wallets.add(r.addr);
      }
    }

    // build ranking
    let ranked = Object.entries(agg)
      .filter(([,v])=>Math.abs(v.net)>=minNotional)
      .map(([coin,v])=>({
        coin:`${coin}-PERP`,
        netNotional: Number(v.net.toFixed(2)),
        side: v.net>0?'long':'short',
        walletCount: v.wallets.size
      }))
      .sort((a,b)=>Math.abs(b.netNotional)-Math.abs(a.netNotional))
      .slice(0, topN);

    return ranked.length ? ranked : { result: 'no-trend' };
  }

  // ── 4. Divergence Radar ─────────────────────────────────────────────
  async divergenceRadar({ addresses = [], minutes = 5, params = {} }) {
    const {
      closeNotional = 50_000,
      buildNotional = 50_000,
      minClosers = 2,
      minBuilders = 2
    } = params;
    const windowMs = minutes * 60_000;
    const end = Date.now(), start = end - windowMs;

    // fetch all fills once
    const fillsByWallet = await Promise.all(
      addresses.map(addr =>
        this.hlPost({
          type: 'userFillsByTime',
          user: addr,
          startTime: start,
          endTime: end,
          aggregateByTime: false
        })
        .then(d => ({ addr, fills: d||[] }))
        .catch(() => ({ addr, fills: [] }))
      )
    );

    const book = {};
    for (const r of fillsByWallet) {
      for (const f of r.fills) {
        const coin = f.coin;
        const n    = Math.abs(+f.sz)*+f.px;
        const bucket = f.dir.startsWith('Close')?'closers'
                     : f.dir.startsWith('Open')?'builders':null;
        if (!bucket) continue;
        if (!book[coin]) book[coin]={ closers:{}, builders:{}, side: f.dir.includes('Long')?'long':'short' };
        book[coin][bucket][r.addr] = (book[coin][bucket][r.addr]||0)+n;
      }
    }

    for (const [coin,data] of Object.entries(book)) {
      const closers = Object.entries(data.closers).filter(([,v])=>v>=closeNotional);
      const builders= Object.entries(data.builders).filter(([,v])=>v>=buildNotional&&!data.closers[r.addr]);
      if (closers.length>=minClosers && builders.length>=minBuilders) {
        const totalClose = closers.reduce((s,[,v])=>s+v,0);
        const totalBuild = builders.reduce((s,[,v])=>s+v,0);
        return {
          coin:`${coin}-PERP`,
          side: data.side,
          closers:{ walletCount:closers.length, notional:totalClose.toFixed(2), top: closers.slice(0,3).map(([addr,v])=>({addr,closed:v.toFixed(2)})) },
          builders:{ walletCount:builders.length, notional:totalBuild.toFixed(2), top: builders.slice(0,3).map(([addr,v])=>({addr,opened:v.toFixed(2)})) }
        };
      }
    }

    return { result:'no-divergence' };
  }

  // ── 5. Compression Radar ────────────────────────────────────────────
  async compressionRadar({ minutes = 8, params = {} }) {
    const {
      rangeBp = 30,
      netBuildUsd = 75_000,
      minWallets = 3,
      minTicks = 50
    } = params;
    const windowMs = minutes * 60_000;
    const end = Date.now(), start = end - windowMs;

    // 1️⃣ price candles
    const candles = await this.hlPost({
      type: 'candleSnapshot',
      req: { coin:'all', interval:'1s', startTime:Math.floor(start/1000),endTime:Math.floor(end/1000) }
    }).then(d=>d).catch(()=>[]);
    const stats = {};
    for (const c of candles) {
      if (!stats[c.coin]) stats[c.coin]={ hi:-1e9, lo:1e9, ticks:0 };
      const s = stats[c.coin];
      s.hi = Math.max(s.hi,+c.h);
      s.lo = Math.min(s.lo,+c.l);
      s.ticks++;
    }

    // 2️⃣ wallet flows
    const fillsByWallet = await Promise.all(
      (params.addresses||[]).map(addr=>
        this.hlPost({
          type:'userFillsByTime', user:addr,
          startTime:start, endTime:end,
          aggregateByTime:false
        }).then(d=>({addr,fills:d||[]}))
          .catch(()=>({addr,fills:[]}))
      )
    );
    const flow = {};
    for (const r of fillsByWallet) {
      const perCoin = {};
      for (const f of r.fills) {
        const n = Math.abs(+f.sz)*+f.px;
        const sign = f.dir.includes('Long')
          ? (f.dir.startsWith('Close')?-1:+1)
          : (f.dir.startsWith('Close')?+1:-1);
        perCoin[f.coin] = (perCoin[f.coin]||0) + n*sign;
      }
      for (const [coin,delta] of Object.entries(perCoin)) {
        if (!flow[coin]) flow[coin]={ net:0, wallets:new Set(),details:{} };
        flow[coin].net += delta;
        flow[coin].wallets.add(r.addr);
        flow[coin].details[r.addr] = delta;
      }
    }

    // scan coins
    for (const [coin,st] of Object.entries(stats)) {
      if (st.ticks<minTicks) continue;
      const rangePct = 10000*(st.hi-st.lo)/st.lo;
      if (rangePct>rangeBp) continue;
      const f = flow[coin];
      if (!f||Math.abs(f.net)<netBuildUsd||f.wallets.size<minWallets) continue;
      const side = f.net>0?'long':'short';
      const top = Object.entries(f.details).sort((a,b)=>Math.abs(b[1])-Math.abs(a[1])).slice(0,5)
        .map(([addr,v])=>({addr,delta:v.toFixed(2)}));
      return { coin:`${coin}-PERP`, windowMinutes:minutes, rangeBps:rangePct.toFixed(1),
               netBuild:f.net.toFixed(2), side, walletCount:f.wallets.size, topBuilders:top };
    }
    return { result:'no-compression' };
  }

  // ── 6. Liquidation Sniper ───────────────────────────────────────────
  async liquidationSniper({ minutes = 2, params = {} }) {
    const {
      liqThreshold=1_000_000, buildThreshold=100_000, minWallets=5
    } = params;
    const windowMs = minutes*60_000;
    const end = Date.now(), start = end - windowMs;

    // fetch liquidations via OI drop
    const liqAgg = await this.hlPost({
      type:'liquidations',
      startTime:Math.floor(start/1000),
      endTime:Math.floor(end/1000)
    }).then(d=>d.events||[]).catch(()=>[]);
    // sum by coin/side
    const byCoin = {};
    for (const ev of liqAgg) {
      const coin = ev.coin, side=ev.side==='long'?'longs':'shorts';
      const notional = Math.abs(+ev.sz)*+ev.px;
      byCoin[coin] = byCoin[coin]||{longs:0,shorts:0};
      byCoin[coin][side]+=notional;
    }
    for (const [coin,liq] of Object.entries(byCoin)) {
      const cascadeSide = liq.longs>=liqThreshold?'longs':liq.shorts>=liqThreshold?'shorts':null;
      if (!cascadeSide) continue;
      const wantSide = cascadeSide==='longs'?'long':'short';
      // fetch builds
      const builds = {};
      let totalBuild=0;
      for (const addr of (params.addresses||[])) {
        const fills = await this.hlPost({
          type:'userFillsByTime',user:addr,
          startTime:start,endTime:end,aggregateByTime:false
        }).then(d=>d||[]).catch(()=>[]);
        let net=0;
        for (const f of fills.filter(f=>f.coin===coin)) {
          const n=Math.abs(+f.sz)*+f.px;
          if (f.dir.startsWith('Open') && f.dir.includes(wantSide)) net+=n;
        }
        if (net>=buildThreshold) { builds[addr]=net; totalBuild+=net; }
      }
      if (Object.keys(builds).length>=minWallets) {
        const top=Object.entries(builds).sort((a,b)=>b[1]-a[1]).slice(0,5)
                      .map(([addr,v])=>({addr,add:v.toFixed(2)}));
        return {
          coin:`${coin}-PERP`,
          cascadeSide,
          liqNotional:(cascadeSide==='longs'?liq.longs:liq.shorts).toFixed(2),
          whaleBuild: `${totalBuild.toFixed(2)} net ${wantSide}`,
          walletCount:Object.keys(builds).length,
          topBuilders:top
        };
      }
    }
    return { result:'no-setup' };
  }

  // ── Unified entrypoint ─────────────────────────────────────────────
  async _call(raw) {
    const parsed = this.schema.parse(raw);
    const { mode, addresses, minutes, hours, params } = parsed;
    try {
      switch (mode) {
        case 'positionDeltaPulse':
          return await this.positionDeltaPulse({ addresses, minutes, params });
        case 'openInterestPulse':
          return await this.openInterestPulse({ addresses, minutes, params });
        case 'trendBias':
          return await this.trendBias({ addresses, minutes, params });
        case 'divergenceRadar':
          return await this.divergenceRadar({ addresses, minutes, params });
        case 'compressionRadar':
          return await this.compressionRadar({ addresses, minutes, params });
        case 'liquidationSniper':
          return await this.liquidationSniper({ addresses, minutes, params });
        default:
          return `❌ Unknown mode: ${mode}`;
      }
    } catch (err) {
      logger.error(`🔴 HyperliquidAPI error in ${mode}:`, err);
      return `❌ Error running ${mode}: ${err.message}`;
    }
  }
}

module.exports = HyperliquidAPI;
