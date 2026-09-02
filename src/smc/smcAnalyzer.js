/**
 * Alchemist Brain — SMC (Smart Money Concepts) Module
 *
 * Detects market structure, liquidity, FVGs, displacement, and breakouts
 * from candlestick data.
 *
 * Pipeline:
 *   candles → swing detection → structure bias → BOS/CHOCH
 *          → liquidity pools/sweeps → FVG → displacement → breakout
 */

// ──────────────────────────────────────────────────────────────
//  SWING DETECTION
// ──────────────────────────────────────────────────────────────

/**
 * Detect swing highs and lows using a fractal approach.
 * A swing high = highest high in a window of `lookback` candles on each side.
 * A swing low = lowest low in a window of `lookback` candles on each side.
 */
export function detectSwings(candles, lookback = 2) {
  const swingHighs = [];
  const swingLows = [];

  for (let i = lookback; i < candles.length - lookback; i++) {
    // Check for swing high
    let isHigh = true;
    for (let j = 1; j <= lookback; j++) {
      if (candles[i].high <= candles[i - j].high || candles[i].high <= candles[i + j].high) {
        isHigh = false;
        break;
      }
    }
    if (isHigh) {
      swingHighs.push({
        index: i,
        price: candles[i].high,
        time: candles[i].openTime,
        type: 'high',
      });
    }

    // Check for swing low
    let isLow = true;
    for (let j = 1; j <= lookback; j++) {
      if (candles[i].low >= candles[i - j].low || candles[i].low >= candles[i + j].low) {
        isLow = false;
        break;
      }
    }
    if (isLow) {
      swingLows.push({
        index: i,
        price: candles[i].low,
        time: candles[i].openTime,
        type: 'low',
      });
    }
  }

  return { swingHighs, swingLows };
}

/**
 * Classify the swing sequence into HH, HL, LH, LL.
 */
export function classifySwings(swingHighs, swingLows) {
  const highs = swingHighs.map((s) => ({ ...s, classification: '' }));
  const lows = swingLows.map((s) => ({ ...s, classification: '' }));

  // Classify highs
  for (let i = 1; i < highs.length; i++) {
    if (highs[i].price > highs[i - 1].price) {
      highs[i].classification = 'HH'; // Higher High
    } else {
      highs[i].classification = 'LH'; // Lower High
    }
  }

  // Classify lows
  for (let i = 1; i < lows.length; i++) {
    if (lows[i].price > lows[i - 1].price) {
      lows[i].classification = 'HL'; // Higher Low
    } else {
      lows[i].classification = 'LL'; // Lower Low
    }
  }

  return { swingHighs: highs, swingLows: lows };
}

/**
 * Determine structure bias from the latest swings.
 * HH + HL = bullish, LH + LL = bearish, mixed = neutral/ranging
 */
export function getStructureBias(swingHighs, swingLows) {
  if (swingHighs.length < 2 || swingLows.length < 2) {
    return { bias: 'NEUTRAL', sequence: 'Insufficient data' };
  }

  const lastHigh = swingHighs[swingHighs.length - 1];
  const prevHigh = swingHighs[swingHighs.length - 2];
  const lastLow = swingLows[swingLows.length - 1];
  const prevLow = swingLows[swingLows.length - 2];

  const highRising = lastHigh.price > prevHigh.price;
  const lowRising = lastLow.price > prevLow.price;
  const highFalling = lastHigh.price < prevHigh.price;
  const lowFalling = lastLow.price < prevLow.price;

  let bias, sequence;

  if (highRising && lowRising) {
    bias = 'BULLISH';
    sequence = 'HL → HH → HL';
  } else if (highFalling && lowFalling) {
    bias = 'BEARISH';
    sequence = 'LH → LL → LH';
  } else if (highRising && lowFalling) {
    bias = 'EXPANSION'; // Divergence — expanding range
    sequence = 'LL → HH → expanding';
  } else if (highFalling && lowRising) {
    bias = 'CONTRACTION'; // Converging — potential breakout
    sequence = 'HL → LH → contracting';
  } else {
    bias = 'NEUTRAL';
    sequence = 'Mixed';
  }

  return { bias, sequence };
}

// ──────────────────────────────────────────────────────────────
//  BREAK OF STRUCTURE (BOS) & CHANGE OF CHARACTER (CHOCH)
// ──────────────────────────────────────────────────────────────

