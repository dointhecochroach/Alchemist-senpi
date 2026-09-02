/**
 * Alchemist Brain — Binance Public Data Client (Node.js)
 *
 * Fetches real market data from Binance public endpoints.
 * No API keys required — all endpoints are public.
 *
 * Data sources:
 *   - Futures klines (candlesticks)
 *   - Open Interest (current + history)
 *   - Funding Rate (current + history)
 *   - Top Trader Long/Short Position Ratio
 *   - Global Long/Short Account Ratio
 *   - Taker Buy/Sell Volume Ratio
 *   - 24h Ticker statistics
 */

import { config } from '../config.js';

const log = (...args) => console.log('[BinanceClient]', ...args);
const logErr = (...args) => console.error('[BinanceClient]', ...args);

export class BinanceClient {
  constructor() {
    // Try multiple Binance endpoints — some regions block fapi.binance.com
    this.futuresURLs = [
      config.binanceFuturesURL,
      'https://fapi.binance.com',
      'https://api.binance.me',  // Sometimes works when .com is blocked
    ];
    this.futuresURL = config.binanceFuturesURL;
    this.spotURL = config.binanceSpotURL;
    this._lastRequest = {}; // per-endpoint rate limiting
    this._minInterval = 100; // 100ms between same-endpoint requests
  }

  async _request(url, params = {}) {
    // Build query string
    const qs = new URLSearchParams(params).toString();
    const fullURL = qs ? `${url}?${qs}` : url;

    // Simple per-endpoint rate limiting
    const endpointKey = url.split('/').slice(-2).join('/');
    const now = Date.now();
    if (this._lastRequest[endpointKey]) {
      const elapsed = now - this._lastRequest[endpointKey];
      if (elapsed < this._minInterval) {
        await this._sleep(this._minInterval - elapsed);
      }
    }
    this._lastRequest[endpointKey] = Date.now();

    try {
      const resp = await fetch(fullURL, {
        headers: { 'User-Agent': 'AlchemistBrain/1.0' },
        signal: AbortSignal.timeout(30000),
      });

      if (resp.status === 429) {
        const retryAfter = parseInt(resp.headers.get('Retry-After') || '5', 10);
        logErr(`Rate limited, waiting ${retryAfter}s...`);
        await this._sleep(retryAfter * 1000);
        const retry = await fetch(fullURL, {
          headers: { 'User-Agent': 'AlchemistBrain/1.0' },
          signal: AbortSignal.timeout(30000),
        });
        if (!retry.ok) throw new Error(`HTTP ${retry.status}`);
        return retry.json();
      }

      if (!resp.ok) throw new Error(`HTTP ${resp.status} — ${url}`);
      return resp.json();
    } catch (err) {
      logErr(`Request failed: ${url} — ${err.message}`);
      throw err;
    }
  }

  /**
   * Try a request against multiple Binance endpoint bases.
   * Falls through to next base if one is geo-blocked (HTTP 451).
   */
  async _requestMulti(path, params = {}) {
    let lastErr = null;
    for (const base of this.futuresURLs) {
      // Skip if this base already failed with 451
      if (this._blockedBases?.has(base)) continue;
      try {
        return await this._request(`${base}${path}`, params);
      } catch (err) {
        lastErr = err;
        if (err.message.includes('451')) {
          if (!this._blockedBases) this._blockedBases = new Set();
          this._blockedBases.add(base);
          continue; // Try next base
        }
        throw err; // Non-451 error — don't try other bases
      }
    }
    throw lastErr || new Error('All Binance endpoints blocked');
  }

  _sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // ═══════════════════════════════════════════════════════════
  //  CANDLESTICK DATA
  // ═══════════════════════════════════════════════════════════

  async getKlines(symbol, interval, limit = 200) {
    const raw = await this._requestMulti('/fapi/v1/klines', { symbol, interval, limit });

    return raw.map((k) => ({
      openTime: k[0],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
      closeTime: k[6],
      quoteVolume: parseFloat(k[7]),
      trades: k[8],
      takerBuyVolume: parseFloat(k[9]),
      takerBuyQuote: parseFloat(k[10]),
      // Derived
      range: parseFloat(k[2]) - parseFloat(k[3]),
      body: Math.abs(parseFloat(k[4]) - parseFloat(k[1])),
      isBullish: parseFloat(k[4]) >= parseFloat(k[1]),
    }));
  }

  async getKlinesMulti(symbol, intervals, limit = 200) {
    const result = {};
    for (const tf of intervals) {
      try {
        result[tf] = await this.getKlines(symbol, tf, limit);
      } catch (e) {
        logErr(`Failed klines ${symbol} ${tf}: ${e.message}`);
        result[tf] = [];
      }
    }
    return result;
  }

  // ═══════════════════════════════════════════════════════════
  //  OPEN INTEREST
  // ═══════════════════════════════════════════════════════════

  async getOpenInterest(symbol) {
    const data = await this._requestMulti('/fapi/v1/openInterest', { symbol });
    return {
      symbol,
      openInterest: parseFloat(data.openInterest),
      timestamp: data.time,
    };
  }

  async getOpenInterestHistory(symbol, period = '15m', limit = 30) {
    const raw = await this._requestMulti('/futures/data/openInterestHist', { symbol, period, limit });
    return raw.map((r) => ({
      timestamp: r.timestamp,
      sumOpenInterest: parseFloat(r.sumOpenInterest),
      sumOpenInterestValue: parseFloat(r.sumOpenInterestValue),
    }));
  }

  // ═══════════════════════════════════════════════════════════
  //  FUNDING RATE
  // ═══════════════════════════════════════════════════════════

