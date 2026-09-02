/**
 * Alchemist Brain — Thesis Engine
 *
 * The core reasoning system. NOT a simple scoring bot.
 *
 * Pipeline:
 *   Market Data + SMC + Smart Money + Technicals
 *     → Form Thesis
 *     → Gather Supporting Evidence
 *     → Gather Contradicting Evidence
 *     → Form Counter-Thesis
 *     → Compare Both Sides
 *     → Consult Memory
 *     → Risk Analysis
 *     → Conclusion (ENTER / WAIT / REJECT)
 *     → Score + Confidence (measurements, NOT the decision)
 */

import { Memory } from './memory.js';
import { RiskAnalyzer } from './riskAnalysis.js';

// ──────────────────────────────────────────────────────────────
//  THESIS ENGINE
// ──────────────────────────────────────────────────────────────

export class ThesisEngine {
  constructor(memory) {
    this.memory = memory || new Memory();
    this.riskAnalyzer = new RiskAnalyzer(null, this.memory);
  }

  /**
   * Run the full thesis pipeline on one symbol's data.
   * Returns a complete Brain thesis for the scorecard.
   */
  evaluate(symbol, smcAnalysis, smartMoneyAnalysis, accountState, technicalAnalysis = null) {
    // ── 1. FORM PRIMARY THESIS ───────────────────────────────
    const primaryThesis = this._formThesis(smcAnalysis, smartMoneyAnalysis, technicalAnalysis);

    // ── 2. GATHER SUPPORTING EVIDENCE ────────────────────────
    const supporting = this._gatherSupporting(smcAnalysis, smartMoneyAnalysis, technicalAnalysis, primaryThesis.direction);

    // ── 3. GATHER CONTRADICTING EVIDENCE ─────────────────────
    const contradicting = this._gatherContradicting(smcAnalysis, smartMoneyAnalysis, technicalAnalysis, primaryThesis.direction);

    // ── 4. FORM COUNTER-THESIS ───────────────────────────────
    const counterThesis = this._formCounterThesis(smcAnalysis, smartMoneyAnalysis, technicalAnalysis, primaryThesis);

    // ── 5. COMPARE BOTH SIDES ────────────────────────────────
    const comparison = this._compareSides(supporting, contradicting, primaryThesis, counterThesis);

    // ── 6. CONSULT MEMORY ────────────────────────────────────
    const memoryResult = this.memory.lookup(symbol, primaryThesis.direction, smcAnalysis, smartMoneyAnalysis, technicalAnalysis);

    // ── 7. RISK ANALYSIS ─────────────────────────────────────
    const risk = this.riskAnalyzer.analyze(smcAnalysis, smartMoneyAnalysis, accountState);

    // ── 8. CONCLUSION ────────────────────────────────────────
    const conclusion = this._conclude(comparison, memoryResult, risk, primaryThesis, counterThesis);

    // ── 9. SCORES (measurements, not the decision) ───────────
    const scores = this._calculateScores(supporting, contradicting, comparison, conclusion);

    return {
      symbol,
      timestamp: Date.now(),
      primaryThesis,
      supporting,
      contradicting,
      counterThesis,
      comparison,
      memory: memoryResult,
      risk,
      conclusion,
      scores,
    };
  }

  // ═══════════════════════════════════════════════════════════
  //  THESIS FORMATION
  // ═══════════════════════════════════════════════════════════

  _formThesis(smc, smartMoney, tech = null) {
    const direction = this._determineDirection(smc, smartMoney, tech);
    const narrative = this._buildNarrative(smc, smartMoney, tech, direction);
    const invalidation = this._buildInvalidation(smc, direction);

    const conflict = this._computeConflict(smc, smartMoney, tech);

    return {
      direction,
      narrative,
      invalidation,
      smcBias: smc.smcBias,
      smartMoneyBias: smartMoney.fusion.direction,
      technicalBias: tech?.technicalBias || 'NEUTRAL',
      conflict,
    };
  }

