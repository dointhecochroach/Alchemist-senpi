/**
 * Alchemist Brain — Terminal Dashboard
 *
 * Interactive TUI with keyboard navigation:
 *   [1] Dashboard  — Live trades overview (default)
 *   [2] Scorecard  — Full brain thesis for top opportunities
 *   [3] Journal    — Trade journal with lessons learned
 *   [4] History    — Completed trades log
 *   [5] Scanner    — Coin scanner showing top coins by volume × volatility
 *   [6] Memory     — Learning stats and pattern database
 *   [q] Quit
 *
 * Uses raw stdin for key capture. No external dependencies.
 */

import { renderScorecard } from './scorecard.js';

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', blink: '\x1b[5m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m', white: '\x1b[37m',
  bgRed: '\x1b[41m', bgGreen: '\x1b[42m', bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m', bgMagenta: '\x1b[45m', bgCyan: '\x1b[46m', bgBlack: '\x1b[40m',
  brightRed: '\x1b[91m', brightGreen: '\x1b[92m', brightYellow: '\x1b[93m',
  brightBlue: '\x1b[94m', brightMagenta: '\x1b[95m', brightCyan: '\x1b[96m', brightWhite: '\x1b[97m',
  // Cursor
  hide: '\x1b[?25l', show: '\x1b[?25h',
  clear: '\x1b[2J', clearLine: '\x1b[2K',
  home: '\x1b[H',
  // Alternate screen buffer — preserves scrollback when quitting
  altScreenOn: '\x1b[?1049h', altScreenOff: '\x1b[?1049l',
  // Selective line clear
  clearFromCursorDown: '\x1b[J',
  saveCursor: '\x1b7', restoreCursor: '\x1b8',
};

const VIEWS = ['dashboard', 'scorecard', 'journal', 'history', 'scanner', 'memory'];
const VIEW_KEYS = { '1': 'dashboard', '2': 'scorecard', '3': 'journal', '4': 'history', '5': 'scanner', '6': 'memory' };

export class Dashboard {
  constructor() {
    this.currentView = 'dashboard';
    this.running = false;
    this.data = {
      opportunities: [],
      accountState: null,
      completedTrades: [],
      memoryStats: null,
      memory: null,
      scanner: null,
      scanLog: [],
      journal: [],
    };
    this._stdin = null;
    this._needsFullRedraw = true;
    this._lastRender = '';
  }

  start() {
    this.running = true;
    // Use alternate screen buffer so we don't mess with scrollback
    process.stdout.write(C.altScreenOn);
    process.stdout.write(C.hide);

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding('utf8');
      this._stdin = process.stdin;
      this._stdin.on('data', (key) => {
        if (key === '\u0003' || key === 'q' || key === 'Q') {
          this.stop();
          return;
        }
        const view = VIEW_KEYS[key];
        if (view) {
          this.currentView = view;
          this._needsFullRedraw = true;
          this.render();
        }
      });
    }
    this._needsFullRedraw = true;
    this.render();
  }

  stop() {
    this.running = false;
    if (process.stdin.isTTY && process.stdin.setRawMode) {
      process.stdin.setRawMode(false);
      process.stdin.pause();
    }
    process.stdout.write(C.show);
    process.stdout.write(C.altScreenOff);
    process.stdout.write(C.reset);
  }

  update(data) {
    this.data = { ...this.data, ...data };
    this.render();
  }

  render() {
    if (!this.running) return;
    const out = this._renderView();
    if (this._needsFullRedraw) {
      // Full redraw — only on view switch or first render
      process.stdout.write(C.home + out);
      this._needsFullRedraw = false;
      this._lastRender = out;
    } else {
      // In-place update — move cursor to top-left, rewrite lines
      // No clear, just overwrite — prevents waterfall/flicker
      process.stdout.write(C.home + out);
      // Clear any leftover lines below
      const lineCount = out.split('\n').length;
      process.stdout.write(`\x1b[${lineCount + 1};1H` + C.clearFromCursorDown);
    }
  }

  _renderView() {
    const header = this._renderHeader();
    const nav = this._renderNav();
    let body = '';

    switch (this.currentView) {
      case 'dashboard': body = this._renderDashboard(); break;
      case 'scorecard': body = this._renderScorecard(); break;
      case 'journal': body = this._renderJournal(); break;
      case 'history': body = this._renderHistory(); break;
      case 'scanner': body = this._renderScanner(); break;
      case 'memory': body = this._renderMemory(); break;
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
    const balance = acct ? `$${acct.balance.toFixed(2)}` : 'N/A';
    const pnl = acct ? acct.totalPnL : 0;
    const pnlPct = acct ? acct.totalPnLPct : 0;
    const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
    const pnlColor = pnl >= 0 ? C.brightGreen : C.brightRed;
    const openCount = acct ? acct.openPositions.length : 0;
    const time = new Date().toUTCString().slice(17, 25);

    let line = '';
    line += `${C.brightMagenta}${C.bold}  🧪 ALCHEMIST BRAIN${C.reset}`;
    line += `  ${C.dim}│${C.reset}  ${C.brightWhite}Balance: ${balance}${C.reset}`;
    line += `  ${C.dim}│${C.reset}  ${pnlColor}PnL: ${pnlStr} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%)${C.reset}`;
    line += `  ${C.dim}│${C.reset}  ${C.brightCyan}Open: ${openCount}${C.reset}`;
    line += `  ${C.dim}│${C.reset}  ${C.dim}${time}${C.reset}`;
    line += '\n';
    return line;
  }

  _renderNav() {
    const views = [
      ['1', 'Dashboard', 'dashboard'],
      ['2', 'Scorecard', 'scorecard'],
      ['3', 'Journal', 'journal'],
      ['4', 'History', 'history'],
      ['5', 'Scanner', 'scanner'],
      ['6', 'Memory', 'memory'],
    ];

    let line = '  ';
    for (const [key, label, view] of views) {
      const active = this.currentView === view;
      if (active) {
        line += `${C.bgMagenta}${C.brightWhite}${C.bold} [${key}] ${label} ${C.reset} `;
      } else {
        line += `${C.dim} [${key}] ${label} ${C.reset} `;
      }
    }
    line += `  ${C.dim}│${C.reset}  ${C.dim}[q] Quit${C.reset}`;
    line += '\n';
    line += `${C.dim}  ${'─'.repeat(78)}${C.reset}\n`;
    return line;
  }

  // ═══════════════════════════════════════════════════════════
  //  [1] DASHBOARD — Live trades overview
  // ═══════════════════════════════════════════════════════════

  _renderDashboard() {
    const lines = [];
    const acct = this.data.accountState;

    if (!acct) {
      lines.push(`  ${C.dim}Loading...${C.reset}`);
      return lines.join('\n') + '\n';
    }

    // ── Open Positions ───────────────────────────────────────
    lines.push(`  ${C.brightCyan}${C.bold}OPEN POSITIONS${C.reset}\n`);

    if (acct.openPositions.length === 0) {
      lines.push(`  ${C.dim}No open positions. Scanning for opportunities...${C.reset}\n`);
    } else {
      // Table header
      lines.push(`  ${C.dim}Symbol     Dir       Price          Entry          PnL%       PnL$         Stop Loss      Trailing   TP1${C.reset}`);
      lines.push(`  ${C.dim}${'─'.repeat(100)}${C.reset}`);

      for (const p of acct.openPositions) {
        const dirColor = p.direction === 'LONG' ? C.brightGreen : C.brightRed;
        const dirSym = p.direction === 'LONG' ? '🟢' : '🔴';
        const pnlColor = p.pnlUSD >= 0 ? C.brightGreen : C.brightRed;
        const pnlStr = p.pnlUSD >= 0 ? `+${p.pnlUSD.toFixed(2)}` : `${p.pnlUSD.toFixed(2)}`;
        const trailStr = p.trailing ? `${C.brightYellow}YES${C.reset}` : `${C.dim}no${C.reset}`;
        const tp1Str = p.tp1Hit ? `${C.brightGreen}✓${C.reset}` : `${C.dim}—${C.reset}`;

        lines.push(
          `  ${C.brightWhite}${p.symbol.padEnd(10)}${C.reset} ` +
          `${dirColor}${dirSym} ${p.direction.padEnd(5)}${C.reset} ` +
          `${C.white}${p.currentPrice?.toFixed(4).padStart(14)}${C.reset} ` +
          `${C.dim}${p.entryPrice.toFixed(4).padStart(14)}${C.reset} ` +
          `${pnlColor}${p.pnlPct >= 0 ? '+' : ''}${p.pnlPct.toFixed(2).padStart(7)}%${C.reset} ` +
          `${pnlColor}${pnlStr.padStart(10)}${C.reset} ` +
          `${C.brightRed}${p.stopLoss.toFixed(4).padStart(14)}${C.reset} ` +
          `${trailStr.padEnd(10)} ` +
          `${tp1Str}`
        );
      }
    }

    // ── Top Opportunities Summary ────────────────────────────
    lines.push('');
    lines.push(`  ${C.brightYellow}${C.bold}TOP OPPORTUNITIES${C.reset}\n`);

    const opps = (this.data.opportunities || [])
      .filter((o) => o && o.conclusion)
      .sort((a, b) => (b.scores?.brainScore || 0) - (a.scores?.brainScore || 0))
      .slice(0, 5);

    if (opps.length === 0) {
      lines.push(`  ${C.dim}No opportunities yet...${C.reset}`);
    } else {
      lines.push(`  ${C.dim}#  Symbol      Decision  Direction  Score  Conf  Conflict${C.reset}`);
      lines.push(`  ${C.dim}${'─'.repeat(65)}${C.reset}`);

      for (let i = 0; i < opps.length; i++) {
        const o = opps[i];
        const dec = o.conclusion.decision;
        const decColor = dec === 'ENTER' ? C.brightRed : dec === 'WAIT' ? C.brightYellow : C.dim;
        const decSym = dec === 'ENTER' ? '🔴' : dec === 'WAIT' ? '🟡' : '⚪';
        const dirColor = o.conclusion.direction === 'BULLISH' ? C.brightGreen : o.conclusion.direction === 'BEARISH' ? C.brightRed : C.dim;

        lines.push(
          `  ${C.bold}${(i + 1).toString().padEnd(3)}${C.reset} ` +
          `${C.brightWhite}${o.symbol.padEnd(11)}${C.reset} ` +
          `${decColor}${decSym} ${dec.padEnd(7)}${C.reset} ` +
          `${dirColor}${(o.conclusion.direction || '—').padEnd(9)}${C.reset} ` +
          `${C.brightWhite}${(o.scores?.brainScore || 0).toString().padStart(5)}${C.reset} ` +
          `${C.brightWhite}${(o.scores?.confidence || 0).toString().padStart(5)}${C.reset} ` +
          `${C.dim}${(o.scores?.conflict || 0).toString().padStart(7)}${C.reset}`
        );
      }
    }

    // ── Quick Stats ──────────────────────────────────────────
    lines.push('');
    lines.push(`  ${C.brightBlue}${C.bold}QUICK STATS${C.reset}\n`);

    const ms = this.data.memoryStats;
    if (ms && ms.totalTrades > 0) {
      const winRate = ((ms.wins / ms.totalTrades) * 100).toFixed(1);
      lines.push(`  ${C.dim}Trades:${C.reset} ${C.white}${ms.totalTrades}${C.reset}  ${C.dim}Win Rate:${C.reset} ${C.brightGreen}${winRate}%${C.reset}  ${C.dim}Avg Win:${C.reset} ${C.brightGreen}+${ms.avgWinPct}%${C.reset}  ${C.dim}Avg Loss:${C.reset} ${C.brightRed}${ms.avgLossPct}%${C.reset}`);
    } else {
      lines.push(`  ${C.dim}No trades completed yet.${C.reset}`);
    }

    // ── Scan Log ─────────────────────────────────────────────
    if (this.data.scanLog && this.data.scanLog.length > 0) {
      lines.push('');
      lines.push(`  ${C.dim}Recent Activity:${C.reset}`);
      for (const entry of this.data.scanLog.slice(-5)) {
        lines.push(`  ${C.dim}  • ${entry}${C.reset}`);
      }
    }

    lines.push('');
    return lines.join('\n');
  }

  // ═══════════════════════════════════════════════════════════
  //  [2] SCORECARD — Full brain thesis
  // ═══════════════════════════════════════════════════════════

  _renderScorecard() {
    return renderScorecard(
      this.data.opportunities || [],
      this.data.accountState || {},
      this.data.completedTrades || [],
      this.data.memoryStats || {}
    ) + '\n';
  }

  // ═══════════════════════════════════════════════════════════
  //  [3] JOURNAL — Trade journal with lessons
  // ═══════════════════════════════════════════════════════════

  _renderJournal() {
    const lines = [];
    lines.push(`  ${C.brightCyan}${C.bold}📒 TRADE JOURNAL${C.reset}\n`);

    const trades = this.data.completedTrades || [];
    if (trades.length === 0) {
      lines.push(`  ${C.dim}No trades yet. The journal will populate as trades complete.${C.reset}`);
      lines.push(`  ${C.dim}Each entry records the thesis, what happened, and what was learned.${C.reset}\n`);
      return lines.join('\n');
    }

    // Show most recent first
    const recent = [...trades].reverse().slice(0, 10);

    for (const t of recent) {
      const resColor = t.result === 'WIN' ? C.brightGreen : t.result === 'LOSS' ? C.brightRed : C.dim;
      const pnlStr = t.pnlUsd >= 0 ? `+${t.pnlUsd.toFixed(2)}` : `${t.pnlUsd.toFixed(2)}`;
      const dirColor = t.direction === 'LONG' ? C.brightGreen : C.brightRed;

      lines.push(`  ${resColor}${C.bold}━━━ ${t.result} ━━━${C.reset} ${C.brightWhite}${t.symbol}${C.reset} ${dirColor}${t.direction}${C.reset} ${resColor}${pnlStr} (${t.pnlPct.toFixed(2)}%)${C.reset} ${C.dim}│ ${t.exitReason} │ ${(t.durationMin || 0)}min${C.reset}`);

      // Thesis
      if (t.thesis) {
        const thesisLines = this._wrap(t.thesis, 76);
        lines.push(`  ${C.dim}Thesis:${C.reset} ${C.white}${thesisLines[0]}${C.reset}`);
        for (let i = 1; i < thesisLines.length; i++) {
          lines.push(`         ${C.white}${thesisLines[i]}${C.reset}`);
        }
      }

      // Management actions
      if (t.managementActions && t.managementActions.length > 0) {
        const actionTypes = t.managementActions.map((a) => a.type);
        const unique = [...new Set(actionTypes)];
        lines.push(`  ${C.dim}Management:${C.reset} ${C.cyan}${unique.join(' → ')}${C.reset}`);
      }

      // Lesson (from memory adjustments)
      if (t.pattern) {
        lines.push(`  ${C.dim}Pattern:${C.reset} ${C.yellow}${t.pattern}${C.reset}`);
      }

      lines.push('');
    }

    return lines.join('\n');
  }

  // ═══════════════════════════════════════════════════════════
  //  [4] HISTORY — Completed trades log
  // ═══════════════════════════════════════════════════════════

  _renderHistory() {
    const lines = [];
    lines.push(`  ${C.brightCyan}${C.bold}📜 TRADE HISTORY${C.reset}\n`);

    const trades = this.data.completedTrades || [];
    if (trades.length === 0) {
      lines.push(`  ${C.dim}No completed trades yet.${C.reset}\n`);
      return lines.join('\n');
    }

    // Summary
    const wins = trades.filter((t) => t.result === 'WIN');
    const losses = trades.filter((t) => t.result === 'LOSS');
    const totalPnL = trades.reduce((s, t) => s + (t.pnlUsd || 0), 0);
    const winRate = trades.length > 0 ? ((wins.length / trades.length) * 100).toFixed(1) : '0';
    const avgWin = wins.length > 0 ? (wins.reduce((s, t) => s + t.pnlPct, 0) / wins.length).toFixed(2) : '0';
    const avgLoss = losses.length > 0 ? (losses.reduce((s, t) => s + t.pnlPct, 0) / losses.length).toFixed(2) : '0';

    lines.push(`  ${C.dim}Total:${C.reset} ${C.white}${trades.length}${C.reset}  ${C.dim}Wins:${C.reset} ${C.brightGreen}${wins.length}${C.reset}  ${C.dim}Losses:${C.reset} ${C.brightRed}${losses.length}${C.reset}  ${C.dim}Win Rate:${C.reset} ${C.brightGreen}${winRate}%${C.reset}  ${C.dim}Total PnL:${C.reset} ${totalPnL >= 0 ? C.brightGreen : C.brightRed}$${totalPnL.toFixed(2)}${C.reset}  ${C.dim}Avg Win:${C.reset} ${C.brightGreen}+${avgWin}%${C.reset}  ${C.dim}Avg Loss:${C.reset} ${C.brightRed}${avgLoss}%${C.reset}`);
    lines.push(`  ${C.dim}${'─'.repeat(100)}${C.reset}`);
    lines.push(`  ${C.dim}Symbol       Dir     Entry          Exit           PnL%      PnL$         Result   Exit Reason          Duration${C.reset}`);
    lines.push(`  ${C.dim}${'─'.repeat(100)}${C.reset}`);

    for (const t of [...trades].reverse()) {
      const resColor = t.result === 'WIN' ? C.brightGreen : t.result === 'LOSS' ? C.brightRed : C.dim;
      const dirColor = t.direction === 'LONG' ? C.brightGreen : C.brightRed;
      const pnlStr = t.pnlUsd >= 0 ? `+${t.pnlUsd.toFixed(2)}` : `${t.pnlUsd.toFixed(2)}`;
      const dur = t.durationMin || 0;

      lines.push(
        `  ${C.brightWhite}${(t.symbol || '').padEnd(12)}${C.reset} ` +
        `${dirColor}${(t.direction || '').padEnd(6)}${C.reset} ` +
        `${C.dim}${(t.entryPrice || 0).toFixed(4).padStart(14)}${C.reset} ` +
        `${C.white}${(t.exitPrice || 0).toFixed(4).padStart(14)}${C.reset} ` +
        `${t.pnlPct >= 0 ? C.brightGreen : C.brightRed}${(t.pnlPct >= 0 ? '+' : '')}${t.pnlPct.toFixed(2).padStart(6)}%${C.reset} ` +
        `${t.pnlPct >= 0 ? C.brightGreen : C.brightRed}${pnlStr.padStart(10)}${C.reset} ` +
        `${resColor}${(t.result || '').padEnd(8)}${C.reset} ` +
        `${C.dim}${(t.exitReason || '').padEnd(20)}${C.reset} ` +
        `${C.dim}${dur}min${C.reset}`
      );
    }

    lines.push('');
    return lines.join('\n');
  }

  // ═══════════════════════════════════════════════════════════
  //  [5] SCANNER — Top coins by volume × volatility
  // ═══════════════════════════════════════════════════════════

  _renderScanner() {
    const lines = [];
    lines.push(`  ${C.brightCyan}${C.bold}📡 COIN SCANNER${C.reset}  ${C.dim}— Top 15 by Volume × Volatility${C.reset}\n`);

    const scanner = this.data.scanner;
    if (!scanner || scanner.length === 0) {
      lines.push(`  ${C.dim}Scanning for top coins...${C.reset}\n`);
      return lines.join('\n');
    }

    lines.push(`  ${C.dim}#   Symbol       Price              24h Volume    Volatility   24h Change    Score${C.reset}`);
    lines.push(`  ${C.dim}${'─'.repeat(90)}${C.reset}`);

    for (let i = 0; i < scanner.length; i++) {
      const c = scanner[i];
      const changeColor = c.priceChangePct >= 0 ? C.brightGreen : C.brightRed;
      const volColor = c.volatility > 5 ? C.brightYellow : c.volatility > 3 ? C.yellow : C.dim;

      lines.push(
        `  ${C.bold}${(i + 1).toString().padEnd(4)}${C.reset} ` +
        `${C.brightWhite}${(c.symbol || '').padEnd(12)}${C.reset} ` +
        `${C.white}${(c.price || 0).toFixed(4).padStart(16)}${C.reset} ` +
        `${C.cyan}${(c.volumeStr || '').padStart(12)}${C.reset} ` +
        `${volColor}${(c.volatility || 0).toFixed(2).padStart(10)}%${C.reset} ` +
        `${changeColor}${(c.priceChangePct >= 0 ? '+' : '')}${(c.priceChangePct || 0).toFixed(2).padStart(8)}%${C.reset} ` +
        `${C.dim}${this._formatScore(c.score).padStart(10)}${C.reset}`
      );
    }

    lines.push('');
    lines.push(`  ${C.dim}Scanner re-ranks every 5 minutes. Currently monitoring ${scanner.length} coins.${C.reset}`);
    lines.push('');
    return lines.join('\n');
  }

  _formatScore(score) {
    if (score >= 1e12) return `${(score / 1e12).toFixed(1)}T`;
    if (score >= 1e9) return `${(score / 1e9).toFixed(1)}B`;
    if (score >= 1e6) return `${(score / 1e6).toFixed(1)}M`;
    if (score >= 1e3) return `${(score / 1e3).toFixed(1)}K`;
    return score.toFixed(0);
  }

  // ═══════════════════════════════════════════════════════════
  //  [6] MEMORY — Learning stats and patterns
  // ═══════════════════════════════════════════════════════════

  _renderMemory() {
    const lines = [];
    lines.push(`  ${C.brightCyan}${C.bold}🧠 MEMORY & LEARNING${C.reset}\n`);

    const ms = this.data.memoryStats;
    const mem = this.data.memory;

    if (!ms || ms.totalTrades === 0) {
      lines.push(`  ${C.dim}No learning data yet. Memory will populate as trades complete.${C.reset}`);
      lines.push(`  ${C.dim}The Brain learns from every trade — tracking patterns, adjusting${C.reset}`);
      lines.push(`  ${C.dim}management rules, and building a pattern database over time.${C.reset}\n`);
      return lines.join('\n');
    }

    // Stats
    lines.push(`  ${C.brightWhite}${C.bold}STATISTICS${C.reset}`);
    lines.push(`  ${C.dim}${'─'.repeat(50)}${C.reset}`);
    lines.push(`  ${C.dim}Total Trades:${C.reset}     ${C.white}${ms.totalTrades}${C.reset}`);
    lines.push(`  ${C.dim}Wins:${C.reset}              ${C.brightGreen}${ms.wins}${C.reset}`);
    lines.push(`  ${C.dim}Losses:${C.reset}            ${C.brightRed}${ms.losses}${C.reset}`);
    lines.push(`  ${C.dim}Win Rate:${C.reset}          ${C.brightGreen}${((ms.wins / ms.totalTrades) * 100).toFixed(1)}%${C.reset}`);
    lines.push(`  ${C.dim}Total PnL:${C.reset}         ${ms.totalPnL >= 0 ? C.brightGreen : C.brightRed}$${ms.totalPnL.toFixed(2)}${C.reset}`);
    lines.push(`  ${C.dim}Avg Win:${C.reset}           ${C.brightGreen}+${ms.avgWinPct}%${C.reset}`);
    lines.push(`  ${C.dim}Avg Loss:${C.reset}          ${C.brightRed}${ms.avgLossPct}%${C.reset}`);

    if (ms.bestSetup) {
      lines.push(`  ${C.dim}Best Setup:${C.reset}      ${C.brightGreen}${this._shortPattern(ms.bestSetup)}${C.reset}`);
    }
    if (ms.worstSetup) {
      lines.push(`  ${C.dim}Worst Setup:${C.reset}     ${C.brightRed}${this._shortPattern(ms.worstSetup)}${C.reset}`);
    }

    // Management rules
    lines.push('');
    lines.push(`  ${C.brightWhite}${C.bold}MANAGEMENT RULES${C.reset}`);
    lines.push(`  ${C.dim}${'─'.repeat(50)}${C.reset}`);

    if (mem && mem.managementRules) {
      const r = mem.managementRules;
      lines.push(`  ${C.dim}Initial Stoploss:${C.reset}    ${C.white}${r.initialStoplossPct || 3}%${C.reset}`);
      lines.push(`  ${C.dim}TP1 Target:${C.reset}         ${C.white}${r.tp1Pct || 3}%${C.reset}`);
      lines.push(`  ${C.dim}TP1 Sell:${C.reset}           ${C.white}${r.tp1SellPct || 30}%${C.reset}`);
      lines.push(`  ${C.dim}Breakeven after TP1:${C.reset} ${C.brightGreen}${r.breakevenAfterTP1 ? 'Yes' : 'No'}${C.reset}`);
      lines.push(`  ${C.dim}Trailing Start:${C.reset}     ${C.white}${r.trailingStartPct || 2}%${C.reset}`);
      lines.push(`  ${C.dim}Trailing Step:${C.reset}      ${C.white}${r.trailingStepPct || 0.5}%${C.reset}`);
      lines.push(`  ${C.dim}Max Trail Distance:${C.reset} ${C.white}${r.maxTrailingDistancePct || 3}%${C.reset}`);

      if (r.adjustments && r.adjustments.length > 0) {
        lines.push('');
        lines.push(`  ${C.brightWhite}${C.bold}LEARNED ADJUSTMENTS (${r.adjustments.length})${C.reset}`);
        lines.push(`  ${C.dim}${'─'.repeat(50)}${C.reset}`);
        for (const adj of r.adjustments.slice(-5)) {
          lines.push(`  ${C.dim}•${C.reset} ${C.white}${adj.result}${C.reset} ${C.dim}(${adj.pnlPct > 0 ? '+' : ''}${adj.pnlPct}%)${C.reset}`);
          for (const obs of (adj.observations || [])) {
            lines.push(`    ${C.yellow}${obs}${C.reset}`);
          }
        }
      }
    }

    // Patterns
    if (mem && mem.patterns) {
      const patternEntries = Object.entries(mem.patterns).filter(([_, p]) => p.sampleSize >= 1);
      if (patternEntries.length > 0) {
        lines.push('');
        lines.push(`  ${C.brightWhite}${C.bold}PATTERN DATABASE (${patternEntries.length} patterns)${C.reset}`);
        lines.push(`  ${C.dim}${'─'.repeat(50)}${C.reset}`);
        for (const [key, p] of patternEntries.slice(-10).reverse()) {
          const recColor = p.winRate >= 60 ? C.brightGreen : p.winRate <= 35 ? C.brightRed : C.dim;
          lines.push(`  ${recColor}${p.winRate}%${C.reset} ${C.dim}win (${p.sampleSize} trades, avg ${p.avgPnL > 0 ? '+' : ''}${p.avgPnL}%)${C.reset} ${C.dim}${this._shortPattern(key)}${C.reset}`);
        }
      }
    }

    lines.push('');
    return lines.join('\n');
  }

  _shortPattern(key) {
    // Shorten pattern key for display
    const parts = key.split('|');
    if (parts.length >= 3) {
      return `${parts[0]} ${parts[1]} | ${parts.slice(2, 5).join(' ')}`;
    }
    return key.slice(0, 50);
  }

  // ═══════════════════════════════════════════════════════════
  //  FOOTER
  // ═══════════════════════════════════════════════════════════

  _renderFooter() {
    return `\n${C.dim}  ${'─'.repeat(78)}${C.reset}\n${C.dim}  Press [1-6] to switch views · [q] to quit · Auto-updating${C.reset}`;
  }

  // ═══════════════════════════════════════════════════════════
  //  HELPERS
  // ═══════════════════════════════════════════════════════════

  _wrap(text, maxWidth) {
    if (!text) return ['N/A'];
    const words = text.split(' ');
    const lines = [];
    let current = '';
    for (const word of words) {
      if ((current + ' ' + word).trim().length > maxWidth) {
        if (current) lines.push(current.trim());
        current = word;
      } else {
        current += ' ' + word;
      }
    }
    if (current.trim()) lines.push(current.trim());
    return lines.length > 0 ? lines : [text];
  }
}

export { C as Colors };
