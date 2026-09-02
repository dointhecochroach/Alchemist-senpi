#!/usr/bin/env node

/**
 * Alchemist Brain — Paper Trading Bot
 *
 * Uses REAL Binance public API data (no keys needed).
 * WebSocket for real-time klines + tickers.
 * REST for derivatives data (OI, funding, L/S ratios) every 30s.
 * Coin scanner picks top 15 by volume × volatility every 30s.
 * Paper trades with real market prices — no mock data.
 *
 * Usage:
 *   node src/main.js              — Start paper trading
 *   node src/main.js --debug      — Debug mode
 */

import { config } from './config.js';
import { LiveDataClient } from './data/liveDataClient.js';
import { CoinScanner } from './data/coinScanner.js';
import { analyzeSMC } from './smc/smcAnalyzer.js';
import { analyzeSmartMoney } from './smart_money/smartMoneyAnalyzer.js';
import { analyzeTechnicals } from './technical/technicalAnalyzer.js';
import { ThesisEngine } from './brain/thesisEngine.js';
import { Memory } from './brain/memory.js';
import { PaperTrader } from './execution/paperTrader.js';
import { Dashboard } from './display/dashboard.js';
import { appendFileSync } from 'fs';

const args = process.argv.slice(2);
const debug = args.includes('--debug');
if (debug) config.debug = true;

// ── Components ───────────────────────────────────────────────
const liveClient = new LiveDataClient();
const memory = new Memory(config.memoryPath);
const brain = new ThesisEngine(memory);
const trader = new PaperTrader(config);
const dashboard = new Dashboard();
let scanner = null;

let scanCount = 0;
let running = true;
let currentSymbols = [];
let fetchingNext = false;

// ── Scan log ─────────────────────────────────────────────────
const scanLog = [];
const LOG_FILE = 'storage/bot.log';

function addLog(msg) {
  const t = new Date().toUTCString().slice(17, 25);
  const entry = `[${t}] ${msg}`;
  scanLog.push(entry);
  if (scanLog.length > 50) scanLog.shift();
  try { appendFileSync(LOG_FILE, entry + '\n'); } catch {}
}

// ── Silence console so it doesn't scroll the terminal ─────
// Route all console.log/error to log file instead of stdout
console.log = (...args) => {
  try { appendFileSync(LOG_FILE, '[console] ' + args.join(' ') + '\n'); } catch {}
};
console.error = (...args) => {
  try { appendFileSync(LOG_FILE, '[error] ' + args.join(' ') + '\n'); } catch {}
};

// ── Graceful shutdown ────────────────────────────────────────
process.on('SIGINT', () => {
  running = false;
  dashboard.stop();
  liveClient.disconnect();
  setTimeout(() => process.exit(0), 500);
});

// ── Analyze one symbol ───────────────────────────────────────
async function analyzeSymbol(symbol, snapshot, scanStart, opportunities, currentPrices, thesisUpdates) {
  if (!snapshot || !snapshot.klines?.[config.primaryTF]?.length) return;

  const candles = snapshot.klines[config.primaryTF];
  const htfCandles = snapshot.klines[config.structureTF] || [];
  currentPrices[symbol] = candles[candles.length - 1].close;

  // SMC
  const smcAnalysis = analyzeSMC(candles, {
    swingLookback: 2,
    depth: snapshot.depth || snapshot.orderBook || null,
    aggTrades: snapshot.aggTrades || null,
  });
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
    const tradeDir = thesis.conclusion.direction;
    // Don't open if we already have a position on this symbol
    const existing = trader.positions.find((p) => p.symbol === symbol);
    if (existing) {
      return;
    }
    // Get pattern key for learned sizing
    const patternKey = memory._patternKey(symbol, tradeDir, smcAnalysis, smartMoneyAnalysis, technicalAnalysis);
    const confidence = thesis.scores?.confidence || 50;
    const riskAnalysis = brain.riskAnalyzer.analyze(smcAnalysis, smartMoneyAnalysis, accountState, tradeDir, patternKey, confidence);
    if (riskAnalysis.approved && trader.positions.length < config.maxConcurrentPositions) {
      thesis.risk = riskAnalysis;
      const position = trader.openPosition(thesis, riskAnalysis);
      if (position) {
        addLog(`🟢 AUTO-BUY ${thesis.conclusion.direction} ${symbol} @ ${position.entryPrice.toFixed(2)} | Size: $${position.size.toFixed(0)} | SL: ${position.initialStopLoss.toFixed(2)} | TP1: ${position.takeProfit1.toFixed(2)}`);
      }
    }
  }

  // Thesis invalidation — only after minimum hold period (5 minutes)
  const hasOpenPos = trader.positions.find((p) => p.symbol === symbol);
  if (hasOpenPos && thesis.conclusion.decision === 'REJECT') {
    const holdTimeMs = Date.now() - hasOpenPos.entryTime;
    const minHoldMs = 5 * 60 * 1000; // 5 minutes minimum hold
    if (holdTimeMs < minHoldMs) {
      // Too early to invalidate — let the stop loss / TP1 manage the trade
      // Don't send thesis update
    } else {
      thesisUpdates[symbol] = thesis;
      addLog(`📋 Thesis invalidated for ${symbol} after ${Math.round(holdTimeMs / 60000)}min`);
    }
  }
}