/**
 * Detect Break of Structure and Change of Character.
 *
 * BOS = price breaks the last swing in the direction of the current trend
 * CHOCH = price breaks the last swing against the current trend (reversal signal)
 */
export function detectBOSandCHOCH(candles, swingHighs, swingLows, structureBias) {
  const result = {
    bos: { detected: false, direction: null, brokenLevel: null, strength: 0 },
    choch: { detected: false, direction: null, brokenLevel: null, strength: 0 },
  };

  if (swingHighs.length < 2 || swingLows.length < 2) return result;

  // Get the most recent confirmed swing high and low
  const lastSwingHigh = swingHighs[swingHighs.length - 1];
  const lastSwingLow = swingLows[swingLows.length - 1];

  // Look at the last few candles after the most recent swing
  const recentCandles = candles.slice(Math.min(lastSwingHigh.index, lastSwingLow.index) + 1);

  if (recentCandles.length === 0) return result;

  const currentPrice = candles[candles.length - 1].close;

  // Check for BOS in bullish direction (price breaks above last swing high)
  if (structureBias.bias === 'BULLISH' || structureBias.bias === 'EXPANSION') {
    const brokeHigh = recentCandles.some((c) => c.close > lastSwingHigh.price);
    if (brokeHigh) {
      const breakCandle = recentCandles.find((c) => c.close > lastSwingHigh.price);
      const displacementStrength = breakCandle.body / (breakCandle.range || 1);
      result.bos = {
        detected: true,
        direction: 'BULLISH',
        brokenLevel: lastSwingHigh.price,
        strength: Math.min(100, Math.round(displacementStrength * 100)),
        breakIndex: breakCandle.openTime,
      };
    }
  }

  // Check for BOS in bearish direction (price breaks below last swing low)
  if (structureBias.bias === 'BEARISH' || structureBias.bias === 'EXPANSION') {
    const brokeLow = recentCandles.some((c) => c.close < lastSwingLow.price);
    if (brokeLow) {
      const breakCandle = recentCandles.find((c) => c.close < lastSwingLow.price);
      const displacementStrength = breakCandle.body / (breakCandle.range || 1);
      result.bos = {
        detected: true,
        direction: 'BEARISH',
        brokenLevel: lastSwingLow.price,
        strength: Math.min(100, Math.round(displacementStrength * 100)),
        breakIndex: breakCandle.openTime,
      };
    }
  }

  // Check for CHOCH (reversal — price breaks against the current trend)
  if (structureBias.bias === 'BULLISH') {
    // CHOCH bearish: price breaks below last swing low in a bullish trend
    const brokeBelow = recentCandles.some((c) => c.close < lastSwingLow.price);
    if (brokeBelow) {
      result.choch = {
        detected: true,
        direction: 'BEARISH',
        brokenLevel: lastSwingLow.price,
        strength: 50, // Initial strength — needs confirmation
      };
    }
  } else if (structureBias.bias === 'BEARISH') {
    // CHOCH bullish: price breaks above last swing high in a bearish trend
    const brokeAbove = recentCandles.some((c) => c.close > lastSwingHigh.price);
    if (brokeAbove) {
      result.choch = {
        detected: true,
        direction: 'BULLISH',
        brokenLevel: lastSwingHigh.price,
        strength: 50,
      };
    }
  }

  return result;
}

// ──────────────────────────────────────────────────────────────
//  LIQUIDITY DETECTION
// ──────────────────────────────────────────────────────────────

/**
 * Detect liquidity pools: equal highs, equal lows, previous highs/lows.
 * Also detect liquidity sweeps (price briefly exceeds a level then reverses).
 */
