// api/market.js — Vercel Serverless Function
// Crypto  → Binance (free, no key)
// Forex   → TwelveData (key) with AlphaVantage fallback (key)
// Gold    → TwelveData XAU/USD
// Cache   → in-memory per symbol+timeframe; only fetches missing/new candles

// ─── IN-MEMORY CACHE ──────────────────────────────────────────────────────────
// Vercel keeps function instances warm between requests.
// Structure: cache[sym][tf] = { candles, lastTime, storedAt }
const cache = {};

function getCache(sym, tf)           { return cache[sym]?.[tf] ?? null; }
function setCache(sym, tf, candles)  {
  if (!cache[sym]) cache[sym] = {};
  cache[sym][tf] = { candles, lastTime: candles[candles.length-1]?.time ?? 0, storedAt: Date.now() };
}

// ─── SYMBOL MAPS ──────────────────────────────────────────────────────────────
const CRYPTO_MAP = {
  BTCUSD:'BTCUSDT', ETHUSD:'ETHUSDT', SOLUSD:'SOLUSDT', XRPUSD:'XRPUSDT',
  BNBUSD:'BNBUSDT', ADAUSD:'ADAUSDT', DOTUSD:'DOTUSDT', LTCUSD:'LTCUSDT',
  AVAXUSD:'AVAXUSDT', LINKUSD:'LINKUSDT', MATICUSD:'MATICUSDT',
};

const TD_INTERVAL = { '1min':'1min','5min':'5min','15min':'15min','1h':'1h','4h':'4h','1day':'1day' };
const TF_SEC      = { '1min':60,'5min':300,'15min':900,'1h':3600,'4h':14400,'1day':86400 };

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function tfSec(tf) { return TF_SEC[tf] || 900; }

function mergeCandles(existing, incoming) {
  const map = new Map();
  for (const c of existing) map.set(c.time, c);
  for (const c of incoming) map.set(c.time, c);
  return Array.from(map.values()).sort((a,b) => a.time - b.time);
}

function cacheStatus(cached, tf, requested) {
  if (!cached) return { needFull: true, missing: 0 };
  const now     = Math.floor(Date.now() / 1000);
  const missing = Math.ceil((now - cached.lastTime) / tfSec(tf));
  if (missing <= 1) return { needFull: false, missing: 0 };
  if (cached.candles.length >= requested && missing < 50) return { needFull: false, missing };
  return { needFull: true, missing };
}

// ─── BINANCE ──────────────────────────────────────────────────────────────────
async function fetchBinance(binSym, tf, limit) {
  const iv = { '1min':'1m','5min':'5m','15min':'15m','1h':'1h','4h':'4h','1day':'1d' };
  const r  = await fetch(`https://api.binance.com/api/v3/klines?symbol=${binSym}&interval=${iv[tf]||'15m'}&limit=${limit}`);
  if (!r.ok) throw new Error(`Binance ${r.status}`);
  return (await r.json()).map(k => ({
    time:k[0]/1000|0, open:+k[1], high:+k[2], low:+k[3], close:+k[4], volume:+k[5]
  }));
}

// ─── TWELVEDATA ───────────────────────────────────────────────────────────────
async function fetchTwelveData(sym, tf, size, key) {
  const tdSym = sym.slice(0,3)+'/'+sym.slice(3,6);
  const url   = `https://api.twelvedata.com/time_series?symbol=${tdSym}&interval=${TD_INTERVAL[tf]||'15min'}&outputsize=${size}&apikey=${key}&format=JSON&order=ASC`;
  const r     = await fetch(url);
  if (!r.ok) throw new Error(`TwelveData HTTP ${r.status}`);
  const d = await r.json();
  if (d.status === 'error') throw new Error(`TwelveData: ${d.message}`);
  if (!d.values?.length)    throw new Error('TwelveData: no values');
  return d.values.map(v => ({
    time:   Math.floor(new Date(v.datetime).getTime()/1000),
    open:   +v.open, high:+v.high, low:+v.low, close:+v.close, volume:+(v.volume||0),
  }));
}

// ─── ALPHAVANTAGE ─────────────────────────────────────────────────────────────
async function fetchAlphaVantage(sym, tf, key) {
  const base  = sym.slice(0,3);
  const quote = sym.slice(3,6);
  const isDaily = tf === '1day';
  const avInterval = { '1min':'1min','5min':'5min','15min':'15min','1h':'60min','4h':'60min' };

  let url;
  if (isDaily) {
    url = `https://www.alphavantage.co/query?function=FX_DAILY&from_symbol=${base}&to_symbol=${quote}&outputsize=full&apikey=${key}`;
  } else {
    url = `https://www.alphavantage.co/query?function=FX_INTRADAY&from_symbol=${base}&to_symbol=${quote}&interval=${avInterval[tf]}&outputsize=full&apikey=${key}`;
  }

  const r = await fetch(url);
  if (!r.ok) throw new Error(`AlphaVantage HTTP ${r.status}`);
  const d = await r.json();

  if (d['Note'] || d['Information']) throw new Error(d['Note'] || d['Information']);
  const tsKey = Object.keys(d).find(k => k.startsWith('Time Series'));
  if (!tsKey) throw new Error('AlphaVantage: no time series key');

  let candles = Object.entries(d[tsKey]).map(([dt,v]) => ({
    time:   Math.floor(new Date(dt).getTime()/1000),
    open:   +v['1. open'], high:+v['2. high'], low:+v['3. low'], close:+v['4. close'], volume:0,
  })).sort((a,b) => a.time - b.time);

  // 4h: downsample from 1h
  if (tf === '4h') {
    const out = [];
    for (let i = 0; i < candles.length; i += 4) {
      const chunk = candles.slice(i, i+4);
      if (!chunk.length) continue;
      out.push({ time:chunk[0].time, open:chunk[0].open,
        high:Math.max(...chunk.map(c=>c.high)), low:Math.min(...chunk.map(c=>c.low)),
        close:chunk[chunk.length-1].close, volume:0 });
    }
    candles = out;
  }
  return candles;
}

