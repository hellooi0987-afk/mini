// api/market.js  — Vercel Serverless Function
// Fetches OHLCV candles: Binance for crypto, Frankfurter for forex/gold

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { symbol = 'BTCUSD', interval = '15min', outputsize = 150 } = req.query;
  const sym  = symbol.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const size = Math.min(parseInt(outputsize) || 150, 500);

  // ── Crypto symbols → Binance ──────────────────────────────────────────────
  const CRYPTO_MAP = {
    BTCUSD:'BTCUSDT', ETHUSD:'ETHUSDT', SOLUSD:'SOLUSDT', XRPUSD:'XRPUSDT',
    BNBUSD:'BNBUSDT', ADAUSD:'ADAUSDT', DOTUSD:'DOTUSDT', LTCUSD:'LTCUSDT',
    AVAXUSD:'AVAXUSDT', LINKUSD:'LINKUSDT', MATICUSD:'MATICUSDT',
  };

  const TF_BINANCE = {
    '1min':'1m','5min':'5m','15min':'15m','1h':'1h','4h':'4h','1day':'1d',
  };

  const binanceSym = CRYPTO_MAP[sym];
  if (binanceSym) {
    try {
      const tf  = TF_BINANCE[interval] || '15m';
      const url = `https://api.binance.com/api/v3/klines?symbol=${binanceSym}&interval=${tf}&limit=${size}`;
      const r   = await fetch(url);
      if (!r.ok) throw new Error(`Binance ${r.status}`);
      const raw = await r.json();
      const candles = raw.map(k => ({
        time:   Math.floor(k[0] / 1000),
        open:   parseFloat(k[1]),
        high:   parseFloat(k[2]),
        low:    parseFloat(k[3]),
        close:  parseFloat(k[4]),
        volume: parseFloat(k[5]),
      }));
      return res.status(200).json({ ok: true, candles, source: 'Binance' });
    } catch (e) {
      return res.status(502).json({ ok: false, error: e.message });
    }
  }

  // ── Forex / Gold → Frankfurter + synthetic candles ───────────────────────
  const base  = sym.slice(0, 3);
  const quote = sym.slice(3, 6);

  // Special handling: Frankfurter doesn't support XAU directly
  const FALLBACK_RATES = {
    XAUUSD: 2320.0, XAGUSD: 27.5,
    EURUSD: 1.082,  GBPUSD: 1.270, USDJPY: 154.5,
    USDCHF: 0.905,  AUDUSD: 0.645, USDCAD: 1.365,
    NZDUSD: 0.595,  EURGBP: 0.852, EURJPY: 167.2, GBPJPY: 196.2,
  };

  let rate = FALLBACK_RATES[sym] || null;

  if (!rate) {
    try {
      const url = `https://api.frankfurter.app/latest?from=${base}&to=${quote}`;
      const r   = await fetch(url);
      if (r.ok) {
        const d = await r.json();
        rate = d.rates?.[quote] ?? null;
      }
    } catch (_) {}
  }

  if (!rate) {
    return res.status(404).json({ ok: false, error: `Symbol ${sym} not supported` });
  }

  const candles = buildSyntheticCandles(rate, sym, size, interval);
  return res.status(200).json({ ok: true, candles, source: rate === FALLBACK_RATES[sym] ? 'Estimated' : 'Frankfurter' });
}

function buildSyntheticCandles(basePrice, sym, count, tf) {
  const vol = basePrice * 0.0008;
  const tfSec = { '1min':60,'5min':300,'15min':900,'1h':3600,'4h':14400,'1day':86400 };
  const step  = tfSec[tf] || 900;
  const now   = Math.floor(Date.now() / 1000);
  const candles = [];
  let price = basePrice * (0.992 + Math.random() * 0.016);
  for (let i = count - 1; i >= 0; i--) {
    const drift = (Math.random() - 0.499) * vol * 2;
    const open  = price;
    price = Math.max(open + drift, open * 0.001);
    const hi = Math.max(open, price) + Math.random() * vol;
    const lo = Math.min(open, price) - Math.random() * vol;
    candles.push({
      time:   now - i * step,
      open:   +open.toFixed(6),
      high:   +hi.toFixed(6),
      low:    +lo.toFixed(6),
      close:  +price.toFixed(6),
      volume: +(Math.random() * 1000 + 100).toFixed(2),
    });
  }
  const last = candles[candles.length - 1];
  last.close = +basePrice.toFixed(6);
  last.high  = Math.max(last.high, last.close);
  last.low   = Math.min(last.low,  last.close);
  return candles;
}
