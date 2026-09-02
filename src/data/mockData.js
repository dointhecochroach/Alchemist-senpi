/**
 * Alchemist Brain — Mock Data Generator
 *
 * Generates realistic-looking candlestick and derivatives data
 * so the bot can be tested without Binance API access.
 *
 * Produces structured price action with:
 *   - Trends (bull/bear phases)
 *   - Swing highs/lows for SMC detection
 *   - Liquidity pools
 *   - FVGs (gaps from displacement candles)
 *   - Realistic OI/funding/L-S ratios
 */

export class MockDataGenerator {
  constructor() {
    this._state = {}; // Per-symbol state
  }

  _getState(symbol) {
    if (!this._state[symbol]) {
      this._state[symbol] = {
        basePrice: this._getBasePrice(symbol),
        trend: Math.random() > 0.5 ? 'BULLISH' : 'BEARISH',
        trendLength: 20 + Math.floor(Math.random() * 30),
        candlesInTrend: 0,
        volatility: 0.005 + Math.random() * 0.01,
        lastClose: null,
      };
    }
    return this._state[symbol];
  }

  _getBasePrice(symbol) {
    const bases = {
      BTCUSDT: 95000, ETHUSDT: 3400, SOLUSDT: 180,
      BNBUSDT: 650, XRPUSDT: 2.1,
    };
    return bases[symbol] || 100;
  }

  /**
   * Generate realistic candlestick data.
   */
  generateKlines(symbol, interval, limit = 200) {
    const state = this._getState(symbol);
    const candles = [];
    const intervalMs = this._intervalToMs(interval);

    // Start from the base or continue from last
    let price = state.lastClose || state.basePrice;
    const now = Date.now();
    const startTime = now - limit * intervalMs;

    for (let i = 0; i < limit; i++) {
      // Occasionally switch trend
      if (state.candlesInTrend >= state.trendLength) {
        state.trend = Math.random() > 0.5 ? 'BULLISH' : 'BEARISH';
        state.trendLength = 20 + Math.floor(Math.random() * 30);
        state.candlesInTrend = 0;
      }
      state.candlesInTrend++;

      // Generate OHLC
      const trendBias = state.trend === 'BULLISH' ? 0.0008 : -0.0008;
      const noise = (Math.random() - 0.5) * state.volatility;
      const change = trendBias + noise;

      const open = price;
      const close = price * (1 + change);

      // Sometimes create displacement candles (larger moves)
      const isDisplacement = Math.random() < 0.05;
      const displacementSize = isDisplacement ? state.volatility * 3 : 0;
      const dispDir = state.trend === 'BULLISH' ? 1 : -1;
      const adjustedClose = isDisplacement ? open * (1 + change + displacementSize * dispDir) : close;

      // Wicks
      const wickSize = state.volatility * price * (0.5 + Math.random());
      const bodyHigh = Math.max(open, adjustedClose);
      const bodyLow = Math.min(open, adjustedClose);
      const high = bodyHigh + wickSize * Math.random();
      const low = bodyLow - wickSize * Math.random();

      // Occasionally create sweep candles (wick beyond recent levels then close back)
      const isSweep = Math.random() < 0.03;
      const sweepWick = wickSize * 3;
      const finalHigh = isSweep ? high + sweepWick : high;
      const finalLow = isSweep ? low - sweepWick : low;

      const volume = (100 + Math.random() * 500) * (isDisplacement ? 3 : 1);
      const takerBuyRatio = 0.4 + Math.random() * 0.2 + (adjustedClose > open ? 0.05 : -0.05);

      candles.push({
        openTime: startTime + i * intervalMs,
        open: parseFloat(open.toFixed(6)),
        high: parseFloat(finalHigh.toFixed(6)),
        low: parseFloat(finalLow.toFixed(6)),
        close: parseFloat(adjustedClose.toFixed(6)),
        volume: parseFloat(volume.toFixed(2)),
        closeTime: startTime + i * intervalMs + intervalMs - 1,
        quoteVolume: parseFloat((volume * price).toFixed(2)),
        trades: Math.floor(1000 + Math.random() * 5000),
        takerBuyVolume: parseFloat((volume * takerBuyRatio).toFixed(2)),
        takerBuyQuote: parseFloat((volume * takerBuyRatio * price).toFixed(2)),
        range: parseFloat((finalHigh - finalLow).toFixed(6)),
        body: parseFloat(Math.abs(adjustedClose - open).toFixed(6)),
        isBullish: adjustedClose >= open,
      });

      price = adjustedClose;
    }

    state.lastClose = price;
    return candles;
  }

