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
        tp1Pct: 1.5,
        tp1SellPct: 30,
        breakevenAfterTP1: true,
        trailingStartPct: 2.0,
        trailingStepPct: 0.5,
        maxTrailingDistancePct: 3.0,
        trailingSensitivity: 1.0,
        // Learned adjustments
        adjustments: [],
      },
      sizingRules: {        // Adaptive position sizing & leverage
        baseRiskPct: 1.0,       // Start at 1% risk per trade
        baseLeverage: 3,         // Start at 3x leverage
        maxLeverage: 10,         // Hard cap
        minLeverage: 1,
        // Per-pattern adjustments
        patternSizing: {},       // pattern key → { riskPct, leverage, winRate, avgPnL }
        // Global learned adjustments
        sizingAdjustments: [],
        // Confidence-based scaling
        highConfidenceMultiplier: 1.5,   // If confidence > 80, scale up
        lowConfidenceMultiplier: 0.5,    // If confidence < 60, scale down
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
    this._updateSizingRules(record);
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

  /**
   * Get adaptive position sizing and leverage for a pattern.
   * Returns { riskPct, leverage } adjusted by learned performance.
   */
  getSizingForPattern(patternKey, confidence = 50) {
    const rules = this.data.sizingRules;
    let riskPct = rules.baseRiskPct;
    let leverage = rules.baseLeverage;

    // Adjust based on pattern history
    const pattern = this.data.patterns[patternKey];
    if (pattern && pattern.sampleSize >= 3) {
      const ps = rules.patternSizing[patternKey];
      if (ps) {
        riskPct = ps.riskPct;
        leverage = ps.leverage;
      }
      // Fine-tune based on win rate
      if (pattern.winRate >= 70) {
        riskPct *= 1.2;  // Winning pattern → risk more
        leverage = Math.min(rules.maxLeverage, leverage + 1);
      } else if (pattern.winRate <= 40) {
        riskPct *= 0.6;  // Losing pattern → risk less
        leverage = Math.max(rules.minLeverage, leverage - 1);
      }
    }

    // Adjust based on confidence
    if (confidence >= 80) {
      riskPct *= rules.highConfidenceMultiplier;
    } else if (confidence < 60) {
      riskPct *= rules.lowConfidenceMultiplier;
    }

    // Clamp
    riskPct = Math.max(0.25, Math.min(5.0, riskPct));
    leverage = Math.max(rules.minLeverage, Math.min(rules.maxLeverage, leverage));

    return {
      riskPct: parseFloat(riskPct.toFixed(2)),
      leverage: Math.round(leverage),
    };
  }

  getSizingRules() {
    return this.data.sizingRules;
  }

  _updateSizingRules(record) {
    const rules = this.data.sizingRules;
    const key = record.pattern;
    if (!key) return;

    // Initialize pattern sizing
    if (!rules.patternSizing[key]) {
      rules.patternSizing[key] = {
        riskPct: rules.baseRiskPct,
        leverage: rules.baseLeverage,
        winRate: 0,
        avgPnL: 0,
        sampleSize: 0,
      };
    }

    const ps = rules.patternSizing[key];
    ps.sampleSize++;
    ps.winRate = Math.round(((ps.winRate / 100) * (ps.sampleSize - 1) + (record.result === 'WIN' ? 1 : 0)) * 100);
    ps.avgPnL = parseFloat(((ps.avgPnL * (ps.sampleSize - 1) + record.pnlPct) / ps.sampleSize).toFixed(2));

    // Adjust risk and leverage based on performance
    if (ps.sampleSize >= 3) {
      if (ps.winRate >= 65 && ps.avgPnL > 0) {
        // Winning pattern → gradually increase
        ps.riskPct = Math.min(5.0, parseFloat((ps.riskPct * 1.1).toFixed(2)));
        ps.leverage = Math.min(rules.maxLeverage, ps.leverage + 1);
      } else if (ps.winRate <= 40 || ps.avgPnL < 0) {
        // Losing pattern → decrease
        ps.riskPct = Math.max(0.25, parseFloat((ps.riskPct * 0.8).toFixed(2)));
        ps.leverage = Math.max(rules.minLeverage, ps.leverage - 1);
      }
    }

    // Log sizing adjustment
    rules.sizingAdjustments.push({
      timestamp: Date.now(),
      tradeId: record.id,
      pattern: key,
      result: record.result,
      pnlPct: record.pnlPct,
      adjustedRisk: ps.riskPct,
      adjustedLeverage: ps.leverage,
      patternWinRate: ps.winRate,
      patternSampleSize: ps.sampleSize,
    });

    // Keep only last 50 adjustments
    if (rules.sizingAdjustments.length > 50) {
      rules.sizingAdjustments = rules.sizingAdjustments.slice(-50);
    }
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
