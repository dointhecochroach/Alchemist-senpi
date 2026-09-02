      const upperBoundary = prev.low;
      const lowerBoundary = next.high;
      const size = upperBoundary - lowerBoundary;
      const sizePct = (size / prev.close) * 100;

      const subsequentCandles = candles.slice(i + 2);
      const touched = subsequentCandles.some((c) => c.high >= lowerBoundary);
      const fullyFilled = subsequentCandles.some((c) => c.high >= upperBoundary);
      const partiallyFilled = touched && !fullyFilled;

      const age = candles.length - i - 1;

      fvgs.push({
        direction: 'BEARISH',
        upperBoundary,
        lowerBoundary,
        size,
        sizePct,
        age,
        touched,
        partiallyFilled,
        fullyFilled,
        status: fullyFilled ? 'FILLED' : partiallyFilled ? 'PARTIALLY_FILLED' : 'UNFILLED',
        index: i,
      });
    }
  }

  // Return the most relevant unfilled or partially filled FVGs
  const activeFVGs = fvgs.filter((f) => !f.fullyFilled);
  const latestActive = activeFVGs.slice(-3); // Last 3 active FVGs

  return {
    all: fvgs,
    active: activeFVGs,
    latest: latestActive,
    // The most recent unfilled FVG
    current: activeFVGs.length > 0 ? activeFVGs[activeFVGs.length - 1] : null,
  };
}

// ──────────────────────────────────────────────────────────────
//  DISPLACEMENT
// ──────────────────────────────────────────────────────────────

/**
 * Measure displacement — strong directional moves that create imbalances.
 * Displacement = current candle range significantly exceeds average range.
 */
export function detectDisplacement(candles, lookback = 20) {
  if (candles.length < lookback + 1) {
    return { detected: false, direction: null, strength: 0 };
  }

  const recentCandles = candles.slice(-lookback);
  const avgRange = recentCandles.reduce((sum, c) => sum + c.range, 0) / lookback;

  const lastCandle = candles[candles.length - 1];
  const rangeRatio = lastCandle.range / (avgRange || 1);

  // Displacement if current range > 1.5x average
  const isDisplacement = rangeRatio > 1.5;

  return {
    detected: isDisplacement,
    direction: lastCandle.isBullish ? 'BULLISH' : 'BEARISH',
    currentRange: lastCandle.range,
    averageRange: avgRange,
    rangeRatio,
    strength: Math.min(100, Math.round(rangeRatio * 33)), // 3x avg = ~100
  };
}

// ──────────────────────────────────────────────────────────────
//  BREAKOUT DETECTION
// ──────────────────────────────────────────────────────────────

/**
 * Detect breakouts and whether they succeed or fail.
 * Also checks for retests and stale breakouts.
 */
export function detectBreakout(candles, swingHighs, swingLows) {
  if (candles.length < 10 || swingHighs.length < 1 || swingLows.length < 1) {
    return { detected: false, direction: null, status: 'NONE' };
  }

  const lastCandle = candles[candles.length - 1];
  const prevCandles = candles.slice(-10, -1);

  // Get recent significant levels
  const recentHigh = Math.max(...swingHighs.slice(-3).map((s) => s.price));
  const recentLow = Math.min(...swingLows.slice(-3).map((s) => s.price));

  // Check for breakout above recent high
  let breakout = {
    detected: false,
    direction: null,
    breakoutLevel: null,
    strength: 0,
    retest: false,
    retestHeld: false,
    retestFailed: false,
    failed: false,
    stale: false,
    status: 'NONE',
  };

  // Bullish breakout
  const brokeAbove = prevCandles.some((c) => c.close > recentHigh);
  if (brokeAbove) {
    const breakCandle = prevCandles.find((c) => c.close > recentHigh);
    const candlesSinceBreak = candles.indexOf(breakCandle);
    const postBreakCandles = candles.slice(candlesSinceBreak + 1);

    // Check if price has returned to the breakout level (retest)
    const retested = postBreakCandles.some((c) => c.low <= recentHigh * 1.001);
    const retestHeld = retested && lastCandle.close > recentHigh;
    const retestFailed = retested && lastCandle.close < recentHigh * 0.999;

    // Failed breakout = price broke above but then closed back below
    const failed = lastCandle.close < recentHigh;

    // Stale breakout = breakout happened long ago with no follow-through
    const stale = postBreakCandles.length > 20 && !failed;

    breakout = {
      detected: true,
      direction: 'BULLISH',
      breakoutLevel: recentHigh,
      strength: Math.min(100, Math.round((breakCandle.body / breakCandle.range) * 100)),
      retest: retested,
      retestHeld,
      retestFailed,
      failed,
      stale,
      status: failed ? 'FAILED' : retestHeld ? 'RETEST_HELD' : retestFailed ? 'RETEST_FAILED' : stale ? 'STALE' : 'BREAKOUT',
    };
  }

  // Bearish breakout
  const brokeBelow = prevCandles.some((c) => c.close < recentLow);
  if (brokeBelow) {
    const breakCandle = prevCandles.find((c) => c.close < recentLow);
    const candlesSinceBreak = candles.indexOf(breakCandle);
    const postBreakCandles = candles.slice(candlesSinceBreak + 1);

    const retested = postBreakCandles.some((c) => c.high >= recentLow * 0.999);
    const retestHeld = retested && lastCandle.close < recentLow;
    const retestFailed = retested && lastCandle.close > recentLow * 1.001;
    const failed = lastCandle.close > recentLow;
    const stale = postBreakCandles.length > 20 && !failed;

    breakout = {
      detected: true,
      direction: 'BEARISH',
      breakoutLevel: recentLow,
      strength: Math.min(100, Math.round((breakCandle.body / breakCandle.range) * 100)),
      retest: retested,
      retestHeld,
      retestFailed,
      failed,
      stale,
      status: failed ? 'FAILED' : retestHeld ? 'RETEST_HELD' : retestFailed ? 'RETEST_FAILED' : stale ? 'STALE' : 'BREAKOUT',
    };
  }

  return breakout;
}

