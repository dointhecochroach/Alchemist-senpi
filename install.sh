#!/bin/bash
# Paste in Termux to install Alchemist Brain
set -e
mkdir -p Alchemist_Senpi/src/{data,smc,smart_money,brain,execution,display,technical,storage}
cd Alchemist_Senpi

echo 'package.json'
mkdir -p \.
cat > 'package.json' << '__FILE_EOF__'
{
  "name": "alchemist-senpi",
  "version": "1.0.0",
  "description": "Alchemist Brain — Crypto futures trading bot with SMC + Smart Money thesis engine",
  "main": "src/main.js",
  "type": "module",
  "scripts": {
    "start": "node src/main.js",
    "start:debug": "node src/main.js --debug",
    "test": "node src/test.js"
  },
  "engines": {
    "node": ">=18.0.0"
  },
  "dependencies": {},
  "keywords": ["trading", "bot", "smc", "smart-money", "binance", "futures"],
  "license": "MIT"
}

__FILE_EOF__

echo 'src/config.js'
mkdir -p \.
cat > 'src/config.js' << '__FILE_EOF__'
/**
 * Alchemist Brain — Configuration
 * All tunable parameters in one place.
 */

export const config = {
  // ── Symbols to scan ──────────────────────────────────────
  symbols: [
    'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT',
  ],

  // ── Timeframes ───────────────────────────────────────────
  primaryTF: '15m',       // Main trading timeframe
  structureTF: '1h',      // Higher TF for structure
  trendTF: '4h',          // Macro trend TF
  timeframes: ['15m', '1h', '4h'],

  // ── Candle limits ────────────────────────────────────────
  candleLimit: 200,

  // ── Scanning ─────────────────────────────────────────────
  scanIntervalSec: 60,       // Re-scan every N seconds
  maxLiveOpportunities: 5,   // Max opportunities in scorecard

  // ── Risk Management ──────────────────────────────────────
  initialStoplossPct: 3.0,       // 3% initial SL
  tp1Pct: 3.0,                   // TP1 at 3%
  tp1SellPct: 30,                // Sell 30% at TP1
  breakevenAfterTP1: true,       // Move SL to breakeven after TP1
  trailingEnabled: true,         // Adaptive trailing on runner
  trailingStartPct: 2.0,         // Start trailing after +2% from TP1
  trailingStepPct: 0.5,          // Trail by 0.5% steps
  maxTrailingDistancePct: 3.0,   // Max distance price can move against

  // ── Position Sizing ──────────────────────────────────────
  riskPerTradePct: 1.0,     // Risk 1% of paper balance per trade
  paperBalance: 10000.0,    // Starting paper balance

  // ── Brain Thresholds ────────────────────────────────────
  minBrainScore: 60.0,      // Minimum score to consider entry
  minConfidence: 65.0,      // Minimum confidence to enter
  maxConflict: 40.0,        // Max conflict score to enter

  // ── Binance API (public, no keys needed) ────────────────
  binanceFuturesURL: 'https://fapi.binance.com',
  binanceSpotURL: 'https://api.binance.com',

  // ── Data refresh intervals (ms) ──────────────────────────
  oiRefreshMs: 60_000,
  fundingRefreshMs: 120_000,
  lsRatioRefreshMs: 300_000,

  // ── Storage ──────────────────────────────────────────────
  dbPath: 'storage/alchemist.json',  // JSON-based for Termux compatibility
  tradesPath: 'storage/trades.json',
  memoryPath: 'storage/memory.json',

  // ── Display ──────────────────────────────────────────────
  scorecardRefreshMs: 5000,
  ansiColors: true,

  // ── Auto-Execution ──────────────────────────────────────
  autoBuy: true,             // Automatically execute trades when Brain says ENTER
  autoSell: true,            // Automatically close when thesis invalidates
  maxConcurrentPositions: 5, // Max simultaneous open positions

  // ── Mode ─────────────────────────────────────────────────
  paperTrade: true,  // Start in paper mode
  debug: false,
  logLevel: 'INFO',
};

__FILE_EOF__

echo 'src/data/binanceClient.js'
mkdir -p \.
cat > 'src/data/binanceClient.js' << '__FILE_EOF__'
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

__FILE_EOF__

echo 'src/data/mockData.js'
mkdir -p \.
cat > 'src/data/mockData.js' << '__FILE_EOF__'
/**
 * Alchemist Brain — Mock Data Generator
 *
 * Generates realistic-looking candlestick and derivatives data
 * so the bot can be tested without Binance API access.
 *
 * Produces structured price action with:
 *   - Trends (bull/bear phases)
 *   - Swing highs/lows for SMC detection
 *   - Liquidity pools
 *   - FVGs (gaps from displacement candles)
 *   - Realistic OI/funding/L-S ratios
 */

export class MockDataGenerator {
  constructor() {
    this._state = {}; // Per-symbol state
  }

  _getState(symbol) {
    if (!this._state[symbol]) {
      this._state[symbol] = {
        basePrice: this._getBasePrice(symbol),
        trend: Math.random() > 0.5 ? 'BULLISH' : 'BEARISH',
        trendLength: 20 + Math.floor(Math.random() * 30),
        candlesInTrend: 0,
        volatility: 0.005 + Math.random() * 0.01,
        lastClose: null,
      };
    }
    return this._state[symbol];
  }

  _getBasePrice(symbol) {
    const bases = {
      BTCUSDT: 95000, ETHUSDT: 3400, SOLUSDT: 180,
      BNBUSDT: 650, XRPUSDT: 2.1,
    };
    return bases[symbol] || 100;
  }

  /**
   * Generate realistic candlestick data.
   */
  generateKlines(symbol, interval, limit = 200) {
    const state = this._getState(symbol);
    const candles = [];
    const intervalMs = this._intervalToMs(interval);

    // Start from the base or continue from last
    let price = state.lastClose || state.basePrice;
    const now = Date.now();
    const startTime = now - limit * intervalMs;

    for (let i = 0; i < limit; i++) {
      // Occasionally switch trend
      if (state.candlesInTrend >= state.trendLength) {
        state.trend = Math.random() > 0.5 ? 'BULLISH' : 'BEARISH';
        state.trendLength = 20 + Math.floor(Math.random() * 30);
        state.candlesInTrend = 0;
      }
      state.candlesInTrend++;

      // Generate OHLC
      const trendBias = state.trend === 'BULLISH' ? 0.0008 : -0.0008;
      const noise = (Math.random() - 0.5) * state.volatility;
      const change = trendBias + noise;

      const open = price;
      const close = price * (1 + change);

      // Sometimes create displacement candles (larger moves)
      const isDisplacement = Math.random() < 0.05;
      const displacementSize = isDisplacement ? state.volatility * 3 : 0;
      const dispDir = state.trend === 'BULLISH' ? 1 : -1;
      const adjustedClose = isDisplacement ? open * (1 + change + displacementSize * dispDir) : close;

      // Wicks
      const wickSize = state.volatility * price * (0.5 + Math.random());
      const bodyHigh = Math.max(open, adjustedClose);
      const bodyLow = Math.min(open, adjustedClose);
      const high = bodyHigh + wickSize * Math.random();
      const low = bodyLow - wickSize * Math.random();

      // Occasionally create sweep candles (wick beyond recent levels then close back)
      const isSweep = Math.random() < 0.03;
      const sweepWick = wickSize * 3;
      const finalHigh = isSweep ? high + sweepWick : high;
      const finalLow = isSweep ? low - sweepWick : low;

      const volume = (100 + Math.random() * 500) * (isDisplacement ? 3 : 1);
      const takerBuyRatio = 0.4 + Math.random() * 0.2 + (adjustedClose > open ? 0.05 : -0.05);

      candles.push({
        openTime: startTime + i * intervalMs,
        open: parseFloat(open.toFixed(6)),
        high: parseFloat(finalHigh.toFixed(6)),
        low: parseFloat(finalLow.toFixed(6)),
        close: parseFloat(adjustedClose.toFixed(6)),
        volume: parseFloat(volume.toFixed(2)),
        closeTime: startTime + i * intervalMs + intervalMs - 1,
        quoteVolume: parseFloat((volume * price).toFixed(2)),
        trades: Math.floor(1000 + Math.random() * 5000),
        takerBuyVolume: parseFloat((volume * takerBuyRatio).toFixed(2)),
        takerBuyQuote: parseFloat((volume * takerBuyRatio * price).toFixed(2)),
        range: parseFloat((finalHigh - finalLow).toFixed(6)),
        body: parseFloat(Math.abs(adjustedClose - open).toFixed(6)),
        isBullish: adjustedClose >= open,
      });

      price = adjustedClose;
    }

    state.lastClose = price;
    return candles;
  }

  /**
   * Generate a complete mock snapshot for a symbol.
   */
  generateSnapshot(symbol, intervals, candleLimit = 200) {
    const klines = {};
    for (const tf of intervals) {
      klines[tf] = this.generateKlines(symbol, tf, candleLimit);
    }

    const basePrice = klines[intervals[0]][klines[intervals[0]].length - 1].close;

    return {
      symbol,
      timestamp: Date.now(),
      klines,
      openInterest: {
        symbol,
        openInterest: parseFloat((Math.random() * 100000 + 50000).toFixed(4)),
        timestamp: Date.now(),
      },
      oiHistory: this._generateOIHistory(symbol),
      funding: {
        symbol,
        markPrice: basePrice,
        fundingRate: (Math.random() - 0.5) * 0.0005,
        nextFundingTime: Date.now() + 28800000,
        timestamp: Date.now(),
      },
      fundingHistory: this._generateFundingHistory(symbol),
      topTraderLS: this._generateLSRatio(symbol, 'top'),
      globalLS: this._generateLSRatio(symbol, 'global'),
      takerVolume: this._generateTakerVolume(symbol),
      ticker24h: {
        symbol,
        priceChange: parseFloat((basePrice * (Math.random() - 0.5) * 0.05).toFixed(4)),
        priceChangePct: parseFloat((Math.random() - 0.5) * 5).toFixed(2),
        lastPrice: basePrice,
        high24h: parseFloat((basePrice * 1.03).toFixed(4)),
        low24h: parseFloat((basePrice * 0.97).toFixed(4)),
        volume24h: parseFloat((Math.random() * 1000000).toFixed(2)),
        quoteVolume24h: parseFloat((Math.random() * 1000000000).toFixed(2)),
        count: Math.floor(100000 + Math.random() * 900000),
      },
    };
  }

  _generateOIHistory(symbol) {
    const history = [];
    let oi = 80000 + Math.random() * 20000;
    for (let i = 0; i < 30; i++) {
      oi += (Math.random() - 0.5) * 2000;
      history.push({
        timestamp: Date.now() - (30 - i) * 900000,
        sumOpenInterest: parseFloat(oi.toFixed(4)),
        sumOpenInterestValue: parseFloat((oi * 50000).toFixed(2)),
      });
    }
    return history;
  }

  _generateFundingHistory(symbol) {
    const history = [];
    for (let i = 0; i < 30; i++) {
      history.push({
        symbol,
        fundingRate: (Math.random() - 0.5) * 0.0003,
        fundingTime: Date.now() - (30 - i) * 28800000,
      });
    }
    return history;
  }

  _generateLSRatio(symbol, type) {
    const history = [];
    // Top traders tend to be more accurate — bias them toward the "real" trend
    const biasDir = Math.random() > 0.5 ? 0.55 : 0.45; // 55% long or 45% long
    for (let i = 0; i < 30; i++) {
      const noise = (Math.random() - 0.5) * 0.1;
      const longAccount = type === 'top' ? biasDir + noise : 0.5 + (Math.random() - 0.5) * 0.2;
      const shortAccount = 1 - longAccount;
      history.push({
        timestamp: Date.now() - (30 - i) * 900000,
        longShortRatio: parseFloat((longAccount / shortAccount).toFixed(4)),
        longAccount: parseFloat(longAccount.toFixed(4)),
        shortAccount: parseFloat(shortAccount.toFixed(4)),
        longPosition: type === 'top' ? parseFloat((Math.random() * 1000000).toFixed(2)) : 0,
        shortPosition: type === 'top' ? parseFloat((Math.random() * 1000000).toFixed(2)) : 0,
      });
    }
    return history;
  }

  _generateTakerVolume(symbol) {
    const history = [];
    for (let i = 0; i < 30; i++) {
      const buyVol = Math.random() * 500000 + 200000;
      const sellVol = Math.random() * 500000 + 200000;
      history.push({
        timestamp: Date.now() - (30 - i) * 900000,
        buySellRatio: parseFloat((buyVol / sellVol).toFixed(4)),
        buyVol: parseFloat(buyVol.toFixed(2)),
        sellVol: parseFloat(sellVol.toFixed(2)),
      });
    }
    return history;
  }

  _intervalToMs(interval) {
    const map = {
      '1m': 60000, '3m': 180000, '5m': 300000, '15m': 900000,
      '30m': 1800000, '1h': 3600000, '2h': 7200000, '4h': 14400000,
      '8h': 28800000, '12h': 43200000, '1d': 86400000, '1w': 604800000,
    };
    return map[interval] || 900000;
  }

  /**
   * Generate snapshots for all symbols.
   */
  generateAllSnapshots(symbols, intervals, candleLimit = 200) {
    const snapshots = {};
    for (const symbol of symbols) {
      snapshots[symbol] = this.generateSnapshot(symbol, intervals, candleLimit);
    }
    return snapshots;
  }

  /**
   * Update prices slightly for real-time simulation.
   */
  tickPrices(snapshots) {
    for (const symbol of Object.keys(snapshots)) {
      const snap = snapshots[symbol];
      if (!snap.klines?.['15m']?.length) continue;
      const candles = snap.klines['15m'];
      const last = candles[candles.length - 1];
      // Small price movement
      const change = (Math.random() - 0.5) * 0.003;
      const newClose = last.close * (1 + change);
      last.close = parseFloat(newClose.toFixed(6));
      last.high = Math.max(last.high, last.close);
      last.low = Math.min(last.low, last.close);
    }
    return snapshots;
  }
}

__FILE_EOF__

echo 'src/smc/smcAnalyzer.js'
mkdir -p \.
cat > 'src/smc/smcAnalyzer.js' << '__FILE_EOF__'
/**
 * Alchemist Brain — SMC (Smart Money Concepts) Module
 *
 * Detects market structure, liquidity, FVGs, displacement, and breakouts
 * from candlestick data.
 *
 * Pipeline:
 *   candles → swing detection → structure bias → BOS/CHOCH
 *          → liquidity pools/sweeps → FVG → displacement → breakout
 */

// ──────────────────────────────────────────────────────────────
//  SWING DETECTION
// ──────────────────────────────────────────────────────────────

/**
 * Detect swing highs and lows using a fractal approach.
 * A swing high = highest high in a window of `lookback` candles on each side.
 * A swing low = lowest low in a window of `lookback` candles on each side.
 */
export function detectSwings(candles, lookback = 2) {
  const swingHighs = [];
  const swingLows = [];

  for (let i = lookback; i < candles.length - lookback; i++) {
    // Check for swing high
    let isHigh = true;
    for (let j = 1; j <= lookback; j++) {
      if (candles[i].high <= candles[i - j].high || candles[i].high <= candles[i + j].high) {
        isHigh = false;
        break;
      }
    }
    if (isHigh) {
      swingHighs.push({
        index: i,
        price: candles[i].high,
        time: candles[i].openTime,
        type: 'high',
      });
    }

    // Check for swing low
    let isLow = true;
    for (let j = 1; j <= lookback; j++) {
      if (candles[i].low >= candles[i - j].low || candles[i].low >= candles[i + j].low) {
        isLow = false;
        break;
      }
    }
    if (isLow) {
      swingLows.push({
        index: i,
        price: candles[i].low,
        time: candles[i].openTime,
        type: 'low',
      });
    }
  }

  return { swingHighs, swingLows };
}

/**
 * Classify the swing sequence into HH, HL, LH, LL.
 */
export function classifySwings(swingHighs, swingLows) {
  const highs = swingHighs.map((s) => ({ ...s, classification: '' }));
  const lows = swingLows.map((s) => ({ ...s, classification: '' }));

  // Classify highs
  for (let i = 1; i < highs.length; i++) {
    if (highs[i].price > highs[i - 1].price) {
      highs[i].classification = 'HH'; // Higher High
    } else {
      highs[i].classification = 'LH'; // Lower High
    }
  }

  // Classify lows
  for (let i = 1; i < lows.length; i++) {
    if (lows[i].price > lows[i - 1].price) {
      lows[i].classification = 'HL'; // Higher Low
    } else {
      lows[i].classification = 'LL'; // Lower Low
    }
  }

  return { swingHighs: highs, swingLows: lows };
}

/**
 * Determine structure bias from the latest swings.
 * HH + HL = bullish, LH + LL = bearish, mixed = neutral/ranging
 */
export function getStructureBias(swingHighs, swingLows) {
  if (swingHighs.length < 2 || swingLows.length < 2) {
    return { bias: 'NEUTRAL', sequence: 'Insufficient data' };
  }

  const lastHigh = swingHighs[swingHighs.length - 1];
  const prevHigh = swingHighs[swingHighs.length - 2];
  const lastLow = swingLows[swingLows.length - 1];
  const prevLow = swingLows[swingLows.length - 2];

  const highRising = lastHigh.price > prevHigh.price;
  const lowRising = lastLow.price > prevLow.price;
  const highFalling = lastHigh.price < prevHigh.price;
  const lowFalling = lastLow.price < prevLow.price;

  let bias, sequence;

  if (highRising && lowRising) {
    bias = 'BULLISH';
    sequence = 'HL → HH → HL';
  } else if (highFalling && lowFalling) {
    bias = 'BEARISH';
    sequence = 'LH → LL → LH';
  } else if (highRising && lowFalling) {
    bias = 'EXPANSION'; // Divergence — expanding range
    sequence = 'LL → HH → expanding';
  } else if (highFalling && lowRising) {
    bias = 'CONTRACTION'; // Converging — potential breakout
    sequence = 'HL → LH → contracting';
  } else {
    bias = 'NEUTRAL';
    sequence = 'Mixed';
  }

  return { bias, sequence };
}

// ──────────────────────────────────────────────────────────────
//  BREAK OF STRUCTURE (BOS) & CHANGE OF CHARACTER (CHOCH)
// ──────────────────────────────────────────────────────────────

/**
 * Detect Break of Structure and Change of Character.
 *
 * BOS = price breaks the last swing in the direction of the current trend
 * CHOCH = price breaks the last swing against the current trend (reversal signal)
 */
export function detectBOSandCHOCH(candles, swingHighs, swingLows, structureBias) {
  const result = {
    bos: { detected: false, direction: null, brokenLevel: null, strength: 0 },
    choch: { detected: false, direction: null, brokenLevel: null, strength: 0 },
  };

  if (swingHighs.length < 2 || swingLows.length < 2) return result;

  // Get the most recent confirmed swing high and low
  const lastSwingHigh = swingHighs[swingHighs.length - 1];
  const lastSwingLow = swingLows[swingLows.length - 1];

  // Look at the last few candles after the most recent swing
  const recentCandles = candles.slice(Math.min(lastSwingHigh.index, lastSwingLow.index) + 1);

  if (recentCandles.length === 0) return result;

  const currentPrice = candles[candles.length - 1].close;

  // Check for BOS in bullish direction (price breaks above last swing high)
  if (structureBias.bias === 'BULLISH' || structureBias.bias === 'EXPANSION') {
    const brokeHigh = recentCandles.some((c) => c.close > lastSwingHigh.price);
    if (brokeHigh) {
      const breakCandle = recentCandles.find((c) => c.close > lastSwingHigh.price);
      const displacementStrength = breakCandle.body / (breakCandle.range || 1);
      result.bos = {
        detected: true,
        direction: 'BULLISH',
        brokenLevel: lastSwingHigh.price,
        strength: Math.min(100, Math.round(displacementStrength * 100)),
        breakIndex: breakCandle.openTime,
      };
    }
  }

  // Check for BOS in bearish direction (price breaks below last swing low)
  if (structureBias.bias === 'BEARISH' || structureBias.bias === 'EXPANSION') {
    const brokeLow = recentCandles.some((c) => c.close < lastSwingLow.price);
    if (brokeLow) {
      const breakCandle = recentCandles.find((c) => c.close < lastSwingLow.price);
      const displacementStrength = breakCandle.body / (breakCandle.range || 1);
      result.bos = {
        detected: true,
        direction: 'BEARISH',
        brokenLevel: lastSwingLow.price,
        strength: Math.min(100, Math.round(displacementStrength * 100)),
        breakIndex: breakCandle.openTime,
      };
    }
  }

  // Check for CHOCH (reversal — price breaks against the current trend)
  if (structureBias.bias === 'BULLISH') {
    // CHOCH bearish: price breaks below last swing low in a bullish trend
    const brokeBelow = recentCandles.some((c) => c.close < lastSwingLow.price);
    if (brokeBelow) {
      result.choch = {
        detected: true,
        direction: 'BEARISH',
        brokenLevel: lastSwingLow.price,
        strength: 50, // Initial strength — needs confirmation
      };
    }
  } else if (structureBias.bias === 'BEARISH') {
    // CHOCH bullish: price breaks above last swing high in a bearish trend
    const brokeAbove = recentCandles.some((c) => c.close > lastSwingHigh.price);
    if (brokeAbove) {
      result.choch = {
        detected: true,
        direction: 'BULLISH',
        brokenLevel: lastSwingHigh.price,
        strength: 50,
      };
    }
  }

  return result;
}

