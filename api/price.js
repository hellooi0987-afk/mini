// api/price.js  — Vercel Serverless Function
// Returns live prices + 24h change% for a comma-separated list of symbols

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const raw  = (req.query.symbols || 'BTCUSD').toUpperCase();
  const syms = raw.split(',').map(s => s.trim()).filter(Boolean);

  const CRYPTO_MAP = {
    BTCUSD:'BTCUSDT', ETHUSD:'ETHUSDT', SOLUSD:'SOLUSDT', XRPUSD:'XRPUSDT',
    BNBUSD:'BNBUSDT', ADAUSD:'ADAUSDT', DOTUSD:'DOTUSDT', LTCUSD:'LTCUSDT',
    AVAXUSD:'AVAXUSDT', LINKUSD:'LINKUSDT', MATICUSD:'MATICUSDT',
  };

  const FALLBACK_RATES = {
    XAUUSD: 2320.0, XAGUSD: 27.5,
    EURUSD: 1.082,  GBPUSD: 1.270, USDJPY: 154.5,
    USDCHF: 0.905,  AUDUSD: 0.645, USDCAD: 1.365,
    NZDUSD: 0.595,  EURGBP: 0.852, EURJPY: 167.2, GBPJPY: 196.2,
  };

  const prices = {};

  // ── Crypto batch from Binance ─────────────────────────────────────────────
  const cryptoSyms = syms.filter(s => CRYPTO_MAP[s]);
  if (cryptoSyms.length) {
    try {
      const pairs = cryptoSyms.map(s => CRYPTO_MAP[s]);
      const qs    = encodeURIComponent(JSON.stringify(pairs));
      const r     = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbols=${qs}`);
      if (r.ok) {
        const data = await r.json();
        for (const t of data) {
          const internal = cryptoSyms.find(s => CRYPTO_MAP[s] === t.symbol);
          if (internal) {
            prices[internal] = {
              price:     parseFloat(t.lastPrice),
              changePct: parseFloat(t.priceChangePercent),
            };
          }
        }
      }
    } catch (_) {}
  }

  // ── Forex one-by-one from Frankfurter ────────────────────────────────────
  const forexSyms = syms.filter(s => !CRYPTO_MAP[s]);
  await Promise.allSettled(forexSyms.map(async sym => {
    const base  = sym.slice(0, 3);
    const quote = sym.slice(3, 6);
    try {
      const r = await fetch(`https://api.frankfurter.app/latest?from=${base}&to=${quote}`);
      if (r.ok) {
        const d    = await r.json();
        const rate = d.rates?.[quote];
        if (rate) { prices[sym] = { price: rate, changePct: 0 }; return; }
      }
    } catch (_) {}
    // Fallback
    if (FALLBACK_RATES[sym]) {
      prices[sym] = { price: FALLBACK_RATES[sym], changePct: 0 };
    }
  }));

  return res.status(200).json({ ok: true, prices });
}