// ── Main ─────────────────────────────────────────────────────
async function main() {
  process.stdout.write('  🧪 ALCHEMIST BRAIN — Paper Trading (Real Data)\n');

  // ── Connect to Binance ────────────────────────────────────
  process.stdout.write('  Connecting to Binance API...');
  const ok = await liveClient.init();

  if (!ok) {
    process.stdout.write('\n  ❌ Cannot reach Binance. Check your internet connection.\n');
    process.stdout.write('  Make sure Binance is available in your region.\n');
    process.exit(1);
  }

  if (liveClient.futuresAvailable) {
    process.stdout.write('\r  🧪 ALCHEMIST BRAIN — LIVE DATA (Futures + Spot)    \n');
  } else if (liveClient.spotAvailable) {
    process.stdout.write('\r  🧪 ALCHEMIST BRAIN — LIVE DATA (Spot, futures blocked)    \n');
  }

  scanner = new CoinScanner(liveClient);

  // ── Scan for top coins ────────────────────────────────────
  process.stdout.write('  Scanning top coins...\r');
  try {
    await scanner.scanTopCoins();
  } catch (e) {
    addLog(`Scanner error: ${e.message}, using fallback coins`);
    scanner._fallbackCoins();
  }
  currentSymbols = scanner.coins.map((c) => c.symbol);
  addLog(`📡 Tracking ${currentSymbols.length} coins: ${currentSymbols.join(', ')}`);

  // ── Connect WebSocket ─────────────────────────────────────
  try {
    await liveClient.connectWebSocket(currentSymbols, config.timeframes);
    addLog('📡 WebSocket connected — real-time streaming');
  } catch (e) {
    addLog(`⚠️ WebSocket failed: ${e.message} — using REST polling`);
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

  // ── Derivatives refresh (every 30s) ───────────────────────
  let lastDerivativesRefresh = 0;
  const DERIVATIVES_INTERVAL = 30 * 1000;

  // ── Continuous loop ───────────────────────────────────────
  while (running) {
    scanCount++;
    const scanStart = Date.now();

    try {
      // Periodic coin rescan (every 30s)
      if (scanCount > 1 && Date.now() - scanner.lastScan > scanner.scanIntervalMs && !fetchingNext) {
        fetchingNext = true;
        scanner.scanTopCoins().then(() => {
          const newSymbols = scanner.coins.map((c) => c.symbol);
          const added = newSymbols.filter((s) => !currentSymbols.includes(s));
          const removed = currentSymbols.filter((s) => !newSymbols.includes(s));
          if (added.length > 0 || removed.length > 0) {
            addLog(`📡 Scanner updated: +${added.length} new, -${removed.length} removed`);
            // Update WS subscriptions
            if (liveClient._wsConnected) {
              if (removed.length > 0) {
                const unsubs = removed.flatMap((s) => {
                  const l = s.toLowerCase();
                  return [...config.timeframes.map((tf) => `${l}@kline_${tf}`), `${l}@ticker`];
                });
                try { liveClient._ws.send(JSON.stringify({ method: 'UNSUBSCRIBE', params: unsubs, id: Date.now() })); } catch {}
              }
              if (added.length > 0) {
                const subs = added.flatMap((s) => {
                  const l = s.toLowerCase();
                  return [...config.timeframes.map((tf) => `${l}@kline_${tf}`), `${l}@ticker`];
                });
                try { liveClient._ws.send(JSON.stringify({ method: 'SUBSCRIBE', params: subs, id: Date.now() })); } catch {}
              }
            }
          }
          currentSymbols = newSymbols;
          dashboard.update({ scanner: scanner.coins });
          fetchingNext = false;
        }).catch(() => { fetchingNext = false; });
      }

      // Fetch data — candles from WS cache, derivatives from REST
      const shouldRefreshDerivatives = Date.now() - lastDerivativesRefresh > DERIVATIVES_INTERVAL;
      const snapshots = {};

      for (const symbol of currentSymbols) {
        try {
          if (shouldRefreshDerivatives) {
            // Full snapshot with REST derivatives
            snapshots[symbol] = await liveClient.getSymbolSnapshot(symbol, config.timeframes);
          } else {
            // Just candles from WS cache + ticker
            const klines = {};
            for (const tf of config.timeframes) {
              klines[tf] = await liveClient.getCandles(symbol, tf, config.candleLimit);
            }
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
        addLog('🔄 Derivatives refreshed (OI, funding, L/S ratios)');
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
        addLog(`Scan #${scanCount} | ${scanTime}s | E:${eCount}`);
      }

      // 5 second delay between scans — realistic pace
      await new Promise((r) => setTimeout(r, 5000));

    } catch (err) {
      if (debug) console.error('[Main]', err.message);
      addLog(`⚠️ Error: ${err.message}`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  dashboard.stop();
  liveClient.disconnect();
  console.log('Alchemist Brain stopped.');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
