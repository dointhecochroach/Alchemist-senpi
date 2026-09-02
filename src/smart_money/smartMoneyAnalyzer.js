/**
 * Alchemist Brain — Smart Money Module
 *
 * Analyzes what large/informed market participants are doing.
 *
 * Data sources (all Binance public, no keys):
 *   - Top Trader Long/Short Position Ratio (position-weighted)
 *   - Top Trader Long/Short Account Ratio (account-weighted)
 *   - Global Long/Short Account Ratio (retail sentiment)
 *   - Open Interest + changes (positioning flow)
 *   - Funding Rate (cost of holding positions)
 *   - Taker Buy/Sell Volume (aggressive order flow)
 *   - Aggregate Trades (whale trade detection)
 *   - Order Book depth (liquidity walls)
 *
 * Whale detection thresholds:
 *   - $25,000 minimum trade size baseline
 *   - 24h volume fraction (relative significance)
 *   - 95th percentile trade-size detection
 *   - Minimum directional imbalance
 */

// ──────────────────────────────────────────────────────────────
//  WHALE / TOP TRADER ANALYSIS
// ──────────────────────────────────────────────────────────────

// Whale detection thresholds
const WHALE_MIN_USD = 25000;        // $25k minimum baseline
const WHALE_VOLUME_FRACTION = 0.001; // 0.1% of 24h volume
const WHALE_PERCENTILE = 95;       // 95th percentile trade size
const WHALE_MIN_IMBALANCE = 0.15;  // 15% minimum directional imbalance

/**
 * Analyze top trader positioning combining BOTH:
 *   - Account ratio (topLongShortAccountRatio) — how many accounts
 *   - Position ratio (topLongShortPositionRatio) — position sizes
 * This gives a composite view = top trader composite.
 */
export function analyzeTopTraderComposite(topTraderPosition, topTraderAccount) {
  const result = {
    accountBias: 0,
    positionBias: 0,
    compositeBias: 0,
    direction: 'NEUTRAL',
    longPct: 50,
    shortPct: 50,
    positionLongPct: 50,
    positionShortPct: 50,
    changes: [],
    divergence: 0,
  };

  // Account ratio (how many top trader accounts are long vs short)
  if (topTraderAccount && topTraderAccount.length > 0) {
    const latest = topTraderAccount[topTraderAccount.length - 1];
    result.longPct = parseFloat((latest.longAccount * 100).toFixed(1));
    result.shortPct = parseFloat((latest.shortAccount * 100).toFixed(1));
    result.accountBias = clamp((latest.longShortRatio - 1) / (latest.longShortRatio + 1) * 2, -1, 1);
  }

  // Position ratio (position size weighted)
  if (topTraderPosition && topTraderPosition.length > 0) {
    const latest = topTraderPosition[topTraderPosition.length - 1];
    result.positionLongPct = parseFloat((latest.longAccount * 100).toFixed(1));
    result.positionShortPct = parseFloat((latest.shortAccount * 100).toFixed(1));
    result.positionBias = clamp((latest.longShortRatio - 1) / (latest.longShortRatio + 1) * 2, -1, 1);

    // Detect position changes
    const lookback = Math.min(5, topTraderPosition.length - 1);
    if (lookback > 0) {
      const older = topTraderPosition[topTraderPosition.length - 1 - lookback];
      const longChange = latest.longAccount - older.longAccount;
      const shortChange = latest.shortAccount - older.shortAccount;
      if (longChange > 0.01) result.changes.push({ type: 'INCREASING_LONG', value: longChange });
      if (shortChange > 0.01) result.changes.push({ type: 'INCREASING_SHORT', value: shortChange });
      if (longChange < -0.01) result.changes.push({ type: 'DECREASING_LONG', value: longChange });
      if (shortChange < -0.01) result.changes.push({ type: 'DECREASING_SHORT', value: shortChange });
    }
  }

  // Composite = weighted blend (position ratio is more meaningful — it's size-weighted)
  result.compositeBias = (result.accountBias * 0.4 + result.positionBias * 0.6);
  result.direction = result.compositeBias > 0.1 ? 'BULLISH' : result.compositeBias < -0.1 ? 'BEARISH' : 'NEUTRAL';

  return result;
}