// ──────────────────────────────────────────────────────────────
//  PROTECTED HIGH / PROTECTED LOW
// ──────────────────────────────────────────────────────────────

/**
 * Protected High = the most recent swing high that hasn't been breached.
 * Protected Low = the most recent swing low that hasn't been breached.
 * These are the "line in the sand" levels for structure.
 */
export function getProtectedLevels(candles, swingHighs, swingLows) {
  const currentPrice = candles[candles.length - 1].close;

  let protectedHigh = null;
  let protectedLow = null;

  // Find the most recent swing high that price is still below
  for (let i = swingHighs.length - 1; i >= 0; i--) {
    if (swingHighs[i].price > currentPrice) {
      protectedHigh = swingHighs[i];
      break;
    }
  }

  // Find the most recent swing low that price is still above
  for (let i = swingLows.length - 1; i >= 0; i--) {
    if (swingLows[i].price < currentPrice) {
      protectedLow = swingLows[i];
      break;
    }
  }

  return { protectedHigh, protectedLow };
}

// ──────────────────────────────────────────────────────────────
//  FULL SMC ANALYSIS
// ──────────────────────────────────────────────────────────────

/**
 * Run the complete SMC analysis pipeline on a set of candles.
 * Returns everything the Brain needs for thesis formation.
 */
export function analyzeSMC(candles, options = {}) {
  const lookback = options.swingLookback || 2;

  // 1. Swing detection
  const { swingHighs, swingLows } = detectSwings(candles, lookback);

  // 2. Classify swings
  const classified = classifySwings(swingHighs, swingLows);

  // 3. Structure bias
  const structure = getStructureBias(classified.swingHighs, classified.swingLows);

  // 4. BOS / CHOCH
  const boschoch = detectBOSandCHOCH(candles, classified.swingHighs, classified.swingLows, structure);

  // 5. Liquidity
  const liquidity = detectLiquidity(candles, classified.swingHighs, classified.swingLows);

  // 6. FVG
  const fvg = detectFVG(candles);

  // 7. Displacement
  const displacement = detectDisplacement(candles);

  // 8. Breakout
  const breakout = detectBreakout(candles, classified.swingHighs, classified.swingLows);

  // 9. Protected levels
  const protectedLevels = getProtectedLevels(candles, classified.swingHighs, classified.swingLows);

  // 10. Current price
  const currentPrice = candles[candles.length - 1].close;

  // 11. SMC evidence score (0-100)
  let smcScore = 0;
  let bullishCount = 0;
  let bearishCount = 0;
  const evidenceList = [];

  if (structure.bias === 'BULLISH') { bullishCount++; evidenceList.push('Bullish structure'); }
  if (structure.bias === 'BEARISH') { bearishCount++; evidenceList.push('Bearish structure'); }

  if (boschoch.bos.detected) {
    if (boschoch.bos.direction === 'BULLISH') { bullishCount += 2; evidenceList.push('Bullish BOS'); }
    if (boschoch.bos.direction === 'BEARISH') { bearishCount += 2; evidenceList.push('Bearish BOS'); }
  }

  if (boschoch.choch.detected) {
    if (boschoch.choch.direction === 'BULLISH') { bullishCount++; evidenceList.push('Bullish CHOCH'); }
    if (boschoch.choch.direction === 'BEARISH') { bearishCount++; evidenceList.push('Bearish CHOCH'); }
  }

  if (liquidity.sweep) {
    if (liquidity.sweep.direction === 'ABOVE') { bearishCount++; evidenceList.push('Liquidity sweep above (bearish)'); }
    if (liquidity.sweep.direction === 'BELOW') { bullishCount++; evidenceList.push('Liquidity sweep below (bullish)'); }
  }

  if (fvg.current && !fvg.current.fullyFilled) {
    if (fvg.current.direction === 'BULLISH') { bullishCount++; evidenceList.push('Unfilled bullish FVG'); }
    if (fvg.current.direction === 'BEARISH') { bearishCount++; evidenceList.push('Unfilled bearish FVG'); }
  }

  if (displacement.detected) {
    if (displacement.direction === 'BULLISH') { bullishCount++; evidenceList.push('Bullish displacement'); }
    if (displacement.direction === 'BEARISH') { bearishCount++; evidenceList.push('Bearish displacement'); }
  }

  if (breakout.detected) {
    if (breakout.failed) {
      if (breakout.direction === 'BULLISH') { bearishCount += 2; evidenceList.push('Failed bullish breakout (bearish)'); }
      if (breakout.direction === 'BEARISH') { bullishCount += 2; evidenceList.push('Failed bearish breakout (bullish)'); }
    } else if (breakout.retestHeld) {
      if (breakout.direction === 'BULLISH') { bullishCount++; evidenceList.push('Bullish breakout retest held'); }
      if (breakout.direction === 'BEARISH') { bearishCount++; evidenceList.push('Bearish breakout retest held'); }
    }
  }

  const total = bullishCount + bearishCount;
  if (total > 0) {
    smcScore = Math.round((Math.max(bullishCount, bearishCount) / total) * 100);
  }

  const smcBias = bullishCount > bearishCount ? 'BULLISH' : bearishCount > bullishCount ? 'BEARISH' : 'NEUTRAL';

  return {
    currentPrice,
    swingHighs: classified.swingHighs,
    swingLows: classified.swingLows,
    structure,
    bos: boschoch.bos,
    choch: boschoch.choch,
    liquidity,
    fvg,
    displacement,
    breakout,
    protectedLevels,
    smcScore,
    smcBias,
    evidence: evidenceList,
  };
}