  _computeConflict(smc, smartMoney, tech = null) {
    const smcSmart = smc.smcBias !== smartMoney.fusion.direction && smc.smcBias !== 'NEUTRAL' && smartMoney.fusion.direction !== 'NEUTRAL';
    const smcTech = tech && tech.technicalBias !== 'NEUTRAL' && smc.smcBias !== 'NEUTRAL' && tech.technicalBias !== smc.smcBias;
    const smTech = tech && tech.technicalBias !== 'NEUTRAL' && smartMoney.fusion.direction !== 'NEUTRAL' && tech.technicalBias !== smartMoney.fusion.direction;
    return smcSmart || smcTech || smTech;
  }

  _determineDirection(smc, smartMoney, tech = null) {
    const biases = [smc.smcBias, smartMoney.fusion.direction];
    if (tech) biases.push(tech.technicalBias);

    const bullVotes = biases.filter((b) => b === 'BULLISH').length;
    const bearVotes = biases.filter((b) => b === 'BEARISH').length;

    // All agree → strong signal
    if (bullVotes === biases.length) return 'BULLISH';
    if (bearVotes === biases.length) return 'BEARISH';

    // Majority (2 of 3)
    if (bullVotes >= 2 && bearVotes === 0) return 'BULLISH';
    if (bearVotes >= 2 && bullVotes === 0) return 'BEARISH';

    // 2 vs 1 conflict — lean toward SMC (price action is truth)
    if (smc.smcBias !== 'NEUTRAL') return smc.smcBias;
    if (smartMoney.fusion.direction !== 'NEUTRAL') return smartMoney.fusion.direction;
    if (tech?.technicalBias && tech.technicalBias !== 'NEUTRAL') return tech.technicalBias;

    return 'NEUTRAL';
  }

  _buildNarrative(smc, smartMoney, tech = null, direction) {
    const parts = [];

    if (direction === 'BEARISH') {
      // Build bearish narrative
      if (smc.liquidity.sweep?.direction === 'ABOVE') {
        parts.push('Price engineered a bullish liquidity grab above the previous high.');
      }
      if (smc.breakout.failed && smc.breakout.direction === 'BULLISH') {
        parts.push('The bullish breakout failed.');
      }
      if (smc.displacement.detected && smc.displacement.direction === 'BEARISH') {
        parts.push('Bearish displacement followed.');
      }
      if (smc.bos.detected && smc.bos.direction === 'BEARISH') {
        parts.push('Structure subsequently broke bearish.');
      }
      if (smc.breakout.retestHeld && smc.breakout.direction === 'BEARISH') {
        parts.push('Bearish retest held.');
      }
      if (smartMoney.fusion.direction === 'BEARISH') {
        if (smartMoney.topTraders.direction === 'BEARISH') {
          parts.push(`Large accounts are net-short (${smartMoney.topTraders.shortPct}% short).`);
        }
        if (smartMoney.derivatives.takerFlow.direction === 'BEARISH') {
          parts.push('Taker flow is negative.');
        }
        if (smartMoney.derivatives.funding.direction === 'BEARISH') {
          parts.push('Derivatives flow supports the move.');
        }
      }
      if (smc.fvg.current?.direction === 'BEARISH' && !smc.fvg.current.fullyFilled) {
        parts.push('Unfilled bearish FVG provides target.');
      }
    } else if (direction === 'BULLISH') {
      if (smc.liquidity.sweep?.direction === 'BELOW') {
        parts.push('Price engineered a bearish liquidity grab below the previous low.');
      }
      if (smc.breakout.failed && smc.breakout.direction === 'BEARISH') {
        parts.push('The bearish breakout failed.');
      }
      if (smc.displacement.detected && smc.displacement.direction === 'BULLISH') {
        parts.push('Bullish displacement followed.');
      }
      if (smc.bos.detected && smc.bos.direction === 'BULLISH') {
        parts.push('Structure subsequently broke bullish.');
      }
      if (smc.breakout.retestHeld && smc.breakout.direction === 'BULLISH') {
        parts.push('Bullish retest held.');
      }
      if (smartMoney.fusion.direction === 'BULLISH') {
        if (smartMoney.topTraders.direction === 'BULLISH') {
          parts.push(`Large accounts are net-long (${smartMoney.topTraders.longPct}% long).`);
        }
        if (smartMoney.derivatives.takerFlow.direction === 'BULLISH') {
          parts.push('Taker flow is positive.');
        }
        if (smartMoney.derivatives.funding.direction === 'BULLISH') {
          parts.push('Funding environment is supportive.');
        }
      }
      if (smc.fvg.current?.direction === 'BULLISH' && !smc.fvg.current.fullyFilled) {
        parts.push('Unfilled bullish FVG provides target.');
      }
    } else {
      parts.push('Market structure and smart money signals are conflicting or insufficient for a directional thesis.');
    }

    // ── Technical evidence in narrative ────────────────────
    if (tech && direction !== 'NEUTRAL') {
      const techDir = direction === 'BEARISH' ? 'BEARISH' : 'BULLISH';
      const matchingSignals = tech.technicalDirection.signals.filter((s) => s.direction === techDir);
      if (matchingSignals.length >= 3) {
        parts.push(`Technical engine confirms: ${matchingSignals.length} of ${tech.technicalDirection.signals.length} signals align ${techDir.toLowerCase()}.`);
      } else if (matchingSignals.length <= 1) {
        parts.push(`Technical engine diverges: only ${matchingSignals.length} signal(s) align with thesis.`);
      }
      if (tech.contradictions.length > 0) {
        parts.push(`However, ${tech.contradictions.length} technical contradiction(s) detected.`);
      }
    }

    return parts.join(' ');
  }