// ──────────────────────────────────────────────────────────────
//  LIQUIDITY DETECTION
// ──────────────────────────────────────────────────────────────

/**
 * Detect liquidity pools: equal highs, equal lows, previous highs/lows.
 * Also detect liquidity sweeps (price briefly exceeds a level then reverses).
 */
export function detectLiquidity(candles, swingHighs, swingLows) {
  const tolerance = 0.001; // 0.1% tolerance for "equal" levels

  // Equal highs (liquidity above)
  const equalHighs = [];
  for (let i = 1; i < swingHighs.length; i++) {
    const diff = Math.abs(swingHighs[i].price - swingHighs[i - 1].price);
    const pctDiff = diff / Math.min(swingHighs[i].price, swingHighs[i - 1].price);
    if (pctDiff < tolerance) {
      equalHighs.push({
        level: Math.max(swingHighs[i].price, swingHighs[i - 1].price),
        indices: [swingHighs[i - 1].index, swingHighs[i].index],
        type: 'equal_high',
      });
    }
  }

  // Equal lows (liquidity below)
  const equalLows = [];
  for (let i = 1; i < swingLows.length; i++) {
    const diff = Math.abs(swingLows[i].price - swingLows[i - 1].price);
    const pctDiff = diff / Math.min(swingLows[i].price, swingLows[i - 1].price);
    if (pctDiff < tolerance) {
      equalLows.push({
        level: Math.min(swingLows[i].price, swingLows[i - 1].price),
        indices: [swingLows[i - 1].index, swingLows[i].index],
        type: 'equal_low',
      });
    }
  }

  // Previous highs and lows (single liquidity points)
  const prevHighs = swingHighs.slice(-5).map((s) => ({
    level: s.price,
    index: s.index,
    type: 'prev_high',
  }));

  const prevLows = swingLows.slice(-5).map((s) => ({
    level: s.price,
    index: s.index,
    type: 'prev_low',
  }));

  // ── Liquidity sweep detection ─────────────────────────────
  // A sweep = price exceeds a swing high/low but closes back inside
  const sweeps = [];
  const lastCandle = candles[candles.length - 1];
  const lookback = 10;
  const recentCandles = candles.slice(-lookback);

  for (const sh of [...equalHighs, ...prevHighs]) {
    // Check if any recent candle spiked above the level then closed below
    for (const c of recentCandles) {
      if (c.high > sh.level && c.close < sh.level) {
        const wickSize = c.high - sh.level;
        const candleRange = c.range || 1;
        sweeps.push({
          direction: 'ABOVE',
          level: sh.level,
          strength: Math.min(100, Math.round((wickSize / candleRange) * 100)),
          sweepTime: c.openTime,
          location: sh.type,
        });
        break;
      }
    }
  }

  for (const sl of [...equalLows, ...prevLows]) {
    for (const c of recentCandles) {
      if (c.low < sl.level && c.close > sl.level) {
        const wickSize = sl.level - c.low;
        const candleRange = c.range || 1;
        sweeps.push({
          direction: 'BELOW',
          level: sl.level,
          strength: Math.min(100, Math.round((wickSize / candleRange) * 100)),
          sweepTime: c.openTime,
          location: sl.type,
        });
        break;
      }
    }
  }

  // Determine the most recent/strongest sweep
  let strongestSweep = null;
  if (sweeps.length > 0) {
    strongestSweep = sweeps.reduce((max, s) => (s.strength > max.strength ? s : max), sweeps[0]);
  }

  // Liquidity targets (where price is likely to go next)
  const liquidityTargets = [];
  if (strongestSweep?.direction === 'ABOVE') {
    // Swept above — target is liquidity below
    const lowestLiq = prevLows.reduce(
      (min, p) => (p.level < min ? p.level : min),
      Infinity
    );
    if (lowestLiq !== Infinity) liquidityTargets.push({ direction: 'DOWN', level: lowestLiq });
  } else if (strongestSweep?.direction === 'BELOW') {
    const highestLiq = prevHighs.reduce(
      (max, p) => (p.level > max ? p.level : max),
      0
    );
    if (highestLiq !== 0) liquidityTargets.push({ direction: 'UP', level: highestLiq });
  }

  return {
    equalHighs,
    equalLows,
    prevHighs,
    prevLows,
    sweep: strongestSweep,
    allSweeps: sweeps,
    liquidityTargets,
  };
}

// ──────────────────────────────────────────────────────────────
//  FAIR VALUE GAPS (FVG)
// ──────────────────────────────────────────────────────────────

/**
 * Detect Fair Value Gaps (3-candle imbalance).
 *
 * Bullish FVG: candle[i-1].high < candle[i+1].low (gap up)
 * Bearish FVG: candle[i-1].low > candle[i+1].high (gap down)
 */
export function detectFVG(candles) {
  const fvgs = [];

  for (let i = 1; i < candles.length - 1; i++) {
    const prev = candles[i - 1];
    const next = candles[i + 1];

    // Bullish FVG
    if (prev.high < next.low) {
      const upperBoundary = next.low;
      const lowerBoundary = prev.high;
      const size = upperBoundary - lowerBoundary;
      const sizePct = (size / prev.close) * 100;

      // Check if filled
      const subsequentCandles = candles.slice(i + 2);
      const touched = subsequentCandles.some((c) => c.low <= upperBoundary);
      const fullyFilled = subsequentCandles.some((c) => c.low <= lowerBoundary);
      const partiallyFilled = touched && !fullyFilled;

      // Age in candles
      const age = candles.length - i - 1;

      fvgs.push({
        direction: 'BULLISH',
        upperBoundary,
        lowerBoundary,
        size,
        sizePct,
        age,
        touched,
        partiallyFilled,
        fullyFilled,
        status: fullyFilled ? 'FILLED' : partiallyFilled ? 'PARTIALLY_FILLED' : 'UNFILLED',
        index: i,
      });
    }

    // Bearish FVG
    if (prev.low > next.high) {
      const upperBoundary = prev.low;
      const lowerBoundary = next.high;
      const size = upperBoundary - lowerBoundary;
      const sizePct = (size / prev.close) * 100;

      const subsequentCandles = candles.slice(i + 2);
      const touched = subsequentCandles.some((c) => c.high >= lowerBoundary);
      const fullyFilled = subsequentCandles.some((c) => c.high >= upperBoundary);
      const partiallyFilled = touched && !fullyFilled;

      const age = candles.length - i - 1;

      fvgs.push({
        direction: 'BEARISH',
        upperBoundary,
        lowerBoundary,
        size,
        sizePct,
        age,
        touched,
        partiallyFilled,
        fullyFilled,
        status: fullyFilled ? 'FILLED' : partiallyFilled ? 'PARTIALLY_FILLED' : 'UNFILLED',
        index: i,
      });
    }
  }

  // Return the most relevant unfilled or partially filled FVGs
  const activeFVGs = fvgs.filter((f) => !f.fullyFilled);
  const latestActive = activeFVGs.slice(-3); // Last 3 active FVGs

  return {
    all: fvgs,
    active: activeFVGs,
    latest: latestActive,
    // The most recent unfilled FVG
    current: activeFVGs.length > 0 ? activeFVGs[activeFVGs.length - 1] : null,
  };
}

// ──────────────────────────────────────────────────────────────
//  DISPLACEMENT
// ──────────────────────────────────────────────────────────────

/**
 * Measure displacement — strong directional moves that create imbalances.
 * Displacement = current candle range significantly exceeds average range.
 */
export function detectDisplacement(candles, lookback = 20) {
  if (candles.length < lookback + 1) {
    return { detected: false, direction: null, strength: 0 };
  }

  const recentCandles = candles.slice(-lookback);
  const avgRange = recentCandles.reduce((sum, c) => sum + c.range, 0) / lookback;

  const lastCandle = candles[candles.length - 1];
  const rangeRatio = lastCandle.range / (avgRange || 1);

  // Displacement if current range > 1.5x average
  const isDisplacement = rangeRatio > 1.5;

  return {
    detected: isDisplacement,
    direction: lastCandle.isBullish ? 'BULLISH' : 'BEARISH',
    currentRange: lastCandle.range,
    averageRange: avgRange,
    rangeRatio,
    strength: Math.min(100, Math.round(rangeRatio * 33)), // 3x avg = ~100
  };
}

// ──────────────────────────────────────────────────────────────
//  BREAKOUT DETECTION
// ──────────────────────────────────────────────────────────────

/**
 * Detect breakouts and whether they succeed or fail.
 * Also checks for retests and stale breakouts.
 */
export function detectBreakout(candles, swingHighs, swingLows) {
  if (candles.length < 10 || swingHighs.length < 1 || swingLows.length < 1) {
    return { detected: false, direction: null, status: 'NONE' };
  }

  const lastCandle = candles[candles.length - 1];
  const prevCandles = candles.slice(-10, -1);

  // Get recent significant levels
  const recentHigh = Math.max(...swingHighs.slice(-3).map((s) => s.price));
  const recentLow = Math.min(...swingLows.slice(-3).map((s) => s.price));

  // Check for breakout above recent high
  let breakout = {
    detected: false,
    direction: null,
    breakoutLevel: null,
    strength: 0,
    retest: false,
    retestHeld: false,
    retestFailed: false,
    failed: false,
    stale: false,
    status: 'NONE',
  };

  // Bullish breakout
  const brokeAbove = prevCandles.some((c) => c.close > recentHigh);
  if (brokeAbove) {
    const breakCandle = prevCandles.find((c) => c.close > recentHigh);
    const candlesSinceBreak = candles.indexOf(breakCandle);
    const postBreakCandles = candles.slice(candlesSinceBreak + 1);

    // Check if price has returned to the breakout level (retest)
    const retested = postBreakCandles.some((c) => c.low <= recentHigh * 1.001);
    const retestHeld = retested && lastCandle.close > recentHigh;
    const retestFailed = retested && lastCandle.close < recentHigh * 0.999;

    // Failed breakout = price broke above but then closed back below
    const failed = lastCandle.close < recentHigh;

    // Stale breakout = breakout happened long ago with no follow-through
    const stale = postBreakCandles.length > 20 && !failed;

    breakout = {
      detected: true,
      direction: 'BULLISH',
      breakoutLevel: recentHigh,
      strength: Math.min(100, Math.round((breakCandle.body / breakCandle.range) * 100)),
      retest: retested,
      retestHeld,
      retestFailed,
      failed,
      stale,
      status: failed ? 'FAILED' : retestHeld ? 'RETEST_HELD' : retestFailed ? 'RETEST_FAILED' : stale ? 'STALE' : 'BREAKOUT',
    };
  }

  // Bearish breakout
  const brokeBelow = prevCandles.some((c) => c.close < recentLow);
  if (brokeBelow) {
    const breakCandle = prevCandles.find((c) => c.close < recentLow);
    const candlesSinceBreak = candles.indexOf(breakCandle);
    const postBreakCandles = candles.slice(candlesSinceBreak + 1);

    const retested = postBreakCandles.some((c) => c.high >= recentLow * 0.999);
    const retestHeld = retested && lastCandle.close < recentLow;
    const retestFailed = retested && lastCandle.close > recentLow * 1.001;
    const failed = lastCandle.close > recentLow;
    const stale = postBreakCandles.length > 20 && !failed;

    breakout = {
      detected: true,
      direction: 'BEARISH',
      breakoutLevel: recentLow,
      strength: Math.min(100, Math.round((breakCandle.body / breakCandle.range) * 100)),
      retest: retested,
      retestHeld,
      retestFailed,
      failed,
      stale,
      status: failed ? 'FAILED' : retestHeld ? 'RETEST_HELD' : retestFailed ? 'RETEST_FAILED' : stale ? 'STALE' : 'BREAKOUT',
    };
  }

  return breakout;
}

// ──────────────────────────────────────────────────────────────
//  PROTECTED HIGH / PROTECTED LOW
// ──────────────────────────────────────────────────────────────

/**
 * Protected High = the most recent swing high that hasn't been breached.
 * Protected Low = the most recent swing low that hasn't been breached.
 * These are the "line in the sand" levels for structure.
 */
export function getProtectedLevels(candles, swingHighs, swingLows) {
  const currentPrice = candles[candles.length - 1].close;

  let protectedHigh = null;
  let protectedLow = null;

  // Find the most recent swing high that price is still below
  for (let i = swingHighs.length - 1; i >= 0; i--) {
    if (swingHighs[i].price > currentPrice) {
      protectedHigh = swingHighs[i];
      break;
    }
  }

  // Find the most recent swing low that price is still above
  for (let i = swingLows.length - 1; i >= 0; i--) {
    if (swingLows[i].price < currentPrice) {
      protectedLow = swingLows[i];
      break;
    }
  }

  return { protectedHigh, protectedLow };
}

// ──────────────────────────────────────────────────────────────
//  FULL SMC ANALYSIS
// ──────────────────────────────────────────────────────────────

/**
 * Run the complete SMC analysis pipeline on a set of candles.
 * Returns everything the Brain needs for thesis formation.
 */
export function analyzeSMC(candles, options = {}) {
  const lookback = options.swingLookback || 2;

  // 1. Swing detection
  const { swingHighs, swingLows } = detectSwings(candles, lookback);

  // 2. Classify swings
  const classified = classifySwings(swingHighs, swingLows);

  // 3. Structure bias
  const structure = getStructureBias(classified.swingHighs, classified.swingLows);

  // 4. BOS / CHOCH
  const boschoch = detectBOSandCHOCH(candles, classified.swingHighs, classified.swingLows, structure);

  // 5. Liquidity
  const liquidity = detectLiquidity(candles, classified.swingHighs, classified.swingLows);

  // 6. FVG
  const fvg = detectFVG(candles);

  // 7. Displacement
  const displacement = detectDisplacement(candles);

  // 8. Breakout
  const breakout = detectBreakout(candles, classified.swingHighs, classified.swingLows);

  // 9. Protected levels
  const protectedLevels = getProtectedLevels(candles, classified.swingHighs, classified.swingLows);

  // 10. Current price
  const currentPrice = candles[candles.length - 1].close;

  // 11. SMC evidence score (0-100)
  let smcScore = 0;
  let bullishCount = 0;
  let bearishCount = 0;
  const evidenceList = [];

  if (structure.bias === 'BULLISH') { bullishCount++; evidenceList.push('Bullish structure'); }
  if (structure.bias === 'BEARISH') { bearishCount++; evidenceList.push('Bearish structure'); }

  if (boschoch.bos.detected) {
    if (boschoch.bos.direction === 'BULLISH') { bullishCount += 2; evidenceList.push('Bullish BOS'); }
    if (boschoch.bos.direction === 'BEARISH') { bearishCount += 2; evidenceList.push('Bearish BOS'); }
  }

  if (boschoch.choch.detected) {
    if (boschoch.choch.direction === 'BULLISH') { bullishCount++; evidenceList.push('Bullish CHOCH'); }
    if (boschoch.choch.direction === 'BEARISH') { bearishCount++; evidenceList.push('Bearish CHOCH'); }
  }

  if (liquidity.sweep) {
    if (liquidity.sweep.direction === 'ABOVE') { bearishCount++; evidenceList.push('Liquidity sweep above (bearish)'); }
    if (liquidity.sweep.direction === 'BELOW') { bullishCount++; evidenceList.push('Liquidity sweep below (bullish)'); }
  }

  if (fvg.current && !fvg.current.fullyFilled) {
    if (fvg.current.direction === 'BULLISH') { bullishCount++; evidenceList.push('Unfilled bullish FVG'); }
    if (fvg.current.direction === 'BEARISH') { bearishCount++; evidenceList.push('Unfilled bearish FVG'); }
  }

  if (displacement.detected) {
    if (displacement.direction === 'BULLISH') { bullishCount++; evidenceList.push('Bullish displacement'); }
    if (displacement.direction === 'BEARISH') { bearishCount++; evidenceList.push('Bearish displacement'); }
  }

  if (breakout.detected) {
    if (breakout.failed) {
      if (breakout.direction === 'BULLISH') { bearishCount += 2; evidenceList.push('Failed bullish breakout (bearish)'); }
      if (breakout.direction === 'BEARISH') { bullishCount += 2; evidenceList.push('Failed bearish breakout (bullish)'); }
    } else if (breakout.retestHeld) {
      if (breakout.direction === 'BULLISH') { bullishCount++; evidenceList.push('Bullish breakout retest held'); }
      if (breakout.direction === 'BEARISH') { bearishCount++; evidenceList.push('Bearish breakout retest held'); }
    }
  }

  const total = bullishCount + bearishCount;
  if (total > 0) {
    smcScore = Math.round((Math.max(bullishCount, bearishCount) / total) * 100);
  }

  const smcBias = bullishCount > bearishCount ? 'BULLISH' : bearishCount > bullishCount ? 'BEARISH' : 'NEUTRAL';

  return {
    currentPrice,
    swingHighs: classified.swingHighs,
    swingLows: classified.swingLows,
    structure,
    bos: boschoch.bos,
    choch: boschoch.choch,
    liquidity,
    fvg,
    displacement,
    breakout,
    protectedLevels,
    smcScore,
    smcBias,
    evidence: evidenceList,
  };
}

__FILE_EOF__

echo 'src/smart_money/smartMoneyAnalyzer.js'
mkdir -p \.
cat > 'src/smart_money/smartMoneyAnalyzer.js' << '__FILE_EOF__'
/**
 * Alchemist Brain — Smart Money Module
 *
 * Analyzes what large/informed market participants are doing.
 * Uses Binance public derivatives data as a proxy for smart money positioning.
 *
 * Data sources (all public, no API keys):
 *   - Top Trader Long/Short Position Ratio (whale proxy)
 *   - Global Long/Short Account Ratio (retail sentiment)
 *   - Open Interest + changes (positioning flow)
 *   - Funding Rate (cost of holding positions)
 *   - Taker Buy/Sell Volume (aggressive order flow)
 *
 * Note: Binance doesn't expose per-wallet whale data publicly.
 * We use top trader position ratios as the closest proxy, combined
 * with OI/funding/taker flow to build a complete smart money picture.
 */

// ──────────────────────────────────────────────────────────────
//  WHALE / TOP TRADER ANALYSIS
// ──────────────────────────────────────────────────────────────

/**
 * Analyze top trader positioning from L/S ratio data.
 * Top traders on Binance = accounts with large positions.
 */
export function analyzeTopTraders(topTraderLS, globalLS) {
  if (!topTraderLS || topTraderLS.length === 0) {
    return { bias: 0, direction: 'NEUTRAL', longPct: 50, shortPct: 50, changes: [] };
  }

  const latest = topTraderLS[topTraderLS.length - 1];
  const longPct = (latest.longAccount * 100).toFixed(1);
  const shortPct = (latest.shortAccount * 100).toFixed(1);

  // Bias: -1 (max short) to +1 (max long)
  // longShortRatio > 1 = more longs, < 1 = more shorts
  const ratio = latest.longShortRatio;
  const bias = clamp((ratio - 1) / (ratio + 1) * 2, -1, 1);

  // Detect positioning changes over the last few periods
  const changes = [];
  const lookback = Math.min(5, topTraderLS.length - 1);
  if (lookback > 0) {
    const older = topTraderLS[topTraderLS.length - 1 - lookback];
    const longChange = latest.longAccount - older.longAccount;
    const shortChange = latest.shortAccount - older.shortAccount;

    if (longChange > 0.01) changes.push({ type: 'INCREASING_LONG', value: longChange });
    if (shortChange > 0.01) changes.push({ type: 'INCREASING_SHORT', value: shortChange });
    if (longChange < -0.01) changes.push({ type: 'DECREASING_LONG', value: longChange });
    if (shortChange < -0.01) changes.push({ type: 'DECREASING_SHORT', value: shortChange });
  }

  // Compare top traders vs global (retail) — divergence = smart money edge
  let divergence = 0;
  if (globalLS && globalLS.length > 0) {
    const globalLatest = globalLS[globalLS.length - 1];
    const globalBias = clamp((globalLatest.longShortRatio - 1) / (globalLatest.longShortRatio + 1) * 2, -1, 1);
    divergence = bias - globalBias; // Positive = top traders more long than retail
  }

  return {
    bias,
    direction: bias > 0.1 ? 'BULLISH' : bias < -0.1 ? 'BEARISH' : 'NEUTRAL',
    longPct: parseFloat(longPct),
    shortPct: parseFloat(shortPct),
    ratio: latest.longShortRatio,
    changes,
    divergence,
  };
}

// ──────────────────────────────────────────────────────────────
//  GLOBAL MARKET POSITION (RETAIL SENTIMENT)
// ──────────────────────────────────────────────────────────────