__FILE_EOF__

echo 'src/smart_money/smartMoneyAnalyzer.js'
mkdir -p \.
cat > 'src/smart_money/smartMoneyAnalyzer.js' << '__FILE_EOF__'
/**
 * Alchemist Brain — Smart Money Module
 *
 * Analyzes what large/informed market participants are doing.
 * Uses Binance public derivatives data as a proxy for smart money positioning.
 *
 * Data sources (all public, no API keys):
 *   - Top Trader Long/Short Position Ratio (whale proxy)
 *   - Global Long/Short Account Ratio (retail sentiment)
 *   - Open Interest + changes (positioning flow)
 *   - Funding Rate (cost of holding positions)
 *   - Taker Buy/Sell Volume (aggressive order flow)
 *
 * Note: Binance doesn't expose per-wallet whale data publicly.
 * We use top trader position ratios as the closest proxy, combined
 * with OI/funding/taker flow to build a complete smart money picture.
 */

// ──────────────────────────────────────────────────────────────
//  WHALE / TOP TRADER ANALYSIS
// ──────────────────────────────────────────────────────────────

/**
 * Analyze top trader positioning from L/S ratio data.
 * Top traders on Binance = accounts with large positions.
 */
export function analyzeTopTraders(topTraderLS, globalLS) {
  if (!topTraderLS || topTraderLS.length === 0) {
    return { bias: 0, direction: 'NEUTRAL', longPct: 50, shortPct: 50, changes: [] };
  }

  const latest = topTraderLS[topTraderLS.length - 1];
  const longPct = (latest.longAccount * 100).toFixed(1);
  const shortPct = (latest.shortAccount * 100).toFixed(1);

  // Bias: -1 (max short) to +1 (max long)
  // longShortRatio > 1 = more longs, < 1 = more shorts
  const ratio = latest.longShortRatio;
  const bias = clamp((ratio - 1) / (ratio + 1) * 2, -1, 1);

  // Detect positioning changes over the last few periods
  const changes = [];
  const lookback = Math.min(5, topTraderLS.length - 1);
  if (lookback > 0) {
    const older = topTraderLS[topTraderLS.length - 1 - lookback];
    const longChange = latest.longAccount - older.longAccount;
    const shortChange = latest.shortAccount - older.shortAccount;

    if (longChange > 0.01) changes.push({ type: 'INCREASING_LONG', value: longChange });
    if (shortChange > 0.01) changes.push({ type: 'INCREASING_SHORT', value: shortChange });
    if (longChange < -0.01) changes.push({ type: 'DECREASING_LONG', value: longChange });
    if (shortChange < -0.01) changes.push({ type: 'DECREASING_SHORT', value: shortChange });
  }

  // Compare top traders vs global (retail) — divergence = smart money edge
  let divergence = 0;
  if (globalLS && globalLS.length > 0) {
    const globalLatest = globalLS[globalLS.length - 1];
    const globalBias = clamp((globalLatest.longShortRatio - 1) / (globalLatest.longShortRatio + 1) * 2, -1, 1);
    divergence = bias - globalBias; // Positive = top traders more long than retail
  }

  return {
    bias,
    direction: bias > 0.1 ? 'BULLISH' : bias < -0.1 ? 'BEARISH' : 'NEUTRAL',
    longPct: parseFloat(longPct),
    shortPct: parseFloat(shortPct),
    ratio: latest.longShortRatio,
    changes,
    divergence,
  };
}

// ──────────────────────────────────────────────────────────────
//  GLOBAL MARKET POSITION (RETAIL SENTIMENT)
// ──────────────────────────────────────────────────────────────

export function analyzeGlobalPosition(globalLS) {
  if (!globalLS || globalLS.length === 0) {
    return { bias: 0, direction: 'NEUTRAL', longPct: 50, shortPct: 50 };
  }

  const latest = globalLS[globalLS.length - 1];
  const ratio = latest.longShortRatio;
  const bias = clamp((ratio - 1) / (ratio + 1) * 2, -1, 1);

  return {
    bias,
    direction: bias > 0.1 ? 'LONG_HEAVY' : bias < -0.1 ? 'SHORT_HEAVY' : 'BALANCED',
    longPct: parseFloat((latest.longAccount * 100).toFixed(1)),
    shortPct: parseFloat((latest.shortAccount * 100).toFixed(1)),
    ratio,
  };
}

// ──────────────────────────────────────────────────────────────
//  DERIVATIVES ANALYSIS (OI + Funding + Taker Flow)
// ──────────────────────────────────────────────────────────────