  _buildInvalidation(smc, direction) {
    if (direction === 'BEARISH') {
      const protectedHigh = smc.protectedLevels.protectedHigh;
      if (protectedHigh) {
        return `Price reclaims ${protectedHigh.price} and smart-money positioning begins reversing → bearish thesis invalidated.`;
      }
      return 'Price reclaims recent structural high and smart-money positioning reverses.';
    }
    if (direction === 'BULLISH') {
      const protectedLow = smc.protectedLevels.protectedLow;
      if (protectedLow) {
        return `Price loses ${protectedLow.price} and smart-money positioning begins reversing → bullish thesis invalidated.`;
      }
      return 'Price loses recent structural low and smart-money positioning reverses.';
    }
    return 'N/A — no directional thesis to invalidate.';
  }

  // ═══════════════════════════════════════════════════════════
  //  EVIDENCE GATHERING
  // ═══════════════════════════════════════════════════════════

  _gatherSupporting(smc, smartMoney, tech = null, direction) {
    const evidence = [];

    // SMC supporting evidence
    if (direction === 'BEARISH') {
      if (smc.structure.bias === 'BEARISH') evidence.push({ source: 'SMC', item: 'Bearish market structure (LH → LL)', weight: 2 });
      if (smc.bos.detected && smc.bos.direction === 'BEARISH') evidence.push({ source: 'SMC', item: `BOS SHORT confirmed at ${smc.bos.brokenLevel}`, weight: 2 });
      if (smc.liquidity.sweep?.direction === 'ABOVE') evidence.push({ source: 'SMC', item: `Liquidity sweep above ${smc.liquidity.sweep.location} (${smc.liquidity.sweep.strength}% strength)`, weight: 2 });
      if (smc.displacement.detected && smc.displacement.direction === 'BEARISH') evidence.push({ source: 'SMC', item: `Bearish displacement (${smc.displacement.strength}% strength, ${smc.displacement.rangeRatio.toFixed(1)}x avg range)`, weight: 1 });
      if (smc.fvg.current?.direction === 'BEARISH' && !smc.fvg.current.fullyFilled) evidence.push({ source: 'SMC', item: `Unfilled bearish FVG at ${smc.fvg.current.lowerBoundary}-${smc.fvg.current.upperBoundary}`, weight: 1 });
      if (smc.breakout.failed && smc.breakout.direction === 'BULLISH') evidence.push({ source: 'SMC', item: 'Failed bullish breakout', weight: 2 });
      if (smc.breakout.retestHeld && smc.breakout.direction === 'BEARISH') evidence.push({ source: 'SMC', item: 'Bearish retest held', weight: 1 });
      if (smc.choch.detected && smc.choch.direction === 'BEARISH') evidence.push({ source: 'SMC', item: 'Bearish CHOCH (reversal signal)', weight: 2 });
    } else if (direction === 'BULLISH') {
      if (smc.structure.bias === 'BULLISH') evidence.push({ source: 'SMC', item: 'Bullish market structure (HL → HH)', weight: 2 });
      if (smc.bos.detected && smc.bos.direction === 'BULLISH') evidence.push({ source: 'SMC', item: `BOS LONG confirmed at ${smc.bos.brokenLevel}`, weight: 2 });
      if (smc.liquidity.sweep?.direction === 'BELOW') evidence.push({ source: 'SMC', item: `Liquidity sweep below ${smc.liquidity.sweep.location} (${smc.liquidity.sweep.strength}% strength)`, weight: 2 });
      if (smc.displacement.detected && smc.displacement.direction === 'BULLISH') evidence.push({ source: 'SMC', item: `Bullish displacement (${smc.displacement.strength}% strength, ${smc.displacement.rangeRatio.toFixed(1)}x avg range)`, weight: 1 });
      if (smc.fvg.current?.direction === 'BULLISH' && !smc.fvg.current.fullyFilled) evidence.push({ source: 'SMC', item: `Unfilled bullish FVG at ${smc.fvg.current.lowerBoundary}-${smc.fvg.current.upperBoundary}`, weight: 1 });
      if (smc.breakout.failed && smc.breakout.direction === 'BEARISH') evidence.push({ source: 'SMC', item: 'Failed bearish breakout', weight: 2 });
      if (smc.breakout.retestHeld && smc.breakout.direction === 'BULLISH') evidence.push({ source: 'SMC', item: 'Bullish retest held', weight: 1 });
      if (smc.choch.detected && smc.choch.direction === 'BULLISH') evidence.push({ source: 'SMC', item: 'Bullish CHOCH (reversal signal)', weight: 2 });
    }

    // Smart Money supporting evidence
    if (direction === 'BEARISH' || direction === 'BULLISH') {
      const smDir = direction === 'BEARISH' ? 'BEARISH' : 'BULLISH';
      if (smartMoney.fusion.direction === smDir) {
        if (smartMoney.topTraders.direction === smDir) {
          evidence.push({ source: 'Smart Money', item: `Top traders ${smDir.toLowerCase()} (${smartMoney.topTraders.longPct}%L / ${smartMoney.topTraders.shortPct}%S)`, weight: 2 });
        }
        for (const change of smartMoney.topTraders.changes) {
          if ((direction === 'BEARISH' && change.type === 'INCREASING_SHORT') ||
              (direction === 'BULLISH' && change.type === 'INCREASING_LONG')) {
            evidence.push({ source: 'Smart Money', item: `Top traders ${change.type.replace('_', ' ').toLowerCase()} (+${(change.value * 100).toFixed(1)}%)`, weight: 1 });
          }
        }
        if (smartMoney.derivatives.takerFlow.direction === smDir) {
          evidence.push({ source: 'Smart Money', item: `Taker flow ${smDir.toLowerCase()} (${smartMoney.derivatives.takerFlow.avgBuySellRatio})`, weight: 1 });
        }
        if (smartMoney.derivatives.funding.direction === smDir) {
          evidence.push({ source: 'Smart Money', item: `Funding ${smDir.toLowerCase()} (${smartMoney.derivatives.funding.annualizedPct}% ann.)`, weight: 1 });
        }
        if (smartMoney.fusion.flowAlignment === 'STRONG') {
          evidence.push({ source: 'Smart Money', item: 'Strong flow alignment', weight: 1 });
        }
      }
    }

    // Technical supporting evidence
    if (tech && (direction === 'BEARISH' || direction === 'BULLISH')) {
      const techDir = direction === 'BEARISH' ? 'BEARISH' : 'BULLISH';
      for (const sig of tech.technicalDirection.signals) {
        if (sig.direction === techDir) {
          evidence.push({ source: 'Technical', item: `${sig.name} ${sig.value} ${sig.direction} (${sig.note})`, weight: 1 });
        }
      }
      // Technical conviction boost
      if (tech.technicalDirection.conviction > 70 && tech.technicalDirection.direction === techDir) {
        evidence.push({ source: 'Technical', item: `High technical conviction (${tech.technicalDirection.conviction}%)`, weight: 1 });
      }
      // Volume confirms
      if (tech.volume.expansion === 'EXPANDING' && tech.momentum.direction === techDir) {
        evidence.push({ source: 'Technical', item: `Volume expanding (${tech.volume.ratio}x avg) confirms move`, weight: 1 });
      }
      // Regime confirms
      if ((direction === 'BEARISH' && (tech.regime.classification === 'BEAR' || tech.regime.classification === 'TRENDING_BEAR')) ||
          (direction === 'BULLISH' && (tech.regime.classification === 'BULL' || tech.regime.classification === 'TRENDING_BULL'))) {
        evidence.push({ source: 'Technical', item: `Regime ${tech.regime.classification} confirms thesis`, weight: 1 });
      }
    }

    return evidence;
  }