export function analyzeGlobalPosition(globalLS) {
  if (!globalLS || globalLS.length === 0) {
    return { bias: 0, direction: 'NEUTRAL', longPct: 50, shortPct: 50 };
  }

  const latest = globalLS[globalLS.length - 1];
  const ratio = latest.longShortRatio;
  const bias = clamp((ratio - 1) / (ratio + 1) * 2, -1, 1);

  return {
    bias,
    direction: bias > 0.1 ? 'LONG_HEAVY' : bias < -0.1 ? 'SHORT_HEAVY' : 'BALANCED',
    longPct: parseFloat((latest.longAccount * 100).toFixed(1)),
    shortPct: parseFloat((latest.shortAccount * 100).toFixed(1)),
    ratio,
  };
}

// ──────────────────────────────────────────────────────────────
//  DERIVATIVES ANALYSIS (OI + Funding + Taker Flow)
// ──────────────────────────────────────────────────────────────

export function analyzeDerivatives(oi, oiHistory, funding, fundingHistory, takerVolume) {
  const result = {
    funding: { rate: 0, direction: 'NEUTRAL', trend: 'STABLE' },
    openInterest: { current: 0, changePct: 0, trend: 'FLAT' },
    takerFlow: { bias: 0, direction: 'NEUTRAL', strength: 0 },
    contribution: 0, // -1 to +1 overall derivatives bias
  };

  // ── Funding Rate ──────────────────────────────────────────
  if (funding) {
    const rate = funding.fundingRate;
    const annualized = rate * 3 * 365; // 8h funding, 3x/day, 365 days
    result.funding = {
      rate,
      annualizedPct: parseFloat((annualized * 100).toFixed(2)),
      // Positive funding = longs pay shorts → bearish signal (longs crowded)
      // Negative funding = shorts pay longs → bullish signal (shorts crowded)
      direction: rate > 0.0001 ? 'BEARISH' : rate < -0.0001 ? 'BULLISH' : 'NEUTRAL',
      trend: 'STABLE',
    };

    // Funding trend from history
    if (fundingHistory && fundingHistory.length > 5) {
      const recent = fundingHistory.slice(-5);
      const older = fundingHistory.slice(-10, -5);
      const recentAvg = recent.reduce((s, r) => s + r.fundingRate, 0) / recent.length;
      const olderAvg = older.length > 0 ? older.reduce((s, r) => s + r.fundingRate, 0) / older.length : recentAvg;

      if (Math.abs(recentAvg) > Math.abs(olderAvg)) {
        result.funding.trend = 'INTENSIFYING';
      } else if (Math.abs(recentAvg) < Math.abs(olderAvg)) {
        result.funding.trend = 'DECAYING';
      }
    }
  }

  // ── Open Interest ─────────────────────────────────────────
  if (oi && oiHistory && oiHistory.length > 1) {
    const currentOI = oiHistory[oiHistory.length - 1].sumOpenInterestValue;
    const pastOI = oiHistory[0].sumOpenInterestValue;
    const changePct = ((currentOI - pastOI) / pastOI) * 100;

    result.openInterest = {
      current: currentOI,
      previous: pastOI,
      changePct: parseFloat(changePct.toFixed(2)),
      // Rising OI + bearish funding = bearish (new shorts entering)
      // Rising OI + bullish funding = bullish (new longs entering)
      // Falling OI = positions closing (unwinding)
      trend: changePct > 3 ? 'BUILDING' : changePct < -3 ? 'DECLINING' : 'FLAT',
    };
  } else if (oi) {
    result.openInterest.current = oi.openInterest;
  }

  // ── Taker Flow ────────────────────────────────────────────
  if (takerVolume && takerVolume.length > 0) {
    const recent = takerVolume.slice(-5);
    const avgRatio = recent.reduce((s, r) => s + r.buySellRatio, 0) / recent.length;
    const bias = clamp((avgRatio - 1) / (avgRatio + 1) * 2, -1, 1);

    result.takerFlow = {
      bias,
      direction: bias > 0.05 ? 'BULLISH' : bias < -0.05 ? 'BEARISH' : 'NEUTRAL',
      strength: Math.min(100, Math.round(Math.abs(bias) * 100)),
      avgBuySellRatio: parseFloat(avgRatio.toFixed(3)),
    };
  }

  // ── Derivatives Contribution Score ────────────────────────
  let score = 0;
  if (result.funding.direction === 'BULLISH') score += 0.3;
  if (result.funding.direction === 'BEARISH') score -= 0.3;
  if (result.openInterest.trend === 'BUILDING' && result.funding.direction === 'BEARISH') score -= 0.2;
  if (result.openInterest.trend === 'BUILDING' && result.funding.direction === 'BULLISH') score += 0.2;
  if (result.openInterest.trend === 'DECLINING') score -= 0.1; // Unwinding = uncertainty
  if (result.takerFlow.direction === 'BULLISH') score += 0.3;
  if (result.takerFlow.direction === 'BEARISH') score -= 0.3;

  result.contribution = clamp(score, -1, 1);

  return result;
}

// ──────────────────────────────────────────────────────────────
//  SMART MONEY FUSION
// ──────────────────────────────────────────────────────────────

/**
 * Combine all smart money signals into a unified view.
 * This is what the Brain receives for thesis formation.
 */
export function fuseSmartMoney(topTraderAnalysis, globalAnalysis, derivatives) {
  // Weight the signals
  const weights = {
    topTraders: 0.35,   // Top traders = best proxy for smart money
    takerFlow: 0.25,    // Aggressive flow = institutional activity
    funding: 0.20,      // Funding = cost of conviction
    openInterest: 0.10, // OI = capital flow
    global: 0.10,       // Global = contrarian signal (fade retail)
  };

  // Top trader bias (positive = long)
  const topTraderSignal = topTraderAnalysis.bias;

  // Taker flow bias
  const takerSignal = derivatives.takerFlow.bias;

  // Funding signal (negative funding = bullish = longs not crowded)
  // Invert because positive funding is bearish
  const fundingSignal = -derivatives.funding.rate * 100; // Scale up
  const fundingClamped = clamp(fundingSignal, -1, 1);

  // OI signal — rising OI in direction of top traders = confirmation
  const oiSignal = derivatives.openInterest.changePct > 0 && topTraderSignal > 0 ? 0.5
    : derivatives.openInterest.changePct > 0 && topTraderSignal < 0 ? -0.5
    : derivatives.openInterest.changePct < 0 ? -0.2
    : 0;

  // Global signal — contrarian (fade the crowd)
  const globalSignal = -globalAnalysis.bias * 0.5;

  // Weighted fusion
  const smartMoneyBias = clamp(
    topTraderSignal * weights.topTraders +
    takerSignal * weights.takerFlow +
    fundingClamped * weights.funding +
    oiSignal * weights.openInterest +
    globalSignal * weights.global,
    -1, 1
  );

  // Flow alignment — do the signals agree?
  const signals = [topTraderSignal, takerSignal, fundingClamped, oiSignal];
  const positiveCount = signals.filter((s) => s > 0.05).length;
  const negativeCount = signals.filter((s) => s < -0.05).length;
  const totalCount = signals.length;
  const alignment = Math.max(positiveCount, negativeCount) / totalCount;

  const flowAlignment = alignment > 0.75 ? 'STRONG'
    : alignment > 0.5 ? 'MODERATE'
    : alignment > 0.25 ? 'WEAK'
    : 'NONE';

  return {
    smartMoneyBias,
    direction: smartMoneyBias > 0.1 ? 'BULLISH' : smartMoneyBias < -0.1 ? 'BEARISH' : 'NEUTRAL',
    strength: Math.min(100, Math.round(Math.abs(smartMoneyBias) * 100)),
    components: {
      topTraders: { bias: topTraderSignal, weight: weights.topTraders, ...topTraderAnalysis },
      takerFlow: { bias: takerSignal, weight: weights.takerFlow, ...derivatives.takerFlow },
      funding: { bias: fundingClamped, weight: weights.funding, ...derivatives.funding },
      openInterest: { bias: oiSignal, weight: weights.openInterest, ...derivatives.openInterest },
      global: { bias: globalSignal, weight: weights.global, ...globalAnalysis },
    },
    flowAlignment,
    alignmentScore: parseFloat(alignment.toFixed(2)),
  };
}

// ──────────────────────────────────────────────────────────────
//  FULL SMART MONEY ANALYSIS
// ──────────────────────────────────────────────────────────────

/**
 * Run complete smart money analysis from a market data snapshot.
 */
export function analyzeSmartMoney(snapshot) {
  const topTraderAnalysis = analyzeTopTraders(snapshot.topTraderLS, snapshot.globalLS);
  const globalAnalysis = analyzeGlobalPosition(snapshot.globalLS);
  const derivatives = analyzeDerivatives(
    snapshot.openInterest,
    snapshot.oiHistory,
    snapshot.funding,
    snapshot.fundingHistory,
    snapshot.takerVolume
  );
  const fusion = fuseSmartMoney(topTraderAnalysis, globalAnalysis, derivatives);

  // Evidence list for the Brain
  const evidence = [];

  if (topTraderAnalysis.direction === 'BULLISH') {
    evidence.push(`Top traders bullish (${topTraderAnalysis.longPct}% long)`);
  } else if (topTraderAnalysis.direction === 'BEARISH') {
    evidence.push(`Top traders bearish (${topTraderAnalysis.shortPct}% short)`);
  }

  for (const change of topTraderAnalysis.changes) {
    if (change.type === 'INCREASING_LONG') evidence.push(`Top traders increasing long (+${(change.value * 100).toFixed(1)}%)`);
    if (change.type === 'INCREASING_SHORT') evidence.push(`Top traders increasing short (+${(change.value * 100).toFixed(1)}%)`);
  }

  if (derivatives.takerFlow.direction !== 'NEUTRAL') {
    evidence.push(`Taker flow ${derivatives.takerFlow.direction.toLowerCase()} (ratio: ${derivatives.takerFlow.avgBuySellRatio})`);
  }

  if (derivatives.funding.direction !== 'NEUTRAL') {
    evidence.push(`Funding ${derivatives.funding.direction.toLowerCase()} (${derivatives.funding.annualizedPct}% annualized)`);
  }

  if (derivatives.openInterest.trend !== 'FLAT') {
    evidence.push(`OI ${derivatives.openInterest.trend.toLowerCase()} (${derivatives.openInterest.changePct}%)`);
  }

  if (topTraderAnalysis.divergence > 0.1) {
    evidence.push(`Top traders diverge from retail (bullish edge)`);
  } else if (topTraderAnalysis.divergence < -0.1) {
    evidence.push(`Top traders diverge from retail (bearish edge)`);
  }

  return {
    topTraders: topTraderAnalysis,
    global: globalAnalysis,
    derivatives,
    fusion,
    evidence,
    smartMoneyScore: fusion.strength,
    smartMoneyBias: fusion.direction,
  };
}

// ──────────────────────────────────────────────────────────────
//  HELPERS
// ──────────────────────────────────────────────────────────────

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

__FILE_EOF__

echo 'src/technical/technicalAnalyzer.js'
mkdir -p \.
cat > 'src/technical/technicalAnalyzer.js' << '__FILE_EOF__'
/**
 * Alchemist Brain — Technical Engine
 *
 * A separate analytical layer from SMC and Smart Money.
 * Provides RSI, Momentum, Volume, Volatility, Trend, and Regime
 * analysis to the Brain.
 *
 * The Brain doesn't see "RSI = 38 → SHORT".
 * It sees: RSI declining, momentum bearish & accelerating, volume expanding,
 * 5m trend bearish, regime trending bear → technical evidence supports SHORT.
 *
 * Then it compares that with SMC and Smart Money evidence.
 */

// ──────────────────────────────────────────────────────────────
//  RSI (Relative Strength Index)
// ──────────────────────────────────────────────────────────────

