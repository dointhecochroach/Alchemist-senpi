# 🧪 Alchemist Brain — Crypto Futures Trading Bot

An evidence-reasoning trading bot that thinks, not just scores. Built in Node.js, runs in Termux.

## What It Does

The Brain doesn't ask "is this a 90?" It asks:
> "What is happening, what explains it, what supports my thesis, what argues against it, what would invalidate it, what does my experience say, and what action makes sense given the risk?"

### Pipeline

```
MARKET DATA + SMC + SMART MONEY + TECHNICALS
  → FORM THESIS (3-pillar fusion)
  → GATHER SUPPORTING EVIDENCE (🏛 SMC + 🐋 SM + 📊 Tech)
  → GATHER CONTRADICTING EVIDENCE
  → FORM COUNTER-THESIS
  → COMPARE BOTH SIDES
  → CONSULT MEMORY
  → RISK ANALYSIS
  → CONCLUSION (ENTER / WAIT / REJECT)
  → AUTO-BUY (if ENTER & autoBuy enabled)
  → TP1 → BREAKEVEN → RUNNER → ADAPTIVE TRAILING → EXIT
  → POST-TRADE → LEARNING → MEMORY
```

### Modules

- **SMC**: Swing detection, BOS/CHOCH, structure bias, liquidity sweeps, FVG, displacement, breakout analysis
- **Smart Money**: Top trader L/S ratios (whale proxy), global positioning, OI/funding/taker flow, fusion score with flow alignment
- **Technical Engine**: RSI, momentum (ROC + acceleration), volume expansion, volatility (ATR), trend (MA9/21/50 alignment), regime classification (BULL/BEAR/RANGE), momentum/trend alignment, contradiction detection (exhaustion, divergence)
- **Brain**: Thesis engine combining all 3 pillars (SMC + Smart Money + Technicals), counter-thesis, invalidation, memory lookup, risk analysis, conclusion
- **Auto-Buy**: Automatically executes trades when Brain says ENTER. Respects max concurrent positions and risk limits.
- **Memory**: JSON-based learning system that records trades, tracks patterns (including technical bias + regime), and progressively adapts management rules
- **Execution**: Paper trader with TP1 (sell 30%) → breakeven → adaptive trailing on runner (70%)
- **Display**: Full ANSI scorecard — SMC → Smart Money → Technicals → Thesis → Counter → Memory → Risk → Decision

## Quick Start

```bash
# From Termux or terminal
cd "Alchemist Senpi"
node src/main.js
```

### Options

```bash
node src/main.js --mock       # Force mock data (test without Binance)
node src/main.js --debug      # Debug mode with scan summaries
node src/main.js --no-color   # Disable ANSI colors
```

## Data Source

Uses **Binance public API only** — no API keys needed. Fetches:
- Futures klines (candles) on 15m, 1h, 4h
- Open Interest + history
- Funding rate + history
- Top Trader Long/Short Position Ratio (whale proxy)
- Global Long/Short Account Ratio (retail sentiment)
- Taker Buy/Sell Volume Ratio
- 24h Ticker

If Binance is geo-blocked in your region, the bot **automatically falls back to mock data** so you can test the full system. Use `--mock` to force it.

## Configuration

Edit `src/config.js` to change:
- Symbols to scan
- Timeframes
- Risk parameters (stoploss %, TP1 %, trailing settings)
- Brain thresholds (min score, confidence, max conflict)
- Paper balance
- Scan interval

## Position Management

```
ENTRY
  ↓
INITIAL STOPLOSS (3%)
  ↓
TP1 HIT (3%)
  ├── SELL 30%
  └── MOVE STOP → BREAKEVEN
      ↓
      RUNNER (70%)
      ↓
      ADAPTIVE TRAILING (start at +2%, trail by 0.5%)
      ↓
      FINAL EXIT
```

## Files

```
Alchemist Senpi/
├── src/
│   ├── config.js              # All tunable parameters
│   ├── main.js                # Main orchestration loop
│   ├── data/
│   │   ├── binanceClient.js   # Binance public API client
│   │   └── mockData.js        # Mock data generator (fallback)
│   ├── smc/
│   │   └── smcAnalyzer.js     # SMC: swings, BOS, CHOCH, liquidity, FVG, displacement, breakout
│   ├── smart_money/
│   │   └── smartMoneyAnalyzer.js  # Top traders, derivatives, fusion
│   ├── technical/
│   │   └── technicalAnalyzer.js   # RSI, momentum, volume, volatility, trend, regime
│   ├── brain/
│   │   ├── thesisEngine.js    # Thesis → evidence → counter → conclusion
│   │   ├── memory.js          # Trade memory & learning
│   │   └── riskAnalysis.js    # Position sizing & risk checks
│   ├── execution/
│   │   └── paperTrader.js     # Paper trading engine with management
│   └── display/
│       └── scorecard.js       # ANSI scorecard renderer
├── storage/                   # Auto-created: trades.json, memory.json
└── package.json
```

## Roadmap to Real Money

1. ✅ Paper trading with real Binance data
2. ⬜ Add Binance API connector (spot/futures) with API keys
3. ⬜ Switch `paperTrade: false` in config
4. ⬜ Start with small size, verify execution
5. ⬜ Scale up

## Requirements

- Node.js 18+ (has native `fetch`)
- No npm install needed — zero dependencies
- Works in Termux on Android