export function analyzeDerivatives(oi, oiHistory, funding, fundingHistory, takerVolume) {
  const result = {
    funding: { rate: 0, direction: 'NEUTRAL', trend: 'STABLE' },
    openInterest: { current: 0, changePct: 0, trend: 'FLAT' },
    takerFlow: { bias: 0, direction: 'NEUTRAL', strength: 0 },
    contribution: 0, // -1 to +1 overall derivatives bias
  };

  // ── Funding Rate ──────────────────────────────────────────
  if (funding) {
    const rate = funding.fundingRate;
    const annualized = rate * 3 * 365; // 8h funding, 3x/day, 365 days
    result.funding = {
      rate,
      annualizedPct: parseFloat((annualized * 100).toFixed(2)),
      // Positive funding = longs pay shorts → bearish signal (longs crowded)
      // Negative funding = shorts pay longs → bullish signal (shorts crowded)
      direction: rate > 0.0001 ? 'BEARISH' : rate < -0.0001 ? 'BULLISH' : 'NEUTRAL',
      trend: 'STABLE',
    };

    // Funding trend from history
    if (fundingHistory && fundingHistory.length > 5) {
      const recent = fundingHistory.slice(-5);
      const older = fundingHistory.slice(-10, -5);
      const recentAvg = recent.reduce((s, r) => s + r.fundingRate, 0) / recent.length;
      const olderAvg = older.length > 0 ? older.reduce((s, r) => s + r.fundingRate, 0) / older.length : recentAvg;

      if (Math.abs(recentAvg) > Math.abs(olderAvg)) {
        result.funding.trend = 'INTENSIFYING';
      } else if (Math.abs(recentAvg) < Math.abs(olderAvg)) {
        result.funding.trend = 'DECAYING';
      }
    }
  }

  // ── Open Interest ─────────────────────────────────────────
  if (oi && oiHistory && oiHistory.length > 1) {
    const currentOI = oiHistory[oiHistory.length - 1].sumOpenInterestValue;
    const pastOI = oiHistory[0].sumOpenInterestValue;
    const changePct = ((currentOI - pastOI) / pastOI) * 100;

    result.openInterest = {
      current: currentOI,
      previous: pastOI,
      changePct: parseFloat(changePct.toFixed(2)),
      // Rising OI + bearish funding = bearish (new shorts entering)
      // Rising OI + bullish funding = bullish (new longs entering)
      // Falling OI = positions closing (unwinding)
      trend: changePct > 3 ? 'BUILDING' : changePct < -3 ? 'DECLINING' : 'FLAT',
    };
  } else if (oi) {
    result.openInterest.current = oi.openInterest;
  }

  // ── Taker Flow ────────────────────────────────────────────
  if (takerVolume && takerVolume.length > 0) {
    const recent = takerVolume.slice(-5);
    const avgRatio = recent.reduce((s, r) => s + r.buySellRatio, 0) / recent.length;
    const bias = clamp((avgRatio - 1) / (avgRatio + 1) * 2, -1, 1);

    result.takerFlow = {
      bias,
      direction: bias > 0.05 ? 'BULLISH' : bias < -0.05 ? 'BEARISH' : 'NEUTRAL',
      strength: Math.min(100, Math.round(Math.abs(bias) * 100)),
      avgBuySellRatio: parseFloat(avgRatio.toFixed(3)),
    };
  }

  // ── Derivatives Contribution Score ────────────────────────
  let score = 0;
  if (result.funding.direction === 'BULLISH') score += 0.3;
  if (result.funding.direction === 'BEARISH') score -= 0.3;
  if (result.openInterest.trend === 'BUILDING' && result.funding.direction === 'BEARISH') score -= 0.2;
  if (result.openInterest.trend === 'BUILDING' && result.funding.direction === 'BULLISH') score += 0.2;
  if (result.openInterest.trend === 'DECLINING') score -= 0.1; // Unwinding = uncertainty
  if (result.takerFlow.direction === 'BULLISH') score += 0.3;
  if (result.takerFlow.direction === 'BEARISH') score -= 0.3;

  result.contribution = clamp(score, -1, 1);

  return result;
}

// ──────────────────────────────────────────────────────────────
//  SMART MONEY FUSION
// ──────────────────────────────────────────────────────────────

/**
 * Combine all smart money signals into a unified view.
 * This is what the Brain receives for thesis formation.
 */
export function fuseSmartMoney(topTraderAnalysis, globalAnalysis, derivatives) {
  // Weight the signals
  const weights = {
    topTraders: 0.35,   // Top traders = best proxy for smart money
    takerFlow: 0.25,    // Aggressive flow = institutional activity
    funding: 0.20,      // Funding = cost of conviction
    openInterest: 0.10, // OI = capital flow
    global: 0.10,       // Global = contrarian signal (fade retail)
  };

  // Top trader bias (positive = long)
  const topTraderSignal = topTraderAnalysis.bias;

  // Taker flow bias
  const takerSignal = derivatives.takerFlow.bias;

  // Funding signal (negative funding = bullish = longs not crowded)
  // Invert because positive funding is bearish
  const fundingSignal = -derivatives.funding.rate * 100; // Scale up
  const fundingClamped = clamp(fundingSignal, -1, 1);

  // OI signal — rising OI in direction of top traders = confirmation
  const oiSignal = derivatives.openInterest.changePct > 0 && topTraderSignal > 0 ? 0.5
    : derivatives.openInterest.changePct > 0 && topTraderSignal < 0 ? -0.5
    : derivatives.openInterest.changePct < 0 ? -0.2
    : 0;

  // Global signal — contrarian (fade the crowd)
  const globalSignal = -globalAnalysis.bias * 0.5;

  // Weighted fusion
  const smartMoneyBias = clamp(
    topTraderSignal * weights.topTraders +
    takerSignal * weights.takerFlow +
    fundingClamped * weights.funding +
    oiSignal * weights.openInterest +
    globalSignal * weights.global,
    -1, 1
  );

  // Flow alignment — do the signals agree?
  const signals = [topTraderSignal, takerSignal, fundingClamped, oiSignal];
  const positiveCount = signals.filter((s) => s > 0.05).length;
  const negativeCount = signals.filter((s) => s < -0.05).length;
  const totalCount = signals.length;
  const alignment = Math.max(positiveCount, negativeCount) / totalCount;

  const flowAlignment = alignment > 0.75 ? 'STRONG'
    : alignment > 0.5 ? 'MODERATE'
    : alignment > 0.25 ? 'WEAK'
    : 'NONE';

  return {
    smartMoneyBias,
    direction: smartMoneyBias > 0.1 ? 'BULLISH' : smartMoneyBias < -0.1 ? 'BEARISH' : 'NEUTRAL',
    strength: Math.min(100, Math.round(Math.abs(smartMoneyBias) * 100)),
    components: {
      topTraders: { bias: topTraderSignal, weight: weights.topTraders, ...topTraderAnalysis },
      takerFlow: { bias: takerSignal, weight: weights.takerFlow, ...derivatives.takerFlow },
      funding: { bias: fundingClamped, weight: weights.funding, ...derivatives.funding },
      openInterest: { bias: oiSignal, weight: weights.openInterest, ...derivatives.openInterest },
      global: { bias: globalSignal, weight: weights.global, ...globalAnalysis },
    },
    flowAlignment,
    alignmentScore: parseFloat(alignment.toFixed(2)),
  };
}

