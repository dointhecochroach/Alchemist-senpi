#!/usr/bin/env node

/**
 * Alchemist Brain — Main Orchestration Loop
 *
 * - Continuously scans (never pauses — fetches next batch while analyzing current)
 * - Dynamically picks top 15 coins by volume × volatility
 * - Interactive TUI dashboard with [1-6] keyboard navigation
 * - Auto-buy when Brain says ENTER
 *
 * Usage:
 *   node src/main.js              — Run (auto-falls back to mock data)
 *   node src/main.js --mock       — Force mock data mode
 *   node src/main.js --debug      — Debug mode
 */

import { config } from './config.js';
import { BinanceClient } from './data/binanceClient.js';
import { MockDataGenerator } from './data/mockData.js';
import { CoinScanner } from './data/coinScanner.js';
import { analyzeSMC } from './smc/smcAnalyzer.js';
import { analyzeSmartMoney } from './smart_money/smartMoneyAnalyzer.js';
import { analyzeTechnicals } from './technical/technicalAnalyzer.js';
import { ThesisEngine } from './brain/thesisEngine.js';
import { Memory } from './brain/memory.js';
import { PaperTrader } from './execution/paperTrader.js';
import { Dashboard } from './display/dashboard.js';

// ── Parse CLI args ────────────────────────────────────────────
const args = process.argv.slice(2);
const debug = args.includes('--debug');
const forceMock = args.includes('--mock');
if (debug) config.debug = true;

// ── Initialize components ─────────────────────────────────────
const binance = new BinanceClient();
const mockGen = new MockDataGenerator();
const scanner = new CoinScanner(binance);
const memory = new Memory(config.memoryPath);
const brain = new ThesisEngine(memory);
const trader = new PaperTrader(config);
const dashboard = new Dashboard();

let scanCount = 0;
let running = true;
let mockMode = forceMock;
let mockSnapshots = null;
let currentSymbols = [];
let fetchingNext = false;

// ── Graceful shutdown ────────────────────────────────────────
process.on('SIGINT', () => {
  console.log('\n\n🛑 Alchemist Brain shutting down...');
  running = false;
  dashboard.stop();
  setTimeout(() => process.exit(0), 500);
});

// ── Data fetcher with fallback ───────────────────────────────
async function fetchSnapshots(symbols) {
  if (mockMode) {
    if (!mockSnapshots) {
      mockSnapshots = mockGen.generateAllSnapshots(symbols, config.timeframes, config.candleLimit);
    } else {
      mockSnapshots = mockGen.tickPrices(mockSnapshots);
    }
    return mockSnapshots;
  }

  try {
    const snapshots = await binance.getAllSnapshots(symbols, config.timeframes, config.candleLimit);
    const allFailed = symbols.every((s) => !snapshots[s] || !snapshots[s].klines?.[config.primaryTF]?.length);
    if (allFailed) {
      if (debug) console.log('\n⚠️  Binance API unavailable. Switching to MOCK DATA mode.\n');
      mockMode = true;
      mockSnapshots = mockGen.generateAllSnapshots(symbols, config.timeframes, config.candleLimit);
      return mockSnapshots;
    }
    return snapshots;
  } catch (err) {
    if (!mockMode) {
      if (debug) console.log('\n⚠️  Binance API error. Switching to MOCK DATA mode.\n');
      mockMode = true;
      mockSnapshots = mockGen.generateAllSnapshots(symbols, config.timeframes, config.candleLimit);
      return mockSnapshots;
    }
    throw err;
  }
}

// ── Update symbols from scanner ──────────────────────────────
async function updateSymbols() {
  try {
    const symbols = await scanner.getTopCoins();
    if (symbols && symbols.length > 0) {
      currentSymbols = symbols;
      if (debug) console.log(`[Scanner] Tracking ${symbols.length} coins`);
    }
  } catch (e) {
    if (debug) console.log(`[Scanner] Error: ${e.message}`);
  }
}