  _gatherContradicting(smc, smartMoney, tech = null, direction) {
    const evidence = [];

    // SMC contradicting evidence
    if (direction === 'BEARISH') {
      if (smc.structure.bias === 'BULLISH') evidence.push({ source: 'SMC', item: 'Structure is still bullish (HL → HH)', weight: 2 });
      if (smc.choch.detected && smc.choch.direction === 'BULLISH') evidence.push({ source: 'SMC', item: 'Bullish CHOCH detected — potential reversal', weight: 2 });
      if (smc.bos.detected && smc.bos.direction === 'BULLISH') evidence.push({ source: 'SMC', item: 'Bullish BOS also present', weight: 1 });
      if (smc.fvg.current?.direction === 'BULLISH' && !smc.fvg.current.fullyFilled) evidence.push({ source: 'SMC', item: 'Unfilled bullish FVG below (may attract price)', weight: 1 });
      if (smc.displacement.detected && smc.displacement.direction === 'BULLISH') evidence.push({ source: 'SMC', item: 'Latest displacement is bullish', weight: 1 });
    } else if (direction === 'BULLISH') {
      if (smc.structure.bias === 'BEARISH') evidence.push({ source: 'SMC', item: 'Structure is still bearish (LH → LL)', weight: 2 });
      if (smc.choch.detected && smc.choch.direction === 'BEARISH') evidence.push({ source: 'SMC', item: 'Bearish CHOCH detected — potential reversal', weight: 2 });
      if (smc.bos.detected && smc.bos.direction === 'BEARISH') evidence.push({ source: 'SMC', item: 'Bearish BOS also present', weight: 1 });
      if (smc.fvg.current?.direction === 'BEARISH' && !smc.fvg.current.fullyFilled) evidence.push({ source: 'SMC', item: 'Unfilled bearish FVG above (may attract price)', weight: 1 });
      if (smc.displacement.detected && smc.displacement.direction === 'BEARISH') evidence.push({ source: 'SMC', item: 'Latest displacement is bearish', weight: 1 });
    }

    // Smart Money contradicting evidence
    const oppositeDir = direction === 'BEARISH' ? 'BULLISH' : 'BULLISH';
    if (smartMoney.fusion.direction === oppositeDir && direction !== 'NEUTRAL') {
      if (smartMoney.topTraders.direction === oppositeDir) {
        evidence.push({ source: 'Smart Money', item: `Top traders ${oppositeDir.toLowerCase()} — diverging from thesis`, weight: 2 });
      }
      if (smartMoney.derivatives.takerFlow.direction === oppositeDir) {
        evidence.push({ source: 'Smart Money', item: `Taker flow ${oppositeDir.toLowerCase()} — contradicting`, weight: 1 });
      }
      if (smartMoney.derivatives.funding.direction === oppositeDir) {
        evidence.push({ source: 'Smart Money', item: `Funding ${oppositeDir.toLowerCase()} — contradicting`, weight: 1 });
      }
    }

    // Divergence between top traders and retail
    if (Math.abs(smartMoney.topTraders.divergence) > 0.15) {
      const divDir = smartMoney.topTraders.divergence > 0 ? 'BULLISH' : 'BEARISH';
      if (divDir !== direction) {
        evidence.push({ source: 'Smart Money', item: `Top traders diverge from retail (${divDir.toLowerCase()} edge)`, weight: 1 });
      }
    }

    // OI unwinding = uncertainty
    if (smartMoney.derivatives.openInterest.trend === 'DECLINING') {
      evidence.push({ source: 'Smart Money', item: 'Open interest declining — positions unwinding', weight: 1 });
    }

    // Technical contradicting evidence
    if (tech && direction !== 'NEUTRAL') {
      const oppositeTechDir = direction === 'BEARISH' ? 'BULLISH' : 'BEARISH';
      // Signals that oppose the thesis
      for (const sig of tech.technicalDirection.signals) {
        if (sig.direction === oppositeTechDir) {
          evidence.push({ source: 'Technical', item: `${sig.name} ${sig.value} ${sig.direction} — contradicting (${sig.note})`, weight: 1 });
        }
      }
      // Technical contradictions (exhaustion, divergence, etc.)
      for (const contra of tech.contradictions) {
        if (contra.direction === oppositeTechDir || contra.direction === 'NEUTRAL') {
          evidence.push({ source: 'Technical', item: contra.note, weight: contra.weight });
        }
      }
      // Technical bias opposes thesis
      if (tech.technicalBias === oppositeTechDir) {
        evidence.push({ source: 'Technical', item: `Technical conclusion is ${oppositeTechDir.toLowerCase()} — diverges from thesis`, weight: 2 });
      }
    }

    return evidence;
  }

