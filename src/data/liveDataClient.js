/**
 * Alchemist Brain — Binance Live Data Client
 *
 * Architecture:
 *   - WebSocket for real-time kline (candle) data — no polling needed
 *   - WebSocket for 24h ticker stats
 *   - REST for periodic data (OI, funding, L/S ratios) every 5 min
 *   - Tries multiple endpoints (fapi.binance.com, alternatives)
 *   - Proper rate limiting on REST calls
 *   - Auto-reconnect on WebSocket disconnect
 *
 * Binance Futures:
 *   REST:      https://fapi.binance.com
 *   WebSocket: wss://fstream.binance.com
 *
 * Rate limits (futures):
 *   REST: 2400 weight/min — most calls are weight 1
 *   WS:   10 incoming messages/sec, 300 req/5min for order
 *   We only read data → very low limit usage
 */

// Node 22+ has native WebSocket — no external dependency needed

const log = (...a) => console.log('[LiveData]', ...a);
const logErr = (...a) => console.error('[LiveData]', ...a);

// Binance endpoint alternatives — some regions block one but not others
const REST_ENDPOINTS = [
  'https://fapi.binance.com',
  'https://fapi.binance.me',
];

const WS_ENDPOINTS = [
  'wss://fstream.binance.com',
  'wss://fstream.binance.me',
];

export class LiveDataClient {
  constructor() {
    this.restBase = null;       // Active REST URL (discovered by testing)
    this.wsBase = null;         // Active WS URL
    this._ws = null;            // Active WebSocket
    this._wsReconnectTimer = null;
    this._wsConnected = false;
    this._klineSubs = new Map(); // symbol+tf → callback
    this._tickerSubs = new Set(); // symbols with ticker subscriptions
    this._candleCache = new Map(); // symbol|tf → candles[]
    this._tickerCache = new Map(); // symbol → ticker data
    this._restBlocked = new Set(); // blocked REST endpoints
    this._rateLimitState = { count: 0, resetTime: Date.now() + 60000 };
  }

  // ═══════════════════════════════════════════════════════════
  //  INIT — find working endpoints
  // ═══════════════════════════════════════════════════════════

  async init() {
    // Test REST endpoints
    for (const url of REST_ENDPOINTS) {
      try {
        const resp = await fetch(`${url}/fapi/v1/ping`, {
          signal: AbortSignal.timeout(5000),
          headers: { 'User-Agent': 'AlchemistBrain/1.0' },
        });
        if (resp.ok) {
          this.restBase = url;
          log(`REST endpoint: ${url}`);
          break;
        } else if (resp.status === 451) {
          log(`${url} geo-blocked (451), trying next...`);
          this._restBlocked.add(url);
        }
      } catch (e) {
        log(`${url} unreachable: ${e.message}`);
        this._restBlocked.add(url);
      }
    }

    if (!this.restBase) {
      logErr('All REST endpoints blocked. Will use WebSocket only.');
    }

    // WS endpoint — try matching the working REST, or test each
    this.wsBase = WS_ENDPOINTS[0];
    if (this.restBase?.includes('.me')) {
      this.wsBase = WS_ENDPOINTS[1];
    }

    return this.restBase !== null;
  }

  get available() {
    return this.restBase !== null;
  }

  // ═══════════════════════════════════════════════════════════
  //  REST — periodic data (rate-limited)
  // ═══════════════════════════════════════════════════════════

