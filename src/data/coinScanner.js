/**
 * Alchemist Brain — Dynamic Coin Scanner
 *
 * Scans all Binance futures USDT pairs and ranks them by
 * volume × volatility to find the best 15 coins to trade.
 * Updates periodically to catch shifting opportunities.
 */

const log = (...args) => console.log('[Scanner]', ...args);

export class CoinScanner {
  constructor(dataClient) {
    this.client = dataClient; // LiveDataClient or BinanceClient
    this.coins = [];           // Current top coins
    this.allPairs = [];        // All USDT futures pairs
    this.lastScan = 0;
    this.scanIntervalMs = 30 * 1000;  // Rescan every 30 seconds
    this.minVolume = 50_000_000;  // Min 24h volume ($50M)
    this.maxCoins = 15;
  }

  /**
   * Fetch all USDT futures trading pairs from Binance.
   */
  async fetchAllPairs() {
    try {
      const data = await this.client.getExchangeInfo();
      this.allPairs = data.symbols
        .filter((s) =>
          s.quoteAsset === 'USDT' &&
          s.contractType === 'PERPETUAL' &&
          s.status === 'TRADING'
        )
        .map((s) => ({
          symbol: s.symbol,
          pricePrecision: s.pricePrecision,
          quantityPrecision: s.quantityPrecision,
        }));
      log(`Found ${this.allPairs.length} USDT perpetual pairs`);
      return this.allPairs;
    } catch (e) {
      log(`Failed to fetch pairs: ${e.message}`);
      return [];
    }
  }

  async fetchAllTickers() {
    try {
      // Try cached WS tickers first
      if (this.client.getAllTickers && this.client.getAllTickers().length > 0) {
        return this.client.getAllTickers();
      }
      // Fallback to REST
      const data = await this.client.getAllTickers24h();
      return data.filter((t) => t.symbol.endsWith('USDT'));
    } catch (e) {
      log(`Failed to fetch tickers: ${e.message}`);
      return [];
    }
  }

  /**
   * Scan and rank coins by volume × volatility.
   * Returns the top N coins.
   */
  async scanTopCoins() {
    log('Scanning for top coins by volume × volatility...');

    // Get all pairs if we don't have them
    if (this.allPairs.length === 0) {
      await this.fetchAllPairs();
    }

    // Get 24h tickers for all pairs
    const tickers = await this.fetchAllTickers();
    if (tickers.length === 0) {
      log('No tickers returned, using fallback list');
      return this._fallbackCoins();
    }

    // Calculate volume × volatility score for each
    const scored = tickers.map((t) => {
      const volume = parseFloat(t.quoteVolume);  // 24h quote volume in USDT
      const high = parseFloat(t.highPrice);
      const low = parseFloat(t.lowPrice);
      const close = parseFloat(t.lastPrice);

      // Volatility = (high - low) / low * 100
      const volatility = low > 0 ? ((high - low) / low) * 100 : 0;

      // Score = volume × volatility (both matter)
      // Use log scale to prevent one dominant factor
      const score = volume * Math.pow(volatility, 1.5);

      return {
        symbol: t.symbol,
        volume: volume,
        volatility: parseFloat(volatility.toFixed(2)),
        price: close,
        priceChangePct: parseFloat(t.priceChangePercent),
        score: score,
        volumeStr: this._formatVolume(volume),
      };
    });

    // Filter: minimum volume
    const filtered = scored.filter((c) => c.volume >= this.minVolume);

    // Sort by score descending
    filtered.sort((a, b) => b.score - a.score);

    // Take top N
    this.coins = filtered.slice(0, this.maxCoins);
    this.lastScan = Date.now();

    log(`Selected top ${this.coins.length} coins:`);
    for (let i = 0; i < this.coins.length; i++) {
      const c = this.coins[i];
      log(`  ${i + 1}. ${c.symbol} | Vol: ${c.volumeStr} | Volat: ${c.volatility}% | Change: ${c.priceChangePct}%`);
    }

    return this.coins;
  }

  /**
   * Get the current top coins (or scan if stale).
   */
  async getTopCoins() {
    const stale = Date.now() - this.lastScan > this.scanIntervalMs;
    if (this.coins.length === 0 || stale) {
      await this.scanTopCoins();
    }
    return this.coins.map((c) => c.symbol);
  }

  /**
   * Get coin metadata (volume, volatility, etc).
   */
  getCoinMeta(symbol) {
    return this.coins.find((c) => c.symbol === symbol) || null;
  }

  _formatVolume(vol) {
    if (vol >= 1e9) return `$${(vol / 1e9).toFixed(2)}B`;
    if (vol >= 1e6) return `$${(vol / 1e6).toFixed(1)}M`;
    if (vol >= 1e3) return `$${(vol / 1e3).toFixed(0)}K`;
    return `$${vol.toFixed(0)}`;
  }

  _fallbackCoins() {
    // Used if API fails
    const fallback = [
      'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT',
      'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'DOTUSDT',
      'MATICUSDT', 'LTCUSDT', 'BCHUSDT', 'ATOMUSDT', 'NEARUSDT',
    ];
    this.coins = fallback.map((symbol) => ({
      symbol,
      volume: 0,
      volatility: 0,
      volumeStr: 'N/A',
      score: 0,
    }));
    return this.coins;
  }
}