  /**
   * Generate a complete mock snapshot for a symbol.
   */
  generateSnapshot(symbol, intervals, candleLimit = 200) {
    const klines = {};
    for (const tf of intervals) {
      klines[tf] = this.generateKlines(symbol, tf, candleLimit);
    }

    const basePrice = klines[intervals[0]][klines[intervals[0]].length - 1].close;

    return {
      symbol,
      timestamp: Date.now(),
      klines,
      openInterest: {
        symbol,
        openInterest: parseFloat((Math.random() * 100000 + 50000).toFixed(4)),
        timestamp: Date.now(),
      },
      oiHistory: this._generateOIHistory(symbol),
      funding: {
        symbol,
        markPrice: basePrice,
        fundingRate: (Math.random() - 0.5) * 0.0005,
        nextFundingTime: Date.now() + 28800000,
        timestamp: Date.now(),
      },
      fundingHistory: this._generateFundingHistory(symbol),
      topTraderLS: this._generateLSRatio(symbol, 'top'),
      globalLS: this._generateLSRatio(symbol, 'global'),
      takerVolume: this._generateTakerVolume(symbol),
      ticker24h: {
        symbol,
        priceChange: parseFloat((basePrice * (Math.random() - 0.5) * 0.05).toFixed(4)),
        priceChangePct: parseFloat((Math.random() - 0.5) * 5).toFixed(2),
        lastPrice: basePrice,
        high24h: parseFloat((basePrice * 1.03).toFixed(4)),
        low24h: parseFloat((basePrice * 0.97).toFixed(4)),
        volume24h: parseFloat((Math.random() * 1000000).toFixed(2)),
        quoteVolume24h: parseFloat((Math.random() * 1000000000).toFixed(2)),
        count: Math.floor(100000 + Math.random() * 900000),
      },
    };
  }

  _generateOIHistory(symbol) {
    const history = [];
    let oi = 80000 + Math.random() * 20000;
    for (let i = 0; i < 30; i++) {
      oi += (Math.random() - 0.5) * 2000;
      history.push({
        timestamp: Date.now() - (30 - i) * 900000,
        sumOpenInterest: parseFloat(oi.toFixed(4)),
        sumOpenInterestValue: parseFloat((oi * 50000).toFixed(2)),
      });
    }
    return history;
  }

  _generateFundingHistory(symbol) {
    const history = [];
    for (let i = 0; i < 30; i++) {
      history.push({
        symbol,
        fundingRate: (Math.random() - 0.5) * 0.0003,
        fundingTime: Date.now() - (30 - i) * 28800000,
      });
    }
    return history;
  }

  _generateLSRatio(symbol, type) {
    const history = [];
    // Top traders tend to be more accurate — bias them toward the "real" trend
    const biasDir = Math.random() > 0.5 ? 0.55 : 0.45; // 55% long or 45% long
    for (let i = 0; i < 30; i++) {
      const noise = (Math.random() - 0.5) * 0.1;
      const longAccount = type === 'top' ? biasDir + noise : 0.5 + (Math.random() - 0.5) * 0.2;
      const shortAccount = 1 - longAccount;
      history.push({
        timestamp: Date.now() - (30 - i) * 900000,
        longShortRatio: parseFloat((longAccount / shortAccount).toFixed(4)),
        longAccount: parseFloat(longAccount.toFixed(4)),
        shortAccount: parseFloat(shortAccount.toFixed(4)),
        longPosition: type === 'top' ? parseFloat((Math.random() * 1000000).toFixed(2)) : 0,
        shortPosition: type === 'top' ? parseFloat((Math.random() * 1000000).toFixed(2)) : 0,
      });
    }
    return history;
  }

  _generateTakerVolume(symbol) {
    const history = [];
    for (let i = 0; i < 30; i++) {
      const buyVol = Math.random() * 500000 + 200000;
      const sellVol = Math.random() * 500000 + 200000;
      history.push({
        timestamp: Date.now() - (30 - i) * 900000,
        buySellRatio: parseFloat((buyVol / sellVol).toFixed(4)),
        buyVol: parseFloat(buyVol.toFixed(2)),
        sellVol: parseFloat(sellVol.toFixed(2)),
      });
    }
    return history;
  }

  _intervalToMs(interval) {
    const map = {
      '1m': 60000, '3m': 180000, '5m': 300000, '15m': 900000,
      '30m': 1800000, '1h': 3600000, '2h': 7200000, '4h': 14400000,
      '8h': 28800000, '12h': 43200000, '1d': 86400000, '1w': 604800000,
    };
    return map[interval] || 900000;
  }

  /**
   * Generate snapshots for all symbols.
   */
  generateAllSnapshots(symbols, intervals, candleLimit = 200) {
    const snapshots = {};
    for (const symbol of symbols) {
      snapshots[symbol] = this.generateSnapshot(symbol, intervals, candleLimit);
    }
    return snapshots;
  }

  /**
   * Update prices slightly for real-time simulation.
   */
  tickPrices(snapshots) {
    for (const symbol of Object.keys(snapshots)) {
      const snap = snapshots[symbol];
      if (!snap.klines?.['15m']?.length) continue;
      const candles = snap.klines['15m'];
      const last = candles[candles.length - 1];
      // Small price movement
      const change = (Math.random() - 0.5) * 0.003;
      const newClose = last.close * (1 + change);
      last.close = parseFloat(newClose.toFixed(6));
      last.high = Math.max(last.high, last.close);
      last.low = Math.min(last.low, last.close);
    }
    return snapshots;
  }
}
