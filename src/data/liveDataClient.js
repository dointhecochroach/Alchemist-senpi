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

// Binance endpoint alternatives — futures + spot
// Some regions block fapi but api.binance.com works for spot
const FUTURES_REST_ENDPOINTS = [
  'https://fapi.binance.com',
  'https://fapi.binance.me',
];

const SPOT_REST_ENDPOINTS = [
  'https://api.binance.com',
  'https://api.binance.me',
  'https://api1.binance.com',
  'https://api2.binance.com',
  'https://api3.binance.com',
  'https://api4.binance.com',
];

const WS_ENDPOINTS = [
  'wss://fstream.binance.com',
  'wss://fstream.binance.me',
];

export class LiveDataClient {
  constructor() {
    this.restBase = null;       // Active futures REST URL
    this.spotBase = null;       // Active spot REST URL (fallback)
    this.futuresAvailable = false;
    this.spotAvailable = false;
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
    // Test futures REST endpoints
    for (const url of FUTURES_REST_ENDPOINTS) {
      try {
        const resp = await fetch(`${url}/fapi/v1/ping`, {
          signal: AbortSignal.timeout(5000),
          headers: { 'User-Agent': 'AlchemistBrain/1.0' },
        });
        if (resp.ok) {
          this.restBase = url;
          this.futuresAvailable = true;
          log(`Futures REST: ${url} ✓`);
          break;
        } else if (resp.status === 451) {
          
          this._restBlocked.add(url);
        }
      } catch (e) {
        
        this._restBlocked.add(url);
      }
    }

    // Test spot REST endpoints (fallback for prices/klines)
    for (const url of SPOT_REST_ENDPOINTS) {
      try {
        const resp = await fetch(`${url}/api/v3/ping`, {
          signal: AbortSignal.timeout(5000),
          headers: { 'User-Agent': 'AlchemistBrain/1.0' },
        });
        if (resp.ok) {
          this.spotBase = url;
          this.spotAvailable = true;
          log(`Spot REST: ${url} ✓`);
          break;
        } else if (resp.status === 451) {
          
        }
      } catch (e) {
        
      }
    }

    if (!this.restBase && this.spotBase) {
      log('Futures blocked — using spot API for prices/klines. Derivatives data (OI/funding/LS) may be limited.');
    }

    // WS endpoint — try matching the working REST, or test each
    this.wsBase = WS_ENDPOINTS[0];
    if (this.restBase?.includes('.me')) {
      this.wsBase = WS_ENDPOINTS[1];
    }

    return this.restBase !== null || this.spotBase !== null;
  }

  get available() {
    return this.restBase !== null || this.spotBase !== null;
  }

  // ═══════════════════════════════════════════════════════════
  //  REST — periodic data (rate-limited)
  // ═══════════════════════════════════════════════════════════

  async _rest(path, params = {}) {
    if (!this.restBase) throw new Error('No futures REST endpoint available');
    return this._doRest(this.restBase, path, params, FUTURES_REST_ENDPOINTS);
  }

  async _spotRest(path, params = {}) {
    if (!this.spotBase) throw new Error('No spot REST endpoint available');
    return this._doRest(this.spotBase, path, params, SPOT_REST_ENDPOINTS);
  }