/**
 * Detect whale trades from aggregate trade data.
 * Uses multiple thresholds:
 *   - $25,000 minimum USD size
 *   - 0.1% of 24h quote volume (relative significance)
 *   - 95th percentile of trade sizes in the batch
 *   - Minimum 15% directional imbalance
 */
export function analyzeWhaleFlow(aggTrades, ticker24h) {
  if (!aggTrades || aggTrades.length === 0) {
    return {
      detected: false,
      whaleTrades: [],
      whaleBuys: 0,
      whaleSells: 0,
      netFlow: 0,
      direction: 'NEUTRAL',
      strength: 0,
      totalWhaleVolume: 0,
    };
  }

  // Calculate thresholds
  const quoteVolume = ticker24h?.quoteVolume24h || 0;
  const volumeThreshold = quoteVolume * WHALE_VOLUME_FRACTION;
  const usdThreshold = Math.max(WHALE_MIN_USD, volumeThreshold);

  // Calculate 95th percentile trade size
  const tradeSizes = aggTrades.map((t) => t.quantity * t.price).sort((a, b) => a - b);
  const p95Index = Math.floor(tradeSizes.length * WHALE_PERCENTILE / 100);
  const p95Threshold = tradeSizes[p95Index] || 0;

  // A trade is "whale" if it exceeds ANY threshold
  const whaleTrades = aggTrades.filter((t) => {
    const usdValue = t.quantity * t.price;
    return usdValue >= usdThreshold || usdValue >= p95Threshold;
  });

  // Separate buys vs sells
  // isBuyerMaker = true means the buyer is the maker (taker is selling)
  // isBuyerMaker = false means the seller is the maker (taker is buying)
  const whaleBuys = whaleTrades.filter((t) => !t.isBuyerMaker);
  const whaleSells = whaleTrades.filter((t) => t.isBuyerMaker);

  const buyVolume = whaleBuys.reduce((s, t) => s + t.quantity * t.price, 0);
  const sellVolume = whaleSells.reduce((s, t) => s + t.quantity * t.price, 0);
  const totalVolume = buyVolume + sellVolume;
  const netFlow = buyVolume - sellVolume;

  // Directional imbalance
  const imbalance = totalVolume > 0 ? Math.abs(netFlow) / totalVolume : 0;

  // Only report whale signal if imbalance exceeds minimum
  let direction = 'NEUTRAL';
  let strength = 0;
  if (imbalance >= WHALE_MIN_IMBALANCE && whaleTrades.length > 0) {
    direction = netFlow > 0 ? 'BULLISH' : 'BEARISH';
    strength = Math.min(100, Math.round(imbalance * 100));
  }

  return {
    detected: whaleTrades.length > 0,
    whaleTrades: whaleTrades.slice(0, 10).map((t) => ({
      price: t.price,
      quantity: t.quantity,
      usdValue: parseFloat((t.quantity * t.price).toFixed(2)),
      isBuy: !t.isBuyerMaker,
      timestamp: t.timestamp,
    })),
    whaleBuys: whaleBuys.length,
    whaleSells: whaleSells.length,
    buyVolume: parseFloat(buyVolume.toFixed(2)),
    sellVolume: parseFloat(sellVolume.toFixed(2)),
    netFlow: parseFloat(netFlow.toFixed(2)),
    direction,
    strength,
    imbalance: parseFloat(imbalance.toFixed(2)),
    totalWhaleVolume: parseFloat(totalVolume.toFixed(2)),
    threshold: parseFloat(usdThreshold.toFixed(2)),
  };
}

/**
 * Analyze order book for liquidity walls and bid/ask imbalance.
 */
