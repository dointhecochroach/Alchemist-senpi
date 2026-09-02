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