  async _rest(path, params = {}) {
    if (!this.restBase) throw new Error('No REST endpoint available');

    // Simple rate limiter — 1200 weight/min (conservative)
    const now = Date.now();
    if (now > this._rateLimitState.resetTime) {
      this._rateLimitState.count = 0;
      this._rateLimitState.resetTime = now + 60000;
    }
    if (this._rateLimitState.count > 1200) {
      const wait = this._rateLimitState.resetTime - now;
      log(`Rate limit approaching, waiting ${wait}ms...`);
      await new Promise((r) => setTimeout(r, wait));
    }
    this._rateLimitState.count++;

    const qs = new URLSearchParams(params).toString();
    const url = `${this.restBase}${path}${qs ? `?${qs}` : ''}`;

    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'AlchemistBrain/1.0' },
        signal: AbortSignal.timeout(10000),
      });

      if (resp.status === 429) {
        const retry = parseInt(resp.headers.get('Retry-After') || '5', 10);
        log(`Rate limited (429), waiting ${retry}s...`);
        await new Promise((r) => setTimeout(r, retry * 1000));
        return this._rest(path, params); // Retry once
      }

      if (resp.status === 451) {
        this._restBlocked.add(this.restBase);
        // Try switching endpoint
        for (const alt of REST_ENDPOINTS) {
          if (this._restBlocked.has(alt)) continue;
          this.restBase = alt;
          log(`Switched REST to ${alt}`);
          return this._rest(path, params);
        }
        throw new Error('All REST endpoints geo-blocked (451)');
      }

      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return resp.json();
    } catch (e) {
      // Try alternate endpoint on network error
      for (const alt of REST_ENDPOINTS) {
        if (alt === this.restBase || this._restBlocked.has(alt)) continue;
        this.restBase = alt;
        log(`Network error, trying ${alt}...`);
        try {
          const qs2 = new URLSearchParams(params).toString();
          const url2 = `${alt}${path}${qs2 ? `?${qs2}` : ''}`;
          const resp2 = await fetch(url2, {
            headers: { 'User-Agent': 'AlchemistBrain/1.0' },
            signal: AbortSignal.timeout(10000),
          });
          if (resp2.ok) return resp2.json();
        } catch {}
      }
      throw e;
    }
  }

  // ── Exchange Info (all trading pairs) ─────────────────────
  async getExchangeInfo() {
    return this._rest('/fapi/v1/exchangeInfo');
  }

  // ── All 24h tickers (single call) ─────────────────────────
  async getAllTickers24h() {
    return this._rest('/fapi/v1/ticker/24hr');
  }

  // ── Open Interest ─────────────────────────────────────────
  async getOpenInterest(symbol) {
    const d = await this._rest('/fapi/v1/openInterest', { symbol });
    return { symbol, openInterest: parseFloat(d.openInterest), timestamp: d.time };
  }

  async getOpenInterestHistory(symbol, period = '15m', limit = 30) {
    const raw = await this._rest('/futures/data/openInterestHist', { symbol, period, limit });
    return raw.map((r) => ({
      timestamp: r.timestamp,
      sumOpenInterest: parseFloat(r.sumOpenInterest),
      sumOpenInterestValue: parseFloat(r.sumOpenInterestValue),
    }));
  }

  // ── Funding Rate ──────────────────────────────────────────
  async getFundingRate(symbol) {
    const d = await this._rest('/fapi/v1/premiumIndex', { symbol });
    return {
      symbol,
      markPrice: parseFloat(d.markPrice),
      fundingRate: parseFloat(d.lastFundingRate),
      nextFundingTime: d.nextFundingTime,
      timestamp: d.time,
    };
  }

  async getFundingHistory(symbol, limit = 30) {
    const raw = await this._rest('/fapi/v1/fundingRate', { symbol, limit });
    return raw.map((r) => ({
      symbol: r.symbol,
      fundingRate: parseFloat(r.fundingRate),
      fundingTime: r.fundingTime,
    }));
  }

  // ── Long/Short Ratios ─────────────────────────────────────
  async getTopTraderLS(symbol, period = '15m', limit = 30) {
    const raw = await this._rest('/futures/data/topLongShortPositionRatio', { symbol, period, limit });
    return raw.map((r) => ({
      timestamp: r.timestamp,
      longShortRatio: parseFloat(r.longShortRatio),
      longAccount: parseFloat(r.longAccount),
      shortAccount: parseFloat(r.shortAccount),
      longPosition: parseFloat(r.longPosition || 0),
      shortPosition: parseFloat(r.shortPosition || 0),
    }));
  }

  async getGlobalLS(symbol, period = '15m', limit = 30) {
    const raw = await this._rest('/futures/data/globalLongShortAccountRatio', { symbol, period, limit });
    return raw.map((r) => ({
      timestamp: r.timestamp,
      longShortRatio: parseFloat(r.longShortRatio),
      longAccount: parseFloat(r.longAccount),
      shortAccount: parseFloat(r.shortAccount),
    }));
  }

  async getTakerVolume(symbol, period = '15m', limit = 30) {
    const raw = await this._rest('/futures/data/takerlongshortRatio', { symbol, period, limit });
    return raw.map((r) => ({
      timestamp: r.timestamp,
      buySellRatio: parseFloat(r.buySellRatio),
      buyVol: parseFloat(r.buyVol),
      sellVol: parseFloat(r.sellVol),
    }));
  }

  // ── Historical klines (for initial load) ──────────────────
  async getKlines(symbol, interval, limit = 200) {
    const raw = await this._rest('/fapi/v1/klines', { symbol, interval, limit });
    return raw.map((k) => ({
      openTime: k[0],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
      closeTime: k[6],
      quoteVolume: parseFloat(k[7]),
      trades: k[8],
      takerBuyVolume: parseFloat(k[9]),
      takerBuyQuote: parseFloat(k[10]),
      range: parseFloat(k[2]) - parseFloat(k[3]),
      body: Math.abs(parseFloat(k[4]) - parseFloat(k[1])),
      isBullish: parseFloat(k[4]) >= parseFloat(k[1]),
    }));
  }

  // ═══════════════════════════════════════════════════════════
  //  WEBSOCKET — real-time kline + ticker data
  // ═══════════════════════════════════════════════════════════

  /**
   * Connect to Binance Futures WebSocket.
   * Subscribes to kline streams for all symbols + timeframes.
   */
  async connectWebSocket(symbols, timeframes) {
    this._symbols = symbols;
    this._timeframes = timeframes;

    await this._connectWS();

    // Subscribe to streams
    this._subscribeKlines(symbols, timeframes);
  }

  async _connectWS() {
    return new Promise((resolve, reject) => {
      log(`Connecting WebSocket to ${this.wsBase}...`);
      try {
        this._ws = new WebSocket(`${this.wsBase}/stream`);
      } catch (e) {
        logErr(`WebSocket construction failed: ${e.message}`);
        reject(e);
        return;
      }

      const timeout = setTimeout(() => {
        reject(new Error('WebSocket connection timeout'));
      }, 10000);

      this._ws.addEventListener('open', () => {
        clearTimeout(timeout);
        log('WebSocket connected ✓');
        this._wsConnected = true;
        if (this._wsReconnectTimer) {
          clearTimeout(this._wsReconnectTimer);
          this._wsReconnectTimer = null;
        }
        resolve();
      });

      this._ws.addEventListener('message', (event) => {
        try {
          const msg = JSON.parse(event.data);
          this._handleWSMessage(msg);
        } catch (e) {
          // Non-JSON or parse error — ignore
        }
      });

      this._ws.addEventListener('error', (err) => {
        clearTimeout(timeout);
        logErr(`WebSocket error`);
        this._wsConnected = false;
        if (!this._wsReconnectTimer) {
          this._scheduleReconnect();
        }
        if (this._ws.readyState === 0) { // CONNECTING
          // Try alternative WS endpoint
          for (const alt of WS_ENDPOINTS) {
            if (alt !== this.wsBase) {
              this.wsBase = alt;
              log(`Trying alternative WS: ${alt}`);
              break;
            }
          }
          reject(new Error('WebSocket connection failed'));
        }
      });

      this._ws.addEventListener('close', () => {
        log('WebSocket disconnected, will reconnect...');
        this._wsConnected = false;
        this._scheduleReconnect();
      });
    });
  }

  _scheduleReconnect() {
    if (this._wsReconnectTimer) return;
    const delay = 3000;
    log(`Reconnecting in ${delay / 1000}s...`);
    this._wsReconnectTimer = setTimeout(async () => {
      this._wsReconnectTimer = null;
      try {
        await this._connectWS();
        if (this._symbols && this._timeframes) {
          this._subscribeKlines(this._symbols, this._timeframes);
        }
      } catch (e) {
        logErr(`Reconnect failed: ${e.message}`);
        this._scheduleReconnect();
      }
    }, delay);
  }

  _subscribeKlines(symbols, timeframes) {
    if (!this._ws || !this._wsConnected) return;

    // Build stream names: btcusdt@kline_15m
    const streams = [];
    for (const sym of symbols) {
      const lower = sym.toLowerCase();
      for (const tf of timeframes) {
        streams.push(`${lower}@kline_${tf}`);
      }
      // Also subscribe to ticker for real-time 24h stats
      streams.push(`${lower}@ticker`);
    }

    // Subscribe in batches (Binance max 200 streams per request, 1024 total)
    const batchSize = 200;
    for (let i = 0; i < streams.length; i += batchSize) {
      const batch = streams.slice(i, i + batchSize);
      const msg = { method: 'SUBSCRIBE', params: batch, id: i + 1 };
      this._ws.send(JSON.stringify(msg));
    }

    log(`Subscribed to ${streams.length} streams (${symbols.length} symbols × ${timeframes.length} TFs + tickers)`);
  }

  _handleWSMessage(msg) {
    // Kline update
    if (msg.stream && msg.stream.includes('@kline_')) {
      const kline = msg.data?.k;
      if (!kline) return;

      const [symbol, , tf] = msg.stream.split('@kline_');
      const key = `${symbol.toUpperCase()}|${tf}`;

      // Update or create candle
      const candle = {
        openTime: kline.t,
        open: parseFloat(kline.o),
        high: parseFloat(kline.h),
        low: parseFloat(kline.l),
        close: parseFloat(kline.c),
        volume: parseFloat(kline.v),
        closeTime: kline.T,
        quoteVolume: parseFloat(kline.q),
        trades: kline.n,
        takerBuyVolume: parseFloat(kline.V),
        takerBuyQuote: parseFloat(kline.Q),
        range: parseFloat(kline.h) - parseFloat(kline.l),
        body: Math.abs(parseFloat(kline.c) - parseFloat(kline.o)),
        isBullish: parseFloat(kline.c) >= parseFloat(kline.o),
        isClosed: kline.x, // true if this is the final update for this candle
      };

      if (!this._candleCache.has(key)) {
        this._candleCache.set(key, []);
      }
      const candles = this._candleCache.get(key);

      // Replace last candle if same openTime, else push
      if (candles.length > 0 && candles[candles.length - 1].openTime === candle.openTime) {
        candles[candles.length - 1] = candle;
      } else {
        candles.push(candle);
        // Keep max 300 candles
        if (candles.length > 300) candles.shift();
      }
    }

    // Ticker update (24h rolling stats)
    if (msg.stream && msg.stream.includes('@ticker')) {
      const d = msg.data;
      if (!d) return;
      const symbol = d.s;
      this._tickerCache.set(symbol, {
        symbol,
        priceChange: parseFloat(d.p),
        priceChangePct: parseFloat(d.P),
        lastPrice: parseFloat(d.c),
        high24h: parseFloat(d.h),
        low24h: parseFloat(d.l),
        volume24h: parseFloat(d.v),
        quoteVolume24h: parseFloat(d.q),
        count: parseInt(d.n),
      });
    }
  }

  /**
   * Get cached candles for a symbol+timeframe.
   * If cache is empty, fetch via REST first.
   */
  async getCandles(symbol, timeframe, limit = 200) {
    const key = `${symbol}|${timeframe}`;
    const cached = this._candleCache.get(key);

    if (cached && cached.length >= 50) {
      return cached.slice(-limit);
    }

    // Cache miss or too few — fetch via REST
    const klines = await this.getKlines(symbol, timeframe, limit);

    // Prime the cache
    this._candleCache.set(key, klines);

    return klines;
  }

  /**
   * Get cached 24h ticker for a symbol.
   */
  getTicker(symbol) {
    return this._tickerCache.get(symbol) || null;
  }

  /**
   * Get all cached tickers.
   */
  getAllTickers() {
    return Array.from(this._tickerCache.values());
  }

  // ═══════════════════════════════════════════════════════════
  //  FULL SNAPSHOT — for analysis
  // ═══════════════════════════════════════════════════════════

  /**
   * Get a full analysis snapshot for one symbol.
   * Candles come from WebSocket cache (real-time).
   * Derivatives data comes from REST (periodic).
   */
  async getSymbolSnapshot(symbol, timeframes) {
    // Candles from WS cache
    const klines = {};
    for (const tf of timeframes) {
      try {
        klines[tf] = await this.getCandles(symbol, tf, 200);
      } catch (e) {
        logErr(`Failed candles ${symbol} ${tf}: ${e.message}`);
        klines[tf] = [];
      }
    }

    // REST data — fetch concurrently
    const [
      openInterest, oiHistory, funding, fundingHistory,
      topTraderLS, globalLS, takerVolume,
    ] = await Promise.allSettled([
      this.getOpenInterest(symbol),
      this.getOpenInterestHistory(symbol, '15m', 30),
      this.getFundingRate(symbol),
      this.getFundingHistory(symbol, 30),
      this.getTopTraderLS(symbol, '15m', 30),
      this.getGlobalLS(symbol, '15m', 30),
      this.getTakerVolume(symbol, '15m', 30),
    ]);

    const unwrap = (r, fallback = null) =>
      r.status === 'fulfilled' ? r.value : fallback;

    const ticker = this.getTicker(symbol) ||
      // Build from 24h ticker REST if WS hasn't sent one yet
      (klines[timeframes[0]]?.length > 0 ? {
        symbol,
        lastPrice: klines[timeframes[0]][klines[timeframes[0]].length - 1].close,
        high24h: Math.max(...klines[timeframes[0]].slice(-96).map((c) => c.high)),
        low24h: Math.min(...klines[timeframes[0]].slice(-96).map((c) => c.low)),
        volume24h: klines[timeframes[0]].slice(-96).reduce((s, c) => s + c.volume, 0),
        quoteVolume24h: klines[timeframes[0]].slice(-96).reduce((s, c) => s + c.quoteVolume, 0),
      } : null);

    return {
      symbol,
      timestamp: Date.now(),
      klines,
      openInterest: unwrap(openInterest),
      oiHistory: unwrap(oiHistory, []),
      funding: unwrap(funding),
      fundingHistory: unwrap(fundingHistory, []),
      topTraderLS: unwrap(topTraderLS, []),
      globalLS: unwrap(globalLS, []),
      takerVolume: unwrap(takerVolume, []),
      ticker24h: ticker,
    };
  }

  /**
   * Get snapshots for multiple symbols (sequential to limit rate).
   * Derivatives REST calls are staggered.
   */
  async getAllSnapshots(symbols, timeframes) {
    const snapshots = {};
    for (const symbol of symbols) {
      try {
        snapshots[symbol] = await this.getSymbolSnapshot(symbol, timeframes);
      } catch (e) {
        logErr(`Snapshot failed ${symbol}: ${e.message}`);
        snapshots[symbol] = null;
      }
      // Small delay between symbols to spread REST load
      await new Promise((r) => setTimeout(r, 200));
    }
    return snapshots;
  }

  // ═══════════════════════════════════════════════════════════
  //  CLEANUP
  // ═══════════════════════════════════════════════════════════

  disconnect() {
    if (this._wsReconnectTimer) {
      clearTimeout(this._wsReconnectTimer);
      this._wsReconnectTimer = null;
    }
    if (this._ws) {
      try {
        this._ws.close();
      } catch {}
    }
    this._wsConnected = false;
  }
}
