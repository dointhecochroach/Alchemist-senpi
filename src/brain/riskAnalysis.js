/**
 * Alchemist Brain — Risk Analysis
 *
 * Evaluates whether a potential trade meets risk criteria.
 * Checks position sizing, stop loss placement, R:R ratio,
 * and account-level risk limits.
 */

export class RiskAnalyzer {
  constructor(config = null, memory = null) {
    this.config = config || {
      riskPerTradePct: 1.0,
      initialStoplossPct: 3.0,
      tp1Pct: 1.5,
      minRR: 1.0,
      maxOpenPositions: 5,
      maxRiskPerSymbolPct: 3.0,
      maxDailyLossPct: 6.0,
      maxLeverage: 10,
    };
    this.memory = memory;
  }

  /**
   * Analyze risk for a potential trade.
   * Uses learned sizing from memory if available.
   */
  analyze(smcAnalysis, smartMoneyAnalysis, accountState, tradeDirection = null, patternKey = null, confidence = 50) {
    const balance = accountState?.balance || 10000;
    const openPositions = accountState?.openPositions || [];
    const dailyPnL = accountState?.dailyPnL || 0;

    // Use trade direction if provided, otherwise fall back to SMC bias
    const effectiveDir = tradeDirection || smcAnalysis.thesisDirection || smcAnalysis.structure?.bias || 'BULLISH';

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

    const newRiskUSD = (balance * (this.memory ? (this.memory.getSizingForPattern(patternKey || '', confidence).riskPct) : this.config.riskPerTradePct)) / 100;
    const totalSymbolRisk = symbolRisk + newRiskUSD;
    const totalSymbolRiskPct = (totalSymbolRisk / balance) * 100;

    if (totalSymbolRiskPct > this.config.maxRiskPerSymbolPct) {
      result.approved = false;
      result.reason = 'MAX_RISK_PER_SYMBOL_EXCEEDED';
      return result;
    }

    // ── Calculate position size with learned sizing ────────
    let riskPct = this.config.riskPerTradePct;
    let leverage = 3; // Default leverage

    // Get learned sizing from memory
    if (this.memory && patternKey) {
      const sizing = this.memory.getSizingForPattern(patternKey, confidence);
      riskPct = sizing.riskPct;
      leverage = sizing.leverage;
    }

    result.leverage = leverage;
    result.riskUSD = (balance * riskPct) / 100;
    result.riskPct = riskPct;
    result.stopLossPct = this.config.initialStoplossPct;
    result.stopLossPrice = this._calcStopLoss(smcAnalysis, effectiveDir);
    result.tp1Price = this._calcTP1(smcAnalysis, effectiveDir);

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

  _calcStopLoss(smcAnalysis, direction = 'LONG') {
    const price = smcAnalysis.currentPrice;
    const slPct = this.config.initialStoplossPct / 100;

    if (direction === 'BEARISH' || direction === 'SHORT') {
      // Short — stop ABOVE entry price
      const protectedHigh = smcAnalysis.protectedLevels?.protectedHigh?.price;
      if (protectedHigh && protectedHigh > price) {
        return protectedHigh * 1.002;
      }
      return price * (1 + slPct);
    } else {
      // Long — stop BELOW entry price
      const protectedLow = smcAnalysis.protectedLevels?.protectedLow?.price;
      if (protectedLow && protectedLow < price) {
        return protectedLow * 0.998;
      }
      return price * (1 - slPct);
    }
  }

  _calcTP1(smcAnalysis, direction = 'LONG') {
    const price = smcAnalysis.currentPrice;
    const tpPct = this.config.tp1Pct / 100;

    if (direction === 'BEARISH' || direction === 'SHORT') {
      // Short — TP BELOW entry
      const fvg = smcAnalysis.fvg?.current;
      if (fvg?.direction === 'BEARISH' && fvg.lowerBoundary < price) {
        return fvg.lowerBoundary;
      }
      const target = smcAnalysis.liquidity?.liquidityTargets?.find((t) => t.direction === 'DOWN');
      if (target?.level < price) return target.level;
      return price * (1 - tpPct);
    } else {
      // Long — TP ABOVE entry
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
