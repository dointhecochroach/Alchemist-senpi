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
      note: 'RSI near overbought — upside may be exhausting',
      direction: 'BEARISH',
      weight: 1,
    });
  }

  // Momentum decelerating while trend continues
  if (momentum.accelerationDirection === 'DECELERATING' && trend.strength > 50) {
    contradictions.push({
      indicator: 'Momentum Change',
      note: `Momentum decelerating while trend still strong — move may be losing steam`,
      direction: trend.direction === 'BULLISH' ? 'BEARISH' : 'BULLISH',
      weight: 1,
    });
  }

  // Low volume on a strong move
  if (volume.expansion === 'LOW' && momentum.strength > 40) {
    contradictions.push({
      indicator: 'Volume',
      note: 'Strong move on low volume — lack of participation',
      direction: 'NEUTRAL',
      weight: 1,
    });
  }

  // Volatility contracting while trending
  if (volatility.direction === 'CONTRACTING' && regime.classification.startsWith('TRENDING')) {
    contradictions.push({
      indicator: 'Volatility',
      note: 'Volatility contracting in a trending regime — potential reversal',
      direction: 'NEUTRAL',
      weight: 1,
    });
  }

  // Price approaching liquidity target (if SMC data available)
  if (smc?.liquidity?.liquidityTargets?.[0] && smc?.currentPrice) {
    const target = smc.liquidity.liquidityTargets[0];
    const dist = Math.abs((smc.currentPrice - target.level) / smc.currentPrice) * 100;
    if (dist < 1.0) {
      contradictions.push({
        indicator: 'Liquidity Target',
        note: `Price approaching liquidity target at ${target.level.toFixed(2)} (${dist.toFixed(2)}% away)`,
        direction: target.direction === 'UP' ? 'BULLISH' : 'BEARISH',
        weight: 2,
      });
    }
  }

  return contradictions;
}

// ──────────────────────────────────────────────────────────────
//  FULL TECHNICAL ANALYSIS
// ──────────────────────────────────────────────────────────────

export function analyzeTechnicals(candles, smcData = null) {
  const rsi = calcRSI(candles, 14);
  const momentum = calcMomentum(candles, 10, 20);
  const volume = calcVolume(candles, 20);
  const volatility = calcVolatility(candles, 20);
  const trend = calcTrend(candles);
  const regime = calcRegime(candles);

  const technicalDirection = calcTechnicalDirection(rsi, momentum, volume, volatility, trend, regime);
  const contradictions = detectContradictions(rsi, momentum, volume, volatility, trend, regime, smcData);

  // Build evidence list for the Brain
  const evidence = [];
  for (const sig of technicalDirection.signals) {
    if (sig.direction !== 'NEUTRAL') {
      evidence.push({
        source: 'Technical',
        item: `${sig.name} ${sig.value} ${sig.direction} (${sig.note})`,
        direction: sig.direction,
        weight: 1,
      });
    }
  }

  // Technical conclusion
  let techConclusion = 'NEUTRAL';
  if (technicalDirection.bullCount > technicalDirection.bearCount + 1) {
    techConclusion = 'BULLISH';
  } else if (technicalDirection.bearCount > technicalDirection.bullCount + 1) {
    techConclusion = 'BEARISH';
  }

  return {
    rsi,
    momentum,
    volume,
    volatility,
    trend,
    regime,
    technicalDirection,
    contradictions,
    evidence,
    technicalScore: technicalDirection.conviction,
    technicalBias: techConclusion,
    supportingCount: Math.max(technicalDirection.bullCount, technicalDirection.bearCount),
    contradictingCount: contradictions.length,
  };
}

// ──────────────────────────────────────────────────────────────
//  HELPERS
// ──────────────────────────────────────────────────────────────

function sma(values, period) {
  if (values.length < period) return values[values.length - 1] || 0;
  const slice = values.slice(-period);
  return slice.reduce((s, v) => s + v, 0) / period;
}