// ──────────────────────────────────────────────────────────────
//  FULL SMART MONEY ANALYSIS
// ──────────────────────────────────────────────────────────────

/**
 * Run complete smart money analysis from a market data snapshot.
 */
export function analyzeSmartMoney(snapshot) {
  const topTraderAnalysis = analyzeTopTraders(snapshot.topTraderLS, snapshot.globalLS);
  const globalAnalysis = analyzeGlobalPosition(snapshot.globalLS);
  const derivatives = analyzeDerivatives(
    snapshot.openInterest,
    snapshot.oiHistory,
    snapshot.funding,
    snapshot.fundingHistory,
    snapshot.takerVolume
  );
  const fusion = fuseSmartMoney(topTraderAnalysis, globalAnalysis, derivatives);

  // Evidence list for the Brain
  const evidence = [];

  if (topTraderAnalysis.direction === 'BULLISH') {
    evidence.push(`Top traders bullish (${topTraderAnalysis.longPct}% long)`);
  } else if (topTraderAnalysis.direction === 'BEARISH') {
    evidence.push(`Top traders bearish (${topTraderAnalysis.shortPct}% short)`);
  }

  for (const change of topTraderAnalysis.changes) {
    if (change.type === 'INCREASING_LONG') evidence.push(`Top traders increasing long (+${(change.value * 100).toFixed(1)}%)`);
    if (change.type === 'INCREASING_SHORT') evidence.push(`Top traders increasing short (+${(change.value * 100).toFixed(1)}%)`);
  }

  if (derivatives.takerFlow.direction !== 'NEUTRAL') {
    evidence.push(`Taker flow ${derivatives.takerFlow.direction.toLowerCase()} (ratio: ${derivatives.takerFlow.avgBuySellRatio})`);
  }

  if (derivatives.funding.direction !== 'NEUTRAL') {
    evidence.push(`Funding ${derivatives.funding.direction.toLowerCase()} (${derivatives.funding.annualizedPct}% annualized)`);
  }

  if (derivatives.openInterest.trend !== 'FLAT') {
    evidence.push(`OI ${derivatives.openInterest.trend.toLowerCase()} (${derivatives.openInterest.changePct}%)`);
  }

  if (topTraderAnalysis.divergence > 0.1) {
    evidence.push(`Top traders diverge from retail (bullish edge)`);
  } else if (topTraderAnalysis.divergence < -0.1) {
    evidence.push(`Top traders diverge from retail (bearish edge)`);
  }

  return {
    topTraders: topTraderAnalysis,
    global: globalAnalysis,
    derivatives,
    fusion,
    evidence,
    smartMoneyScore: fusion.strength,
    smartMoneyBias: fusion.direction,
  };
}

// ──────────────────────────────────────────────────────────────
//  HELPERS
// ──────────────────────────────────────────────────────────────

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

__FILE_EOF__

echo 'src/technical/technicalAnalyzer.js'
mkdir -p \.
cat > 'src/technical/technicalAnalyzer.js' << '__FILE_EOF__'
/**
 * Alchemist Brain — Technical Engine
 *
 * A separate analytical layer from SMC and Smart Money.
 * Provides RSI, Momentum, Volume, Volatility, Trend, and Regime
 * analysis to the Brain.
 *
 * The Brain doesn't see "RSI = 38 → SHORT".
 * It sees: RSI declining, momentum bearish & accelerating, volume expanding,
 * 5m trend bearish, regime trending bear → technical evidence supports SHORT.
 *
 * Then it compares that with SMC and Smart Money evidence.
 */

// ──────────────────────────────────────────────────────────────
//  RSI (Relative Strength Index)
// ──────────────────────────────────────────────────────────────