export function detectLiquidity(candles, swingHighs, swingLows) {
  const tolerance = 0.001; // 0.1% tolerance for "equal" levels

  // Equal highs (liquidity above)
  const equalHighs = [];
  for (let i = 1; i < swingHighs.length; i++) {
    const diff = Math.abs(swingHighs[i].price - swingHighs[i - 1].price);
    const pctDiff = diff / Math.min(swingHighs[i].price, swingHighs[i - 1].price);
    if (pctDiff < tolerance) {
      equalHighs.push({
        level: Math.max(swingHighs[i].price, swingHighs[i - 1].price),
        indices: [swingHighs[i - 1].index, swingHighs[i].index],
        type: 'equal_high',
      });
    }
  }

  // Equal lows (liquidity below)
  const equalLows = [];
  for (let i = 1; i < swingLows.length; i++) {
    const diff = Math.abs(swingLows[i].price - swingLows[i - 1].price);
    const pctDiff = diff / Math.min(swingLows[i].price, swingLows[i - 1].price);
    if (pctDiff < tolerance) {
      equalLows.push({
        level: Math.min(swingLows[i].price, swingLows[i - 1].price),
        indices: [swingLows[i - 1].index, swingLows[i].index],
        type: 'equal_low',
      });
    }
  }

  // Previous highs and lows (single liquidity points)
  const prevHighs = swingHighs.slice(-5).map((s) => ({
    level: s.price,
    index: s.index,
    type: 'prev_high',
  }));

  const prevLows = swingLows.slice(-5).map((s) => ({
    level: s.price,
    index: s.index,
    type: 'prev_low',
  }));

  // ── Liquidity sweep detection ─────────────────────────────
  // A sweep = price exceeds a swing high/low but closes back inside
  const sweeps = [];
  const lastCandle = candles[candles.length - 1];
  const lookback = 10;
  const recentCandles = candles.slice(-lookback);

  for (const sh of [...equalHighs, ...prevHighs]) {
    // Check if any recent candle spiked above the level then closed below
    for (const c of recentCandles) {
      if (c.high > sh.level && c.close < sh.level) {
        const wickSize = c.high - sh.level;
        const candleRange = c.range || 1;
        sweeps.push({
          direction: 'ABOVE',
          level: sh.level,
          strength: Math.min(100, Math.round((wickSize / candleRange) * 100)),
          sweepTime: c.openTime,
          location: sh.type,
        });
        break;
      }
    }
  }

  for (const sl of [...equalLows, ...prevLows]) {
    for (const c of recentCandles) {
      if (c.low < sl.level && c.close > sl.level) {
        const wickSize = sl.level - c.low;
        const candleRange = c.range || 1;
        sweeps.push({
          direction: 'BELOW',
          level: sl.level,
          strength: Math.min(100, Math.round((wickSize / candleRange) * 100)),
          sweepTime: c.openTime,
          location: sl.type,
        });
        break;
      }
    }
  }

  // Determine the most recent/strongest sweep
  let strongestSweep = null;
  if (sweeps.length > 0) {
    strongestSweep = sweeps.reduce((max, s) => (s.strength > max.strength ? s : max), sweeps[0]);
  }

  // Liquidity targets (where price is likely to go next)
  const liquidityTargets = [];
  if (strongestSweep?.direction === 'ABOVE') {
    // Swept above — target is liquidity below
    const lowestLiq = prevLows.reduce(
      (min, p) => (p.level < min ? p.level : min),
      Infinity
    );
    if (lowestLiq !== Infinity) liquidityTargets.push({ direction: 'DOWN', level: lowestLiq });
  } else if (strongestSweep?.direction === 'BELOW') {
    const highestLiq = prevHighs.reduce(
      (max, p) => (p.level > max ? p.level : max),
      0
    );
    if (highestLiq !== 0) liquidityTargets.push({ direction: 'UP', level: highestLiq });
  }

  return {
    equalHighs,
    equalLows,
    prevHighs,
    prevLows,
    sweep: strongestSweep,
    allSweeps: sweeps,
    liquidityTargets,
  };
}

// ──────────────────────────────────────────────────────────────
//  FAIR VALUE GAPS (FVG)
// ──────────────────────────────────────────────────────────────

/**
 * Detect Fair Value Gaps (3-candle imbalance).
 *
 * Bullish FVG: candle[i-1].high < candle[i+1].low (gap up)
 * Bearish FVG: candle[i-1].low > candle[i+1].high (gap down)
 */
