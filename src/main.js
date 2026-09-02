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
