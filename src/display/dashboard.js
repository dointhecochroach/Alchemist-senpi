/**
 * Alchemist Brain — Terminal Dashboard
 *
 * Clean, readable TUI with keyboard navigation:
 *   [1] Dashboard  — Live trades + opportunities overview
 *   [2] Scorecard  — Full brain thesis per coin
 *   [3] Journal    — Trade journal with lessons
 *   [4] History    — Completed trades log
 *   [5] Scanner    — Top coins by volume × volatility
 *   [6] Memory     — Learning stats and patterns
 *   [p] Freeze     — Pause screen updates so you can scroll
 *   [q] Quit
 */

import { renderScoreCard, renderAccountSummary, Colors as C } from './scorecard.js';
import { readFileSync, existsSync } from 'fs';

const VIEW_KEYS = {
  '1': 'dashboard', '2': 'scorecard', '3': 'journal',
  '4': 'history', '5': 'scanner', '6': 'memory', '7': 'log',
};

const W = 66;

function hr(char = '─', color = C.dim) {
  return `${color}${char.repeat(W)}${C.reset}`;
}

function section(title) {
  return `\n${C.brightCyan}${C.bold}${title}${C.reset}\n${hr()}`;
}

export class Dashboard {
  constructor() {
    this.currentView = 'dashboard';
    this.running = false;
    this.frozen = false;
    this.data = {
      opportunities: [],
      accountState: null,
      completedTrades: [],
      memoryStats: null,
      memory: null,
      scanner: null,
      scanLog: [],
    };
    this._needsRedraw = true;
    this._lastRender = '';
  }