// ── Analyze one symbol ───────────────────────────────────────
async function analyzeSymbol(symbol, snapshot, scanStart, opportunities, currentPrices, thesisUpdates) {
  if (!snapshot || !snapshot.klines?.[config.primaryTF]?.length) return;

  const candles = snapshot.klines[config.primaryTF];
  const htfCandles = snapshot.klines[config.structureTF] || [];
  currentPrices[symbol] = candles[candles.length - 1].close;

  // SMC
  const smcAnalysis = analyzeSMC(candles, { swingLookback: 2 });
  if (htfCandles.length > 10) {
    const htfSMC = analyzeSMC(htfCandles, { swingLookback: 2 });
    smcAnalysis.htf = htfSMC;
    if (htfSMC.structure.bias !== smcAnalysis.structure.bias && htfSMC.structure.bias !== 'NEUTRAL') {
      smcAnalysis.htfConflict = true;
    }
  }

  // Smart Money
  const smartMoneyAnalysis = analyzeSmartMoney(snapshot);

  // Technicals
  const technicalAnalysis = analyzeTechnicals(candles, smcAnalysis);

  // Brain
  const accountState = trader.getAccountState();
  const thesis = brain.evaluate(symbol, smcAnalysis, smartMoneyAnalysis, accountState, technicalAnalysis);
  thesis.smc = smcAnalysis;
  thesis.smartMoney = smartMoneyAnalysis;
  thesis.technical = technicalAnalysis;
  thesis.currentPrice = currentPrices[symbol];
  opportunities.push(thesis);

  // Auto-buy
  if (thesis.conclusion.decision === 'ENTER' && config.autoBuy) {
    const riskAnalysis = brain.riskAnalyzer.analyze(smcAnalysis, smartMoneyAnalysis, accountState);
    if (riskAnalysis.approved && trader.positions.length < config.maxConcurrentPositions) {
      thesis.risk = riskAnalysis;
      const position = trader.openPosition(thesis, riskAnalysis);
      if (position) {
        const logMsg = `🟢 AUTO-BUY ${thesis.conclusion.direction} ${symbol} @ ${position.entryPrice} | Size: $${position.size.toFixed(2)} | SL: ${position.initialStopLoss.toFixed(2)} | TP1: ${position.takeProfit1.toFixed(2)}`;
        if (debug) console.log(`[AUTO-BUY] ${thesis.conclusion.direction} ${symbol} @ ${position.entryPrice}`);
        addScanLog(logMsg);
      }
    }
  }

  // Thesis invalidation for open positions
  const hasOpenPos = trader.positions.find((p) => p.symbol === symbol);
  if (hasOpenPos && thesis.conclusion.decision === 'REJECT') {
    thesisUpdates[symbol] = thesis;
  }
}

// ── Scan log ─────────────────────────────────────────────────
const scanLog = [];
function addScanLog(msg) {
  const time = new Date().toUTCString().slice(17, 25);
  scanLog.push(`[${time}] ${msg}`);
  if (scanLog.length > 50) scanLog.shift();
}