  // ═══════════════════════════════════════════════════════════
  //  COUNTER-THESIS
  // ═══════════════════════════════════════════════════════════

  _formCounterThesis(smc, smartMoney, tech = null, primaryThesis) {
    if (primaryThesis.direction === 'NEUTRAL') {
      return {
        direction: 'NEUTRAL',
        narrative: 'No counter-thesis — primary thesis is neutral.',
        evidence: [],
      };
    }

    const oppositeDir = primaryThesis.direction === 'BEARISH' ? 'BULLISH' : 'BEARISH';
    const parts = [];

    // Build the counter-narrative from contradicting signals
    if (primaryThesis.direction === 'BEARISH') {
      // Bullish counter-thesis
      if (smc.protectedLevels.protectedLow && smc.currentPrice > smc.protectedLevels.protectedLow.price) {
        parts.push(`Price is still above protected low at ${smc.protectedLevels.protectedLow.price}.`);
      }
      if (smartMoney.topTraders.direction === 'BULLISH') {
        parts.push(`Top traders are net-long (${smartMoney.topTraders.longPct}%).`);
      }
      if (smartMoney.derivatives.funding.direction === 'BULLISH') {
        parts.push('Funding suggests shorts are crowded (bullish contrarian).');
      }
      if (smartMoney.derivatives.openInterest.trend === 'DECLINING') {
        parts.push('OI is declining — the bearish move may be exhaustion, not continuation.');
      }
      if (smc.structure.bias === 'BULLISH') {
        parts.push('Higher-timeframe structure remains bullish.');
      }
      // Technical counter-thesis (bullish)
      if (tech) {
        if (tech.rsi.momentumContext === 'OVERSOLD') {
          parts.push(`RSI is oversold at ${tech.rsi.value} — downside may be exhausted.`);
        }
        if (tech.momentum.accelerationDirection === 'DECELERATING' && tech.momentum.direction === 'BEARISH') {
          parts.push('Bearish momentum is decelerating — move losing steam.');
        }
        if (tech.regime.classification === 'BULL' || tech.regime.classification === 'TRENDING_BULL') {
          parts.push(`Regime is ${tech.regime.classification.toLowerCase()} — higher-timeframe context is bullish.`);
        }
        if (tech.trend.direction === 'BULLISH') {
          parts.push(`5m trend is bullish (${tech.trend.alignment.toLowerCase().replace('_', ' ')}).`);
        }
        for (const contra of tech.contradictions) {
          if (contra.direction === 'BULLISH') {
            parts.push(contra.note);
          }
        }
      }
    } else {
      // Bearish counter-thesis
      if (smc.protectedLevels.protectedHigh && smc.currentPrice < smc.protectedLevels.protectedHigh.price) {
        parts.push(`Price is still below protected high at ${smc.protectedLevels.protectedHigh.price}.`);
      }
      if (smartMoney.topTraders.direction === 'BEARISH') {
        parts.push(`Top traders are net-short (${smartMoney.topTraders.shortPct}%).`);
      }
      if (smartMoney.derivatives.funding.direction === 'BEARISH') {
        parts.push('Funding suggests longs are crowded (bearish contrarian).');
      }
      if (smartMoney.derivatives.openInterest.trend === 'DECLINING') {
        parts.push('OI is declining — the bullish move may be exhaustion, not continuation.');
      }
      if (smc.structure.bias === 'BEARISH') {
        parts.push('Higher-timeframe structure remains bearish.');
      }
      // Technical counter-thesis (bearish)
      if (tech) {
        if (tech.rsi.momentumContext === 'OVERBOUGHT') {
          parts.push(`RSI is overbought at ${tech.rsi.value} — upside may be exhausted.`);
        }
        if (tech.momentum.accelerationDirection === 'DECELERATING' && tech.momentum.direction === 'BULLISH') {
          parts.push('Bullish momentum is decelerating — move losing steam.');
        }
        if (tech.regime.classification === 'BEAR' || tech.regime.classification === 'TRENDING_BEAR') {
          parts.push(`Regime is ${tech.regime.classification.toLowerCase()} — higher-timeframe context is bearish.`);
        }
        if (tech.trend.direction === 'BEARISH') {
          parts.push(`5m trend is bearish (${tech.trend.alignment.toLowerCase().replace('_', ' ')}).`);
        }
        for (const contra of tech.contradictions) {
          if (contra.direction === 'BEARISH') {
            parts.push(contra.note);
          }
        }
      }
    }

    if (parts.length === 0) {
      parts.push(`No strong evidence for ${oppositeDir.toLowerCase()} counter-thesis at this time.`);
    }

    return {
      direction: oppositeDir,
      narrative: parts.join(' '),
      evidence: parts,
    };
  }