export function detectFVG(candles) {
  const fvgs = [];

  for (let i = 1; i < candles.length - 1; i++) {
    const prev = candles[i - 1];
    const next = candles[i + 1];

    // Bullish FVG
    if (prev.high < next.low) {
      const upperBoundary = next.low;
      const lowerBoundary = prev.high;
      const size = upperBoundary - lowerBoundary;
      const sizePct = (size / prev.close) * 100;

      // Check if filled
      const subsequentCandles = candles.slice(i + 2);
      const touched = subsequentCandles.some((c) => c.low <= upperBoundary);
      const fullyFilled = subsequentCandles.some((c) => c.low <= lowerBoundary);
      const partiallyFilled = touched && !fullyFilled;

      // Age in candles
      const age = candles.length - i - 1;

      fvgs.push({
        direction: 'BULLISH',
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

    // Bearish FVG
    if (prev.low > next.high) {
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

  // 11. Order book liquidity (if depth data provided)
  let orderBookLiquidity = null;
  if (options.depth) {
    orderBookLiquidity = analyzeOrderBook(options.depth, currentPrice);
  }

  // 12. Aggregate trade analysis (whale trades)
  let whaleTrades = null;
  if (options.aggTrades) {
    whaleTrades = analyzeAggTrades(options.aggTrades);
  }

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
    orderBookLiquidity,
    whaleTrades,
    smcScore,
    smcBias,
    evidence: evidenceList,
  };
}

// ──────────────────────────────────────────────────────────────
//  ORDER BOOK ANALYSIS
// ──────────────────────────────────────────────────────────────

/**
 * Analyze order book for real liquidity levels.
 * Shows where large buy/sell walls are.
 */
export function analyzeOrderBook(depth, currentPrice) {
  if (!depth || !depth.bids || !depth.asks) return null;

  const bidLevels = depth.bids.slice(0, 10);
  const askLevels = depth.asks.slice(0, 10);

  const totalBidVol = bidLevels.reduce((s, b) => s + b[1], 0);
  const totalAskVol = askLevels.reduce((s, a) => s + a[1], 0);

  // Find largest bid/ask walls
  const largestBidWall = bidLevels.reduce((max, b) => b[1] > max[1] ? b : max, bidLevels[0]);
  const largestAskWall = askLevels.reduce((max, a) => a[1] > max[1] ? a : max, askLevels[0]);

  // Bid/ask imbalance
  const imbalance = totalBidVol / (totalBidVol + totalAskVol);

  return {
    totalBidVolume: parseFloat(totalBidVol.toFixed(4)),
    totalAskVolume: parseFloat(totalAskVol.toFixed(4)),
    imbalance: parseFloat(imbalance.toFixed(2)), // >0.5 = more bids = bullish
    direction: imbalance > 0.55 ? 'BULLISH' : imbalance < 0.45 ? 'BEARISH' : 'NEUTRAL',
    largestBidWall: { price: largestBidWall[0], volume: largestBidWall[1] },
    largestAskWall: { price: largestAskWall[0], volume: largestAskWall[1] },
    spread: askLevels[0][0] - bidLevels[0][0],
  };
}

// ──────────────────────────────────────────────────────────────
//  AGGREGATE TRADES ANALYSIS (WHALE DETECTION)
// ──────────────────────────────────────────────────────────────

/**
 * Analyze aggregate trades for whale activity.
 * Large trades = institutional/smart money participation.
 */
export function analyzeAggTrades(trades) {
  if (!trades || trades.length === 0) return null;

  // Sort by quantity to find large trades
  const sorted = [...trades].sort((a, b) => b.quantity - a.quantity);
  const topTrades = sorted.slice(0, 10);

  // Calculate average trade size
  const avgSize = trades.reduce((s, t) => s + t.quantity, 0) / trades.length;

  // Large trades = >3x average
  const largeTrades = trades.filter((t) => t.quantity > avgSize * 3);
  const largeBuys = largeTrades.filter((t) => !t.isBuyerMaker).length; // taker buys
  const largeSells = largeTrades.filter((t) => t.isBuyerMaker).length; // taker sells

  // Net flow from large trades
  const netFlow = largeTrades.reduce((sum, t) => {
    return sum + (t.isBuyerMaker ? -t.quantity : t.quantity);
  }, 0);

  return {
    totalTrades: trades.length,
    avgTradeSize: parseFloat(avgSize.toFixed(4)),
    largeTradeCount: largeTrades.length,
    largeBuys,
    largeSells,
    netFlow: parseFloat(netFlow.toFixed(4)),
    direction: netFlow > 0 ? 'BULLISH' : netFlow < 0 ? 'BEARISH' : 'NEUTRAL',
    topTrades: topTrades.map((t) => ({
      price: t.price,
      quantity: t.quantity,
      isBuy: !t.isBuyerMaker,
    })),
  };
}
