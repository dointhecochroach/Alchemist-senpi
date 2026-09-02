#!/usr/bin/env node

/**
 * Alchemist Brain — Main Orchestration (Live Data + Paper Trading)
 *
 * Data flow:
 *   - WebSocket: real-time klines + tickers (no polling, no rate limit)
 *   - REST: periodic derivatives data (OI, funding, L/S ratios) every 5 min
 *   - Coin scanner: auto-picks top 15 by volume × volatility
 *   - Falls back to mock data if Binance is geo-blocked
 *
 * Usage:
 *   node src/main.js              — Live data (auto fallback to mock)
 *   node src/main.js --mock       — Force mock data
 *   node src/main.js --debug      — Debug mode
 */

import { config } from './config.js';
import { LiveDataClient } from './data/liveDataClient.js';
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

const args = process.argv.slice(2);
const debug = args.includes('--debug');
const forceMock = args.includes('--mock');
if (debug) config.debug = true;

// ── Components ───────────────────────────────────────────────
const liveClient = new LiveDataClient();
const mockGen = new MockDataGenerator();
const memory = new Memory(config.memoryPath);
const brain = new ThesisEngine(memory);
const trader = new PaperTrader(config);
const dashboard = new Dashboard();

let scanner = null;
let scanCount = 0;
let running = true;
let mockMode = forceMock;
let mockSnapshots = null;
let currentSymbols = [];
let fetchingNext = false;

// ── Scan log ─────────────────────────────────────────────────
const scanLog = [];
function addLog(msg) {
  const t = new Date().toUTCString().slice(17, 25);
  scanLog.push(`[${t}] ${msg}`);
  if (scanLog.length > 50) scanLog.shift();
}

// ── Graceful shutdown ────────────────────────────────────────
process.on('SIGINT', () => {
  running = false;
  dashboard.stop();
  if (!mockMode) liveClient.disconnect();
  setTimeout(() => process.exit(0), 500);
});

// ── Mock data helpers ────────────────────────────────────────
function getMockSnapshots(symbols) {
  if (!mockSnapshots) {
    mockSnapshots = mockGen.generateAllSnapshots(symbols, config.timeframes, config.candleLimit);
  } else {
    mockSnapshots = mockGen.tickPrices(mockSnapshots);
  }
  return mockSnapshots;
}

function getMockScannerCoins(symbols) {
  return symbols.map((s) => ({
    symbol: s,
    volume: 50_000_000 + Math.random() * 2_000_000_000,
    volatility: 2 + Math.random() * 8,
    price: 100 + Math.random() * 90000,
    priceChangePct: (Math.random() - 0.5) * 10,
    score: Math.random() * 1e9,
    volumeStr: `$${(50 + Math.random() * 2000).toFixed(0)}M`,
  })).sort((a, b) => b.score - a.score);
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
        addLog(`🟢 AUTO-BUY ${thesis.conclusion.direction} ${symbol} @ ${position.entryPrice.toFixed(2)} | Size: $${position.size.toFixed(0)} | SL: ${position.initialStopLoss.toFixed(2)} | TP1: ${position.takeProfit1.toFixed(2)}`);
      }
    }
  }

  // Thesis invalidation
  const hasOpenPos = trader.positions.find((p) => p.symbol === symbol);
  if (hasOpenPos && thesis.conclusion.decision === 'REJECT') {
    thesisUpdates[symbol] = thesis;
  }
}