export function calcRSI(candles, period = 14) {
  if (candles.length < period + 1) {
    return { value: 50, direction: 'FLAT', change: 0, previous: 50, momentumContext: 'NEUTRAL' };
  }

  let gains = 0;
  let losses = 0;

  // Calculate initial average
  for (let i = 1; i <= period; i++) {
    const change = candles[i].close - candles[i - 1].close;
    if (change > 0) gains += change;
    else losses += Math.abs(change);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  // Smooth the RSI for remaining candles
  const rsiValues = [];
  let rsi = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  rsiValues.push(rsi);

  for (let i = period + 1; i < candles.length; i++) {
    const change = candles[i].close - candles[i - 1].close;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;

    rsi = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    rsiValues.push(rsi);
  }

  const currentRSI = rsiValues[rsiValues.length - 1];
  const previousRSI = rsiValues[rsiValues.length - 2] || currentRSI;
  const rsiChange = currentRSI - previousRSI;

  // RSI direction
  let direction = 'FLAT';
  if (rsiChange > 0.5) direction = 'RISING';
  else if (rsiChange < -0.5) direction = 'FALLING';

  // RSI momentum context
  let momentumContext = 'NEUTRAL';
  if (currentRSI > 70) momentumContext = 'OVERBOUGHT';
  else if (currentRSI > 60) momentumContext = 'BULLISH';
  else if (currentRSI > 40) momentumContext = 'NEUTRAL';
  else if (currentRSI > 30) momentumContext = 'BEARISH';
  else momentumContext = 'OVERSOLD';

  return {
    value: parseFloat(currentRSI.toFixed(2)),
    direction,
    change: parseFloat(rsiChange.toFixed(2)),
    previous: parseFloat(previousRSI.toFixed(2)),
    momentumContext,
  };
}

// ──────────────────────────────────────────────────────────────
//  MOMENTUM
// ──────────────────────────────────────────────────────────────

export function calcMomentum(candles, shortPeriod = 10, longPeriod = 20) {
  if (candles.length < longPeriod + 1) {
    return {
      value: 0,
      shortTerm: 0,
      change: 0,
      acceleration: 0,
      direction: 'NEUTRAL',
      strength: 0,
      agrees: null,
    };
  }

  // Rate of Change (ROC) based momentum
  const currentClose = candles[candles.length - 1].close;
  const shortRef = candles[candles.length - 1 - shortPeriod].close;
  const longRef = candles[candles.length - 1 - longPeriod].close;

  // Short-term momentum (ROC)
  const shortTerm = ((currentClose - shortRef) / shortRef) * 100;

  // Long-term momentum
  const longTerm = ((currentClose - longRef) / longRef) * 100;

  // Momentum change (difference between short and long)
  const change = shortTerm - longTerm;

  // Momentum acceleration (is momentum speeding up or slowing down?)
  const prevShort = candles[candles.length - 2].close;
  const prevShortRef = candles[candles.length - 1 - shortPeriod].close;
  const prevShortTerm = ((prevShort - prevShortRef) / prevShortRef) * 100;
  const acceleration = shortTerm - prevShortTerm;

  // Direction
  let direction = 'NEUTRAL';
  if (shortTerm > 0.1) direction = 'BULLISH';
  else if (shortTerm < -0.1) direction = 'BEARISH';

  // Strength (0-100)
  const strength = Math.min(100, Math.round(Math.abs(shortTerm) * 20));

  return {
    value: parseFloat(longTerm.toFixed(2)),
    shortTerm: parseFloat(shortTerm.toFixed(2)),
    change: parseFloat(change.toFixed(2)),
    acceleration: parseFloat(acceleration.toFixed(2)),
    direction,
    strength,
    accelerationDirection: acceleration > 0.05 ? 'ACCELERATING' : acceleration < -0.05 ? 'DECELERATING' : 'STABLE',
  };
}

// ──────────────────────────────────────────────────────────────
//  VOLUME
// ──────────────────────────────────────────────────────────────

export function calcVolume(candles, lookback = 20) {
  if (candles.length < lookback + 1) {
    return { current: 0, average: 0, ratio: 1, expansion: 'NORMAL' };
  }

  const currentVol = candles[candles.length - 1].volume;
  const recentVols = candles.slice(-lookback - 1, -1);
  const avgVol = recentVols.reduce((sum, c) => sum + c.volume, 0) / lookback;
  const ratio = avgVol > 0 ? currentVol / avgVol : 1;

  // Volume expansion classification
  let expansion = 'NORMAL';
  if (ratio > 2.0) expansion = 'EXPANDING';
  else if (ratio > 1.5) expansion = 'ELEVATED';
  else if (ratio < 0.5) expansion = 'LOW';

  return {
    current: parseFloat(currentVol.toFixed(2)),
    average: parseFloat(avgVol.toFixed(2)),
    ratio: parseFloat(ratio.toFixed(2)),
    expansion,
  };
}

// ──────────────────────────────────────────────────────────────
//  VOLATILITY
// ──────────────────────────────────────────────────────────────

export function calcVolatility(candles, lookback = 20) {
  if (candles.length < lookback + 1) {
    return { pct: 0, current: 0, direction: 'STABLE', expansion: 'NORMAL' };
  }

  // Current volatility = ATR-like measure
  const recentCandles = candles.slice(-lookback);
  const trueRanges = recentCandles.map((c, i) => {
    if (i === 0) return c.range;
    const prevClose = candles[candles.length - lookback + i - 1].close;
    return Math.max(c.range, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
  });

  const currentATR = trueRanges.reduce((s, tr) => s + tr, 0) / lookback;
  const currentPrice = candles[candles.length - 1].close;
  const volPct = (currentATR / currentPrice) * 100;

  // Previous volatility for comparison
  const prevCandles = candles.slice(-lookback * 2, -lookback);
  let prevATR = currentATR;
  if (prevCandles.length >= lookback) {
    const prevTR = prevCandles.map((c, i) => {
      if (i === 0) return c.range;
      const prevClose = prevCandles[i - 1].close;
      return Math.max(c.range, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
    });
    prevATR = prevTR.reduce((s, tr) => s + tr, 0) / lookback;
  }

  const volChange = ((currentATR - prevATR) / prevATR) * 100;

  let direction = 'STABLE';
  if (volChange > 15) direction = 'EXPANDING';
  else if (volChange < -15) direction = 'CONTRACTING';

  let expansion = 'NORMAL';
  if (volPct > 3) expansion = 'HIGH';
  else if (volPct > 1.5) expansion = 'ELEVATED';
  else if (volPct < 0.5) expansion = 'LOW';

  return {
    pct: parseFloat(volPct.toFixed(2)),
    current: parseFloat(currentATR.toFixed(6)),
    previous: parseFloat(prevATR.toFixed(6)),
    direction,
    expansion,
    changePct: parseFloat(volChange.toFixed(2)),
  };
}

// ──────────────────────────────────────────────────────────────
//  TREND (Moving Averages)
// ──────────────────────────────────────────────────────────────

export function calcTrend(candles) {
  if (candles.length < 50) {
    return {
      direction: 'NEUTRAL',
      strength: 0,
      ma9: 0,
      ma21: 0,
      ma50: 0,
      alignment: 'NEUTRAL',
    };
  }

  const closes = candles.map((c) => c.close);
  const currentPrice = closes[closes.length - 1];

  const ma9 = sma(closes, 9);
  const ma21 = sma(closes, 21);
  const ma50 = sma(closes, 50);

  // MA alignment
  let alignment = 'NEUTRAL';
  if (ma9 > ma21 && ma21 > ma50) alignment = 'BULLISH_STACKED';
  else if (ma9 > ma21 && ma21 < ma50) alignment = 'BULLISH_PARTIAL';
  else if (ma9 < ma21 && ma21 < ma50) alignment = 'BEARISH_STACKED';
  else if (ma9 < ma21 && ma21 > ma50) alignment = 'BEARISH_PARTIAL';

  // Trend direction from MA relationship
  let direction = 'NEUTRAL';
  if (currentPrice > ma9 && ma9 > ma21) direction = 'BULLISH';
  else if (currentPrice < ma9 && ma9 < ma21) direction = 'BEARISH';

  // Trend strength — how far price is from MAs, normalized
  const spread = Math.abs(currentPrice - ma21) / ma21 * 100;
  const strength = Math.min(100, Math.round(spread * 10));

  return {
    direction,
    strength,
    ma9: parseFloat(ma9.toFixed(6)),
    ma21: parseFloat(ma21.toFixed(6)),
    ma50: parseFloat(ma50.toFixed(6)),
    alignment,
    priceVsMA9: currentPrice > ma9 ? 'ABOVE' : 'BELOW',
    priceVsMA21: currentPrice > ma21 ? 'ABOVE' : 'BELOW',
    priceVsMA50: currentPrice > ma50 ? 'ABOVE' : 'BELOW',
  };
}

// ──────────────────────────────────────────────────────────────
//  REGIME (Market Classification)
// ──────────────────────────────────────────────────────────────

export function calcRegime(candles) {
  if (candles.length < 50) {
    return { classification: 'RANGE', ma10: 0, ma30: 0, ma50: 0, slope: 'FLAT' };
  }

  const closes = candles.map((c) => c.close);
  const ma10 = sma(closes, 10);
  const ma30 = sma(closes, 30);
  const ma50 = sma(closes, 50);

  // Slope of MA30 (trend direction)
  const prevMA30 = sma(closes.slice(0, -5), 30);
  const slope = ma30 > prevMA30 ? 'UP' : ma30 < prevMA30 ? 'DOWN' : 'FLAT';

  // Volatility for regime classification
  const recentRanges = candles.slice(-20).map((c) => c.range / c.close);
  const avgRange = recentRanges.reduce((s, r) => s + r, 0) / recentRanges.length;

  // Classification
  let classification = 'RANGE';
  const price = closes[closes.length - 1];

  if (ma10 > ma30 && ma30 > ma50 && slope === 'UP') {
    classification = avgRange > 0.015 ? 'TRENDING_BULL' : 'BULL';
  } else if (ma10 < ma30 && ma30 < ma50 && slope === 'DOWN') {
    classification = avgRange > 0.015 ? 'TRENDING_BEAR' : 'BEAR';
  } else if (Math.abs(ma10 - ma30) / ma30 < 0.003 && Math.abs(ma30 - ma50) / ma50 < 0.005) {
    classification = 'RANGE';
  } else if (slope === 'UP' && price > ma50) {
    classification = 'BULL';
  } else if (slope === 'DOWN' && price < ma50) {
    classification = 'BEAR';
  }

  return {
    classification,
    ma10: parseFloat(ma10.toFixed(6)),
    ma30: parseFloat(ma30.toFixed(6)),
    ma50: parseFloat(ma50.toFixed(6)),
    slope,
    volatility: parseFloat(avgRange.toFixed(4)),
  };
}

// ──────────────────────────────────────────────────────────────
//  MOMENTUM / TREND ALIGNMENT — Technical Direction
// ──────────────────────────────────────────────────────────────

/**
 * Combine all technical signals into a unified technical direction.
 * This is NOT the Brain's decision — it's one input among many.
 */
export function calcTechnicalDirection(rsi, momentum, volume, volatility, trend, regime) {
  let bullCount = 0;
  let bearCount = 0;
  const signals = [];

  // RSI
  if (rsi.momentumContext === 'BULLISH' || rsi.momentumContext === 'OVERBOUGHT') {
    if (rsi.direction === 'RISING') { bullCount++; signals.push({ name: 'RSI', value: rsi.value, direction: 'BULLISH', note: `${rsi.direction}` }); }
    else { signals.push({ name: 'RSI', value: rsi.value, direction: 'NEUTRAL', note: `${rsi.direction}` }); }
  } else if (rsi.momentumContext === 'BEARISH' || rsi.momentumContext === 'OVERSOLD') {
    if (rsi.direction === 'FALLING') { bearCount++; signals.push({ name: 'RSI', value: rsi.value, direction: 'BEARISH', note: `${rsi.direction}` }); }
    else { signals.push({ name: 'RSI', value: rsi.value, direction: 'NEUTRAL', note: `${rsi.direction}` }); }
  } else {
    signals.push({ name: 'RSI', value: rsi.value, direction: 'NEUTRAL', note: rsi.momentumContext });
  }

  // Momentum
  if (momentum.direction === 'BULLISH') {
    bullCount++;
    signals.push({ name: 'Momentum', value: momentum.shortTerm, direction: 'BULLISH', note: `${momentum.strength}% strength` });
  } else if (momentum.direction === 'BEARISH') {
    bearCount++;
    signals.push({ name: 'Momentum', value: momentum.shortTerm, direction: 'BEARISH', note: `${momentum.strength}% strength` });
  } else {
    signals.push({ name: 'Momentum', value: momentum.shortTerm, direction: 'NEUTRAL', note: 'flat' });
  }

  // Momentum acceleration
  if (momentum.accelerationDirection === 'ACCELERATING') {
    if (momentum.direction === 'BULLISH') { bullCount++; signals.push({ name: 'Momentum Change', value: momentum.acceleration, direction: 'BULLISH', note: 'accelerating' }); }
    else if (momentum.direction === 'BEARISH') { bearCount++; signals.push({ name: 'Momentum Change', value: momentum.acceleration, direction: 'BEARISH', note: 'accelerating' }); }
    else { signals.push({ name: 'Momentum Change', value: momentum.acceleration, direction: 'NEUTRAL', note: 'accelerating but flat' }); }
  } else if (momentum.accelerationDirection === 'DECELERATING') {
    signals.push({ name: 'Momentum Change', value: momentum.acceleration, direction: 'NEUTRAL', note: 'decelerating' });
  } else {
    signals.push({ name: 'Momentum Change', value: momentum.acceleration, direction: 'NEUTRAL', note: 'stable' });
  }

  // Volume
  if (volume.expansion === 'EXPANDING' || volume.expansion === 'ELEVATED') {
    // High volume confirms the current move
    const lastCandle = { isBullish: true }; // We don't have the candle here, but direction is from momentum
    if (momentum.direction === 'BULLISH') {
      bullCount++;
      signals.push({ name: 'Volume', value: `${volume.ratio}x avg`, direction: 'BULLISH', note: volume.expansion.toLowerCase() });
    } else if (momentum.direction === 'BEARISH') {
      bearCount++;
      signals.push({ name: 'Volume', value: `${volume.ratio}x avg`, direction: 'BEARISH', note: volume.expansion.toLowerCase() });
    } else {
      signals.push({ name: 'Volume', value: `${volume.ratio}x avg`, direction: 'NEUTRAL', note: volume.expansion.toLowerCase() });
    }
  } else if (volume.expansion === 'LOW') {
    signals.push({ name: 'Volume', value: `${volume.ratio}x avg`, direction: 'NEUTRAL', note: 'low volume' });
  } else {
    signals.push({ name: 'Volume', value: `${volume.ratio}x avg`, direction: 'NEUTRAL', note: 'normal' });
  }

  // Trend
  if (trend.direction === 'BULLISH') {
    bullCount++;
    signals.push({ name: '5m Trend', value: trend.alignment, direction: 'BULLISH', note: `${trend.strength}% strength` });
  } else if (trend.direction === 'BEARISH') {
    bearCount++;
    signals.push({ name: '5m Trend', value: trend.alignment, direction: 'BEARISH', note: `${trend.strength}% strength` });
  } else {
    signals.push({ name: '5m Trend', value: trend.alignment, direction: 'NEUTRAL', note: 'neutral' });
  }

  // Regime
  if (regime.classification === 'TRENDING_BULL' || regime.classification === 'BULL') {
    bullCount++;
    signals.push({ name: 'Regime', value: regime.classification, direction: 'BULLISH', note: regime.slope.toLowerCase() });
  } else if (regime.classification === 'TRENDING_BEAR' || regime.classification === 'BEAR') {
    bearCount++;
    signals.push({ name: 'Regime', value: regime.classification, direction: 'BEARISH', note: regime.slope.toLowerCase() });
  } else {
    signals.push({ name: 'Regime', value: regime.classification, direction: 'NEUTRAL', note: 'ranging' });
  }

  // Technical direction
  let direction = 'NEUTRAL';
  if (bullCount > bearCount && bullCount >= 3) direction = 'LONG';
  else if (bearCount > bullCount && bearCount >= 3) direction = 'SHORT';

  // Direction score (-100 to +100)
  const directionScore = ((bullCount - bearCount) / (bullCount + bearCount || 1)) * 100;

  // Base score (0-100)
  const baseScore = Math.min(100, Math.round(Math.max(bullCount, bearCount) * 14));

  // Technical conviction
  const conviction = Math.min(100, Math.round(Math.abs(directionScore)));

  return {
    direction,
    directionScore: parseFloat(directionScore.toFixed(0)),
    baseScore,
    conviction,
    bullCount,
    bearCount,
    signals,
  };
}

// ──────────────────────────────────────────────────────────────
//  CONTRADICTION DETECTION
// ──────────────────────────────────────────────────────────────

/**
 * Detect contradictions in technical evidence.
 * e.g., RSI near oversold while price is falling — downside may be exhausting.
 */
export function detectContradictions(rsi, momentum, volume, volatility, trend, regime, smc) {
  const contradictions = [];

  // RSI oversold while bearish → potential exhaustion
  if (rsi.momentumContext === 'OVERSOLD' && momentum.direction === 'BEARISH') {
    contradictions.push({
      indicator: 'RSI',
      note: 'RSI near oversold — downside may be exhausting',
      direction: 'BULLISH',
      weight: 1,
    });
  }

  // RSI overbought while bullish → potential exhaustion
  if (rsi.momentumContext === 'OVERBOUGHT' && momentum.direction === 'BULLISH') {
    contradictions.push({
      indicator: 'RSI',
      note: 'RSI near overbought — upside may be exhausting',
      direction: 'BEARISH',
      weight: 1,
    });
  }

  // Momentum decelerating while trend continues
  if (momentum.accelerationDirection === 'DECELERATING' && trend.strength > 50) {
    contradictions.push({
      indicator: 'Momentum Change',
      note: `Momentum decelerating while trend still strong — move may be losing steam`,
      direction: trend.direction === 'BULLISH' ? 'BEARISH' : 'BULLISH',
      weight: 1,
    });
  }

  // Low volume on a strong move
  if (volume.expansion === 'LOW' && momentum.strength > 40) {
    contradictions.push({
      indicator: 'Volume',
      note: 'Strong move on low volume — lack of participation',
      direction: 'NEUTRAL',
      weight: 1,
    });
  }

  // Volatility contracting while trending
  if (volatility.direction === 'CONTRACTING' && regime.classification.startsWith('TRENDING')) {
    contradictions.push({
      indicator: 'Volatility',
      note: 'Volatility contracting in a trending regime — potential reversal',
      direction: 'NEUTRAL',
      weight: 1,
    });
  }

  // Price approaching liquidity target (if SMC data available)
  if (smc?.liquidity?.liquidityTargets?.[0] && smc?.currentPrice) {
    const target = smc.liquidity.liquidityTargets[0];
    const dist = Math.abs((smc.currentPrice - target.level) / smc.currentPrice) * 100;
    if (dist < 1.0) {
      contradictions.push({
        indicator: 'Liquidity Target',
        note: `Price approaching liquidity target at ${target.level.toFixed(2)} (${dist.toFixed(2)}% away)`,
        direction: target.direction === 'UP' ? 'BULLISH' : 'BEARISH',
        weight: 2,
      });
    }
  }

  return contradictions;
}

// ──────────────────────────────────────────────────────────────
//  FULL TECHNICAL ANALYSIS
// ──────────────────────────────────────────────────────────────

export function analyzeTechnicals(candles, smcData = null) {
  const rsi = calcRSI(candles, 14);
  const momentum = calcMomentum(candles, 10, 20);
  const volume = calcVolume(candles, 20);
  const volatility = calcVolatility(candles, 20);
  const trend = calcTrend(candles);
  const regime = calcRegime(candles);

  const technicalDirection = calcTechnicalDirection(rsi, momentum, volume, volatility, trend, regime);
  const contradictions = detectContradictions(rsi, momentum, volume, volatility, trend, regime, smcData);

  // Build evidence list for the Brain
  const evidence = [];
  for (const sig of technicalDirection.signals) {
    if (sig.direction !== 'NEUTRAL') {
      evidence.push({
        source: 'Technical',
        item: `${sig.name} ${sig.value} ${sig.direction} (${sig.note})`,
        direction: sig.direction,
        weight: 1,
      });
    }
  }

  // Technical conclusion
  let techConclusion = 'NEUTRAL';
  if (technicalDirection.bullCount > technicalDirection.bearCount + 1) {
    techConclusion = 'BULLISH';
  } else if (technicalDirection.bearCount > technicalDirection.bullCount + 1) {
    techConclusion = 'BEARISH';
  }

  return {
    rsi,
    momentum,
    volume,
    volatility,
    trend,
    regime,
    technicalDirection,
    contradictions,
    evidence,
    technicalScore: technicalDirection.conviction,
    technicalBias: techConclusion,
    supportingCount: Math.max(technicalDirection.bullCount, technicalDirection.bearCount),
    contradictingCount: contradictions.length,
  };
}

// ──────────────────────────────────────────────────────────────
//  HELPERS
// ──────────────────────────────────────────────────────────────

function sma(values, period) {
  if (values.length < period) return values[values.length - 1] || 0;
  const slice = values.slice(-period);
  return slice.reduce((s, v) => s + v, 0) / period;
}

__FILE_EOF__

echo 'src/brain/thesisEngine.js'
mkdir -p \.
cat > 'src/brain/thesisEngine.js' << '__FILE_EOF__'
/**
 * Alchemist Brain — Thesis Engine
 *
 * The core reasoning system. NOT a simple scoring bot.
 *
 * Pipeline:
 *   Market Data + SMC + Smart Money + Technicals
 *     → Form Thesis
 *     → Gather Supporting Evidence
 *     → Gather Contradicting Evidence
 *     → Form Counter-Thesis
 *     → Compare Both Sides
 *     → Consult Memory
 *     → Risk Analysis
 *     → Conclusion (ENTER / WAIT / REJECT)
 *     → Score + Confidence (measurements, NOT the decision)
 */

import { Memory } from './memory.js';
import { RiskAnalyzer } from './riskAnalysis.js';

// ──────────────────────────────────────────────────────────────
//  THESIS ENGINE
// ──────────────────────────────────────────────────────────────

export class ThesisEngine {
  constructor(memory) {
    this.memory = memory || new Memory();
    this.riskAnalyzer = new RiskAnalyzer();
  }

  /**
   * Run the full thesis pipeline on one symbol's data.
   * Returns a complete Brain thesis for the scorecard.
   */
  evaluate(symbol, smcAnalysis, smartMoneyAnalysis, accountState, technicalAnalysis = null) {
    // ── 1. FORM PRIMARY THESIS ───────────────────────────────
    const primaryThesis = this._formThesis(smcAnalysis, smartMoneyAnalysis, technicalAnalysis);

    // ── 2. GATHER SUPPORTING EVIDENCE ────────────────────────
    const supporting = this._gatherSupporting(smcAnalysis, smartMoneyAnalysis, technicalAnalysis, primaryThesis.direction);

    // ── 3. GATHER CONTRADICTING EVIDENCE ─────────────────────
    const contradicting = this._gatherContradicting(smcAnalysis, smartMoneyAnalysis, technicalAnalysis, primaryThesis.direction);

    // ── 4. FORM COUNTER-THESIS ───────────────────────────────
    const counterThesis = this._formCounterThesis(smcAnalysis, smartMoneyAnalysis, technicalAnalysis, primaryThesis);

    // ── 5. COMPARE BOTH SIDES ────────────────────────────────
    const comparison = this._compareSides(supporting, contradicting, primaryThesis, counterThesis);

    // ── 6. CONSULT MEMORY ────────────────────────────────────
    const memoryResult = this.memory.lookup(symbol, primaryThesis.direction, smcAnalysis, smartMoneyAnalysis, technicalAnalysis);

    // ── 7. RISK ANALYSIS ─────────────────────────────────────
    const risk = this.riskAnalyzer.analyze(smcAnalysis, smartMoneyAnalysis, accountState);

    // ── 8. CONCLUSION ────────────────────────────────────────
    const conclusion = this._conclude(comparison, memoryResult, risk, primaryThesis, counterThesis);

    // ── 9. SCORES (measurements, not the decision) ───────────
    const scores = this._calculateScores(supporting, contradicting, comparison, conclusion);

    return {
      symbol,
      timestamp: Date.now(),
      primaryThesis,
      supporting,
      contradicting,
      counterThesis,
      comparison,
      memory: memoryResult,
      risk,
      conclusion,
      scores,
    };
  }

  // ═══════════════════════════════════════════════════════════
  //  THESIS FORMATION
  // ═══════════════════════════════════════════════════════════

  _formThesis(smc, smartMoney, tech = null) {
    const direction = this._determineDirection(smc, smartMoney, tech);
    const narrative = this._buildNarrative(smc, smartMoney, tech, direction);
    const invalidation = this._buildInvalidation(smc, direction);

    const conflict = this._computeConflict(smc, smartMoney, tech);

    return {
      direction,
      narrative,
      invalidation,
      smcBias: smc.smcBias,
      smartMoneyBias: smartMoney.fusion.direction,
      technicalBias: tech?.technicalBias || 'NEUTRAL',
      conflict,
    };
  }

  _computeConflict(smc, smartMoney, tech = null) {
    const smcSmart = smc.smcBias !== smartMoney.fusion.direction && smc.smcBias !== 'NEUTRAL' && smartMoney.fusion.direction !== 'NEUTRAL';
    const smcTech = tech && tech.technicalBias !== 'NEUTRAL' && smc.smcBias !== 'NEUTRAL' && tech.technicalBias !== smc.smcBias;
    const smTech = tech && tech.technicalBias !== 'NEUTRAL' && smartMoney.fusion.direction !== 'NEUTRAL' && tech.technicalBias !== smartMoney.fusion.direction;
    return smcSmart || smcTech || smTech;
  }

  _determineDirection(smc, smartMoney, tech = null) {
    const biases = [smc.smcBias, smartMoney.fusion.direction];
    if (tech) biases.push(tech.technicalBias);

    const bullVotes = biases.filter((b) => b === 'BULLISH').length;
    const bearVotes = biases.filter((b) => b === 'BEARISH').length;

    // All agree → strong signal
    if (bullVotes === biases.length) return 'BULLISH';
    if (bearVotes === biases.length) return 'BEARISH';

    // Majority (2 of 3)
    if (bullVotes >= 2 && bearVotes === 0) return 'BULLISH';
    if (bearVotes >= 2 && bullVotes === 0) return 'BEARISH';

    // 2 vs 1 conflict — lean toward SMC (price action is truth)
    if (smc.smcBias !== 'NEUTRAL') return smc.smcBias;
    if (smartMoney.fusion.direction !== 'NEUTRAL') return smartMoney.fusion.direction;
    if (tech?.technicalBias && tech.technicalBias !== 'NEUTRAL') return tech.technicalBias;

    return 'NEUTRAL';
  }

  _buildNarrative(smc, smartMoney, tech = null, direction) {
    const parts = [];

    if (direction === 'BEARISH') {
      // Build bearish narrative
      if (smc.liquidity.sweep?.direction === 'ABOVE') {
        parts.push('Price engineered a bullish liquidity grab above the previous high.');
      }
      if (smc.breakout.failed && smc.breakout.direction === 'BULLISH') {
        parts.push('The bullish breakout failed.');
      }
      if (smc.displacement.detected && smc.displacement.direction === 'BEARISH') {
        parts.push('Bearish displacement followed.');
      }
      if (smc.bos.detected && smc.bos.direction === 'BEARISH') {
        parts.push('Structure subsequently broke bearish.');
      }
      if (smc.breakout.retestHeld && smc.breakout.direction === 'BEARISH') {
        parts.push('Bearish retest held.');
      }
      if (smartMoney.fusion.direction === 'BEARISH') {
        if (smartMoney.topTraders.direction === 'BEARISH') {
          parts.push(`Large accounts are net-short (${smartMoney.topTraders.shortPct}% short).`);
        }
        if (smartMoney.derivatives.takerFlow.direction === 'BEARISH') {
          parts.push('Taker flow is negative.');
        }
        if (smartMoney.derivatives.funding.direction === 'BEARISH') {
          parts.push('Derivatives flow supports the move.');
        }
      }
      if (smc.fvg.current?.direction === 'BEARISH' && !smc.fvg.current.fullyFilled) {
        parts.push('Unfilled bearish FVG provides target.');
      }
    } else if (direction === 'BULLISH') {
      if (smc.liquidity.sweep?.direction === 'BELOW') {
        parts.push('Price engineered a bearish liquidity grab below the previous low.');
      }
      if (smc.breakout.failed && smc.breakout.direction === 'BEARISH') {
        parts.push('The bearish breakout failed.');
      }
      if (smc.displacement.detected && smc.displacement.direction === 'BULLISH') {
        parts.push('Bullish displacement followed.');
      }
      if (smc.bos.detected && smc.bos.direction === 'BULLISH') {
        parts.push('Structure subsequently broke bullish.');
      }
      if (smc.breakout.retestHeld && smc.breakout.direction === 'BULLISH') {
        parts.push('Bullish retest held.');
      }
      if (smartMoney.fusion.direction === 'BULLISH') {
        if (smartMoney.topTraders.direction === 'BULLISH') {
          parts.push(`Large accounts are net-long (${smartMoney.topTraders.longPct}% long).`);
        }
        if (smartMoney.derivatives.takerFlow.direction === 'BULLISH') {
          parts.push('Taker flow is positive.');
        }
        if (smartMoney.derivatives.funding.direction === 'BULLISH') {
          parts.push('Funding environment is supportive.');
        }
      }
      if (smc.fvg.current?.direction === 'BULLISH' && !smc.fvg.current.fullyFilled) {
        parts.push('Unfilled bullish FVG provides target.');
      }
    } else {
      parts.push('Market structure and smart money signals are conflicting or insufficient for a directional thesis.');
    }

    // ── Technical evidence in narrative ────────────────────
    if (tech && direction !== 'NEUTRAL') {
      const techDir = direction === 'BEARISH' ? 'BEARISH' : 'BULLISH';
      const matchingSignals = tech.technicalDirection.signals.filter((s) => s.direction === techDir);
      if (matchingSignals.length >= 3) {
        parts.push(`Technical engine confirms: ${matchingSignals.length} of ${tech.technicalDirection.signals.length} signals align ${techDir.toLowerCase()}.`);
      } else if (matchingSignals.length <= 1) {
        parts.push(`Technical engine diverges: only ${matchingSignals.length} signal(s) align with thesis.`);
      }
      if (tech.contradictions.length > 0) {
        parts.push(`However, ${tech.contradictions.length} technical contradiction(s) detected.`);
      }
    }

    return parts.join(' ');
  }

  _buildInvalidation(smc, direction) {
    if (direction === 'BEARISH') {
      const protectedHigh = smc.protectedLevels.protectedHigh;
      if (protectedHigh) {
        return `Price reclaims ${protectedHigh.price} and smart-money positioning begins reversing → bearish thesis invalidated.`;
      }
      return 'Price reclaims recent structural high and smart-money positioning reverses.';
    }
    if (direction === 'BULLISH') {
      const protectedLow = smc.protectedLevels.protectedLow;
      if (protectedLow) {
        return `Price loses ${protectedLow.price} and smart-money positioning begins reversing → bullish thesis invalidated.`;
      }
      return 'Price loses recent structural low and smart-money positioning reverses.';
    }
    return 'N/A — no directional thesis to invalidate.';
  }

  // ═══════════════════════════════════════════════════════════
  //  EVIDENCE GATHERING
  // ═══════════════════════════════════════════════════════════

  _gatherSupporting(smc, smartMoney, tech = null, direction) {
    const evidence = [];

    // SMC supporting evidence
    if (direction === 'BEARISH') {
      if (smc.structure.bias === 'BEARISH') evidence.push({ source: 'SMC', item: 'Bearish market structure (LH → LL)', weight: 2 });
      if (smc.bos.detected && smc.bos.direction === 'BEARISH') evidence.push({ source: 'SMC', item: `BOS SHORT confirmed at ${smc.bos.brokenLevel}`, weight: 2 });
      if (smc.liquidity.sweep?.direction === 'ABOVE') evidence.push({ source: 'SMC', item: `Liquidity sweep above ${smc.liquidity.sweep.location} (${smc.liquidity.sweep.strength}% strength)`, weight: 2 });
      if (smc.displacement.detected && smc.displacement.direction === 'BEARISH') evidence.push({ source: 'SMC', item: `Bearish displacement (${smc.displacement.strength}% strength, ${smc.displacement.rangeRatio.toFixed(1)}x avg range)`, weight: 1 });
      if (smc.fvg.current?.direction === 'BEARISH' && !smc.fvg.current.fullyFilled) evidence.push({ source: 'SMC', item: `Unfilled bearish FVG at ${smc.fvg.current.lowerBoundary}-${smc.fvg.current.upperBoundary}`, weight: 1 });
      if (smc.breakout.failed && smc.breakout.direction === 'BULLISH') evidence.push({ source: 'SMC', item: 'Failed bullish breakout', weight: 2 });
      if (smc.breakout.retestHeld && smc.breakout.direction === 'BEARISH') evidence.push({ source: 'SMC', item: 'Bearish retest held', weight: 1 });
      if (smc.choch.detected && smc.choch.direction === 'BEARISH') evidence.push({ source: 'SMC', item: 'Bearish CHOCH (reversal signal)', weight: 2 });
    } else if (direction === 'BULLISH') {
      if (smc.structure.bias === 'BULLISH') evidence.push({ source: 'SMC', item: 'Bullish market structure (HL → HH)', weight: 2 });
      if (smc.bos.detected && smc.bos.direction === 'BULLISH') evidence.push({ source: 'SMC', item: `BOS LONG confirmed at ${smc.bos.brokenLevel}`, weight: 2 });
      if (smc.liquidity.sweep?.direction === 'BELOW') evidence.push({ source: 'SMC', item: `Liquidity sweep below ${smc.liquidity.sweep.location} (${smc.liquidity.sweep.strength}% strength)`, weight: 2 });
      if (smc.displacement.detected && smc.displacement.direction === 'BULLISH') evidence.push({ source: 'SMC', item: `Bullish displacement (${smc.displacement.strength}% strength, ${smc.displacement.rangeRatio.toFixed(1)}x avg range)`, weight: 1 });
      if (smc.fvg.current?.direction === 'BULLISH' && !smc.fvg.current.fullyFilled) evidence.push({ source: 'SMC', item: `Unfilled bullish FVG at ${smc.fvg.current.lowerBoundary}-${smc.fvg.current.upperBoundary}`, weight: 1 });
      if (smc.breakout.failed && smc.breakout.direction === 'BEARISH') evidence.push({ source: 'SMC', item: 'Failed bearish breakout', weight: 2 });
      if (smc.breakout.retestHeld && smc.breakout.direction === 'BULLISH') evidence.push({ source: 'SMC', item: 'Bullish retest held', weight: 1 });
      if (smc.choch.detected && smc.choch.direction === 'BULLISH') evidence.push({ source: 'SMC', item: 'Bullish CHOCH (reversal signal)', weight: 2 });
    }

    // Smart Money supporting evidence
    if (direction === 'BEARISH' || direction === 'BULLISH') {
      const smDir = direction === 'BEARISH' ? 'BEARISH' : 'BULLISH';
      if (smartMoney.fusion.direction === smDir) {
        if (smartMoney.topTraders.direction === smDir) {
          evidence.push({ source: 'Smart Money', item: `Top traders ${smDir.toLowerCase()} (${smartMoney.topTraders.longPct}%L / ${smartMoney.topTraders.shortPct}%S)`, weight: 2 });
        }
        for (const change of smartMoney.topTraders.changes) {
          if ((direction === 'BEARISH' && change.type === 'INCREASING_SHORT') ||
              (direction === 'BULLISH' && change.type === 'INCREASING_LONG')) {
            evidence.push({ source: 'Smart Money', item: `Top traders ${change.type.replace('_', ' ').toLowerCase()} (+${(change.value * 100).toFixed(1)}%)`, weight: 1 });
          }
        }
        if (smartMoney.derivatives.takerFlow.direction === smDir) {
          evidence.push({ source: 'Smart Money', item: `Taker flow ${smDir.toLowerCase()} (${smartMoney.derivatives.takerFlow.avgBuySellRatio})`, weight: 1 });
        }
        if (smartMoney.derivatives.funding.direction === smDir) {
          evidence.push({ source: 'Smart Money', item: `Funding ${smDir.toLowerCase()} (${smartMoney.derivatives.funding.annualizedPct}% ann.)`, weight: 1 });
        }
        if (smartMoney.fusion.flowAlignment === 'STRONG') {
          evidence.push({ source: 'Smart Money', item: 'Strong flow alignment', weight: 1 });
        }
      }
    }

    // Technical supporting evidence
    if (tech && (direction === 'BEARISH' || direction === 'BULLISH')) {
      const techDir = direction === 'BEARISH' ? 'BEARISH' : 'BULLISH';
      for (const sig of tech.technicalDirection.signals) {
        if (sig.direction === techDir) {
          evidence.push({ source: 'Technical', item: `${sig.name} ${sig.value} ${sig.direction} (${sig.note})`, weight: 1 });
        }
      }
      // Technical conviction boost
      if (tech.technicalDirection.conviction > 70 && tech.technicalDirection.direction === techDir) {
        evidence.push({ source: 'Technical', item: `High technical conviction (${tech.technicalDirection.conviction}%)`, weight: 1 });
      }
      // Volume confirms
      if (tech.volume.expansion === 'EXPANDING' && tech.momentum.direction === techDir) {
        evidence.push({ source: 'Technical', item: `Volume expanding (${tech.volume.ratio}x avg) confirms move`, weight: 1 });
      }
      // Regime confirms
      if ((direction === 'BEARISH' && (tech.regime.classification === 'BEAR' || tech.regime.classification === 'TRENDING_BEAR')) ||
          (direction === 'BULLISH' && (tech.regime.classification === 'BULL' || tech.regime.classification === 'TRENDING_BULL'))) {
        evidence.push({ source: 'Technical', item: `Regime ${tech.regime.classification} confirms thesis`, weight: 1 });
      }
    }

    return evidence;
  }

  _gatherContradicting(smc, smartMoney, tech = null, direction) {
    const evidence = [];

    // SMC contradicting evidence
    if (direction === 'BEARISH') {
      if (smc.structure.bias === 'BULLISH') evidence.push({ source: 'SMC', item: 'Structure is still bullish (HL → HH)', weight: 2 });
      if (smc.choch.detected && smc.choch.direction === 'BULLISH') evidence.push({ source: 'SMC', item: 'Bullish CHOCH detected — potential reversal', weight: 2 });
      if (smc.bos.detected && smc.bos.direction === 'BULLISH') evidence.push({ source: 'SMC', item: 'Bullish BOS also present', weight: 1 });
      if (smc.fvg.current?.direction === 'BULLISH' && !smc.fvg.current.fullyFilled) evidence.push({ source: 'SMC', item: 'Unfilled bullish FVG below (may attract price)', weight: 1 });
      if (smc.displacement.detected && smc.displacement.direction === 'BULLISH') evidence.push({ source: 'SMC', item: 'Latest displacement is bullish', weight: 1 });
    } else if (direction === 'BULLISH') {
      if (smc.structure.bias === 'BEARISH') evidence.push({ source: 'SMC', item: 'Structure is still bearish (LH → LL)', weight: 2 });
      if (smc.choch.detected && smc.choch.direction === 'BEARISH') evidence.push({ source: 'SMC', item: 'Bearish CHOCH detected — potential reversal', weight: 2 });
      if (smc.bos.detected && smc.bos.direction === 'BEARISH') evidence.push({ source: 'SMC', item: 'Bearish BOS also present', weight: 1 });
      if (smc.fvg.current?.direction === 'BEARISH' && !smc.fvg.current.fullyFilled) evidence.push({ source: 'SMC', item: 'Unfilled bearish FVG above (may attract price)', weight: 1 });
      if (smc.displacement.detected && smc.displacement.direction === 'BEARISH') evidence.push({ source: 'SMC', item: 'Latest displacement is bearish', weight: 1 });
    }

    // Smart Money contradicting evidence
    const oppositeDir = direction === 'BEARISH' ? 'BULLISH' : 'BULLISH';
    if (smartMoney.fusion.direction === oppositeDir && direction !== 'NEUTRAL') {
      if (smartMoney.topTraders.direction === oppositeDir) {
        evidence.push({ source: 'Smart Money', item: `Top traders ${oppositeDir.toLowerCase()} — diverging from thesis`, weight: 2 });
      }
      if (smartMoney.derivatives.takerFlow.direction === oppositeDir) {
        evidence.push({ source: 'Smart Money', item: `Taker flow ${oppositeDir.toLowerCase()} — contradicting`, weight: 1 });
      }
      if (smartMoney.derivatives.funding.direction === oppositeDir) {
        evidence.push({ source: 'Smart Money', item: `Funding ${oppositeDir.toLowerCase()} — contradicting`, weight: 1 });
      }
    }

    // Divergence between top traders and retail
    if (Math.abs(smartMoney.topTraders.divergence) > 0.15) {
      const divDir = smartMoney.topTraders.divergence > 0 ? 'BULLISH' : 'BEARISH';
      if (divDir !== direction) {
        evidence.push({ source: 'Smart Money', item: `Top traders diverge from retail (${divDir.toLowerCase()} edge)`, weight: 1 });
      }
    }

    // OI unwinding = uncertainty
    if (smartMoney.derivatives.openInterest.trend === 'DECLINING') {
      evidence.push({ source: 'Smart Money', item: 'Open interest declining — positions unwinding', weight: 1 });
    }

    // Technical contradicting evidence
    if (tech && direction !== 'NEUTRAL') {
      const oppositeTechDir = direction === 'BEARISH' ? 'BULLISH' : 'BEARISH';
      // Signals that oppose the thesis
      for (const sig of tech.technicalDirection.signals) {
        if (sig.direction === oppositeTechDir) {
          evidence.push({ source: 'Technical', item: `${sig.name} ${sig.value} ${sig.direction} — contradicting (${sig.note})`, weight: 1 });
        }
      }
      // Technical contradictions (exhaustion, divergence, etc.)
      for (const contra of tech.contradictions) {
        if (contra.direction === oppositeTechDir || contra.direction === 'NEUTRAL') {
          evidence.push({ source: 'Technical', item: contra.note, weight: contra.weight });
        }
      }
      // Technical bias opposes thesis
      if (tech.technicalBias === oppositeTechDir) {
        evidence.push({ source: 'Technical', item: `Technical conclusion is ${oppositeTechDir.toLowerCase()} — diverges from thesis`, weight: 2 });
      }
    }

    return evidence;
  }

  // ═══════════════════════════════════════════════════════════
  //  COUNTER-THESIS
  // ═══════════════════════════════════════════════════════════

  _formCounterThesis(smc, smartMoney, tech = null, primaryThesis) {
    if (primaryThesis.direction === 'NEUTRAL') {
      return {
        direction: 'NEUTRAL',
        narrative: 'No counter-thesis — primary thesis is neutral.',
        evidence: [],
      };
    }

    const oppositeDir = primaryThesis.direction === 'BEARISH' ? 'BULLISH' : 'BEARISH';
    const parts = [];

    // Build the counter-narrative from contradicting signals
    if (primaryThesis.direction === 'BEARISH') {
      // Bullish counter-thesis
      if (smc.protectedLevels.protectedLow && smc.currentPrice > smc.protectedLevels.protectedLow.price) {
        parts.push(`Price is still above protected low at ${smc.protectedLevels.protectedLow.price}.`);
      }
      if (smartMoney.topTraders.direction === 'BULLISH') {
        parts.push(`Top traders are net-long (${smartMoney.topTraders.longPct}%).`);
      }
      if (smartMoney.derivatives.funding.direction === 'BULLISH') {
        parts.push('Funding suggests shorts are crowded (bullish contrarian).');
      }
      if (smartMoney.derivatives.openInterest.trend === 'DECLINING') {
        parts.push('OI is declining — the bearish move may be exhaustion, not continuation.');
      }
      if (smc.structure.bias === 'BULLISH') {
        parts.push('Higher-timeframe structure remains bullish.');
      }
      // Technical counter-thesis (bullish)
      if (tech) {
        if (tech.rsi.momentumContext === 'OVERSOLD') {
          parts.push(`RSI is oversold at ${tech.rsi.value} — downside may be exhausted.`);
        }
        if (tech.momentum.accelerationDirection === 'DECELERATING' && tech.momentum.direction === 'BEARISH') {
          parts.push('Bearish momentum is decelerating — move losing steam.');
        }
        if (tech.regime.classification === 'BULL' || tech.regime.classification === 'TRENDING_BULL') {
          parts.push(`Regime is ${tech.regime.classification.toLowerCase()} — higher-timeframe context is bullish.`);
        }
        if (tech.trend.direction === 'BULLISH') {
          parts.push(`5m trend is bullish (${tech.trend.alignment.toLowerCase().replace('_', ' ')}).`);
        }
        for (const contra of tech.contradictions) {
          if (contra.direction === 'BULLISH') {
            parts.push(contra.note);
          }
        }
      }
    } else {
      // Bearish counter-thesis
      if (smc.protectedLevels.protectedHigh && smc.currentPrice < smc.protectedLevels.protectedHigh.price) {
        parts.push(`Price is still below protected high at ${smc.protectedLevels.protectedHigh.price}.`);
      }
      if (smartMoney.topTraders.direction === 'BEARISH') {
        parts.push(`Top traders are net-short (${smartMoney.topTraders.shortPct}%).`);
      }
      if (smartMoney.derivatives.funding.direction === 'BEARISH') {
        parts.push('Funding suggests longs are crowded (bearish contrarian).');
      }
      if (smartMoney.derivatives.openInterest.trend === 'DECLINING') {
        parts.push('OI is declining — the bullish move may be exhaustion, not continuation.');
      }
      if (smc.structure.bias === 'BEARISH') {
        parts.push('Higher-timeframe structure remains bearish.');
      }
      // Technical counter-thesis (bearish)
      if (tech) {
        if (tech.rsi.momentumContext === 'OVERBOUGHT') {
          parts.push(`RSI is overbought at ${tech.rsi.value} — upside may be exhausted.`);
        }
        if (tech.momentum.accelerationDirection === 'DECELERATING' && tech.momentum.direction === 'BULLISH') {
          parts.push('Bullish momentum is decelerating — move losing steam.');
        }
        if (tech.regime.classification === 'BEAR' || tech.regime.classification === 'TRENDING_BEAR') {
          parts.push(`Regime is ${tech.regime.classification.toLowerCase()} — higher-timeframe context is bearish.`);
        }
        if (tech.trend.direction === 'BEARISH') {
          parts.push(`5m trend is bearish (${tech.trend.alignment.toLowerCase().replace('_', ' ')}).`);
        }
        for (const contra of tech.contradictions) {
          if (contra.direction === 'BEARISH') {
            parts.push(contra.note);
          }
        }
      }
    }

    if (parts.length === 0) {
      parts.push(`No strong evidence for ${oppositeDir.toLowerCase()} counter-thesis at this time.`);
    }

    return {
      direction: oppositeDir,
      narrative: parts.join(' '),
      evidence: parts,
    };
  }

  // ═══════════════════════════════════════════════════════════
  //  COMPARISON
  // ═══════════════════════════════════════════════════════════

  _compareSides(supporting, contradicting, primaryThesis, counterThesis) {
    const supportingWeight = supporting.reduce((sum, e) => sum + e.weight, 0);
    const contradictingWeight = contradicting.reduce((sum, e) => sum + e.weight, 0);
    const total = supportingWeight + contradictingWeight;

    const supportingRatio = total > 0 ? supportingWeight / total : 0.5;
    const contradictingRatio = total > 0 ? contradictingWeight / total : 0.5;

    // Conflict score: 0 = perfect alignment, 100 = maximum conflict
    const conflictScore = total > 0 ? Math.round(contradictingRatio * 100) : 50;

    // Confluence: how much the evidence agrees
    const confluence = total > 0 ? Math.round(supportingRatio * 100) : 50;

    let verdict;
    if (supportingWeight > contradictingWeight * 2) {
      verdict = 'STRONG_ADVANTAGE';
    } else if (supportingWeight > contradictingWeight) {
      verdict = 'MODERATE_ADVANTAGE';
    } else if (contradictingWeight > supportingWeight) {
      verdict = 'COUNTER_ADVANTAGE';
    } else {
      verdict = 'BALANCED';
    }

    return {
      supportingWeight,
      contradictingWeight,
      supportingRatio: parseFloat(supportingRatio.toFixed(2)),
      contradictingRatio: parseFloat(contradictingRatio.toFixed(2)),
      conflictScore,
      confluence,
      verdict,
    };
  }

  // ═══════════════════════════════════════════════════════════
  //  CONCLUSION
  // ═══════════════════════════════════════════════════════════

  _conclude(comparison, memoryResult, risk, primaryThesis, counterThesis) {
    const { minBrainScore, minConfidence, maxConflict } = this._getThresholds();

    let decision = 'WAIT';
    let reason = '';

    // REJECT if thesis is neutral
    if (primaryThesis.direction === 'NEUTRAL') {
      decision = 'REJECT';
      reason = 'No directional thesis — insufficient evidence for a trade.';
    }
    // REJECT if conflict is too high
    else if (comparison.conflictScore > maxConflict) {
      decision = 'REJECT';
      reason = `Conflict too high (${comparison.conflictScore}%) — evidence disagrees. Wait for clarity.`;
    }
    // REJECT if risk is too high
    else if (risk.approved === false && risk.reason !== 'INSUFFICIENT_BALANCE') {
      decision = 'REJECT';
      reason = `Risk rejected: ${risk.reason}`;
    }
    // WAIT if evidence is balanced
    else if (comparison.verdict === 'BALANCED' || comparison.verdict === 'COUNTER_ADVANTAGE') {
      decision = 'WAIT';
      reason = `Evidence is ${comparison.verdict === 'BALANCED' ? 'balanced' : 'counter-thesis has advantage'} — waiting for stronger confirmation.`;
    }
    // WAIT if memory warns against this pattern
    else if (memoryResult.recommendation === 'AVOID') {
      decision = 'WAIT';
      reason = `Memory: similar setups have underperformed (${memoryResult.winRate}% win rate, ${memoryResult.sampleSize} trades).`;
    }
    // WAIT if brain score is below threshold
    else if (comparison.confluence < minBrainScore) {
      decision = 'WAIT';
      reason = `Brain score ${comparison.confluence} below threshold ${minBrainScore}.`;
    }
    // ENTER if all checks pass
    else if (comparison.verdict === 'STRONG_ADVANTAGE' || comparison.verdict === 'MODERATE_ADVANTAGE') {
      decision = 'ENTER';
      reason = `${comparison.verdict.replace('_', ' ')} for ${primaryThesis.direction} thesis. Score: ${comparison.confluence}, Conflict: ${comparison.conflictScore}.`;
    }

    return {
      decision,
      reason,
      direction: decision === 'ENTER' ? primaryThesis.direction : null,
      confidence: this._calculateConfidence(comparison, memoryResult, risk, decision),
    };
  }

  _calculateConfidence(comparison, memoryResult, risk, decision) {
    let confidence = comparison.confluence;

    // Adjust for memory
    if (memoryResult.recommendation === 'SUPPORT') {
      confidence += 5;
    } else if (memoryResult.recommendation === 'AVOID') {
      confidence -= 15;
    }

    // Adjust for risk
    if (risk.approved === false) {
      confidence -= 20;
    }

    // Adjust for conflict
    confidence -= comparison.conflictScore * 0.3;

    return Math.max(0, Math.min(100, Math.round(confidence)));
  }

  _calculateScores(supporting, contradicting, comparison, conclusion) {
    const brainScore = comparison.confluence;
    const confidence = conclusion.confidence;
    const conflict = comparison.conflictScore;

    return { brainScore, confidence, conflict };
  }

  _getThresholds() {
    // Could be loaded from config
    return {
      minBrainScore: 60,
      minConfidence: 65,
      maxConflict: 40,
    };
  }
}

__FILE_EOF__

echo 'src/brain/memory.js'
mkdir -p \.
cat > 'src/brain/memory.js' << '__FILE_EOF__'
/**
 * Alchemist Brain — Memory & Learning System
 *
 * Stores trade results, learns from patterns, and feeds experience
 * back into the thesis engine.
 *
 * Storage: JSON file (Termux-friendly, no native deps needed).
 *
 * Learning modifies MANAGEMENT rules over time — not just
 * "did this setup win or lose" but "what exit behavior works best
 * for this type of setup."
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';

export class Memory {
  constructor(filePath = 'storage/memory.json') {
    this.filePath = filePath;
    this.data = this._load();
  }

  _load() {
    try {
      if (existsSync(this.filePath)) {
        return JSON.parse(readFileSync(this.filePath, 'utf-8'));
      }
    } catch (e) {
      console.error('[Memory] Failed to load:', e.message);
    }
    return {
      trades: [],          // Completed trade records
      patterns: {},         // Pattern → performance mapping
      managementRules: {    // Adaptive management parameters
        tp1Pct: 3.0,
        tp1SellPct: 30,
        breakevenAfterTP1: true,
        trailingStartPct: 2.0,
        trailingStepPct: 0.5,
        maxTrailingDistancePct: 3.0,
        trailingSensitivity: 1.0,
        // Learned adjustments
        adjustments: [],
      },
      learningStats: {
        totalTrades: 0,
        wins: 0,
        losses: 0,
        totalPnL: 0,
        avgWinPct: 0,
        avgLossPct: 0,
        bestSetup: null,
        worstSetup: null,
      },
    };
  }

  _save() {
    try {
      const dir = dirname(this.filePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
    } catch (e) {
      console.error('[Memory] Failed to save:', e.message);
    }
  }

  /**
   * Look up similar historical setups for the thesis engine.
   * Returns a recommendation: SUPPORT, NEUTRAL, or AVOID.
   */
  lookup(symbol, direction, smcAnalysis, smartMoneyAnalysis, techAnalysis = null) {
    const key = this._patternKey(symbol, direction, smcAnalysis, smartMoneyAnalysis, techAnalysis);
    const pattern = this.data.patterns[key];

    if (!pattern || pattern.sampleSize < 3) {
      return {
        found: false,
        recommendation: 'NEUTRAL',
        winRate: 0,
        sampleSize: 0,
        avgPnL: 0,
        notes: 'No similar historical setups found.',
      };
    }

    let recommendation = 'NEUTRAL';
    if (pattern.winRate >= 60 && pattern.sampleSize >= 5) {
      recommendation = 'SUPPORT';
    } else if (pattern.winRate <= 35 && pattern.sampleSize >= 5) {
      recommendation = 'AVOID';
    }

    return {
      found: true,
      recommendation,
      winRate: pattern.winRate,
      sampleSize: pattern.sampleSize,
      avgPnL: pattern.avgPnL,
      notes: pattern.notes || `${pattern.sampleSize} similar setups, ${pattern.winRate}% win rate.`,
    };
  }

  /**
   * Record a completed trade and update learning.
   */
  recordTrade(trade) {
    const record = {
      id: trade.id,
      symbol: trade.symbol,
      direction: trade.direction,
      entryPrice: trade.entryPrice,
      exitPrice: trade.exitPrice,
      entryTime: trade.entryTime,
      exitTime: trade.exitTime,
      pnlPct: trade.pnlPct,
      pnlUsd: trade.pnlUsd,
      result: trade.result, // 'WIN' | 'LOSS' | 'BREAKEVEN'
      thesis: trade.thesis,
      thesisDirection: trade.thesisDirection,
      smcSummary: trade.smcSummary,
      smartMoneySummary: trade.smartMoneySummary,
      managementActions: trade.managementActions || [],
      exitReason: trade.exitReason,
      pattern: trade.pattern,
      durationMin: trade.durationMin,
    };

    this.data.trades.push(record);
    this._updatePattern(record);
    this._updateStats();
    this._updateManagementRules(record);
    this._save();
  }

  _patternKey(symbol, direction, smc, smartMoney, tech = null) {
    // Create a pattern signature from the key features
    const features = [
      symbol,
      direction,
      smc.structure?.bias || 'unknown',
      smc.bos?.detected ? `${smc.bos.direction}_BOS` : 'no_bos',
      smc.liquidity?.sweep ? `sweep_${smc.liquidity.sweep.direction}` : 'no_sweep',
      smc.fvg?.current ? `fvg_${smc.fvg.current.direction}` : 'no_fvg',
      smartMoney?.fusion?.direction || 'neutral',
      smartMoney?.fusion?.flowAlignment || 'none',
      tech?.technicalBias || 'neutral',
      tech?.regime?.classification || 'unknown',
    ];
    return features.join('|');
  }

  _updatePattern(record) {
    const key = record.pattern || this._patternKey(record.symbol, record.direction, {}, {});
    if (!this.data.patterns[key]) {
      this.data.patterns[key] = {
        sampleSize: 0,
        wins: 0,
        losses: 0,
        totalPnL: 0,
        winRate: 0,
        avgPnL: 0,
        notes: '',
        trades: [],
      };
    }

    const p = this.data.patterns[key];
    p.sampleSize++;
    p.trades.push(record.id);

    if (record.result === 'WIN') {
      p.wins++;
      p.totalPnL += record.pnlPct;
    } else if (record.result === 'LOSS') {
      p.losses++;
      p.totalPnL += record.pnlPct; // negative
    }

    p.winRate = Math.round((p.wins / p.sampleSize) * 100);
    p.avgPnL = parseFloat((p.totalPnL / p.sampleSize).toFixed(2));
  }

  _updateStats() {
    const trades = this.data.trades;
    const wins = trades.filter((t) => t.result === 'WIN');
    const losses = trades.filter((t) => t.result === 'LOSS');

    this.data.learningStats = {
      totalTrades: trades.length,
      wins: wins.length,
      losses: losses.length,
      totalPnL: parseFloat(trades.reduce((s, t) => s + (t.pnlUsd || 0), 0).toFixed(2)),
      avgWinPct: wins.length > 0 ? parseFloat((wins.reduce((s, t) => s + t.pnlPct, 0) / wins.length).toFixed(2)) : 0,
      avgLossPct: losses.length > 0 ? parseFloat((losses.reduce((s, t) => s + t.pnlPct, 0) / losses.length).toFixed(2)) : 0,
    };

    // Find best/worst patterns (min 3 trades)
    const validPatterns = Object.entries(this.data.patterns).filter(([_, p]) => p.sampleSize >= 3);
    if (validPatterns.length > 0) {
      const sorted = validPatterns.sort((a, b) => b[1].avgPnL - a[1].avgPnL);
      this.data.learningStats.bestSetup = sorted[0][0];
      this.data.learningStats.worstSetup = sorted[sorted.length - 1][0];
    }
  }

  _updateManagementRules(record) {
    // Adaptive learning — progressively adjust management based on trade outcomes
    const actions = record.managementActions || [];
    const adjustment = {
      timestamp: Date.now(),
      tradeId: record.id,
      result: record.result,
      pnlPct: record.pnlPct,
      observations: [],
    };

    // Did TP1 hit? If so, was the 30% sell optimal?
    const tp1Hit = actions.some((a) => a.type === 'TP1_HIT');
    if (tp1Hit) {
      // If the runner portion was stopped at breakeven, maybe TP1 sell % should increase
      const runnerStopped = actions.some((a) => a.type === 'RUNNER_STOPPED' && a.reason === 'BREAKEVEN');
      if (runnerStopped && record.result !== 'WIN') {
        adjustment.observations.push('Runner stopped at breakeven after TP1 — consider increasing TP1 sell % to 40%');
      }
    }

    // Did the trade hit full stop before TP1?
    if (record.result === 'LOSS' && !tp1Hit) {
      adjustment.observations.push('Full stop before TP1 — initial stoploss may be too tight for this pattern');
    }

    // Trailing stop analysis
    const trailed = actions.some((a) => a.type === 'TRAILED');
    if (trailed && record.result === 'WIN') {
      adjustment.observations.push('Trailing stop captured gains effectively');
    }

    if (adjustment.observations.length > 0) {
      this.data.managementRules.adjustments.push(adjustment);
    }
  }

  getManagementRules() {
    return this.data.managementRules;
  }

  getStats() {
    return this.data.learningStats;
  }

  getRecentTrades(limit = 10) {
    return this.data.trades.slice(-limit);
  }
}

__FILE_EOF__

echo 'src/brain/riskAnalysis.js'
mkdir -p \.
cat > 'src/brain/riskAnalysis.js' << '__FILE_EOF__'
/**
 * Alchemist Brain — Risk Analysis
 *
 * Evaluates whether a potential trade meets risk criteria.
 * Checks position sizing, stop loss placement, R:R ratio,
 * and account-level risk limits.
 */

export class RiskAnalyzer {
  constructor(config = null) {
    this.config = config || {
      riskPerTradePct: 1.0,
      initialStoplossPct: 3.0,
      tp1Pct: 3.0,
      minRR: 1.5,
      maxOpenPositions: 5,
      maxRiskPerSymbolPct: 3.0,
      maxDailyLossPct: 6.0,
    };
  }

  /**
   * Analyze risk for a potential trade.
   */
  analyze(smcAnalysis, smartMoneyAnalysis, accountState) {
    const balance = accountState?.balance || 10000;
    const openPositions = accountState?.openPositions || [];
    const dailyPnL = accountState?.dailyPnL || 0;

    const result = {
      approved: true,
      reason: 'OK',
      positionSize: 0,
      riskUSD: 0,
      stopLossPct: this.config.initialStoplossPct,
      stopLossPrice: 0,
      tp1Price: 0,
      rrRatio: 0,
      warnings: [],
    };

    // ── Check max open positions ─────────────────────────────
    if (openPositions.length >= this.config.maxOpenPositions) {
      result.approved = false;
      result.reason = 'MAX_OPEN_POSITIONS_REACHED';
      return result;
    }

    // ── Check daily loss limit ───────────────────────────────
    const dailyLossPct = Math.abs(Math.min(0, dailyPnL) / balance) * 100;
    if (dailyLossPct >= this.config.maxDailyLossPct) {
      result.approved = false;
      result.reason = 'DAILY_LOSS_LIMIT_REACHED';
      return result;
    }

    // ── Check existing risk on same symbol ───────────────────
    const symbolRisk = openPositions
      .filter((p) => p.symbol === smcAnalysis.symbol)
      .reduce((sum, p) => sum + p.riskUSD, 0);

    const newRiskUSD = (balance * this.config.riskPerTradePct) / 100;
    const totalSymbolRisk = symbolRisk + newRiskUSD;
    const totalSymbolRiskPct = (totalSymbolRisk / balance) * 100;

    if (totalSymbolRiskPct > this.config.maxRiskPerSymbolPct) {
      result.approved = false;
      result.reason = 'MAX_RISK_PER_SYMBOL_EXCEEDED';
      return result;
    }

    // ── Calculate position size ──────────────────────────────
    result.riskUSD = newRiskUSD;
    result.stopLossPct = this.config.initialStoplossPct;
    result.stopLossPrice = this._calcStopLoss(smcAnalysis);
    result.tp1Price = this._calcTP1(smcAnalysis);

    // ── R:R ratio ────────────────────────────────────────────
    if (smcAnalysis.currentPrice && result.stopLossPrice && result.tp1Price) {
      const risk = Math.abs(smcAnalysis.currentPrice - result.stopLossPrice);
      const reward = Math.abs(result.tp1Price - smcAnalysis.currentPrice);
      result.rrRatio = risk > 0 ? parseFloat((reward / risk).toFixed(2)) : 0;

      if (result.rrRatio < this.config.minRR) {
        result.warnings.push(`R:R ratio ${result.rrRatio} below minimum ${this.config.minRR}`);
        // Warning only — Brain decides whether to proceed
      }
    }

    // ── Check liquidity for stop placement ───────────────────
    if (smcAnalysis.protectedLevels.protectedLow && smcAnalysis.protectedLevels.protectedHigh) {
      const range = smcAnalysis.protectedLevels.protectedHigh.price - smcAnalysis.protectedLevels.protectedLow.price;
      const stopDist = Math.abs(smcAnalysis.currentPrice - result.stopLossPrice);
      if (stopDist > range * 0.5) {
        result.warnings.push('Stop loss is more than 50% of the structural range — consider tighter placement');
      }
    }

    // ── Funding cost warning ─────────────────────────────────
    if (smartMoneyAnalysis?.derivatives?.funding?.annualizedPct > 30) {
      result.warnings.push(`High funding rate (${smartMoneyAnalysis.derivatives.funding.annualizedPct}% annualized) — holding cost is significant`);
    }

    return result;
  }

  _calcStopLoss(smcAnalysis) {
    const price = smcAnalysis.currentPrice;
    const slPct = this.config.initialStoplossPct / 100;

    // Try to place stop beyond protected level
    if (smcAnalysis.thesisDirection === 'BEARISH' || smcAnalysis.structure?.bias === 'BEARISH') {
      // Short — stop above protected high or above current price
      const protectedHigh = smcAnalysis.protectedLevels?.protectedHigh?.price;
      if (protectedHigh && protectedHigh > price) {
        return protectedHigh * 1.002; // Small buffer above
      }
      return price * (1 + slPct);
    } else {
      // Long — stop below protected low or below current price
      const protectedLow = smcAnalysis.protectedLevels?.protectedLow?.price;
      if (protectedLow && protectedLow < price) {
        return protectedLow * 0.998; // Small buffer below
      }
      return price * (1 - slPct);
    }
  }

  _calcTP1(smcAnalysis) {
    const price = smcAnalysis.currentPrice;
    const tpPct = this.config.tp1Pct / 100;

    // Try to place TP at the nearest FVG or liquidity target
    if (smcAnalysis.thesisDirection === 'BEARISH' || smcAnalysis.structure?.bias === 'BEARISH') {
      // Short — TP at lower FVG or liquidity target
      const fvg = smcAnalysis.fvg?.current;
      if (fvg?.direction === 'BEARISH' && fvg.lowerBoundary < price) {
        return fvg.lowerBoundary;
      }
      const target = smcAnalysis.liquidity?.liquidityTargets?.find((t) => t.direction === 'DOWN');
      if (target?.level < price) return target.level;
      return price * (1 - tpPct);
    } else {
      // Long — TP at upper FVG or liquidity target
      const fvg = smcAnalysis.fvg?.current;
      if (fvg?.direction === 'BULLISH' && fvg.upperBoundary > price) {
        return fvg.upperBoundary;
      }
      const target = smcAnalysis.liquidity?.liquidityTargets?.find((t) => t.direction === 'UP');
      if (target?.level > price) return target.level;
      return price * (1 + tpPct);
    }
  }
}

__FILE_EOF__

echo 'src/execution/paperTrader.js'
mkdir -p \.
cat > 'src/execution/paperTrader.js' << '__FILE_EOF__'
/**
 * Alchemist Brain — Paper Trade Execution Engine
 *
 * Manages paper trading positions with the full management pipeline:
 *
 *   ENTRY → INITIAL STOPLOSS → TP1 HIT
 *     ├── SELL 30%
 *     └── MOVE STOP → BREAKEVEN
 *         → RUNNER (70%) → ADAPTIVE TRAILING → FINAL EXIT
 *
 * Also supports continuous thesis re-evaluation while in a trade.
 */

import { randomUUID } from 'crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

export class PaperTrader {
  constructor(config) {
    this.config = config;
    this.balance = config.paperBalance;
    this.initialBalance = config.paperBalance;
    this.positions = [];
    this.completedTrades = [];
    this.dailyPnL = 0;
    this.dailyPnLReset = Date.now();
    this.tradesPath = config.tradesPath || 'storage/trades.json';
    this._load();
  }

  _load() {
    try {
      if (existsSync(this.tradesPath)) {
        const data = JSON.parse(readFileSync(this.tradesPath, 'utf-8'));
        this.balance = data.balance || this.initialBalance;
        this.positions = data.positions || [];
        this.completedTrades = data.completedTrades || [];
      }
    } catch (e) {
      console.error('[PaperTrader] Load failed:', e.message);
    }
  }

  _save() {
    try {
      const dir = dirname(this.tradesPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(this.tradesPath, JSON.stringify({
        balance: this.balance,
        positions: this.positions,
        completedTrades: this.completedTrades,
      }, null, 2));
    } catch (e) {
      console.error('[PaperTrader] Save failed:', e.message);
    }
  }

  /**
   * Open a new paper position.
   */
  openPosition(thesis, riskAnalysis) {
    if (!thesis || thesis.conclusion.decision !== 'ENTER') return null;
    if (!riskAnalysis || !riskAnalysis.approved) return null;

    const direction = thesis.conclusion.direction;
    const symbol = thesis.symbol;
    const entryPrice = thesis.currentPrice || riskAnalysis.entryPrice;
    if (!entryPrice) return null;

    // Calculate position size
    const riskUSD = riskAnalysis.riskUSD;
    const stopLossPrice = riskAnalysis.stopLossPrice;
    const stopDistPct = Math.abs((entryPrice - stopLossPrice) / entryPrice) * 100;
    const positionSize = riskUSD / (stopDistPct / 100); // Position size in USD

    if (positionSize > this.balance) {
      console.warn(`[PaperTrader] Insufficient balance: need $${positionSize.toFixed(2)}, have $${this.balance.toFixed(2)}`);
      return null;
    }

    const position = {
      id: randomUUID(),
      symbol,
      direction,
      entryPrice,
      entryTime: Date.now(),
      size: positionSize,
      remainingSize: positionSize,
      initialStopLoss: stopLossPrice,
      currentStopLoss: stopLossPrice,
      takeProfit1: riskAnalysis.tp1Price,
      tp1Hit: false,
      breakevenMoved: false,
      trailingActive: false,
      trailingHighWater: direction === 'LONG' ? entryPrice : entryPrice,
      trailingLowWater: direction === 'LONG' ? entryPrice : entryPrice,
      highestPnL: 0,
      managementActions: [],
      thesis: thesis.primaryThesis.narrative,
      thesisDirection: direction,
      smcSummary: thesis.primaryThesis.smcBias,
      smartMoneySummary: thesis.primaryThesis.smartMoneyBias,
      pattern: this._patternKey(symbol, direction, thesis),
      riskUSD,
      status: 'OPEN',
    };

    this.positions.push(position);
    this._save();

    console.log(`[PaperTrader] OPENED ${direction} ${symbol} @ ${entryPrice} | Size: $${positionSize.toFixed(2)} | SL: ${stopLossPrice} | TP1: ${riskAnalysis.tp1Price}`);
    return position;
  }

  /**
   * Update all open positions with the latest price data.
   * This is called every scan cycle.
   */
  updatePositions(currentPrices, thesisUpdates = {}) {
    const actions = [];

    for (const pos of this.positions) {
      if (pos.status !== 'OPEN') continue;

      const currentPrice = currentPrices[pos.symbol];
      if (!currentPrice) continue;

      const pnlPct = this._calcPnLPct(pos, currentPrice);
      const pnlUSD = this._calcPnLUSD(pos, currentPrice);
      pos.currentPrice = currentPrice;
      pos.currentPnLPct = pnlPct;
      pos.currentPnLUSD = pnlUSD;

      if (pnlUSD > pos.highestPnL) pos.highestPnL = pnlUSD;

      // Track high/low water for trailing
      if (pos.direction === 'LONG') {
        if (currentPrice > pos.trailingHighWater) pos.trailingHighWater = currentPrice;
      } else {
        if (currentPrice < pos.trailingLowWater) pos.trailingLowWater = currentPrice;
      }

      // ── Check initial stop loss ────────────────────────────
      if (!pos.tp1Hit && this._stopHit(pos, currentPrice)) {
        actions.push(this._closePosition(pos, pos.currentStopLoss, 'INITIAL_STOPLOSS'));
        continue;
      }

      // ── Check TP1 ──────────────────────────────────────────
      if (!pos.tp1Hit && this._tp1Hit(pos, currentPrice)) {
        this._executeTP1(pos, currentPrice);
        actions.push({ type: 'TP1_HIT', symbol: pos.symbol, price: currentPrice, pnlPct });
      }

      // ── After TP1: move stop to breakeven ──────────────────
      if (pos.tp1Hit && this.config.breakevenAfterTP1 && !pos.breakevenMoved) {
        pos.currentStopLoss = pos.entryPrice;
        pos.breakevenMoved = true;
        pos.managementActions.push({ type: 'BREAKEVEN_SET', time: Date.now(), price: pos.entryPrice });
        actions.push({ type: 'BREAKEVEN_MOVED', symbol: pos.symbol, stopLoss: pos.entryPrice });
      }

      // ── After TP1: start trailing on runner ────────────────
      if (pos.tp1Hit && this.config.trailingEnabled) {
        const profitFromTP1 = pos.direction === 'LONG'
          ? ((currentPrice - pos.takeProfit1) / pos.takeProfit1) * 100
          : ((pos.takeProfit1 - currentPrice) / pos.takeProfit1) * 100;

        if (profitFromTP1 >= this.config.trailingStartPct && !pos.trailingActive) {
          pos.trailingActive = true;
          pos.managementActions.push({ type: 'TRAILING_ACTIVATED', time: Date.now(), price: currentPrice });
          actions.push({ type: 'TRAILING_STARTED', symbol: pos.symbol });
        }

        if (pos.trailingActive) {
          this._updateTrailingStop(pos, currentPrice);
        }
      }

      // ── Check stop after breakeven/trailing ────────────────
      if (pos.tp1Hit && this._stopHit(pos, currentPrice)) {
        const reason = pos.trailingActive ? 'TRAILING_STOP' : 'BREAKEVEN_STOP';
        actions.push(this._closePosition(pos, pos.currentStopLoss, reason));
        continue;
      }

      // ── Thesis re-evaluation ───────────────────────────────
      const thesisUpdate = thesisUpdates[pos.symbol];
      if (thesisUpdate && thesisUpdate.conclusion?.decision === 'REJECT') {
        // Thesis invalidated — close position
        actions.push(this._closePosition(pos, currentPrice, 'THESIS_INVALIDATED'));
        continue;
      }
    }

    this._save();
    return actions;
  }

  _executeTP1(pos, currentPrice) {
    const sellPct = this.config.tp1SellPct / 100;
    const sellSize = pos.size * sellPct;
    const remainingSize = pos.size - sellSize;

    // Calculate partial PnL
    const pnlPct = pos.direction === 'LONG'
      ? ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100
      : ((pos.entryPrice - currentPrice) / pos.entryPrice) * 100;
    const pnlUSD = sellSize * (pnlPct / 100);

    this.balance += pnlUSD;
    pos.remainingSize = remainingSize;
    pos.tp1Hit = true;
    pos.managementActions.push({
      type: 'TP1_HIT',
      time: Date.now(),
      price: currentPrice,
      sellSize,
      pnlUSD,
      pnlPct,
    });
  }

  _updateTrailingStop(pos, currentPrice) {
    const trailStep = this.config.trailingStepPct / 100;
    const maxDist = this.config.maxTrailingDistancePct / 100;

    if (pos.direction === 'LONG') {
      // Trail stop below the high water mark
      const newStop = pos.trailingHighWater * (1 - trailStep);
      // Only move stop up, never down
      if (newStop > pos.currentStopLoss) {
        // Ensure we don't trail too far
        const maxStop = pos.trailingHighWater * (1 - maxDist);
        pos.currentStopLoss = Math.max(newStop, maxStop);
        pos.managementActions.push({
          type: 'TRAIL_UPDATED',
          time: Date.now(),
          newStop: pos.currentStopLoss,
          highWater: pos.trailingHighWater,
        });
      }
    } else {
      // Short — trail stop above the low water mark
      const newStop = pos.trailingLowWater * (1 + trailStep);
      if (newStop < pos.currentStopLoss) {
        const maxStop = pos.trailingLowWater * (1 + maxDist);
        pos.currentStopLoss = Math.min(newStop, maxStop);
        pos.managementActions.push({
          type: 'TRAIL_UPDATED',
          time: Date.now(),
          newStop: pos.currentStopLoss,
          lowWater: pos.trailingLowWater,
        });
      }
    }
  }

  _stopHit(pos, currentPrice) {
    if (pos.direction === 'LONG') {
      return currentPrice <= pos.currentStopLoss;
    } else {
      return currentPrice >= pos.currentStopLoss;
    }
  }

  _tp1Hit(pos, currentPrice) {
    if (pos.direction === 'LONG') {
      return currentPrice >= pos.takeProfit1;
    } else {
      return currentPrice <= pos.takeProfit1;
    }
  }

  _closePosition(pos, exitPrice, reason) {
    const pnlPct = pos.direction === 'LONG'
      ? ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100
      : ((pos.entryPrice - exitPrice) / pos.entryPrice) * 100;

    const pnlUSD = pos.remainingSize * (pnlPct / 100);
    this.balance += pnlUSD;
    this.dailyPnL += pnlUSD;

    pos.status = 'CLOSED';
    pos.exitPrice = exitPrice;
    pos.exitTime = Date.now();
    pos.exitReason = reason;
    pos.pnlPct = pnlPct;
    pos.pnlUsd = pnlUSD;
    pos.result = pnlUSD > 0 ? 'WIN' : pnlUSD < 0 ? 'LOSS' : 'BREAKEVEN';
    pos.durationMin = Math.round((pos.exitTime - pos.entryTime) / 60000);

    // Move to completed
    this.completedTrades.push({ ...pos });
    this.positions = this.positions.filter((p) => p.id !== pos.id);

    console.log(`[PaperTrader] CLOSED ${pos.symbol} @ ${exitPrice} | PnL: ${pnlUSD > 0 ? '+' : ''}$${pnlUSD.toFixed(2)} (${pnlPct.toFixed(2)}%) | Reason: ${reason}`);

    return { type: 'POSITION_CLOSED', symbol: pos.symbol, exitPrice, pnlPct, pnlUSD, reason };
  }

  _calcPnLPct(pos, currentPrice) {
    return pos.direction === 'LONG'
      ? ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100
      : ((pos.entryPrice - currentPrice) / pos.entryPrice) * 100;
  }

  _calcPnLUSD(pos, currentPrice) {
    return pos.remainingSize * (this._calcPnLPct(pos, currentPrice) / 100);
  }

  _patternKey(symbol, direction, thesis) {
    const features = [
      symbol,
      direction,
      thesis.primaryThesis?.smcBias || 'unknown',
      thesis.primaryThesis?.smartMoneyBias || 'unknown',
    ];
    return features.join('|');
  }

  getAccountState() {
    return {
      balance: this.balance,
      initialBalance: this.initialBalance,
      openPositions: this.positions.map((p) => ({
        symbol: p.symbol,
        direction: p.direction,
        size: p.remainingSize,
        riskUSD: p.riskUSD,
        entryPrice: p.entryPrice,
        currentPrice: p.currentPrice,
        pnlPct: p.currentPnLPct || 0,
        pnlUSD: p.currentPnLUSD || 0,
        tp1Hit: p.tp1Hit,
        trailing: p.trailingActive,
        stopLoss: p.currentStopLoss,
      })),
      dailyPnL: this.dailyPnL,
      totalPnL: this.balance - this.initialBalance,
      totalPnLPct: ((this.balance - this.initialBalance) / this.initialBalance) * 100,
    };
  }

  getCompletedTrades(limit = 20) {
    return this.completedTrades.slice(-limit);
  }

  resetDailyPnL() {
    this.dailyPnL = 0;
    this.dailyPnLReset = Date.now();
  }
}

__FILE_EOF__

echo 'src/display/scorecard.js'
mkdir -p \.
cat > 'src/display/scorecard.js' << '__FILE_EOF__'
/**
 * Alchemist Brain — ANSI Scorecard Display
 *
 * Renders the full thought process in the terminal:
 *   - Smart Money Intelligence
 *   - SMC / Structure
 *   - Brain Thesis (primary, supporting, contradicting, counter, invalidation)
 *   - Memory
 *   - Conclusion (ENTER / WAIT / REJECT)
 *   - Up to 5 live/near-entry opportunities, continuously updating
 *   - Open positions with management status
 *   - Completed trades summary
 */

// ── ANSI colors ──────────────────────────────────────────────
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m',
  bgMagenta: '\x1b[45m',
  bgCyan: '\x1b[46m',
  bgBlack: '\x1b[40m',
  // Bright
  brightRed: '\x1b[91m',
  brightGreen: '\x1b[92m',
  brightYellow: '\x1b[93m',
  brightBlue: '\x1b[94m',
  brightMagenta: '\x1b[95m',
  brightCyan: '\x1b[96m',
  brightWhite: '\x1b[97m',
};

const SYMBOLS = {
  bullish: '🟢',
  bearish: '🔴',
  neutral: '⚪',
  enter: '🔴',
  wait: '🟡',
  reject: '⚪',
  check: '✓',
  cross: '✗',
  warn: '⚠',
  arrow: '→',
  down: '↓',
  up: '↑',
  diamond: '◆',
  square: '■',
  bullet: '●',
};

function colored(text, color) {
  return `${color}${text}${C.reset}`;
}

function box(text, color = C.cyan) {
  const line = '─'.repeat(Math.max(text.length + 4, 50));
  return `${color}┌${line}┐${C.reset}\n${color}│${C.reset} ${text.padEnd(Math.max(text.length + 3, 47))} ${color}│${C.reset}\n${color}└${line}┘${C.reset}`;
}

function section(title, color = C.cyan) {
  const line = '─'.repeat(62);
  return `\n${color}┌${line}┐${C.reset}\n${color}│${C.reset} ${C.bold}${title.padEnd(60)}${C.reset} ${color}│${C.reset}\n${color}└${line}┘${C.reset}`;
}

function kv(key, value, keyColor = C.dim, valColor = C.white) {
  return `  ${keyColor}${key.padEnd(28)}${C.reset} ${valColor}${value}${C.reset}`;
}

function biasColor(bias) {
  if (bias === 'BULLISH' || bias === 'LONG') return C.brightGreen;
  if (bias === 'BEARISH' || bias === 'SHORT') return C.brightRed;
  return C.dim;
}

function decisionSymbol(decision) {
  if (decision === 'ENTER') return SYMBOLS.enter;
  if (decision === 'WAIT') return SYMBOLS.wait;
  return SYMBOLS.reject;
}

function decisionColor(decision) {
  if (decision === 'ENTER') return C.brightRed; // Red = action
  if (decision === 'WAIT') return C.brightYellow;
  return C.dim;
}

// ──────────────────────────────────────────────────────────────
//  SCORECARD RENDERER
// ──────────────────────────────────────────────────────────────

export function renderScorecard(opportunities, accountState, completedTrades, memoryStats) {
  const lines = [];

  // ── Header ────────────────────────────────────────────────
  lines.push('');
  lines.push(colored('  ╔══════════════════════════════════════════════════════════════╗', C.brightMagenta));
  lines.push(colored('  ║', C.brightMagenta) + colored('          🧪 ALCHEMIST BRAIN — LIVE SCORECARD', C.bold + C.brightWhite) + colored('                  ║', C.brightMagenta));
  lines.push(colored('  ╚══════════════════════════════════════════════════════════════╝', C.brightMagenta));
  lines.push(`  ${C.dim}SMC → Smart Money → Technicals → Thesis → Counter → Memory → Risk → Decision${C.reset}`);
  lines.push(`  ${C.dim}Updated: ${new Date().toUTCString()}${C.reset}`);
  lines.push('');

  // ── Account Summary ───────────────────────────────────────
  lines.push(section('📊 ACCOUNT SUMMARY', C.brightBlue));
  const totalPnL = accountState.totalPnL || 0;
  const totalPnLPct = accountState.totalPnLPct || 0;
  const pnlColor = totalPnL >= 0 ? C.brightGreen : C.brightRed;
  const pnlStr = totalPnL >= 0 ? `+$${totalPnL.toFixed(2)}` : `-$${Math.abs(totalPnL).toFixed(2)}`;

  lines.push(kv('Paper Balance', `$${accountState.balance.toFixed(2)}`, C.dim, C.brightWhite));
  lines.push(kv('Total PnL', `${pnlStr} (${totalPnLPct >= 0 ? '+' : ''}${totalPnLPct.toFixed(2)}%)`, C.dim, pnlColor));
  lines.push(kv('Open Positions', `${accountState.openPositions.length}`, C.dim, C.white));
  lines.push(kv('Daily PnL', `${accountState.dailyPnL >= 0 ? '+' : ''}$${accountState.dailyPnL.toFixed(2)}`, C.dim, accountState.dailyPnL >= 0 ? C.green : C.red));

  if (memoryStats && memoryStats.totalTrades > 0) {
    const winRate = ((memoryStats.wins / memoryStats.totalTrades) * 100).toFixed(1);
    lines.push(kv('Trades Completed', `${memoryStats.totalTrades} (Win rate: ${winRate}%)`, C.dim, C.white));
    lines.push(kv('Avg Win / Loss', `${memoryStats.avgWinPct.toFixed(2)}% / ${memoryStats.avgLossPct.toFixed(2)}%`, C.dim, C.white));
  }

  lines.push('');

  // ── Open Positions ─────────────────────────────────────────
  if (accountState.openPositions.length > 0) {
    lines.push(section('📂 OPEN POSITIONS', C.brightCyan));
    for (const pos of accountState.openPositions) {
      const dirSym = pos.direction === 'LONG' ? SYMBOLS.bullish : SYMBOLS.bearish;
      const dirColor = biasColor(pos.direction);
      const pnlColor = pos.pnlUSD >= 0 ? C.brightGreen : C.brightRed;

      lines.push(`  ${dirColor}${dirSym} ${pos.symbol}${C.reset} ${C.dim}│${C.reset} ${dirColor}${pos.direction}${C.reset} ${C.dim}│${C.reset} Size: $${pos.size.toFixed(0)} ${C.dim}│${C.reset} PnL: ${pnlColor}${pos.pnlUSD >= 0 ? '+' : ''}$${pos.pnlUSD.toFixed(2)} (${pos.pnlPct.toFixed(2)}%)${C.reset}`);

      const tags = [];
      if (pos.tp1Hit) tags.push(colored('TP1 ✓', C.brightGreen));
      if (pos.trailing) tags.push(colored('TRAILING', C.brightYellow));
      if (pos.tp1Hit && !pos.trailing) tags.push(colored('BREAKEVEN', C.cyan));
      tags.push(colored(`SL: ${pos.stopLoss.toFixed(2)}`, C.dim));
      tags.push(colored(`Entry: ${pos.entryPrice.toFixed(2)}`, C.dim));
      lines.push(`    ${C.dim}${tags.join(' │ ')}${C.reset}`);
    }
    lines.push('');
  }

  // ── Live Opportunities (up to 5) ───────────────────────────
  lines.push(section('🔍 LIVE OPPORTUNITIES (Top 5)', C.brightYellow));
  lines.push('');

  const sorted = opportunities
    .filter((o) => o && o.conclusion)
    .sort((a, b) => (b.scores?.brainScore || 0) - (a.scores?.brainScore || 0))
    .slice(0, 5);

  if (sorted.length === 0) {
    lines.push(`  ${C.dim}No opportunities detected. Scanning...${C.reset}`);
  }

  for (let i = 0; i < sorted.length; i++) {
    const opp = sorted[i];
    lines.push(renderOpportunity(opp, i + 1));
  }

  // ── Recent Completed Trades ────────────────────────────────
  if (completedTrades && completedTrades.length > 0) {
    lines.push('');
    lines.push(section('📋 RECENT TRADES', C.dim));
    const recent = completedTrades.slice(-5).reverse();
    for (const t of recent) {
      const resColor = t.result === 'WIN' ? C.brightGreen : t.result === 'LOSS' ? C.brightRed : C.dim;
      const pnlStr = t.pnlUsd >= 0 ? `+$${t.pnlUsd.toFixed(2)}` : `-$${Math.abs(t.pnlUsd).toFixed(2)}`;
      lines.push(`  ${resColor}${t.result.padEnd(8)}${C.reset} ${C.dim}${t.symbol.padEnd(10)}${C.reset} ${biasColor(t.direction)}${t.direction.padEnd(5)}${C.reset} ${resColor}${pnlStr} (${t.pnlPct.toFixed(2)}%)${C.reset} ${C.dim}${t.exitReason}${C.reset}`);
    }
  }

  lines.push('');
  lines.push(colored('  ' + '─'.repeat(62), C.dim));
  lines.push(`  ${C.dim}Alchemist Brain v1.0 — Paper Trading Mode | Press Ctrl+C to stop${C.reset}`);
  lines.push('');

  return lines.join('\n');
}

// ──────────────────────────────────────────────────────────────
//  OPPORTUNITY RENDERER
// ──────────────────────────────────────────────────────────────

function renderOpportunity(opp, rank) {
  const lines = [];
  const decision = opp.conclusion.decision;
  const dir = opp.conclusion.direction || 'NEUTRAL';
  const decSym = decisionSymbol(decision);
  const decColor = decisionColor(decision);
  const dirColor = biasColor(dir);

  // Header line
  lines.push(`  ${C.bold}#${rank}${C.reset} ${C.brightWhite}${opp.symbol}${C.reset} ${C.dim}│${C.reset} ${decColor}${decSym} ${decision}${C.reset} ${C.dim}│${C.reset} ${dirColor}${dir}${C.reset} ${C.dim}│${C.reset} Score: ${C.brightWhite}${opp.scores?.brainScore || 0}${C.reset} ${C.dim}│${C.reset} Confidence: ${C.brightWhite}${opp.scores?.confidence || 0}${C.reset} ${C.dim}│${C.reset} Conflict: ${opp.scores?.conflict || 0}`);

  // Bias alignment row
  const smcBias = opp.primaryThesis?.smcBias || 'NEUTRAL';
  const smBias = opp.primaryThesis?.smartMoneyBias || 'NEUTRAL';
  const techBias = opp.primaryThesis?.technicalBias || 'NEUTRAL';
  lines.push(`  ${C.dim}SMC: ${biasColor(smcBias)}${smcBias}${C.reset} ${C.dim}│ SM: ${biasColor(smBias)}${smBias}${C.reset} ${C.dim}│ Tech: ${biasColor(techBias)}${techBias}${C.reset}${C.dim}`);

  // ── Smart Money Intelligence ──────────────────────────────
  if (opp.smartMoney) {
    const sm = opp.smartMoney;
    lines.push(`  ${C.cyan}🐋 SMART MONEY${C.reset}`);
    const fusion = sm.fusion;

    // Top traders
    lines.push(kv('Top Trader L/S', `${sm.topTraders.longPct}%L / ${sm.topTraders.shortPct}%S (ratio: ${sm.topTraders.ratio?.toFixed(2)})`, C.dim, biasColor(sm.topTraders.direction)));
    lines.push(kv('Top Trader Bias', `${sm.topTraders.direction}`, C.dim, biasColor(sm.topTraders.direction)));

    // Global
    lines.push(kv('Global Position', `${sm.global.longPct}%L / ${sm.global.shortPct}%S`, C.dim, biasColor(sm.global.direction)));

    // Derivatives
    lines.push(kv('Funding', `${sm.derivatives.funding.annualizedPct}% ann. (${sm.derivatives.funding.direction})`, C.dim, biasColor(sm.derivatives.funding.direction)));
    lines.push(kv('Open Interest', `${sm.derivatives.openInterest.changePct}% (${sm.derivatives.openInterest.trend})`, C.dim, C.white));
    lines.push(kv('Taker Flow', `${sm.derivatives.takerFlow.direction} (${sm.derivatives.takerFlow.avgBuySellRatio?.toFixed(3)})`, C.dim, biasColor(sm.derivatives.takerFlow.direction)));

    // Fusion
    lines.push(kv('Smart Money Bias', `${fusion.direction} (${fusion.strength}%)`, C.dim, biasColor(fusion.direction)));
    lines.push(kv('Flow Alignment', `${fusion.flowAlignment}`, C.dim, fusion.flowAlignment === 'STRONG' ? C.brightGreen : fusion.flowAlignment === 'MODERATE' ? C.yellow : C.dim));
  }

  // ── SMC / Structure ───────────────────────────────────────
  if (opp.smc) {
    const smc = opp.smc;
    lines.push(`  ${C.cyan}🏛 SMC / STRUCTURE${C.reset}`);

    lines.push(kv('Trend', `${smc.structure.bias} (${smc.structure.sequence})`, C.dim, biasColor(smc.structure.bias)));

    const bosStr = smc.bos.detected ? `${colored('✅', C.brightGreen)} ${smc.bos.direction} @ ${smc.bos.brokenLevel?.toFixed(2)} (${smc.bos.strength}%)` : `${colored('❌', C.dim)} NONE`;
    lines.push(kv('BOS', bosStr.replace(/\x1b\[[0-9;]*m/g, ''), C.dim, smc.bos.detected ? biasColor(smc.bos.direction) : C.dim));

    const chochStr = smc.choch.detected ? `${smc.choch.direction} @ ${smc.choch.brokenLevel?.toFixed(2)}` : `NONE`;
    lines.push(kv('CHOCH', chochStr, C.dim, smc.choch.detected ? biasColor(smc.choch.direction) : C.dim));

    const sweepStr = smc.liquidity.sweep ? `${smc.liquidity.sweep.direction} @ ${smc.liquidity.sweep.location} (${smc.liquidity.sweep.strength}%)` : `NONE`;
    lines.push(kv('Liquidity Sweep', sweepStr, C.dim, smc.liquidity.sweep ? (smc.liquidity.sweep.direction === 'ABOVE' ? C.brightRed : C.brightGreen) : C.dim));

    const fvgStr = smc.fvg.current ? `${smc.fvg.current.direction} (${smc.fvg.current.status}) @ ${smc.fvg.current.lowerBoundary?.toFixed(2)}-${smc.fvg.current.upperBoundary?.toFixed(2)}` : `NONE`;
    lines.push(kv('FVG', fvgStr, C.dim, smc.fvg.current ? biasColor(smc.fvg.current.direction) : C.dim));

    const dispStr = smc.displacement.detected ? `${smc.displacement.direction} (${smc.displacement.strength}%, ${smc.displacement.rangeRatio.toFixed(1)}x avg)` : `NONE`;
    lines.push(kv('Displacement', dispStr, C.dim, smc.displacement.detected ? biasColor(smc.displacement.direction) : C.dim));

    const bkStr = smc.breakout.detected ? `${smc.breakout.status} (${smc.breakout.direction})` : `NONE`;
    lines.push(kv('Breakout', bkStr, C.dim, smc.breakout.detected ? (smc.breakout.failed ? C.brightRed : C.brightGreen) : C.dim));

    // Protected levels
    if (smc.protectedLevels.protectedHigh) {
      lines.push(kv('Protected High', `${smc.protectedLevels.protectedHigh.price.toFixed(2)}`, C.dim, C.dim));
    }
    if (smc.protectedLevels.protectedLow) {
      lines.push(kv('Protected Low', `${smc.protectedLevels.protectedLow.price.toFixed(2)}`, C.dim, C.dim));
    }

    lines.push(kv('SMC Score', `${smc.smcScore}%`, C.dim, C.brightWhite));
  }

  // ── Technical Evidence ─────────────────────────────────
  if (opp.technical) {
    const tech = opp.technical;
    lines.push(`  ${C.cyan}📊 TECHNICAL EVIDENCE${C.reset}`);

    // RSI
    const rsiDir = tech.rsi.direction === 'RISING' ? '↑' : tech.rsi.direction === 'FALLING' ? '↓' : '→';
    const rsiBias = tech.rsi.momentumContext === 'BULLISH' || tech.rsi.momentumContext === 'OVERBOUGHT' ? 'BULLISH' :
                    tech.rsi.momentumContext === 'BEARISH' || tech.rsi.momentumContext === 'OVERSOLD' ? 'BEARISH' : 'NEUTRAL';
    lines.push(kv('RSI', `${tech.rsi.value} ${rsiDir} ${rsiBias} ${rsiBias !== 'NEUTRAL' ? '✓' : ''}`, C.dim, biasColor(rsiBias)));

    // Momentum
    const momDir = tech.momentum.direction === 'BULLISH' ? '↑' : tech.momentum.direction === 'BEARISH' ? '↓' : '→';
    const momStrength = tech.momentum.strength > 50 ? 'STRONG' : tech.momentum.strength > 25 ? 'MODERATE' : 'WEAK';
    lines.push(kv('Momentum', `${momDir} ${tech.momentum.shortTerm.toFixed(2)} ${momStrength} ${momStrength !== 'WEAK' ? '✓' : ''}`, C.dim, biasColor(tech.momentum.direction)));

    // Momentum acceleration
    const accelDir = tech.momentum.accelerationDirection;
    const accelSym = accelDir === 'ACCELERATING' ? '-++' : accelDir === 'DECELERATING' ? '- --' : '→';
    const accelBias = accelDir === 'ACCELERATING' ? tech.momentum.direction : 'NEUTRAL';
    lines.push(kv('Momentum Change', `${accelSym} ${accelDir} ${accelBias !== 'NEUTRAL' ? '✓' : ''}`, C.dim, biasColor(accelBias)));

    // Volume
    const volBias = tech.volume.expansion === 'EXPANDING' ? tech.momentum.direction :
                    tech.volume.expansion === 'ELEVATED' ? tech.momentum.direction : 'NEUTRAL';
    lines.push(kv('Volume', `${tech.volume.ratio}x avg ${tech.volume.expansion} ${volBias !== 'NEUTRAL' ? '✓' : ''}`, C.dim, biasColor(volBias)));

    // 5m Trend
    const trendBias = tech.trend.direction;
    const trendStrength = tech.trend.strength > 60 ? 'STRONG' : tech.trend.strength > 30 ? 'MODERATE' : 'WEAK';
    lines.push(kv('5m Trend', `${trendBias} ${trendStrength} ${trendStrength !== 'WEAK' ? '✓' : ''}`, C.dim, biasColor(trendBias)));
    lines.push(kv('MA Alignment', tech.trend.alignment.replace('_', ' ').toLowerCase(), C.dim, C.dim));

    // Regime
    const regimeBias = tech.regime.classification.includes('BULL') ? 'BULLISH' :
                       tech.regime.classification.includes('BEAR') ? 'BEARISH' : 'NEUTRAL';
    lines.push(kv('Regime', `${tech.regime.classification.replace('_', ' ')} ${regimeBias !== 'NEUTRAL' ? '✓' : ''}`, C.dim, biasColor(regimeBias)));

    // Volatility
    lines.push(kv('Volatility', `${tech.volatility.pct}% (${tech.volatility.direction})`, C.dim, C.dim));

    // Technical conclusion
    lines.push(kv('Tech Supporting', `${tech.supportingCount} observations`, C.dim, C.brightGreen));
    lines.push(kv('Tech Contradictions', `${tech.contradictingCount} opposing`, C.dim, tech.contradictingCount > 0 ? C.brightRed : C.dim));
    lines.push(kv('Technical Conclusion', `${tech.technicalBias} (${tech.technicalScore}% conviction)`, C.dim, biasColor(tech.technicalBias)));
  }

  // ── Brain Thesis ──────────────────────────────────────────
  lines.push(`  ${C.brightMagenta}🧠 BRAIN THESIS${C.reset}`);

  // Primary thesis
  lines.push(`  ${C.dim}PRIMARY THESIS:${C.reset}`);
  const thesisLines = wrapText(opp.primaryThesis?.narrative || 'N/A', 58);
  for (const tl of thesisLines) {
    lines.push(`    ${C.white}${tl}${C.reset}`);
  }

  // Supporting evidence
  lines.push(`  ${C.dim}SUPPORTING:${C.reset}`);
  if (opp.supporting && opp.supporting.length > 0) {
    for (const e of opp.supporting.slice(0, 10)) {
      const sym = e.source === 'SMC' ? '🏛' : e.source === 'Smart Money' ? '🐋' : e.source === 'Technical' ? '📊' : '●';
      lines.push(`    ${C.brightGreen}${SYMBOLS.check}${C.reset} ${C.dim}${sym}${C.reset} ${C.white}${e.item}${C.reset}`);
    }
  } else {
    lines.push(`    ${C.dim}No supporting evidence${C.reset}`);
  }

  // Contradicting evidence
  lines.push(`  ${C.dim}CONTRADICTING:${C.reset}`);
  if (opp.contradicting && opp.contradicting.length > 0) {
    for (const e of opp.contradicting.slice(0, 8)) {
      const sym = e.source === 'SMC' ? '🏛' : e.source === 'Smart Money' ? '🐋' : e.source === 'Technical' ? '📊' : '●';
      lines.push(`    ${C.brightRed}${SYMBOLS.cross}${C.reset} ${C.dim}${sym}${C.reset} ${C.white}${e.item}${C.reset}`);
    }
  } else {
    lines.push(`    ${C.dim}No contradicting evidence${C.reset}`);
  }

  // Counter-thesis
  lines.push(`  ${C.dim}ALTERNATIVE:${C.reset}`);
  const counterLines = wrapText(opp.counterThesis?.narrative || 'N/A', 58);
  for (const cl of counterLines) {
    lines.push(`    ${C.yellow}${cl}${C.reset}`);
  }

  // Invalidation
  lines.push(`  ${C.dim}INVALIDATION:${C.reset}`);
  const invLines = wrapText(opp.primaryThesis?.invalidation || 'N/A', 58);
  for (const il of invLines) {
    lines.push(`    ${C.brightRed}${il}${C.reset}`);
  }

  // Memory
  if (opp.memory) {
    lines.push(`  ${C.dim}MEMORY:${C.reset}`);
    const memLines = wrapText(opp.memory.notes || 'No historical data.', 58);
    for (const ml of memLines) {
      lines.push(`    ${C.cyan}${ml}${C.reset}`);
    }
    if (opp.memory.found) {
      lines.push(`    ${C.dim}Win rate: ${opp.memory.winRate}% over ${opp.memory.sampleSize} trades → ${opp.memory.recommendation}${C.reset}`);
    }
  }

  // Conclusion
  lines.push(`  ${C.dim}CONCLUSION:${C.reset}`);
  const conclLines = wrapText(opp.conclusion?.reason || 'N/A', 58);
  for (const cl of conclLines) {
    lines.push(`    ${decColor}${cl}${C.reset}`);
  }

  lines.push(`  ${C.dim}DECISION:${C.reset} ${decColor}${C.bold}${decSym} ${decision}${C.reset} ${C.dim}│${C.reset} ${C.dim}Score: ${opp.scores?.brainScore || 0} │ Confidence: ${opp.scores?.confidence || 0} │ Conflict: ${opp.scores?.conflict || 0}${C.reset}`);

  lines.push(`  ${C.dim}${'─'.repeat(62)}${C.reset}`);

  return lines.join('\n');
}

// ──────────────────────────────────────────────────────────────
//  HELPERS
// ──────────────────────────────────────────────────────────────

function wrapText(text, maxWidth) {
  if (!text) return ['N/A'];
  const words = text.split(' ');
  const lines = [];
  let current = '';

  for (const word of words) {
    if ((current + ' ' + word).trim().length > maxWidth) {
      if (current) lines.push(current.trim());
      current = word;
    } else {
      current += ' ' + word;
    }
  }
  if (current.trim()) lines.push(current.trim());

  return lines.length > 0 ? lines : [text];
}

export { C as Colors };

__FILE_EOF__

echo 'src/main.js'
mkdir -p \.
cat > 'src/main.js' << '__FILE_EOF__'
#!/usr/bin/env node

/**
 * Alchemist Brain — Main Orchestration Loop
 *
 * Ties everything together:
 *   1. Fetch market data from Binance (public, no API keys)
 *      → Falls back to mock data if Binance is geo-blocked
 *   2. Run SMC analysis on each symbol
 *   3. Run Smart Money analysis on each symbol
 *   4. Feed both into the Thesis Engine (Brain)
 *   5. Brain forms thesis → evidence → counter-thesis → conclusion
 *   6. Paper trader executes on ENTER decisions
 *   7. Update positions (TP1, breakeven, trailing)
 *   8. Render ANSI scorecard
 *   9. Feed completed trades back into memory/learning
 *  10. Repeat
 *
 * Usage:
 *   node src/main.js              — Run (auto-falls back to mock data)
 *   node src/main.js --mock       — Force mock data mode
 *   node src/main.js --debug      — Debug mode
 *   node src/main.js --no-color   — Disable ANSI colors
 */

import { config } from './config.js';
import { BinanceClient } from './data/binanceClient.js';
import { MockDataGenerator } from './data/mockData.js';
import { analyzeSMC } from './smc/smcAnalyzer.js';
import { analyzeSmartMoney } from './smart_money/smartMoneyAnalyzer.js';
import { analyzeTechnicals } from './technical/technicalAnalyzer.js';
import { ThesisEngine } from './brain/thesisEngine.js';
import { Memory } from './brain/memory.js';
import { PaperTrader } from './execution/paperTrader.js';
import { renderScorecard } from './display/scorecard.js';

// ── Parse CLI args ────────────────────────────────────────────
const args = process.argv.slice(2);
const debug = args.includes('--debug');
const forceMock = args.includes('--mock');
const noColor = args.includes('--no-color');
if (debug) config.debug = true;
if (noColor) config.ansiColors = false;

// ── Initialize components ─────────────────────────────────────
const binance = new BinanceClient();
const mockGen = new MockDataGenerator();
const memory = new Memory(config.memoryPath);
const brain = new ThesisEngine(memory);
const trader = new PaperTrader(config);

let scanCount = 0;
let running = true;
let mockMode = forceMock;
let mockSnapshots = null;
let binanceBlocked = false;

// ── Graceful shutdown ────────────────────────────────────────
process.on('SIGINT', () => {
  console.log('\n\n🛑 Alchemist Brain shutting down...');
  running = false;
  setTimeout(() => process.exit(0), 1000);
});

// ── Data fetcher with fallback ───────────────────────────────
async function fetchSnapshots() {
  if (mockMode) {
    if (!mockSnapshots) {
      mockSnapshots = mockGen.generateAllSnapshots(config.symbols, config.timeframes, config.candleLimit);
    } else {
      mockSnapshots = mockGen.tickPrices(mockSnapshots);
    }
    return mockSnapshots;
  }

  try {
    const snapshots = await binance.getAllSnapshots(
      config.symbols,
      config.timeframes,
      config.candleLimit
    );

    // Check if ALL symbols failed (likely geo-blocked)
    const allFailed = config.symbols.every((s) => !snapshots[s] || !snapshots[s].klines?.[config.primaryTF]?.length);
    if (allFailed) {
      console.log('\n⚠️  Binance API unavailable (likely geo-blocked). Switching to MOCK DATA mode.');
      console.log('   The bot will use simulated market data so you can test the full system.');
      console.log('   Run on your own device/region where Binance is available for real data.\n');
      mockMode = true;
      mockSnapshots = mockGen.generateAllSnapshots(config.symbols, config.timeframes, config.candleLimit);
      return mockSnapshots;
    }

    return snapshots;
  } catch (err) {
    if (!mockMode) {
      console.log('\n⚠️  Binance API error. Switching to MOCK DATA mode.\n');
      mockMode = true;
      mockSnapshots = mockGen.generateAllSnapshots(config.symbols, config.timeframes, config.candleLimit);
      return mockSnapshots;
    }
    throw err;
  }
}

// ── Main loop ────────────────────────────────────────────────
async function main() {
  console.log('\n');
  console.log('  ╔══════════════════════════════════════════════════════════════╗');
  console.log('  ║', '          🧪 ALCHEMIST BRAIN — STARTING UP', '                   ║');
  console.log('  ╚══════════════════════════════════════════════════════════════╝');
  console.log(`  ${'Mode:'} ${'PAPER TRADING'}`);
  console.log(`  ${'Symbols:'} ${config.symbols.join(', ')}`);
  console.log(`  ${'Timeframes:'} ${config.timeframes.join(', ')}`);
  console.log(`  ${'Scan interval:'} ${config.scanIntervalSec}s`);
  console.log(`  ${'Starting balance:'} $${config.paperBalance}`);
  if (forceMock) console.log(`  ${'Data:'} MOCK (forced)`);
  console.log('');

  // Main scan loop
  while (running) {
    scanCount++;
    const scanStart = Date.now();

    try {
      // ── 1. FETCH DATA ─────────────────────────────────────
      if (debug) console.log(`[Scan #${scanCount}] Fetching market data${mockMode ? ' (MOCK)' : ''}...`);
      const snapshots = await fetchSnapshots();

      // ── 2. ANALYZE EACH SYMBOL ────────────────────────────
      const opportunities = [];
      const currentPrices = {};
      const thesisUpdates = {};

      for (const symbol of config.symbols) {
        const snapshot = snapshots[symbol];
        if (!snapshot || !snapshot.klines?.[config.primaryTF]?.length) continue;

        const candles = snapshot.klines[config.primaryTF];
        const htfCandles = snapshot.klines[config.structureTF] || [];
        currentPrices[symbol] = candles[candles.length - 1].close;

        // Run SMC analysis on primary timeframe
        const smcAnalysis = analyzeSMC(candles, { swingLookback: 2 });

        // Also check higher TF for context
        if (htfCandles.length > 10) {
          const htfSMC = analyzeSMC(htfCandles, { swingLookback: 2 });
          smcAnalysis.htf = htfSMC;
          if (htfSMC.structure.bias !== smcAnalysis.structure.bias && htfSMC.structure.bias !== 'NEUTRAL') {
            smcAnalysis.htfConflict = true;
          }
        }

        // Run Smart Money analysis
        const smartMoneyAnalysis = analyzeSmartMoney(snapshot);

        // Run Technical analysis
        const technicalAnalysis = analyzeTechnicals(candles, smcAnalysis);

        // Feed into Brain thesis engine
        const accountState = trader.getAccountState();
        const thesis = brain.evaluate(symbol, smcAnalysis, smartMoneyAnalysis, accountState, technicalAnalysis);

        // Attach extra data for scorecard
        thesis.smc = smcAnalysis;
        thesis.smartMoney = smartMoneyAnalysis;
        thesis.technical = technicalAnalysis;
        thesis.currentPrice = currentPrices[symbol];

        opportunities.push(thesis);

        // If Brain says ENTER and auto-buy is enabled, execute
        if (thesis.conclusion.decision === 'ENTER' && config.autoBuy) {
          const riskAnalysis = brain.riskAnalyzer.analyze(smcAnalysis, smartMoneyAnalysis, accountState);
          if (riskAnalysis.approved) {
            // Check max concurrent positions
            if (trader.positions.length < config.maxConcurrentPositions) {
              thesis.risk = riskAnalysis;
              const position = trader.openPosition(thesis, riskAnalysis);
              if (position) {
                console.log(`[AUTO-BUY] ${thesis.conclusion.direction} ${symbol} @ ${position.entryPrice} | Size: $${position.size.toFixed(2)} | SL: ${position.initialStopLoss.toFixed(2)} | TP1: ${position.takeProfit1.toFixed(2)}`);
                console.log(`[Brain] ${thesis.conclusion.reason}`);
              }
            } else if (debug) {
              console.log(`[Auto-Buy] ${symbol} skipped — max concurrent positions reached (${config.maxConcurrentPositions})`);
            }
          } else if (debug) {
            console.log(`[Auto-Buy] ${symbol} skipped — risk rejected: ${riskAnalysis.reason}`);
          }
        } else if (thesis.conclusion.decision === 'ENTER' && !config.autoBuy) {
          if (debug) console.log(`[Brain] ENTER signal for ${symbol} but auto-buy is disabled`);
        }

        // For open positions on this symbol, generate thesis updates
        const hasOpenPos = trader.positions.find((p) => p.symbol === symbol);
        if (hasOpenPos && thesis.conclusion.decision === 'REJECT') {
          thesisUpdates[symbol] = thesis;
        }
      }

      // ── 3. UPDATE POSITIONS ───────────────────────────────
      const actions = trader.updatePositions(currentPrices, thesisUpdates);

      // Log significant actions
      for (const action of actions) {
        if (action.type === 'TP1_HIT') {
          console.log(`[TP1] ${action.symbol} — TP1 hit at ${action.price}`);
        } else if (action.type === 'BREAKEVEN_MOVED') {
          console.log(`[BE] ${action.symbol} — Stop moved to breakeven at ${action.stopLoss}`);
        } else if (action.type === 'TRAILING_STARTED') {
          console.log(`[TRAIL] ${action.symbol} — Trailing stop activated`);
        } else if (action.type === 'POSITION_CLOSED') {
          const completedTrade = trader.completedTrades.find(
            (t) => t.symbol === action.symbol && t.exitTime > scanStart
          );
          if (completedTrade) {
            memory.recordTrade(completedTrade);
          }
        }
      }

      // ── 4. RENDER SCORECARD ───────────────────────────────
      const acctState = trader.getAccountState();
      const completedTrades = trader.getCompletedTrades(20);
      const memoryStats = memory.getStats();

      console.clear();
      process.stdout.write(renderScorecard(opportunities, acctState, completedTrades, memoryStats));

      // ── 5. SCAN SUMMARY (debug only) ──────────────────────
      if (debug) {
        const scanTime = ((Date.now() - scanStart) / 1000).toFixed(1);
        const enterCount = opportunities.filter((o) => o.conclusion.decision === 'ENTER').length;
        const waitCount = opportunities.filter((o) => o.conclusion.decision === 'WAIT').length;
        const rejectCount = opportunities.filter((o) => o.conclusion.decision === 'REJECT').length;
        console.log(`\n  ${'─'.repeat(62)}`);
        console.log(`  Scan #${scanCount} | ${scanTime}s | ${mockMode ? 'MOCK' : 'LIVE'} | ENTER: ${enterCount} | WAIT: ${waitCount} | REJECT: ${rejectCount}`);
      }

      // ── 6. WAIT FOR NEXT CYCLE ────────────────────────────
      if (running) {
        await sleep(config.scanIntervalSec * 1000);
      }

    } catch (err) {
      console.error('[Main] Scan error:', err.message);
      if (debug) console.error(err.stack);
      await sleep(5000);
    }
  }

  console.log('Alchemist Brain stopped.');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Start ────────────────────────────────────────────────────
main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

__FILE_EOF__

echo 'Done! Run: cd Alchemist_Senpi && node src/main.js --mock'