  async _doRest(base, path, params = {}, endpointList) {
    // Simple rate limiter
    const now = Date.now();
    if (now > this._rateLimitState.resetTime) {
      this._rateLimitState.count = 0;
      this._rateLimitState.resetTime = now + 60000;
    }
    if (this._rateLimitState.count > 1200) {
      const wait = this._rateLimitState.resetTime - now;
      await new Promise((r) => setTimeout(r, wait));
    }
    this._rateLimitState.count++;

    const qs = new URLSearchParams(params).toString();
    const url = `${base}${path}${qs ? `?${qs}` : ''}`;

    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'AlchemistBrain/1.0' },
        signal: AbortSignal.timeout(10000),
      });

      if (resp.status === 429) {
        const retry = parseInt(resp.headers.get('Retry-After') || '5', 10);
        log(`Rate limited (429), waiting ${retry}s...`);
        await new Promise((r) => setTimeout(r, retry * 1000));
        return this._doRest(base, path, params, endpointList);
      }

      if (resp.status === 451) {
        // This endpoint is geo-blocked, try switching
        for (const alt of endpointList) {
          if (alt === base || this._restBlocked.has(alt)) continue;
          log(`Switching endpoint: ${base} → ${alt}`);
          if (endpointList === FUTURES_REST_ENDPOINTS) this.restBase = alt;
          else this.spotBase = alt;
          return this._doRest(alt, path, params, endpointList);
        }
        throw new Error(`Endpoint geo-blocked (451): ${base}`);
      }

      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return resp.json();
    } catch (e) {
      // Try alternate endpoints on network error
      for (const alt of endpointList) {
        if (alt === base || this._restBlocked.has(alt)) continue;
        try {
          const qs2 = new URLSearchParams(params).toString();
          const url2 = `${alt}${path}${qs2 ? `?${qs2}` : ''}`;
          const resp2 = await fetch(url2, {
            headers: { 'User-Agent': 'AlchemistBrain/1.0' },
            signal: AbortSignal.timeout(10000),
          });
          if (resp2.ok) {
            if (endpointList === FUTURES_REST_ENDPOINTS) this.restBase = alt;
            else this.spotBase = alt;
            return resp2.json();
          }
        } catch {}
      }
      throw e;
    }
  }

  // ── Exchange Info (all trading pairs) ─────────────────────
  async getExchangeInfo() {
    if (this.futuresAvailable) {
      try { return await this._rest('/fapi/v1/exchangeInfo'); }
      catch (e) { log('Futures exchangeInfo failed, trying spot'); }
    }
    return this._spotRest('/api/v3/exchangeInfo');
  }

  // ── All 24h tickers (single call) ─────────────────────────
  async getAllTickers24h() {
    if (this.futuresAvailable) {
      try { return await this._rest('/fapi/v1/ticker/24hr'); }
      catch (e) { log('Futures tickers failed, trying spot'); }
    }
    const data = await this._spotRest('/api/v3/ticker/24hr');
    return data.filter((t) => t.symbol.endsWith('USDT'));
  }

  // ── Open Interest ─────────────────────────────────────────
  // Futures-only data — returns null if futures API is blocked
  async getOpenInterest(symbol) {
    if (!this.futuresAvailable) return null;
    try {
      const d = await this._rest('/fapi/v1/openInterest', { symbol });
      return { symbol, openInterest: parseFloat(d.openInterest), timestamp: d.time };
    } catch { return null; }
  }

  async getOpenInterestHistory(symbol, period = '15m', limit = 30) {
    if (!this.futuresAvailable) return [];
    try {
      const raw = await this._rest('/futures/data/openInterestHist', { symbol, period, limit });
      return raw.map((r) => ({
        timestamp: r.timestamp,
        sumOpenInterest: parseFloat(r.sumOpenInterest),
        sumOpenInterestValue: parseFloat(r.sumOpenInterestValue),
      }));
    } catch { return []; }
  }

  // ── Funding Rate ──────────────────────────────────────────
  // Futures-only — returns null if blocked
  async getFundingRate(symbol) {
    if (!this.futuresAvailable) return null;
    try {
      const d = await this._rest('/fapi/v1/premiumIndex', { symbol });
      return {
        symbol,
        markPrice: parseFloat(d.markPrice),
        fundingRate: parseFloat(d.lastFundingRate),
        nextFundingTime: d.nextFundingTime,
        timestamp: d.time,
      };
    } catch { return null; }
  }

  async getFundingHistory(symbol, limit = 30) {
    if (!this.futuresAvailable) return [];
    try {
      const raw = await this._rest('/fapi/v1/fundingRate', { symbol, limit });
      return raw.map((r) => ({
        symbol: r.symbol,
        fundingRate: parseFloat(r.fundingRate),
        fundingTime: r.fundingTime,
      }));
    } catch { return []; }
  }

  // ── Long/Short Ratios ─────────────────────────────────────
  // Futures-only — returns empty if blocked
  async getTopTraderLS(symbol, period = '15m', limit = 30) {
    if (!this.futuresAvailable) return [];
    // Try position ratio first, then account ratio as fallback
    try {
      const raw = await this._rest('/futures/data/topLongShortPositionRatio', { symbol, period, limit });
      if (raw && raw.length > 0) {
        return raw.map((r) => ({
          timestamp: r.timestamp,
          longShortRatio: parseFloat(r.longShortRatio),
          longAccount: parseFloat(r.longAccount),
          shortAccount: parseFloat(r.shortAccount),
          longPosition: parseFloat(r.longPosition || 0),
          shortPosition: parseFloat(r.shortPosition || 0),
        }));
      }
    } catch (e) {
      log(`topLongShortPositionRatio failed for ${symbol}: ${e.message}`);
    }
    // Fallback: account ratio
    try {
      const raw2 = await this._rest('/futures/data/topLongShortAccountRatio', { symbol, period, limit });
      return raw2.map((r) => ({
        timestamp: r.timestamp,
        longShortRatio: parseFloat(r.longShortRatio),
        longAccount: parseFloat(r.longAccount),
        shortAccount: parseFloat(r.shortAccount),
        longPosition: 0,
        shortPosition: 0,
      }));
    } catch (e) {
      log(`topLongShortAccountRatio also failed for ${symbol}`);
      return [];
    }
  }

  async getGlobalLS(symbol, period = '15m', limit = 30) {
    if (!this.futuresAvailable) return [];
    try {
      const raw = await this._rest('/futures/data/globalLongShortAccountRatio', { symbol, period, limit });
      return raw.map((r) => ({
        timestamp: r.timestamp,
        longShortRatio: parseFloat(r.longShortRatio),
        longAccount: parseFloat(r.longAccount),
        shortAccount: parseFloat(r.shortAccount),
      }));
    } catch { return []; }
  }

  async getTakerVolume(symbol, period = '15m', limit = 30) {
    if (!this.futuresAvailable) return [];
    try {
      const raw = await this._rest('/futures/data/takerlongshortRatio', { symbol, period, limit });
      return raw.map((r) => ({
        timestamp: r.timestamp,
        buySellRatio: parseFloat(r.buySellRatio),
        buyVol: parseFloat(r.buyVol),
        sellVol: parseFloat(r.sellVol),
      }));
    } catch { return []; }
  }

  // ── Historical klines (for initial load) ──────────────────
  async getKlines(symbol, interval, limit = 200) {
    if (this.futuresAvailable) {
      try {
        const raw = await this._rest('/fapi/v1/klines', { symbol, interval, limit });
        return this._parseKlines(raw);
      } catch (e) {
        log(`Futures klines failed for ${symbol}, trying spot...`);
      }
    }
    // Spot fallback — same kline format
    const raw = await this._spotRest('/api/v3/klines', { symbol, interval, limit });
    return this._parseKlines(raw);
  }

  _parseKlines(raw) {
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

  // ── Spot Price (works when futures is blocked) ──────────
  async getSpotPrice(symbol) {
    if (!this.spotAvailable) return null;
    try {
      const d = await this._spotRest('/api/v3/ticker/price', { symbol });
      return { symbol, price: parseFloat(d.price) };
    } catch { return null; }
  }

  // ── Order Book Depth ─────────────────────────────────────
  async getOrderBook(symbol, limit = 20) {
    if (this.futuresAvailable) {
      try {
        const d = await this._rest('/fapi/v1/depth', { symbol, limit });
        return {
          symbol,
          bids: d.bids.map((b) => [parseFloat(b[0]), parseFloat(b[1])]),
          asks: d.asks.map((a) => [parseFloat(a[0]), parseFloat(a[1])]),
          lastUpdateId: d.lastUpdateId,
        };
      } catch (e) {
        log(`Futures depth failed for ${symbol}, trying spot...`);
      }
    }
    if (this.spotAvailable) {
      try {
        const d = await this._spotRest('/api/v3/depth', { symbol, limit });
        return {
          symbol,
          bids: d.bids.map((b) => [parseFloat(b[0]), parseFloat(b[1])]),
          asks: d.asks.map((a) => [parseFloat(a[0]), parseFloat(a[1])]),
          lastUpdateId: d.lastUpdateId,
        };
      } catch { return null; }
    }
    return null;
  }

  // ── Aggregate Trades (large trades = whale activity) ─────
  async getAggTrades(symbol, limit = 100) {
    if (this.futuresAvailable) {
      try {
        const raw = await this._rest('/fapi/v1/aggTrades', { symbol, limit });
        return raw.map((t) => ({
          symbol,
          price: parseFloat(t.p),
          quantity: parseFloat(t.q),
          timestamp: t.T,
          isBuyerMaker: t.m,
        }));
      } catch (e) {
        log(`Futures aggTrades failed for ${symbol}, trying spot...`);
      }
    }
    if (this.spotAvailable) {
      try {
        const raw = await this._spotRest('/api/v3/aggTrades', { symbol, limit });
        return raw.map((t) => ({
          symbol,
          price: parseFloat(t.p),
          quantity: parseFloat(t.q),
          timestamp: t.T,
          isBuyerMaker: t.m,
        }));
      } catch { return []; }
    }
    return [];
  }

  // ── Server Time ──────────────────────────────────────────
  async getServerTime() {
    if (this.futuresAvailable) {
      try { return (await this._rest('/fapi/v1/time')).serverTime; } catch {}
    }
    if (this.spotAvailable) {
      try { return (await this._spotRest('/api/v3/time')).serverTime; } catch {}
    }
    return Date.now();
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
      orderBook, aggTrades,
    ] = await Promise.allSettled([
      this.getOpenInterest(symbol),
      this.getOpenInterestHistory(symbol, '15m', 30),
      this.getFundingRate(symbol),
      this.getFundingHistory(symbol, 30),
      this.getTopTraderLS(symbol, '15m', 30),
      this.getGlobalLS(symbol, '15m', 30),
      this.getTakerVolume(symbol, '15m', 30),
      this.getOrderBook(symbol, 20),
      this.getAggTrades(symbol, 100),
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
      orderBook: unwrap(orderBook),
      aggTrades: unwrap(aggTrades, []),
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