// ── Main ─────────────────────────────────────────────────────
async function main() {
  console.log('\n  🧪 ALCHEMIST BRAIN — STARTING UP');
  console.log(`  Mode: ${forceMock ? 'MOCK (forced)' : 'LIVE (real Binance data → mock fallback)'}`);
  console.log(`  Scanner: Top 15 coins by volume × volatility`);
  console.log(`  Balance: $${config.paperBalance} (paper)`);
  console.log(`  Auto-Buy: ${config.autoBuy ? 'ON' : 'OFF'}`);

  // ── Initialize data source ───────────────────────────────
  if (!forceMock) {
    console.log('  Connecting to Binance...');
    const ok = await liveClient.init();
    if (ok) {
      console.log('  ✓ Binance REST available');
      scanner = new CoinScanner(liveClient);
    } else {
      console.log('  ⚠️  Binance unavailable — switching to MOCK');
      mockMode = true;
    }
  }

  if (mockMode) {
    scanner = new CoinScanner({ getExchangeInfo: async () => ({ symbols: [] }), getAllTickers24h: async () => [] });
    scanner._fallbackCoins();
  }

  // ── Scan for top coins ────────────────────────────────────
  console.log('  Scanning for top coins...');
  if (!mockMode) {
    try {
      await scanner.scanTopCoins();
    } catch (e) {
      console.log(`  ⚠️  Scanner error: ${e.message}, using fallback`);
      scanner._fallbackCoins();
    }
  } else {
    scanner.coins = getMockScannerCoins(config.symbols);
  }
  currentSymbols = scanner.coins.map((c) => c.symbol);
  console.log(`  Tracking: ${currentSymbols.join(', ')}`);
  console.log('');

  // ── Connect WebSocket (live mode) ─────────────────────────
  if (!mockMode) {
    try {
      await liveClient.connectWebSocket(currentSymbols, config.timeframes);
      addLog('📡 WebSocket connected — real-time data streaming');
    } catch (e) {
      console.log(`  ⚠️  WebSocket failed: ${e.message} — using REST polling`);
    }
  }

  // ── Start dashboard ───────────────────────────────────────
  dashboard.start();
  dashboard.update({
    scanner: scanner.coins,
    accountState: trader.getAccountState(),
    completedTrades: trader.getCompletedTrades(20),
    memoryStats: memory.getStats(),
    memory: memory.data,
    scanLog,
  });

  // ── Derivatives refresh timer (every 5 min) ───────────────
  let lastDerivativesRefresh = 0;
  const DERIVATIVES_INTERVAL = 5 * 60 * 1000;

  // ── Continuous loop ───────────────────────────────────────
  while (running) {
    scanCount++;
    const scanStart = Date.now();

    try {
      // Periodic coin rescan (every 5 min)
      if (scanCount > 1 && Date.now() - scanner.lastScan > scanner.scanIntervalMs && !fetchingNext) {
        fetchingNext = true;
        if (!mockMode) {
          scanner.scanTopCoins().then(() => {
            const newSymbols = scanner.coins.map((c) => c.symbol);
            // Subscribe to new symbols on WS
            const added = newSymbols.filter((s) => !currentSymbols.includes(s));
            const removed = currentSymbols.filter((s) => !newSymbols.includes(s));
            if (added.length > 0 || removed.length > 0) {
              addLog(`📡 Scanner updated: +${added.length} new, -${removed.length} removed`);
              // Resubscribe WS
              if (liveClient._wsConnected) {
                // Unsubscribe removed
                if (removed.length > 0) {
                  const unsubs = removed.flatMap((s) => {
                    const l = s.toLowerCase();
                    return [...config.timeframes.map((tf) => `${l}@kline_${tf}`), `${l}@ticker`];
                  });
                  liveClient._ws.send(JSON.stringify({ method: 'UNSUBSCRIBE', params: unsubs, id: Date.now() }));
                }
                // Subscribe added
                if (added.length > 0) {
                  const subs = added.flatMap((s) => {
                    const l = s.toLowerCase();
                    return [...config.timeframes.map((tf) => `${l}@kline_${tf}`), `${l}@ticker`];
                  });
                  liveClient._ws.send(JSON.stringify({ method: 'SUBSCRIBE', params: subs, id: Date.now() }));
                }
              }
            }
            currentSymbols = newSymbols;
            dashboard.update({ scanner: scanner.coins });
            fetchingNext = false;
          }).catch(() => { fetchingNext = false; });
        } else {
          scanner.coins = getMockScannerCoins(config.symbols);
          currentSymbols = scanner.coins.map((c) => c.symbol);
          dashboard.update({ scanner: scanner.coins });
          fetchingNext = false;
        }
      }

      // Fetch data
      let snapshots;
      if (mockMode) {
        snapshots = getMockSnapshots(currentSymbols);
      } else {
        // Candles from WS cache, derivatives from REST (throttled)
        const shouldRefreshDerivatives = Date.now() - lastDerivativesRefresh > DERIVATIVES_INTERVAL;

        snapshots = {};
        for (const symbol of currentSymbols) {
          try {
            // Candles — from WS cache (instant, no API call)
            const klines = {};
            for (const tf of config.timeframes) {
              klines[tf] = await liveClient.getCandles(symbol, tf, config.candleLimit);
            }

            if (shouldRefreshDerivatives) {
              // Full snapshot with REST derivatives
              snapshots[symbol] = await liveClient.getSymbolSnapshot(currentSymbols.includes(symbol) ? symbol : symbol, config.timeframes);
            } else {
              // Just candles + cached ticker from WS
              snapshots[symbol] = {
                symbol,
                timestamp: Date.now(),
                klines,
                openInterest: null,
                oiHistory: [],
                funding: null,
                fundingHistory: [],
                topTraderLS: [],
                globalLS: [],
                takerVolume: [],
                ticker24h: liveClient.getTicker(symbol),
              };
            }
          } catch (e) {
            if (debug) addLog(`⚠️ ${symbol}: ${e.message}`);
            snapshots[symbol] = null;
          }
        }

        if (shouldRefreshDerivatives) {
          lastDerivativesRefresh = Date.now();
          addLog('🔄 Derivatives data refreshed (OI, funding, L/S ratios)');
        }
      }

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
        if (action.type === 'TP1_HIT') addLog(`🎯 TP1 hit ${action.symbol} @ ${action.price?.toFixed(2)}`);
        else if (action.type === 'BREAKEVEN_MOVED') addLog(`📌 Breakeven ${action.symbol} @ ${action.stopLoss?.toFixed(2)}`);
        else if (action.type === 'TRAILING_STARTED') addLog(`📈 Trailing started ${action.symbol}`);
        else if (action.type === 'POSITION_CLOSED') {
          const pnlStr = action.pnlUSD >= 0 ? `+${action.pnlUSD.toFixed(2)}` : `${action.pnlUSD.toFixed(2)}`;
          const emoji = action.pnlUSD >= 0 ? '✅' : '❌';
          addLog(`${emoji} CLOSED ${action.symbol} @ ${action.exitPrice?.toFixed(2)} | PnL: ${pnlStr} (${action.pnlPct.toFixed(2)}%) | ${action.reason}`);
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

      if (debug && scanCount % 10 === 0) {
        const scanTime = ((Date.now() - scanStart) / 1000).toFixed(1);
        const eCount = opportunities.filter((o) => o.conclusion.decision === 'ENTER').length;
        addLog(`Scan #${scanCount} | ${scanTime}s | ${mockMode ? 'MOCK' : 'LIVE'} | E:${eCount}`);
      }

      // Small delay — 500ms in live mode (WS updates continuously),
      // 100ms in mock mode
      await new Promise((r) => setTimeout(r, mockMode ? 100 : 500));

    } catch (err) {
      if (debug) console.error('[Main]', err.message);
      addLog(`⚠️ Error: ${err.message}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  dashboard.stop();
  if (!mockMode) liveClient.disconnect();
  console.log('Alchemist Brain stopped.');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
