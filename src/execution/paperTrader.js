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