  // ═══════════════════════════════════════════════════════════
  //  COMPARISON
  // ═══════════════════════════════════════════════════════════

  _compareSides(supporting, contradicting, primaryThesis, counterThesis) {
    const supportingWeight = supporting.reduce((sum, e) => sum + e.weight, 0);
    const contradictingWeight = contradicting.reduce((sum, e) => sum + e.weight, 0);
    const total = supportingWeight + contradictingWeight;

    const supportingRatio = total > 0 ? supportingWeight / total : 0.5;
    const contradictingRatio = total > 0 ? contradictingWeight / total : 0.5;

    // Conflict score: 0 = perfect alignment, 100 = maximum conflict
    const conflictScore = total > 0 ? Math.round(contradictingRatio * 100) : 50;

    // Confluence: how much the evidence agrees
    const confluence = total > 0 ? Math.round(supportingRatio * 100) : 50;

    let verdict;
    if (supportingWeight > contradictingWeight * 2) {
      verdict = 'STRONG_ADVANTAGE';
    } else if (supportingWeight > contradictingWeight) {
      verdict = 'MODERATE_ADVANTAGE';
    } else if (contradictingWeight > supportingWeight) {
      verdict = 'COUNTER_ADVANTAGE';
    } else {
      verdict = 'BALANCED';
    }

    return {
      supportingWeight,
      contradictingWeight,
      supportingRatio: parseFloat(supportingRatio.toFixed(2)),
      contradictingRatio: parseFloat(contradictingRatio.toFixed(2)),
      conflictScore,
      confluence,
      verdict,
    };
  }