export function calcRSI(candles, period = 14) {
  if (candles.length < period + 1) {
    return { value: 50, direction: 'FLAT', change: 0, previous: 50, momentumContext: 'NEUTRAL' };
  }

  let gains = 0;
  let losses = 0;

  // Calculate initial average
  for (let i = 1; i <= period; i++) {
    const change = candles[i].close - candles[i - 1].close;
    if (change > 0) gains += change;
    else losses += Math.abs(change);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  // Smooth the RSI for remaining candles
  const rsiValues = [];
  let rsi = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  rsiValues.push(rsi);

  for (let i = period + 1; i < candles.length; i++) {
    const change = candles[i].close - candles[i - 1].close;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;

    rsi = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    rsiValues.push(rsi);
  }

  const currentRSI = rsiValues[rsiValues.length - 1];
  const previousRSI = rsiValues[rsiValues.length - 2] || currentRSI;
  const rsiChange = currentRSI - previousRSI;

  // RSI direction
  let direction = 'FLAT';
  if (rsiChange > 0.5) direction = 'RISING';
  else if (rsiChange < -0.5) direction = 'FALLING';

  // RSI momentum context
  let momentumContext = 'NEUTRAL';
  if (currentRSI > 70) momentumContext = 'OVERBOUGHT';
  else if (currentRSI > 60) momentumContext = 'BULLISH';
  else if (currentRSI > 40) momentumContext = 'NEUTRAL';
  else if (currentRSI > 30) momentumContext = 'BEARISH';
  else momentumContext = 'OVERSOLD';

  return {
    value: parseFloat(currentRSI.toFixed(2)),
    direction,
    change: parseFloat(rsiChange.toFixed(2)),
    previous: parseFloat(previousRSI.toFixed(2)),
    momentumContext,
  };
}

// ──────────────────────────────────────────────────────────────
//  MOMENTUM
// ──────────────────────────────────────────────────────────────

export function calcMomentum(candles, shortPeriod = 10, longPeriod = 20) {
  if (candles.length < longPeriod + 1) {
    return {
      value: 0,
      shortTerm: 0,
      change: 0,
      acceleration: 0,
      direction: 'NEUTRAL',
      strength: 0,
      agrees: null,
    };
  }

  // Rate of Change (ROC) based momentum
  const currentClose = candles[candles.length - 1].close;
  const shortRef = candles[candles.length - 1 - shortPeriod].close;
  const longRef = candles[candles.length - 1 - longPeriod].close;

  // Short-term momentum (ROC)
  const shortTerm = ((currentClose - shortRef) / shortRef) * 100;

  // Long-term momentum
  const longTerm = ((currentClose - longRef) / longRef) * 100;

  // Momentum change (difference between short and long)
  const change = shortTerm - longTerm;

  // Momentum acceleration (is momentum speeding up or slowing down?)
  const prevShort = candles[candles.length - 2].close;
  const prevShortRef = candles[candles.length - 1 - shortPeriod].close;
  const prevShortTerm = ((prevShort - prevShortRef) / prevShortRef) * 100;
  const acceleration = shortTerm - prevShortTerm;

  // Direction
  let direction = 'NEUTRAL';
  if (shortTerm > 0.1) direction = 'BULLISH';
  else if (shortTerm < -0.1) direction = 'BEARISH';

  // Strength (0-100)
  const strength = Math.min(100, Math.round(Math.abs(shortTerm) * 20));

  return {
    value: parseFloat(longTerm.toFixed(2)),
    shortTerm: parseFloat(shortTerm.toFixed(2)),
    change: parseFloat(change.toFixed(2)),
    acceleration: parseFloat(acceleration.toFixed(2)),
    direction,
    strength,
    accelerationDirection: acceleration > 0.05 ? 'ACCELERATING' : acceleration < -0.05 ? 'DECELERATING' : 'STABLE',
  };
}

// ──────────────────────────────────────────────────────────────
//  VOLUME
// ──────────────────────────────────────────────────────────────

export function calcVolume(candles, lookback = 20) {
  if (candles.length < lookback + 1) {
    return { current: 0, average: 0, ratio: 1, expansion: 'NORMAL' };
  }

  const currentVol = candles[candles.length - 1].volume;
  const recentVols = candles.slice(-lookback - 1, -1);
  const avgVol = recentVols.reduce((sum, c) => sum + c.volume, 0) / lookback;
  const ratio = avgVol > 0 ? currentVol / avgVol : 1;

  // Volume expansion classification
  let expansion = 'NORMAL';
  if (ratio > 2.0) expansion = 'EXPANDING';
  else if (ratio > 1.5) expansion = 'ELEVATED';
  else if (ratio < 0.5) expansion = 'LOW';

  return {
    current: parseFloat(currentVol.toFixed(2)),
    average: parseFloat(avgVol.toFixed(2)),
    ratio: parseFloat(ratio.toFixed(2)),
    expansion,
  };
}

// ──────────────────────────────────────────────────────────────
//  VOLATILITY
// ──────────────────────────────────────────────────────────────

export function calcVolatility(candles, lookback = 20) {
  if (candles.length < lookback + 1) {
    return { pct: 0, current: 0, direction: 'STABLE', expansion: 'NORMAL' };
  }

  // Current volatility = ATR-like measure
  const recentCandles = candles.slice(-lookback);
  const trueRanges = recentCandles.map((c, i) => {
    if (i === 0) return c.range;
    const prevClose = candles[candles.length - lookback + i - 1].close;
    return Math.max(c.range, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
  });

  const currentATR = trueRanges.reduce((s, tr) => s + tr, 0) / lookback;
  const currentPrice = candles[candles.length - 1].close;
  const volPct = (currentATR / currentPrice) * 100;

  // Previous volatility for comparison
  const prevCandles = candles.slice(-lookback * 2, -lookback);
  let prevATR = currentATR;
  if (prevCandles.length >= lookback) {
    const prevTR = prevCandles.map((c, i) => {
      if (i === 0) return c.range;
      const prevClose = prevCandles[i - 1].close;
      return Math.max(c.range, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
    });
    prevATR = prevTR.reduce((s, tr) => s + tr, 0) / lookback;
  }

  const volChange = ((currentATR - prevATR) / prevATR) * 100;

  let direction = 'STABLE';
  if (volChange > 15) direction = 'EXPANDING';
  else if (volChange < -15) direction = 'CONTRACTING';

  let expansion = 'NORMAL';
  if (volPct > 3) expansion = 'HIGH';
  else if (volPct > 1.5) expansion = 'ELEVATED';
  else if (volPct < 0.5) expansion = 'LOW';

  return {
    pct: parseFloat(volPct.toFixed(2)),
    current: parseFloat(currentATR.toFixed(6)),
    previous: parseFloat(prevATR.toFixed(6)),
    direction,
    expansion,
    changePct: parseFloat(volChange.toFixed(2)),
  };
}

// ──────────────────────────────────────────────────────────────
//  TREND (Moving Averages)
// ──────────────────────────────────────────────────────────────

export function calcTrend(candles) {
  if (candles.length < 50) {
    return {
      direction: 'NEUTRAL',
      strength: 0,
      ma9: 0,
      ma21: 0,
      ma50: 0,
      alignment: 'NEUTRAL',
    };
  }

  const closes = candles.map((c) => c.close);
  const currentPrice = closes[closes.length - 1];

  const ma9 = sma(closes, 9);
  const ma21 = sma(closes, 21);
  const ma50 = sma(closes, 50);

  // MA alignment
  let alignment = 'NEUTRAL';
  if (ma9 > ma21 && ma21 > ma50) alignment = 'BULLISH_STACKED';
  else if (ma9 > ma21 && ma21 < ma50) alignment = 'BULLISH_PARTIAL';
  else if (ma9 < ma21 && ma21 < ma50) alignment = 'BEARISH_STACKED';
  else if (ma9 < ma21 && ma21 > ma50) alignment = 'BEARISH_PARTIAL';

  // Trend direction from MA relationship
  let direction = 'NEUTRAL';
  if (currentPrice > ma9 && ma9 > ma21) direction = 'BULLISH';
  else if (currentPrice < ma9 && ma9 < ma21) direction = 'BEARISH';

  // Trend strength — how far price is from MAs, normalized
  const spread = Math.abs(currentPrice - ma21) / ma21 * 100;
  const strength = Math.min(100, Math.round(spread * 10));

  return {
    direction,
    strength,
    ma9: parseFloat(ma9.toFixed(6)),
    ma21: parseFloat(ma21.toFixed(6)),
    ma50: parseFloat(ma50.toFixed(6)),
    alignment,
    priceVsMA9: currentPrice > ma9 ? 'ABOVE' : 'BELOW',
    priceVsMA21: currentPrice > ma21 ? 'ABOVE' : 'BELOW',
    priceVsMA50: currentPrice > ma50 ? 'ABOVE' : 'BELOW',
  };
}

// ──────────────────────────────────────────────────────────────
//  REGIME (Market Classification)
// ──────────────────────────────────────────────────────────────

export function calcRegime(candles) {
  if (candles.length < 50) {
    return { classification: 'RANGE', ma10: 0, ma30: 0, ma50: 0, slope: 'FLAT' };
  }

  const closes = candles.map((c) => c.close);
  const ma10 = sma(closes, 10);
  const ma30 = sma(closes, 30);
  const ma50 = sma(closes, 50);

  // Slope of MA30 (trend direction)
  const prevMA30 = sma(closes.slice(0, -5), 30);
  const slope = ma30 > prevMA30 ? 'UP' : ma30 < prevMA30 ? 'DOWN' : 'FLAT';

  // Volatility for regime classification
  const recentRanges = candles.slice(-20).map((c) => c.range / c.close);
  const avgRange = recentRanges.reduce((s, r) => s + r, 0) / recentRanges.length;

  // Classification
  let classification = 'RANGE';
  const price = closes[closes.length - 1];

  if (ma10 > ma30 && ma30 > ma50 && slope === 'UP') {
    classification = avgRange > 0.015 ? 'TRENDING_BULL' : 'BULL';
  } else if (ma10 < ma30 && ma30 < ma50 && slope === 'DOWN') {
    classification = avgRange > 0.015 ? 'TRENDING_BEAR' : 'BEAR';
  } else if (Math.abs(ma10 - ma30) / ma30 < 0.003 && Math.abs(ma30 - ma50) / ma50 < 0.005) {
    classification = 'RANGE';
  } else if (slope === 'UP' && price > ma50) {
    classification = 'BULL';
  } else if (slope === 'DOWN' && price < ma50) {
    classification = 'BEAR';
  }

  return {
    classification,
    ma10: parseFloat(ma10.toFixed(6)),
    ma30: parseFloat(ma30.toFixed(6)),
    ma50: parseFloat(ma50.toFixed(6)),
    slope,
    volatility: parseFloat(avgRange.toFixed(4)),
  };
}

// ──────────────────────────────────────────────────────────────
//  MOMENTUM / TREND ALIGNMENT — Technical Direction
// ──────────────────────────────────────────────────────────────

/**
 * Combine all technical signals into a unified technical direction.
 * This is NOT the Brain's decision — it's one input among many.
 */
export function calcTechnicalDirection(rsi, momentum, volume, volatility, trend, regime) {
  let bullCount = 0;
  let bearCount = 0;
  const signals = [];

  // RSI
  if (rsi.momentumContext === 'BULLISH' || rsi.momentumContext === 'OVERBOUGHT') {
    if (rsi.direction === 'RISING') { bullCount++; signals.push({ name: 'RSI', value: rsi.value, direction: 'BULLISH', note: `${rsi.direction}` }); }
    else { signals.push({ name: 'RSI', value: rsi.value, direction: 'NEUTRAL', note: `${rsi.direction}` }); }
  } else if (rsi.momentumContext === 'BEARISH' || rsi.momentumContext === 'OVERSOLD') {
    if (rsi.direction === 'FALLING') { bearCount++; signals.push({ name: 'RSI', value: rsi.value, direction: 'BEARISH', note: `${rsi.direction}` }); }
    else { signals.push({ name: 'RSI', value: rsi.value, direction: 'NEUTRAL', note: `${rsi.direction}` }); }
  } else {
    signals.push({ name: 'RSI', value: rsi.value, direction: 'NEUTRAL', note: rsi.momentumContext });
  }

  // Momentum
  if (momentum.direction === 'BULLISH') {
    bullCount++;
    signals.push({ name: 'Momentum', value: momentum.shortTerm, direction: 'BULLISH', note: `${momentum.strength}% strength` });
  } else if (momentum.direction === 'BEARISH') {
    bearCount++;
    signals.push({ name: 'Momentum', value: momentum.shortTerm, direction: 'BEARISH', note: `${momentum.strength}% strength` });
  } else {
    signals.push({ name: 'Momentum', value: momentum.shortTerm, direction: 'NEUTRAL', note: 'flat' });
  }

  // Momentum acceleration
  if (momentum.accelerationDirection === 'ACCELERATING') {
    if (momentum.direction === 'BULLISH') { bullCount++; signals.push({ name: 'Momentum Change', value: momentum.acceleration, direction: 'BULLISH', note: 'accelerating' }); }
    else if (momentum.direction === 'BEARISH') { bearCount++; signals.push({ name: 'Momentum Change', value: momentum.acceleration, direction: 'BEARISH', note: 'accelerating' }); }
    else { signals.push({ name: 'Momentum Change', value: momentum.acceleration, direction: 'NEUTRAL', note: 'accelerating but flat' }); }
  } else if (momentum.accelerationDirection === 'DECELERATING') {
    signals.push({ name: 'Momentum Change', value: momentum.acceleration, direction: 'NEUTRAL', note: 'decelerating' });
  } else {
    signals.push({ name: 'Momentum Change', value: momentum.acceleration, direction: 'NEUTRAL', note: 'stable' });
  }

  // Volume
  if (volume.expansion === 'EXPANDING' || volume.expansion === 'ELEVATED') {
    // High volume confirms the current move
    const lastCandle = { isBullish: true }; // We don't have the candle here, but direction is from momentum
    if (momentum.direction === 'BULLISH') {
      bullCount++;
      signals.push({ name: 'Volume', value: `${volume.ratio}x avg`, direction: 'BULLISH', note: volume.expansion.toLowerCase() });
    } else if (momentum.direction === 'BEARISH') {
      bearCount++;
      signals.push({ name: 'Volume', value: `${volume.ratio}x avg`, direction: 'BEARISH', note: volume.expansion.toLowerCase() });
    } else {
      signals.push({ name: 'Volume', value: `${volume.ratio}x avg`, direction: 'NEUTRAL', note: volume.expansion.toLowerCase() });
    }
  } else if (volume.expansion === 'LOW') {
    signals.push({ name: 'Volume', value: `${volume.ratio}x avg`, direction: 'NEUTRAL', note: 'low volume' });
  } else {
    signals.push({ name: 'Volume', value: `${volume.ratio}x avg`, direction: 'NEUTRAL', note: 'normal' });
  }

  // Trend
  if (trend.direction === 'BULLISH') {
    bullCount++;
    signals.push({ name: '5m Trend', value: trend.alignment, direction: 'BULLISH', note: `${trend.strength}% strength` });
  } else if (trend.direction === 'BEARISH') {
    bearCount++;
    signals.push({ name: '5m Trend', value: trend.alignment, direction: 'BEARISH', note: `${trend.strength}% strength` });
  } else {
    signals.push({ name: '5m Trend', value: trend.alignment, direction: 'NEUTRAL', note: 'neutral' });
  }

  // Regime
  if (regime.classification === 'TRENDING_BULL' || regime.classification === 'BULL') {
    bullCount++;
    signals.push({ name: 'Regime', value: regime.classification, direction: 'BULLISH', note: regime.slope.toLowerCase() });
  } else if (regime.classification === 'TRENDING_BEAR' || regime.classification === 'BEAR') {
    bearCount++;
    signals.push({ name: 'Regime', value: regime.classification, direction: 'BEARISH', note: regime.slope.toLowerCase() });
  } else {
    signals.push({ name: 'Regime', value: regime.classification, direction: 'NEUTRAL', note: 'ranging' });
  }

  // Technical direction
  let direction = 'NEUTRAL';
  if (bullCount > bearCount && bullCount >= 3) direction = 'LONG';
  else if (bearCount > bullCount && bearCount >= 3) direction = 'SHORT';

  // Direction score (-100 to +100)
  const directionScore = ((bullCount - bearCount) / (bullCount + bearCount || 1)) * 100;

  // Base score (0-100)
  const baseScore = Math.min(100, Math.round(Math.max(bullCount, bearCount) * 14));

  // Technical conviction
  const conviction = Math.min(100, Math.round(Math.abs(directionScore)));

  return {
    direction,
    directionScore: parseFloat(directionScore.toFixed(0)),
    baseScore,
    conviction,
    bullCount,
    bearCount,
    signals,
  };
}

// ──────────────────────────────────────────────────────────────
//  CONTRADICTION DETECTION
// ──────────────────────────────────────────────────────────────

/**
 * Detect contradictions in technical evidence.
 * e.g., RSI near oversold while price is falling — downside may be exhausting.
 */
export function detectContradictions(rsi, momentum, volume, volatility, trend, regime, smc) {
  const contradictions = [];

  // RSI oversold while bearish → potential exhaustion
  if (rsi.momentumContext === 'OVERSOLD' && momentum.direction === 'BEARISH') {
    contradictions.push({
      indicator: 'RSI',
      note: 'RSI near oversold — downside may be exhausting',
      direction: 'BULLISH',
      weight: 1,
    });
  }

  // RSI overbought while bullish → potential exhaustion
  if (rsi.momentumContext === 'OVERBOUGHT' && momentum.direction === 'BULLISH') {
    contradictions.push({
      indicator: 'RSI',