export function analyzeOrderBookDepth(orderBook) {
  if (!orderBook || !orderBook.bids || !orderBook.asks) {
    return { direction: 'NEUTRAL', imbalance: 0.5, strength: 0 };
  }

  const bidVol = orderBook.bids.reduce((s, b) => s + b[1], 0);
  const askVol = orderBook.asks.reduce((s, a) => s + a[1], 0);
  const total = bidVol + askVol;
  const imbalance = total > 0 ? bidVol / total : 0.5;

  // Find largest walls
  const largestBid = orderBook.bids.reduce((max, b) => b[1] > max[1] ? b : max, orderBook.bids[0]);
  const largestAsk = orderBook.asks.reduce((max, a) => a[1] > max[1] ? a : max, orderBook.asks[0]);

  return {
    direction: imbalance > 0.55 ? 'BULLISH' : imbalance < 0.45 ? 'BEARISH' : 'NEUTRAL',
    imbalance: parseFloat(imbalance.toFixed(2)),
    strength: Math.min(100, Math.round(Math.abs(imbalance - 0.5) * 200)),
    bidVolume: parseFloat(bidVol.toFixed(4)),
    askVolume: parseFloat(askVol.toFixed(4)),
    largestBidWall: largestBid ? { price: largestBid[0], volume: largestBid[1] } : null,
    largestAskWall: largestAsk ? { price: largestAsk[0], volume: largestAsk[1] } : null,
    spread: orderBook.asks[0] && orderBook.bids[0] ? orderBook.asks[0][0] - orderBook.bids[0][0] : 0,
  };
}
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
  // Use composite top trader analysis (account + position ratio)
  const topTraderComposite = analyzeTopTraderComposite(
    snapshot.topTraderLS,      // position ratio
    snapshot.topTraderAccount  // account ratio (may be null)
  );

  // Also keep backward-compatible analysis
  const topTraderAnalysis = analyzeTopTraders(snapshot.topTraderLS, snapshot.globalLS);
  const globalAnalysis = analyzeGlobalPosition(snapshot.globalLS);
  const derivatives = analyzeDerivatives(
    snapshot.openInterest,
    snapshot.oiHistory,
    snapshot.funding,
    snapshot.fundingHistory,
    snapshot.takerVolume
  );

  // Whale flow from aggregate trades
  const whaleFlow = analyzeWhaleFlow(snapshot.aggTrades, snapshot.ticker24h);

  // Order book depth
  const orderBook = analyzeOrderBookDepth(snapshot.orderBook);

  const fusion = fuseSmartMoney(topTraderAnalysis, globalAnalysis, derivatives);

  // Integrate whale flow into fusion
  if (whaleFlow.detected && whaleFlow.direction !== 'NEUTRAL') {
    const whaleSignal = whaleFlow.direction === 'BULLISH' ? whaleFlow.strength / 100 : -(whaleFlow.strength / 100);
    fusion.smartMoneyBias = clamp(fusion.smartMoneyBias + whaleSignal * 0.15, -1, 1);
    fusion.direction = fusion.smartMoneyBias > 0.1 ? 'BULLISH' : fusion.smartMoneyBias < -0.1 ? 'BEARISH' : 'NEUTRAL';
    fusion.strength = Math.min(100, Math.round(Math.abs(fusion.smartMoneyBias) * 100));
  }

  // Evidence list for the Brain
  const evidence = [];

  if (topTraderComposite.direction === 'BULLISH') {
    evidence.push(`Top traders bullish (composite: ${topTraderComposite.longPct}%L / ${topTraderComposite.shortPct}%S)`);
  } else if (topTraderComposite.direction === 'BEARISH') {
    evidence.push(`Top traders bearish (composite: ${topTraderComposite.longPct}%L / ${topTraderComposite.shortPct}%S)`);
  }

  for (const change of topTraderComposite.changes) {
    if (change.type === 'INCREASING_LONG') evidence.push(`Top traders increasing long (+${(change.value * 100).toFixed(1)}%)`);
    if (change.type === 'INCREASING_SHORT') evidence.push(`Top traders increasing short (+${(change.value * 100).toFixed(1)}%)`);
  }

  if (whaleFlow.detected) {
    evidence.push(`Whale flow: ${whaleFlow.whaleBuys} buys vs ${whaleFlow.whaleSells} sells (${whaleFlow.direction}, ${whaleFlow.strength}% strength)`);
  }

  if (orderBook.direction !== 'NEUTRAL') {
    evidence.push(`Order book ${orderBook.direction.toLowerCase()} (${(orderBook.imbalance * 100).toFixed(0)}% bid)`);
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

  if (topTraderComposite.divergence > 0.1) {
    evidence.push(`Top traders diverge from retail (bullish edge)`);
  } else if (topTraderComposite.divergence < -0.1) {
    evidence.push(`Top traders diverge from retail (bearish edge)`);
  }

  return {
    topTraders: topTraderComposite,
    topTraderAnalysis, // backward compat
    global: globalAnalysis,
    derivatives,
    whaleFlow,
    orderBook,
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