  // ═══════════════════════════════════════════════════════════
  //  CONCLUSION
  // ═══════════════════════════════════════════════════════════

  _conclude(comparison, memoryResult, risk, primaryThesis, counterThesis) {
    const { minBrainScore, minConfidence, maxConflict } = this._getThresholds();

    let decision = 'WAIT';
    let reason = '';

    // REJECT if thesis is neutral
    if (primaryThesis.direction === 'NEUTRAL') {
      decision = 'REJECT';
      reason = 'No directional thesis — insufficient evidence for a trade.';
    }
    // REJECT if conflict is too high
    else if (comparison.conflictScore > maxConflict) {
      decision = 'REJECT';
      reason = `Conflict too high (${comparison.conflictScore}%) — evidence disagrees. Wait for clarity.`;
    }
    // REJECT if risk is too high
    else if (risk.approved === false && risk.reason !== 'INSUFFICIENT_BALANCE') {
      decision = 'REJECT';
      reason = `Risk rejected: ${risk.reason}`;
    }
    // WAIT if evidence is balanced
    else if (comparison.verdict === 'BALANCED' || comparison.verdict === 'COUNTER_ADVANTAGE') {
      decision = 'WAIT';
      reason = `Evidence is ${comparison.verdict === 'BALANCED' ? 'balanced' : 'counter-thesis has advantage'} — waiting for stronger confirmation.`;
    }
    // WAIT if memory warns against this pattern
    else if (memoryResult.recommendation === 'AVOID') {
      decision = 'WAIT';
      reason = `Memory: similar setups have underperformed (${memoryResult.winRate}% win rate, ${memoryResult.sampleSize} trades).`;
    }
    // WAIT if brain score is below threshold
    else if (comparison.confluence < minBrainScore) {
      decision = 'WAIT';
      reason = `Brain score ${comparison.confluence} below threshold ${minBrainScore}.`;
    }
    // ENTER if all checks pass
    else if (comparison.verdict === 'STRONG_ADVANTAGE' || comparison.verdict === 'MODERATE_ADVANTAGE') {
      decision = 'ENTER';
      reason = `${comparison.verdict.replace('_', ' ')} for ${primaryThesis.direction} thesis. Score: ${comparison.confluence}, Conflict: ${comparison.conflictScore}.`;
    }

    return {
      decision,
      reason,
      direction: decision === 'ENTER' ? primaryThesis.direction : null,
      confidence: this._calculateConfidence(comparison, memoryResult, risk, decision),
    };
  }

  _calculateConfidence(comparison, memoryResult, risk, decision) {
    let confidence = comparison.confluence;

    // Adjust for memory
    if (memoryResult.recommendation === 'SUPPORT') {
      confidence += 5;
    } else if (memoryResult.recommendation === 'AVOID') {
      confidence -= 15;
    }

    // Adjust for risk
    if (risk.approved === false) {
      confidence -= 20;
    }

    // Adjust for conflict
    confidence -= comparison.conflictScore * 0.3;

    return Math.max(0, Math.min(100, Math.round(confidence)));
  }

  _calculateScores(supporting, contradicting, comparison, conclusion) {
    const brainScore = comparison.confluence;
    const confidence = conclusion.confidence;
    const conflict = comparison.conflictScore;

    return { brainScore, confidence, conflict };
  }

  _getThresholds() {
    // Could be loaded from config
    return {
      minBrainScore: 60,
      minConfidence: 65,
      maxConflict: 40,
    };
  }
}