  async getFundingRate(symbol) {
    const data = await this._requestMulti('/fapi/v1/premiumIndex', { symbol });
    return {
      symbol,
      markPrice: parseFloat(data.markPrice),
      fundingRate: parseFloat(data.lastFundingRate),
      nextFundingTime: data.nextFundingTime,
      timestamp: data.time,
    };
  }

  async getFundingRateHistory(symbol, limit = 30) {
    const raw = await this._requestMulti('/fapi/v1/fundingRate', { symbol, limit });
    return raw.map((r) => ({
      symbol: r.symbol,
      fundingRate: parseFloat(r.fundingRate),
      fundingTime: r.fundingTime,
    }));
  }

  // ═══════════════════════════════════════════════════════════
  //  TOP TRADER LONG/SHORT POSITION RATIO
  // ═══════════════════════════════════════════════════════════

  async getTopTraderLSRatio(symbol, period = '15m', limit = 30) {
    const raw = await this._requestMulti('/futures/data/topLongShortPositionRatio', { symbol, period, limit });
    return raw.map((r) => ({
      timestamp: r.timestamp,
      longShortRatio: parseFloat(r.longShortRatio),
      longAccount: parseFloat(r.longAccount),
      shortAccount: parseFloat(r.shortAccount),
      longPosition: parseFloat(r.longPosition || 0),
      shortPosition: parseFloat(r.shortPosition || 0),
    }));
  }

  async getTopTraderAccountRatio(symbol, period = '15m', limit = 30) {
    const raw = await this._requestMulti('/futures/data/topLongShortAccountRatio', { symbol, period, limit });
    return raw.map((r) => ({
      timestamp: r.timestamp,
      longShortRatio: parseFloat(r.longShortRatio),
      longAccount: parseFloat(r.longAccount),
      shortAccount: parseFloat(r.shortAccount),
    }));
  }

  // ═══════════════════════════════════════════════════════════
  //  GLOBAL LONG/SHORT ACCOUNT RATIO
  // ═══════════════════════════════════════════════════════════

  async getGlobalLSRatio(symbol, period = '15m', limit = 30) {
    const raw = await this._requestMulti('/futures/data/globalLongShortAccountRatio', { symbol, period, limit });
    return raw.map((r) => ({
      timestamp: r.timestamp,
      longShortRatio: parseFloat(r.longShortRatio),
      longAccount: parseFloat(r.longAccount),
      shortAccount: parseFloat(r.shortAccount),
    }));
  }

  // ═══════════════════════════════════════════════════════════
  //  TAKER BUY/SELL VOLUME
  // ═══════════════════════════════════════════════════════════

  async getTakerVolumeRatio(symbol, period = '15m', limit = 30) {
    const raw = await this._requestMulti('/futures/data/takerlongshortRatio', { symbol, period, limit });
    return raw.map((r) => ({
      timestamp: r.timestamp,
      buySellRatio: parseFloat(r.buySellRatio),
      buyVol: parseFloat(r.buyVol),
      sellVol: parseFloat(r.sellVol),
    }));
  }

  // ═══════════════════════════════════════════════════════════
  //  24H TICKER
  // ═══════════════════════════════════════════════════════════

  async getTicker24h(symbol) {
    const data = await this._requestMulti('/fapi/v1/ticker/24hr', { symbol });
    return {
      symbol,
      priceChange: parseFloat(data.priceChange),
      priceChangePct: parseFloat(data.priceChangePercent),
      lastPrice: parseFloat(data.lastPrice),
      high24h: parseFloat(data.highPrice),
      low24h: parseFloat(data.lowPrice),
      volume24h: parseFloat(data.volume),
      quoteVolume24h: parseFloat(data.quoteVolume),
      count: data.count,
    };
  }

  // ═══════════════════════════════════════════════════════════
  //  BATCH — Full market data snapshot for one symbol
  // ═══════════════════════════════════════════════════════════

  async getSymbolSnapshot(symbol, intervals, candleLimit = 200) {
    log(`Fetching snapshot for ${symbol}...`);

    const promises = [
      this.getKlinesMulti(symbol, intervals, candleLimit),
      this.getOpenInterest(symbol),
      this.getOpenInterestHistory(symbol, '15m', 30),
      this.getFundingRate(symbol),
      this.getFundingRateHistory(symbol, 30),
      this.getTopTraderLSRatio(symbol, '15m', 30),
      this.getGlobalLSRatio(symbol, '15m', 30),
      this.getTakerVolumeRatio(symbol, '15m', 30),
      this.getTicker24h(symbol),
    ];

    const keys = [
      'klines', 'openInterest', 'oiHistory', 'funding',
      'fundingHistory', 'topTraderLS', 'globalLS',
      'takerVolume', 'ticker24h',
    ];

    const results = await Promise.allSettled(promises);

    const snapshot = { symbol, timestamp: Date.now() };
    results.forEach((result, i) => {
      const key = keys[i];
      if (result.status === 'fulfilled') {
        snapshot[key] = result.value;
      } else {
        logErr(`Snapshot ${symbol} ${key} failed: ${result.reason?.message}`);
        snapshot[key] = null;
      }
    });

    return snapshot;
  }

  // ═══════════════════════════════════════════════════════════
  //  MULTI-SYMBOL SNAPSHOTS
  // ═══════════════════════════════════════════════════════════

  async getAllSnapshots(symbols, intervals, candleLimit = 200) {
    const snapshots = {};
    // Sequential to avoid hammering Binance with too many concurrent requests
    for (const symbol of symbols) {
      try {
        snapshots[symbol] = await this.getSymbolSnapshot(symbol, intervals, candleLimit);
      } catch (e) {
        logErr(`Failed snapshot for ${symbol}: ${e.message}`);
        snapshots[symbol] = null;
      }
    }
    return snapshots;
  }
}