  start() {
    this.running = true;
    this.frozen = false;
    // NO alternate screen — use normal screen so Termux scrollback works
    process.stdout.write('\x1b[?25l'); // Hide cursor only

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (key) => this._handleKey(key));
    }

    this._needsRedraw = true;
    this.render();
  }

  stop() {
    this.running = false;
    if (process.stdin.isTTY && process.stdin.setRawMode) {
      process.stdin.setRawMode(false);
      process.stdin.pause();
    }
    process.stdout.write('\x1b[?25h'); // Show cursor
    // NO alternate screen restore — just reset colors
    process.stdout.write(C.reset + '\n');
  }

  _handleKey(key) {
    if (key === '\u0003' || key === 'q' || key === 'Q') {
      this.stop();
      return;
    }
    if (key === 'p' || key === 'P') {
      this.frozen = !this.frozen;
      if (this.frozen) {
        // Print freeze banner at bottom of current content
        // Don't reposition cursor — just print below current content
        process.stdout.write('\n' + C.brightYellow + C.bold + '  ⏸ FROZEN — screen paused, bot still running. Scroll up to read. Press [p] to resume.' + C.reset + '\n');
      } else {
        this._needsRedraw = true;
        this.render();
      }
      return;
    }
    const view = VIEW_KEYS[key];
    if (view) {
      this.currentView = view;
      this._needsRedraw = true;
      if (!this.frozen) this.render();
    }
  }

  update(data) {
    this.data = { ...this.data, ...data };
    // Only render if NOT frozen — this is the key for scrolling
    // When frozen, screen keeps whatever was displayed + the freeze banner
    // User can scroll the terminal's normal scrollback buffer
    if (!this.frozen) {
      this.render();
    }
  }

  render() {
    if (!this.running || this.frozen) return;
    const out = this._renderView();
    // Clear screen and write from top — no alternate screen
    // This overwrites in place, no waterfall
    process.stdout.write('\x1b[2J\x1b[H' + out);
    this._needsRedraw = false;
    this._lastRender = out;
  }

  _renderView() {
    const header = this._renderHeader();
    const nav = this._renderNav();
    let body = '';

    switch (this.currentView) {
      case 'dashboard': body = this._renderDashboard(); break;
      case 'scorecard': body = this._renderScorecardView(); break;
      case 'journal': body = this._renderJournal(); break;
      case 'history': body = this._renderHistory(); break;
      case 'scanner': body = this._renderScanner(); break;
      case 'memory': body = this._renderMemory(); break;
      case 'log': body = this._renderLog(); break;
      default: body = this._renderDashboard();
    }

    const footer = this._renderFooter();
    return header + nav + body + footer;
  }

  // ═══════════════════════════════════════════════════════════
  //  HEADER + NAV
  // ═══════════════════════════════════════════════════════════

  _renderHeader() {
    const acct = this.data.accountState;
    const bal = acct ? `$${acct.balance.toFixed(2)}` : 'N/A';
    const pnl = acct ? acct.totalPnL : 0;
    const pnlPct = acct ? acct.totalPnLPct : 0;
    const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
    const pnlColor = pnl >= 0 ? C.brightGreen : C.brightRed;
    const openCount = acct ? acct.openPositions.length : 0;
    const time = new Date().toUTCString().slice(17, 25);

    let h = '';
    h += `${C.brightMagenta}${C.bold}  🧪 ALCHEMIST BRAIN${C.reset}`;
    h += `  ${C.dim}${bal}${C.reset}`;
    h += `  ${pnlColor}${pnlStr} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%)${C.reset}`;
    h += `  ${C.brightCyan}Open:${openCount}${C.reset}`;
    h += `  ${C.dim}${time}${C.reset}`;
    if (this.frozen) h += `  ${C.brightYellow}⏸ FROZEN${C.reset}`;
    h += '\n';
    return h;
  }

  _renderNav() {
    const views = [
      ['1', 'Dashboard', 'dashboard'],
      ['2', 'Scorecard', 'scorecard'],
      ['3', 'Journal', 'journal'],
      ['4', 'History', 'history'],
      ['5', 'Scanner', 'scanner'],
      ['6', 'Memory', 'memory'],
      ['7', 'Log', 'log'],
    ];

    let line = '';
    for (const [key, label, view] of views) {
      const active = this.currentView === view;
      if (active) {
        line += `${C.bgMagenta}${C.brightWhite}${C.bold} [${key}] ${label} ${C.reset} `;
      } else {
        line += `${C.dim} [${key}] ${label} ${C.reset} `;
      }
    }
    line += ` ${C.brightYellow}[p] Freeze${C.reset}`;
    line += ` ${C.dim}[q] Quit${C.reset}`;
    line += '\n';
    line += hr() + '\n';
    return line;
  }

  // ═══════════════════════════════════════════════════════════
  //  [1] DASHBOARD
  // ═══════════════════════════════════════════════════════════

  _renderDashboard() {
    const L = [];
    const acct = this.data.accountState;

    if (!acct) {
      L.push(`  ${C.dim}Loading...${C.reset}\n`);
      return L.join('\n');
    }

    // ── Open Positions ───────────────────────────────────────
    L.push(section('📂 OPEN POSITIONS'));

    if (acct.openPositions.length === 0) {
      L.push(`  ${C.dim}No open positions. Scanning...${C.reset}`);
    } else {
      for (const p of acct.openPositions) {
        const dirColor = p.direction === 'LONG' ? C.brightGreen : C.brightRed;
        const dirSym = p.direction === 'LONG' ? '🟢' : '🔴';
        const pnlColor = p.pnlUSD >= 0 ? C.brightGreen : C.brightRed;
        const pnlStr = p.pnlUSD >= 0 ? `+${p.pnlUSD.toFixed(2)}` : `${p.pnlUSD.toFixed(2)}`;

        L.push(`  ${dirSym} ${C.brightWhite}${p.symbol}${C.reset} ${dirColor}${p.direction}${C.reset}  ${C.dim}Price${C.reset} ${C.white}${p.currentPrice?.toFixed(2) || 'N/A'}${C.reset}  ${C.dim}Entry${C.reset} ${C.dim}${p.entryPrice.toFixed(2)}${C.reset}`);
        L.push(`    ${C.dim}PnL${C.reset} ${pnlColor}${pnlStr} (${p.pnlPct >= 0 ? '+' : ''}${p.pnlPct.toFixed(2)}%)${C.reset}  ${C.dim}Stop${C.reset} ${C.brightRed}${p.stopLoss.toFixed(2)}${C.reset}  ${C.dim}Trail${C.reset} ${p.trailing ? C.brightYellow + 'YES' : C.dim + 'no'}${C.reset}  ${C.dim}TP1${C.reset} ${p.tp1Hit ? C.brightGreen + '✓' : C.dim + '—'}${C.reset}`);
      }
    }
    L.push('');

    // ── Top Opportunities ────────────────────────────────────
    L.push(section('🔍 TOP OPPORTUNITIES'));

    const opps = (this.data.opportunities || [])
      .filter((o) => o && o.conclusion)
      .sort((a, b) => (b.scores?.brainScore || 0) - (a.scores?.brainScore || 0))
      .slice(0, 5);

    if (opps.length === 0) {
      L.push(`  ${C.dim}Scanning for opportunities...${C.reset}`);
    } else {
      for (let i = 0; i < opps.length; i++) {
        const o = opps[i];
        const dec = o.conclusion.decision;
        const decSym = dec === 'ENTER' ? '🔴' : dec === 'WAIT' ? '🟡' : '⚪';
        const decColor = dec === 'ENTER' ? C.brightRed : dec === 'WAIT' ? C.brightYellow : C.dim;
        const dirColor = biasColor(o.conclusion.direction);

        L.push(`  ${C.bold}#${i + 1}${C.reset} ${C.brightWhite}${o.symbol}${C.reset} ${decColor}${decSym} ${dec.padEnd(7)}${C.reset} ${dirColor}${(o.conclusion.direction || '—').padEnd(8)}${C.reset} ${C.dim}S:${C.reset}${C.white}${o.scores?.brainScore || 0}${C.reset} ${C.dim}C:${C.reset}${C.white}${o.scores?.confidence || 0}${C.reset}`);
      }
      L.push(`  ${C.dim}Press [2] for full scorecard${C.reset}`);
    }
    L.push('');

    // ── Recent Activity ───────────────────────────────────────
    if (this.data.scanLog?.length > 0) {
      L.push(section('📋 RECENT ACTIVITY'));
      for (const entry of this.data.scanLog.slice(-5)) {
        L.push(`  ${C.dim}${entry}${C.reset}`);
      }
      L.push('');
    }

    return L.join('\n');
  }

  // ═══════════════════════════════════════════════════════════
  //  [2] SCORECARD — Full brain thesis
  // ═══════════════════════════════════════════════════════════

  _renderScorecardView() {
    const L = [];
    const acct = this.data.accountState;

    // Account summary line
    L.push(renderAccountSummary(acct, this.data.memoryStats));
    L.push('');

    // Show scorecards for top 3 opportunities + any open positions
    const opps = (this.data.opportunities || [])
      .filter((o) => o && o.conclusion)
      .sort((a, b) => (b.scores?.brainScore || 0) - (a.scores?.brainScore || 0));

    const shown = new Set();
    const toShow = [];

    // Prioritize: open positions first, then top opportunities
    if (acct?.openPositions) {
      for (const pos of acct.openPositions) {
        const opp = opps.find((o) => o.symbol === pos.symbol);
        if (opp && !shown.has(pos.symbol)) {
          toShow.push(opp);
          shown.add(pos.symbol);
        }
      }
    }

    // Then top opportunities (ENTER first, then WAIT)
    for (const opp of opps) {
      if (!shown.has(opp.symbol) && (opp.conclusion.decision === 'ENTER' || opp.conclusion.decision === 'WAIT')) {
        toShow.push(opp);
        shown.add(opp.symbol);
      }
      if (toShow.length >= 3) break;
    }

    if (toShow.length === 0 && opps.length > 0) {
      toShow.push(opps[0]);
    }

    if (toShow.length === 0) {
      L.push(`  ${C.dim}No opportunities to analyze yet. Scanning...${C.reset}`);
    } else {
      for (const opp of toShow) {
        L.push(renderScoreCard(opp));
      }
    }

    L.push(`\n  ${C.dim}Press [p] to freeze and scroll${C.reset}`);
    return L.join('\n');
  }

  // ═══════════════════════════════════════════════════════════
  //  [3] JOURNAL
  // ═══════════════════════════════════════════════════════════

  _renderJournal() {
    const L = [];
    L.push(section('📒 TRADE JOURNAL'));

    const trades = this.data.completedTrades || [];
    if (trades.length === 0) {
      L.push(`  ${C.dim}No trades yet. Journal populates as trades complete.${C.reset}`);
      return L.join('\n') + '\n';
    }

    for (const t of [...trades].reverse().slice(0, 8)) {
      const resColor = t.result === 'WIN' ? C.brightGreen : t.result === 'LOSS' ? C.brightRed : C.dim;
      const pnlStr = t.pnlUsd >= 0 ? `+${t.pnlUsd.toFixed(2)}` : `${t.pnlUsd.toFixed(2)}`;

      L.push(`  ${resColor}${C.bold}━━ ${t.result} ━━${C.reset} ${C.brightWhite}${t.symbol}${C.reset} ${resColor}${pnlStr} (${t.pnlPct.toFixed(2)}%)${C.reset} ${C.dim}${t.exitReason}${C.reset}`);

      if (t.thesis) {
        const lines = wrap(t.thesis, 62);
        L.push(`  ${C.dim}Thesis:${C.reset} ${C.white}${lines[0]}${C.reset}`);
        for (let i = 1; i < lines.length; i++) {
          L.push(`         ${C.white}${lines[i]}${C.reset}`);
        }
      }

      if (t.managementActions?.length > 0) {
        const types = [...new Set(t.managementActions.map((a) => a.type))];
        L.push(`  ${C.dim}Management:${C.reset} ${C.cyan}${types.join(' → ')}${C.reset}`);
      }
      L.push('');
    }

    return L.join('\n');
  }

  // ═══════════════════════════════════════════════════════════
  //  [4] HISTORY
  // ═══════════════════════════════════════════════════════════

  _renderHistory() {
    const L = [];
    L.push(section('📜 TRADE HISTORY'));

    const trades = this.data.completedTrades || [];
    if (trades.length === 0) {
      L.push(`  ${C.dim}No completed trades yet.${C.reset}`);
      return L.join('\n') + '\n';
    }

    // Summary
    const wins = trades.filter((t) => t.result === 'WIN');
    const losses = trades.filter((t) => t.result === 'LOSS');
    const totalPnL = trades.reduce((s, t) => s + (t.pnlUsd || 0), 0);
    const wr = trades.length > 0 ? ((wins.length / trades.length) * 100).toFixed(1) : '0';

    L.push(`  ${C.dim}Total${C.reset} ${C.white}${trades.length}${C.reset}  ${C.dim}W${C.reset} ${C.brightGreen}${wins.length}${C.reset}  ${C.dim}L${C.reset} ${C.brightRed}${losses.length}${C.reset}  ${C.dim}WR${C.reset} ${C.brightGreen}${wr}%${C.reset}  ${C.dim}PnL${C.reset} ${totalPnL >= 0 ? C.brightGreen : C.brightRed}$${totalPnL.toFixed(2)}${C.reset}`);
    L.push(hr());

    for (const t of [...trades].reverse()) {
      const r = t.result === 'WIN' ? C.brightGreen : t.result === 'LOSS' ? C.brightRed : C.dim;
      const d = t.direction === 'LONG' ? C.brightGreen : C.brightRed;
      const ps = t.pnlUsd >= 0 ? `+${t.pnlUsd.toFixed(2)}` : `${t.pnlUsd.toFixed(2)}`;

      const ps2 = t.pnlUsd >= 0 ? `+$${t.pnlUsd.toFixed(2)}` : `-$${Math.abs(t.pnlUsd).toFixed(2)}`;
      L.push(`  ${r}${t.result.padEnd(5)}${C.reset} ${C.brightWhite}${(t.symbol || '').padEnd(11)}${C.reset} ${d}${(t.direction || '').padEnd(5)}${C.reset} ${C.dim}in${C.reset} ${(t.entryPrice || 0).toFixed(2)} ${C.dim}out${C.reset} ${(t.exitPrice || 0).toFixed(2)} ${t.pnlPct >= 0 ? C.brightGreen : C.brightRed}${t.pnlPct >= 0 ? '+' : ''}${t.pnlPct.toFixed(2)}%${C.reset} ${t.pnlUsd >= 0 ? C.brightGreen : C.brightRed}${ps2}${C.reset} ${C.dim}${t.exitReason}${C.reset}`);
    }

    L.push('');
    return L.join('\n');
  }

  // ═══════════════════════════════════════════════════════════
  //  [5] SCANNER
  // ═══════════════════════════════════════════════════════════

  _renderScanner() {
    const L = [];
    L.push(section('📡 COIN SCANNER  —  Top 15 by Volume × Volatility'));

    const coins = this.data.scanner || [];
    if (coins.length === 0) {
      L.push(`  ${C.dim}Scanning for top coins...${C.reset}`);
      return L.join('\n') + '\n';
    }

    L.push(`  ${C.dim}#  Symbol       Volatility   24h Vol     24h Chg    Score${C.reset}`);
    L.push(hr());

    for (let i = 0; i < coins.length; i++) {
      const c = coins[i];
      const chgColor = c.priceChangePct >= 0 ? C.brightGreen : C.brightRed;
      const volColor = c.volatility > 5 ? C.brightYellow : c.volatility > 3 ? C.yellow : C.dim;

      L.push(`  ${C.bold}${(i + 1).toString().padEnd(3)}${C.reset} ${C.brightWhite}${(c.symbol || '').padEnd(12)}${C.reset} ${volColor}${(c.volatility || 0).toFixed(1).padStart(9)}%${C.reset}  ${(c.volumeStr || '').padStart(10)}  ${chgColor}${(c.priceChangePct >= 0 ? '+' : '')}${(c.priceChangePct || 0).toFixed(1).padStart(6)}%${C.reset}`);
    }

    L.push(`\n  ${C.dim}Rescans every 30 seconds${C.reset}`);
    return L.join('\n');
  }

  // ═══════════════════════════════════════════════════════════
  //  [6] MEMORY
  // ═══════════════════════════════════════════════════════════

  _renderMemory() {
    const L = [];
    L.push(section('🧠 MEMORY & LEARNING'));

    const ms = this.data.memoryStats;
    const mem = this.data.memory;

    if (!ms || ms.totalTrades === 0) {
      L.push(`  ${C.dim}No learning data yet. Memory builds as trades complete.${C.reset}`);
      return L.join('\n') + '\n';
    }

    // Stats
    L.push(`  ${C.brightWhite}${C.bold}Statistics${C.reset}`);
    L.push(`  ${C.dim}Trades${C.reset}    ${C.white}${ms.totalTrades}${C.reset}`);
    L.push(`  ${C.dim}Wins${C.reset}       ${C.brightGreen}${ms.wins}${C.reset}`);
    L.push(`  ${C.dim}Losses${C.reset}     ${C.brightRed}${ms.losses}${C.reset}`);
    L.push(`  ${C.dim}Win Rate${C.reset}   ${C.brightGreen}${((ms.wins / ms.totalTrades) * 100).toFixed(1)}%${C.reset}`);
    L.push(`  ${C.dim}Total PnL${C.reset}  ${ms.totalPnL >= 0 ? C.brightGreen : C.brightRed}$${ms.totalPnL.toFixed(2)}${C.reset}`);
    L.push(`  ${C.dim}Avg Win${C.reset}    ${C.brightGreen}+${ms.avgWinPct}%${C.reset}`);
    L.push(`  ${C.dim}Avg Loss${C.reset}   ${C.brightRed}${ms.avgLossPct}%${C.reset}`);

    // Management rules
    L.push('');
    L.push(`  ${C.brightWhite}${C.bold}Management Rules${C.reset}`);
    if (mem?.managementRules) {
      const r = mem.managementRules;
      L.push(`  ${C.dim}Stoploss${C.reset}    ${r.initialStoplossPct || 3}%`);
      L.push(`  ${C.dim}TP1 Target${C.reset} ${r.tp1Pct || 1.5}%`);
      L.push(`  ${C.dim}TP1 Sell${C.reset}    ${r.tp1SellPct || 30}%`);
      L.push(`  ${C.dim}Breakeven${C.reset}   ${r.breakevenAfterTP1 ? 'Yes' : 'No'}`);
      L.push(`  ${C.dim}Trail Start${C.reset} ${r.trailingStartPct || 2}%`);
      L.push(`  ${C.dim}Trail Step${C.reset}  ${r.trailingStepPct || 0.5}%`);

      if (r.adjustments?.length > 0) {
        L.push('');
        L.push(`  ${C.brightWhite}${C.bold}Learned Adjustments (${r.adjustments.length})${C.reset}`);
        for (const adj of r.adjustments.slice(-5)) {
          L.push(`  ${C.dim}•${C.reset} ${adj.result} (${adj.pnlPct > 0 ? '+' : ''}${adj.pnlPct}%)`);
          for (const obs of (adj.observations || [])) {
            L.push(`    ${C.yellow}${obs}${C.reset}`);
          }
        }
      }
    }

    // Patterns
    if (mem?.patterns) {
      const patterns = Object.entries(mem.patterns).filter(([_, p]) => p.sampleSize >= 1);
      if (patterns.length > 0) {
        L.push('');
        L.push(`  ${C.brightWhite}${C.bold}Patterns (${patterns.length})${C.reset}`);
        for (const [key, p] of patterns.slice(-8).reverse()) {
          const c = p.winRate >= 60 ? C.brightGreen : p.winRate <= 35 ? C.brightRed : C.dim;
          L.push(`  ${c}${p.winRate}%${C.reset} ${C.dim}(${p.sampleSize}T, ${p.avgPnL > 0 ? '+' : ''}${p.avgPnL}%)${C.reset}`);
        }
      }
    }

    L.push('');
    return L.join('\n');
  }

  // ═══════════════════════════════════════════════════════════
  //  [7] LOG — Scrollable event log
  // ═══════════════════════════════════════════════════════════

  _renderLog() {
    const L = [];
    L.push(section('📋 EVENT LOG  —  press [p] to freeze and scroll'));

    let logLines = [];
    try {
      if (existsSync('storage/bot.log')) {
        const content = readFileSync('storage/bot.log', 'utf-8');
        logLines = content.split('\n').filter(l => l.trim());
      }
    } catch {}

    if (logLines.length === 0) {
      L.push(`  ${C.dim}No events logged yet.${C.reset}`);
      return L.join('\n') + '\n';
    }

    // Show last 40 lines
    const recent = logLines.slice(-40);
    for (const line of recent) {
      L.push(`  ${C.dim}${line}${C.reset}`);
    }

    L.push(`\n  ${C.dim}${logLines.length} total events. Full log: storage/bot.log${C.reset}`);
    L.push(`  ${C.dim}Press [p] then scroll up to read older events.${C.reset}`);
    return L.join('\n');
  }

  // ═══════════════════════════════════════════════════════════
  //  FOOTER
  // ═══════════════════════════════════════════════════════════

  _renderFooter() {
    let f = `\n${hr()}\n`;
    f += `  ${C.dim}[1-7] Switch views${C.reset}  ${C.brightYellow}[p] Freeze${C.reset}  ${C.dim}[q] Quit${C.reset}`;
    if (this.frozen) f += `  ${C.brightYellow}⏸ FROZEN${C.reset}`;
    return f;
  }
}

function biasColor(bias) {
  if (bias === 'BULLISH' || bias === 'LONG' || bias === 'BULL') return C.brightGreen;
  if (bias === 'BEARISH' || bias === 'SHORT' || bias === 'BEAR') return C.brightRed;
  return C.dim;
}

function wrap(text, width = 60) {
  if (!text) return [''];
  const words = text.split(' ');
  const lines = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > width) {
      if (cur) lines.push(cur.trim());
      cur = w;
    } else {
      cur += ' ' + w;
    }
  }
  if (cur.trim()) lines.push(cur.trim());
  return lines.length > 0 ? lines : [text];
}