// ─── SYNTHETIC FALLBACK ───────────────────────────────────────────────────────
const FALLBACK = {
  XAUUSD:3280, XAGUSD:32.5, EURUSD:1.082, GBPUSD:1.270, USDJPY:154.5,
  USDCHF:0.905, AUDUSD:0.645, USDCAD:1.365, NZDUSD:0.595,
  EURGBP:0.852, EURJPY:167.2, GBPJPY:196.2,
};

function buildSynthetic(base, count, tf) {
  const vol  = base * 0.0008, step = tfSec(tf), now = Date.now()/1000|0;
  const out  = []; let p = base*(0.992+Math.random()*0.016);
  for (let i = count-1; i >= 0; i--) {
    const d = (Math.random()-0.499)*vol*2, op = p;
    p = Math.max(op+d, op*0.001);
    out.push({ time:now-i*step, open:+op.toFixed(6),
      high:+(Math.max(op,p)+Math.random()*vol).toFixed(6),
      low: +(Math.min(op,p)-Math.random()*vol).toFixed(6),
      close:+p.toFixed(6), volume:+(Math.random()*500+50).toFixed(2) });
  }
  const last = out[out.length-1];
  last.close = +base.toFixed(6); last.high = Math.max(last.high,last.close); last.low = Math.min(last.low,last.close);
  return out;
}

// ─── HANDLER ──────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const sym     = (req.query.symbol||'BTCUSD').toUpperCase().replace(/[^A-Z0-9]/g,'');
  const tf      = req.query.interval || '15min';
  const reqSize = Math.min(parseInt(req.query.outputsize)||150, 500);
  const TD_KEY  = process.env.TWELVEDATA_API_KEY;
  const AV_KEY  = process.env.ALPHAVANTAGE_API_KEY;

  // ── CRYPTO ────────────────────────────────────────────────────────────────
  const binSym = CRYPTO_MAP[sym];
  if (binSym) {
    const cached = getCache(sym, tf);
    const status = cacheStatus(cached, tf, reqSize);
    try {
      let candles;
      if (status.needFull) {
        candles = await fetchBinance(binSym, tf, reqSize);
      } else if (status.missing > 0) {
        const fresh = await fetchBinance(binSym, tf, status.missing + 2);
        candles = mergeCandles(cached.candles, fresh).slice(-reqSize);
      } else {
        candles = cached.candles.slice(-reqSize);
      }
      setCache(sym, tf, candles);
      return res.status(200).json({ ok:true, candles, source:'Binance', cached:!status.needFull });
    } catch(e) {
      if (cached) return res.status(200).json({ ok:true, candles:cached.candles.slice(-reqSize), source:'Binance (cached)', cached:true });
      return res.status(502).json({ ok:false, error:e.message });
    }
  }

  // ── FOREX / GOLD ──────────────────────────────────────────────────────────
  const cached = getCache(sym, tf);
  const status = cacheStatus(cached, tf, reqSize);

  // Fully fresh — return cache immediately, zero API calls
  if (!status.needFull && status.missing === 0 && cached) {
    return res.status(200).json({ ok:true, candles:cached.candles.slice(-reqSize), source:'Cached', cached:true });
  }

  const fetchSize = status.needFull ? reqSize : Math.min(status.missing + 5, 50);
  let candles = null, source = 'Fallback';

  // 1. TwelveData
  if (TD_KEY) {
    try {
      const fresh = await fetchTwelveData(sym, tf, fetchSize, TD_KEY);
      candles = (cached && !status.needFull) ? mergeCandles(cached.candles, fresh).slice(-reqSize) : fresh;
      source  = 'TwelveData';
    } catch(e) { console.error('TwelveData:', e.message); }
  }

  // 2. AlphaVantage fallback
  if (!candles && AV_KEY) {
    try {
      const fresh = await fetchAlphaVantage(sym, tf, AV_KEY);
      candles = fresh.slice(-reqSize);
      source  = 'AlphaVantage';
    } catch(e) { console.error('AlphaVantage:', e.message); }
  }

  // 3. Serve stale cache if APIs failed
  if (!candles && cached) {
    candles = cached.candles.slice(-reqSize);
    source  = 'Cached (offline)';
  }

  // 4. Synthetic last resort
  if (!candles) {
    const base = FALLBACK[sym];
    if (!base) return res.status(404).json({ ok:false, error:`Symbol ${sym} not supported` });
    candles = buildSynthetic(base, reqSize, tf);
    source  = 'Estimated';
  }

  if (source !== 'Estimated' && source !== 'Cached (offline)') setCache(sym, tf, candles);

  return res.status(200).json({ ok:true, candles, source, cached: source==='Cached' });
}
