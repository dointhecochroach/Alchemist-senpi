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
