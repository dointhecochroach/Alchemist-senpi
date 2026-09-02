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
  tp1Pct: 1.5,                   // TP1 at 1.5%
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
