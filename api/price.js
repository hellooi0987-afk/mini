// api/price.js — Vercel Serverless Function
// Live prices + 24h change for the watchlist bar
// Crypto → Binance, Forex/Gold → TwelveData, then AlphaVantage, then cache

const priceCache = {}; // sym → { price, changePct, time }

const CRYPTO_MAP = {
  BTCUSD:'BTCUSDT', ETHUSD:'ETHUSDT', SOLUSD:'SOLUSDT', XRPUSD:'XRPUSDT',
  BNBUSD:'BNBUSDT', ADAUSD:'ADAUSDT', DOTUSD:'DOTUSDT', LTCUSD:'LTCUSDT',
  AVAXUSD:'AVAXUSDT', LINKUSD:'LINKUSDT', MATICUSD:'MATICUSDT',
};

const FALLBACK = {
  XAUUSD:3280, XAGUSD:32.5, EURUSD:1.082, GBPUSD:1.270, USDJPY:154.5,
  USDCHF:0.905, AUDUSD:0.645, USDCAD:1.365, NZDUSD:0.595,
  EURGBP:0.852, EURJPY:167.2, GBPJPY:196.2,
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const raw     = (req.query.symbols || 'BTCUSD').toUpperCase();
  const syms    = raw.split(',').map(s => s.trim()).filter(Boolean);
  const TD_KEY  = process.env.TWELVEDATA_API_KEY;
  const AV_KEY  = process.env.ALPHAVANTAGE_API_KEY;
  const prices  = {};

  // ── CRYPTO via Binance (batch) ──────────────────────────────────────────
  const cryptoSyms = syms.filter(s => CRYPTO_MAP[s]);
  if (cryptoSyms.length) {
    try {
      const pairs = JSON.stringify(cryptoSyms.map(s => CRYPTO_MAP[s]));
      const r = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbols=${encodeURIComponent(pairs)}`);
      if (r.ok) {
        const data = await r.json();
        for (const t of data) {
          const sym = cryptoSyms.find(s => CRYPTO_MAP[s] === t.symbol);
          if (sym) {
            const entry = { price: parseFloat(t.lastPrice), changePct: parseFloat(t.priceChangePercent) };
            prices[sym]      = entry;
            priceCache[sym]  = { ...entry, time: Date.now() };
          }
        }
      }
    } catch(_) {
      // use cache
      for (const sym of cryptoSyms) {
        if (priceCache[sym]) prices[sym] = priceCache[sym];
      }
    }
  }

  // ── FOREX / GOLD ────────────────────────────────────────────────────────
  const forexSyms = syms.filter(s => !CRYPTO_MAP[s]);

  await Promise.allSettled(forexSyms.map(async sym => {
    // Return cache if fresher than 60s
    if (priceCache[sym] && Date.now() - priceCache[sym].time < 60000) {
      prices[sym] = priceCache[sym]; return;
    }

    const base = sym.slice(0,3), quote = sym.slice(3,6);

    // 1. TwelveData price
    if (TD_KEY) {
      try {
        const tdSym = base+'/'+quote;
        const r = await fetch(`https://api.twelvedata.com/price?symbol=${tdSym}&apikey=${TD_KEY}`);
        if (r.ok) {
          const d = await r.json();
          if (d.price) {
            const entry = { price: parseFloat(d.price), changePct: 0 };
            prices[sym] = entry; priceCache[sym] = { ...entry, time: Date.now() };
            return;
          }
        }
      } catch(_) {}
    }

    // 2. AlphaVantage exchange rate
    if (AV_KEY) {
      try {
        const r = await fetch(`https://www.alphavantage.co/query?function=CURRENCY_EXCHANGE_RATE&from_currency=${base}&to_currency=${quote}&apikey=${AV_KEY}`);
        if (r.ok) {
          const d = await r.json();
          const rate = d['Realtime Currency Exchange Rate']?.['5. Exchange Rate'];
          if (rate) {
            const entry = { price: parseFloat(rate), changePct: 0 };
            prices[sym] = entry; priceCache[sym] = { ...entry, time: Date.now() };
            return;
          }
        }
      } catch(_) {}
    }

    // 3. Stale cache
    if (priceCache[sym]) { prices[sym] = priceCache[sym]; return; }

    // 4. Fallback
    if (FALLBACK[sym]) prices[sym] = { price: FALLBACK[sym], changePct: 0 };
  }));

  return res.status(200).json({ ok:true, prices });
}
