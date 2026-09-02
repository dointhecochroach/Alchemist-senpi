/**
 * Alchemist Brain — Risk Analysis
 *
 * Evaluates whether a potential trade meets risk criteria.
 * Checks position sizing, stop loss placement, R:R ratio,
 * and account-level risk limits.
 */

export class RiskAnalyzer {
  constructor(config = null) {
    this.config = config || {
      riskPerTradePct: 1.0,
      initialStoplossPct: 3.0,
      tp1Pct: 3.0,
      minRR: 1.5,
      maxOpenPositions: 5,
      maxRiskPerSymbolPct: 3.0,
      maxDailyLossPct: 6.0,
    };
  }

  /**
   * Analyze risk for a potential trade.
   */
  analyze(smcAnalysis, smartMoneyAnalysis, accountState) {
    const balance = accountState?.balance || 10000;
    const openPositions = accountState?.openPositions || [];
    const dailyPnL = accountState?.dailyPnL || 0;

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

    const newRiskUSD = (balance * this.config.riskPerTradePct) / 100;
    const totalSymbolRisk = symbolRisk + newRiskUSD;
    const totalSymbolRiskPct = (totalSymbolRisk / balance) * 100;

    if (totalSymbolRiskPct > this.config.maxRiskPerSymbolPct) {
      result.approved = false;
      result.reason = 'MAX_RISK_PER_SYMBOL_EXCEEDED';
      return result;
    }

    // ── Calculate position size ──────────────────────────────
    result.riskUSD = newRiskUSD;
    result.stopLossPct = this.config.initialStoplossPct;
    result.stopLossPrice = this._calcStopLoss(smcAnalysis);
    result.tp1Price = this._calcTP1(smcAnalysis);

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