// ── Main loop (continuous) ───────────────────────────────────
async function main() {
  console.log('\n  🧪 ALCHEMIST BRAIN — STARTING UP');
  console.log(`  Mode: ${forceMock ? 'MOCK (forced)' : 'AUTO (real → mock fallback)'}`);
  console.log(`  Symbols: Dynamic top ${config.maxConcurrentPositions || 15} by volume × volatility`);
  console.log(`  Scan: CONTINUOUS (no pauses)`);
  console.log(`  Balance: $${config.paperBalance}`);
  console.log(`  Auto-Buy: ${config.autoBuy ? 'ON' : 'OFF'}`);
  console.log('');

  // Start dashboard
  dashboard.start();

  // Initial symbol scan
  if (!forceMock) {
    await scanner.scanTopCoins();
  } else {
    // Mock mode: use default symbols but still show scanner
    scanner._fallbackCoins();
    // Generate mock scanner data with volume/volatility
    const mockTicker = config.symbols.map((s) => ({
      symbol: s,
      volume: 50_000_000 + Math.random() * 2_000_000_000,
      volatility: 2 + Math.random() * 8,
      price: 100 + Math.random() * 90000,
      priceChangePct: (Math.random() - 0.5) * 10,
      score: Math.random() * 1e9,
      volumeStr: `$${(50 + Math.random() * 2000).toFixed(0)}M`,
    })).sort((a, b) => b.score - a.score);
    scanner.coins = mockTicker;
  }
  currentSymbols = scanner.coins.map((c) => c.symbol);

  // Update dashboard with scanner data
  dashboard.update({
    scanner: scanner.coins,
    accountState: trader.getAccountState(),
    completedTrades: trader.getCompletedTrades(20),
    memoryStats: memory.getStats(),
    memory: memory.data,
    scanLog,
  });

  // Continuous loop — no sleep between scans
  while (running) {
    scanCount++;
    const scanStart = Date.now();

    try {
      // Periodically rescan top coins (every 5 min)
      if (scanCount > 1 && Date.now() - scanner.lastScan > scanner.scanIntervalMs && !forceMock) {
        if (!fetchingNext) {
          fetchingNext = true;
          scanner.scanTopCoins().then(() => {
            currentSymbols = scanner.coins.map((c) => c.symbol);
            dashboard.update({ scanner: scanner.coins });
            fetchingNext = false;
          });
        }
      }

      // Fetch data for all current symbols
      const snapshots = await fetchSnapshots(currentSymbols);

      // Analyze each symbol
      const opportunities = [];
      const currentPrices = {};
      const thesisUpdates = {};

      for (const symbol of currentSymbols) {
        await analyzeSymbol(symbol, snapshots[symbol], scanStart, opportunities, currentPrices, thesisUpdates);
      }

      // Update positions
      const actions = trader.updatePositions(currentPrices, thesisUpdates);
      for (const action of actions) {
        if (action.type === 'TP1_HIT') addScanLog(`🎯 TP1 hit ${action.symbol} @ ${action.price}`);
        else if (action.type === 'BREAKEVEN_MOVED') addScanLog(`📌 Breakeven ${action.symbol} @ ${action.stopLoss}`);
        else if (action.type === 'TRAILING_STARTED') addScanLog(`📈 Trailing started ${action.symbol}`);
        else if (action.type === 'POSITION_CLOSED') {
          const pnlStr = action.pnlUSD >= 0 ? `+${action.pnlUSD.toFixed(2)}` : `${action.pnlUSD.toFixed(2)}`;
          const emoji = action.pnlUSD >= 0 ? '✅' : '❌';
          addScanLog(`${emoji} CLOSED ${action.symbol} @ ${action.exitPrice} | PnL: ${pnlStr} (${action.pnlPct.toFixed(2)}%) | ${action.reason}`);
          // Record in memory
          const completedTrade = trader.completedTrades.find(
            (t) => t.symbol === action.symbol && t.exitTime > scanStart
          );
          if (completedTrade) memory.recordTrade(completedTrade);
        }
      }

      // Update dashboard
      dashboard.update({
        opportunities,
        accountState: trader.getAccountState(),
        completedTrades: trader.getCompletedTrades(20),
        memoryStats: memory.getStats(),
        memory: memory.data,
        scanner: scanner.coins,
        scanLog,
      });

      // Debug scan summary
      if (debug) {
        const scanTime = ((Date.now() - scanStart) / 1000).toFixed(1);
        const enterCount = opportunities.filter((o) => o.conclusion.decision === 'ENTER').length;
        const waitCount = opportunities.filter((o) => o.conclusion.decision === 'WAIT').length;
        const rejectCount = opportunities.filter((o) => o.conclusion.decision === 'REJECT').length;
        addScanLog(`Scan #${scanCount} | ${scanTime}s | ${mockMode ? 'MOCK' : 'LIVE'} | E:${enterCount} W:${waitCount} R:${rejectCount}`);
      }

      // Small delay to prevent CPU thrashing (not a full pause)
      await new Promise((r) => setTimeout(r, 100));

    } catch (err) {
      if (debug) console.error('[Main] Scan error:', err.message);
      addScanLog(`⚠️ Error: ${err.message}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  dashboard.stop();
  console.log('Alchemist Brain stopped.');
}

// ── Start ────────────────────────────────────────────────────
main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
