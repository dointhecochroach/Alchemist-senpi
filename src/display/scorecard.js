/**
 * Alchemist Brain — ANSI Scorecard Display
 *
 * Renders the full thought process in the terminal:
 *   - Smart Money Intelligence
 *   - SMC / Structure
 *   - Brain Thesis (primary, supporting, contradicting, counter, invalidation)
 *   - Memory
 *   - Conclusion (ENTER / WAIT / REJECT)
 *   - Up to 5 live/near-entry opportunities, continuously updating
 *   - Open positions with management status
 *   - Completed trades summary
 */

// ── ANSI colors ──────────────────────────────────────────────
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m',
  bgMagenta: '\x1b[45m',
  bgCyan: '\x1b[46m',
  bgBlack: '\x1b[40m',
  // Bright
  brightRed: '\x1b[91m',
  brightGreen: '\x1b[92m',
  brightYellow: '\x1b[93m',
  brightBlue: '\x1b[94m',
  brightMagenta: '\x1b[95m',
  brightCyan: '\x1b[96m',
  brightWhite: '\x1b[97m',
};

const SYMBOLS = {
  bullish: '🟢',
  bearish: '🔴',
  neutral: '⚪',
  enter: '🔴',
  wait: '🟡',
  reject: '⚪',
  check: '✓',
  cross: '✗',
  warn: '⚠',
  arrow: '→',
  down: '↓',
  up: '↑',
  diamond: '◆',
  square: '■',
  bullet: '●',
};

function colored(text, color) {
  return `${color}${text}${C.reset}`;
}

function box(text, color = C.cyan) {
  const line = '─'.repeat(Math.max(text.length + 4, 50));
  return `${color}┌${line}┐${C.reset}\n${color}│${C.reset} ${text.padEnd(Math.max(text.length + 3, 47))} ${color}│${C.reset}\n${color}└${line}┘${C.reset}`;
}

function section(title, color = C.cyan) {
  const line = '─'.repeat(62);
  return `\n${color}┌${line}┐${C.reset}\n${color}│${C.reset} ${C.bold}${title.padEnd(60)}${C.reset} ${color}│${C.reset}\n${color}└${line}┘${C.reset}`;
}

function kv(key, value, keyColor = C.dim, valColor = C.white) {
  return `  ${keyColor}${key.padEnd(28)}${C.reset} ${valColor}${value}${C.reset}`;
}

function biasColor(bias) {
  if (bias === 'BULLISH' || bias === 'LONG') return C.brightGreen;
  if (bias === 'BEARISH' || bias === 'SHORT') return C.brightRed;
  return C.dim;
}

function decisionSymbol(decision) {
  if (decision === 'ENTER') return SYMBOLS.enter;
  if (decision === 'WAIT') return SYMBOLS.wait;
  return SYMBOLS.reject;
}

function decisionColor(decision) {
  if (decision === 'ENTER') return C.brightRed; // Red = action
  if (decision === 'WAIT') return C.brightYellow;
  return C.dim;
}

// ──────────────────────────────────────────────────────────────
//  SCORECARD RENDERER
// ──────────────────────────────────────────────────────────────

export function renderScorecard(opportunities, accountState, completedTrades, memoryStats) {
  const lines = [];

  // ── Header ────────────────────────────────────────────────
  lines.push('');
  lines.push(colored('  ╔══════════════════════════════════════════════════════════════╗', C.brightMagenta));
  lines.push(colored('  ║', C.brightMagenta) + colored('          🧪 ALCHEMIST BRAIN — LIVE SCORECARD', C.bold + C.brightWhite) + colored('                  ║', C.brightMagenta));
  lines.push(colored('  ╚══════════════════════════════════════════════════════════════╝', C.brightMagenta));
  lines.push(`  ${C.dim}SMC → Smart Money → Technicals → Thesis → Counter → Memory → Risk → Decision${C.reset}`);
  lines.push(`  ${C.dim}Updated: ${new Date().toUTCString()}${C.reset}`);
  lines.push('');

  // ── Account Summary ───────────────────────────────────────
  lines.push(section('📊 ACCOUNT SUMMARY', C.brightBlue));
  const totalPnL = accountState.totalPnL || 0;
  const totalPnLPct = accountState.totalPnLPct || 0;
  const pnlColor = totalPnL >= 0 ? C.brightGreen : C.brightRed;
  const pnlStr = totalPnL >= 0 ? `+$${totalPnL.toFixed(2)}` : `-$${Math.abs(totalPnL).toFixed(2)}`;

  lines.push(kv('Paper Balance', `$${accountState.balance.toFixed(2)}`, C.dim, C.brightWhite));
  lines.push(kv('Total PnL', `${pnlStr} (${totalPnLPct >= 0 ? '+' : ''}${totalPnLPct.toFixed(2)}%)`, C.dim, pnlColor));
  lines.push(kv('Open Positions', `${accountState.openPositions.length}`, C.dim, C.white));
  lines.push(kv('Daily PnL', `${accountState.dailyPnL >= 0 ? '+' : ''}$${accountState.dailyPnL.toFixed(2)}`, C.dim, accountState.dailyPnL >= 0 ? C.green : C.red));

  if (memoryStats && memoryStats.totalTrades > 0) {
    const winRate = ((memoryStats.wins / memoryStats.totalTrades) * 100).toFixed(1);
    lines.push(kv('Trades Completed', `${memoryStats.totalTrades} (Win rate: ${winRate}%)`, C.dim, C.white));
    lines.push(kv('Avg Win / Loss', `${memoryStats.avgWinPct.toFixed(2)}% / ${memoryStats.avgLossPct.toFixed(2)}%`, C.dim, C.white));
  }

  lines.push('');

  // ── Open Positions ─────────────────────────────────────────
  if (accountState.openPositions.length > 0) {
    lines.push(section('📂 OPEN POSITIONS', C.brightCyan));
    for (const pos of accountState.openPositions) {
      const dirSym = pos.direction === 'LONG' ? SYMBOLS.bullish : SYMBOLS.bearish;
      const dirColor = biasColor(pos.direction);
      const pnlColor = pos.pnlUSD >= 0 ? C.brightGreen : C.brightRed;

      lines.push(`  ${dirColor}${dirSym} ${pos.symbol}${C.reset} ${C.dim}│${C.reset} ${dirColor}${pos.direction}${C.reset} ${C.dim}│${C.reset} Size: $${pos.size.toFixed(0)} ${C.dim}│${C.reset} PnL: ${pnlColor}${pos.pnlUSD >= 0 ? '+' : ''}$${pos.pnlUSD.toFixed(2)} (${pos.pnlPct.toFixed(2)}%)${C.reset}`);

      const tags = [];
      if (pos.tp1Hit) tags.push(colored('TP1 ✓', C.brightGreen));
      if (pos.trailing) tags.push(colored('TRAILING', C.brightYellow));
      if (pos.tp1Hit && !pos.trailing) tags.push(colored('BREAKEVEN', C.cyan));
      tags.push(colored(`SL: ${pos.stopLoss.toFixed(2)}`, C.dim));
      tags.push(colored(`Entry: ${pos.entryPrice.toFixed(2)}`, C.dim));
      lines.push(`    ${C.dim}${tags.join(' │ ')}${C.reset}`);
    }
    lines.push('');
  }

  // ── Live Opportunities (up to 5) ───────────────────────────
  lines.push(section('🔍 LIVE OPPORTUNITIES (Top 5)', C.brightYellow));
  lines.push('');

  const sorted = opportunities
    .filter((o) => o && o.conclusion)
    .sort((a, b) => (b.scores?.brainScore || 0) - (a.scores?.brainScore || 0))
    .slice(0, 5);

  if (sorted.length === 0) {
    lines.push(`  ${C.dim}No opportunities detected. Scanning...${C.reset}`);
  }

  for (let i = 0; i < sorted.length; i++) {
    const opp = sorted[i];
    lines.push(renderOpportunity(opp, i + 1));
  }

  // ── Recent Completed Trades ────────────────────────────────
  if (completedTrades && completedTrades.length > 0) {
    lines.push('');
    lines.push(section('📋 RECENT TRADES', C.dim));
    const recent = completedTrades.slice(-5).reverse();
    for (const t of recent) {
      const resColor = t.result === 'WIN' ? C.brightGreen : t.result === 'LOSS' ? C.brightRed : C.dim;
      const pnlStr = t.pnlUsd >= 0 ? `+$${t.pnlUsd.toFixed(2)}` : `-$${Math.abs(t.pnlUsd).toFixed(2)}`;
      lines.push(`  ${resColor}${t.result.padEnd(8)}${C.reset} ${C.dim}${t.symbol.padEnd(10)}${C.reset} ${biasColor(t.direction)}${t.direction.padEnd(5)}${C.reset} ${resColor}${pnlStr} (${t.pnlPct.toFixed(2)}%)${C.reset} ${C.dim}${t.exitReason}${C.reset}`);
    }
  }

  lines.push('');
  lines.push(colored('  ' + '─'.repeat(62), C.dim));
  lines.push(`  ${C.dim}Alchemist Brain v1.0 — Paper Trading Mode | Press Ctrl+C to stop${C.reset}`);
  lines.push('');

  return lines.join('\n');
}

// ──────────────────────────────────────────────────────────────
//  OPPORTUNITY RENDERER
// ──────────────────────────────────────────────────────────────

function renderOpportunity(opp, rank) {
  const lines = [];
  const decision = opp.conclusion.decision;
  const dir = opp.conclusion.direction || 'NEUTRAL';
  const decSym = decisionSymbol(decision);
  const decColor = decisionColor(decision);
  const dirColor = biasColor(dir);

  // Header line
  lines.push(`  ${C.bold}#${rank}${C.reset} ${C.brightWhite}${opp.symbol}${C.reset} ${C.dim}│${C.reset} ${decColor}${decSym} ${decision}${C.reset} ${C.dim}│${C.reset} ${dirColor}${dir}${C.reset} ${C.dim}│${C.reset} Score: ${C.brightWhite}${opp.scores?.brainScore || 0}${C.reset} ${C.dim}│${C.reset} Confidence: ${C.brightWhite}${opp.scores?.confidence || 0}${C.reset} ${C.dim}│${C.reset} Conflict: ${opp.scores?.conflict || 0}`);

  // Bias alignment row
  const smcBias = opp.primaryThesis?.smcBias || 'NEUTRAL';
  const smBias = opp.primaryThesis?.smartMoneyBias || 'NEUTRAL';
  const techBias = opp.primaryThesis?.technicalBias || 'NEUTRAL';
  lines.push(`  ${C.dim}SMC: ${biasColor(smcBias)}${smcBias}${C.reset} ${C.dim}│ SM: ${biasColor(smBias)}${smBias}${C.reset} ${C.dim}│ Tech: ${biasColor(techBias)}${techBias}${C.reset}${C.dim}`);

  // ── Smart Money Intelligence ──────────────────────────────
  if (opp.smartMoney) {
    const sm = opp.smartMoney;
    lines.push(`  ${C.cyan}🐋 SMART MONEY${C.reset}`);
    const fusion = sm.fusion;

    // Top traders
    lines.push(kv('Top Trader L/S', `${sm.topTraders.longPct}%L / ${sm.topTraders.shortPct}%S (ratio: ${sm.topTraders.ratio?.toFixed(2)})`, C.dim, biasColor(sm.topTraders.direction)));
    lines.push(kv('Top Trader Bias', `${sm.topTraders.direction}`, C.dim, biasColor(sm.topTraders.direction)));

    // Global
    lines.push(kv('Global Position', `${sm.global.longPct}%L / ${sm.global.shortPct}%S`, C.dim, biasColor(sm.global.direction)));

    // Derivatives
    lines.push(kv('Funding', `${sm.derivatives.funding.annualizedPct}% ann. (${sm.derivatives.funding.direction})`, C.dim, biasColor(sm.derivatives.funding.direction)));
    lines.push(kv('Open Interest', `${sm.derivatives.openInterest.changePct}% (${sm.derivatives.openInterest.trend})`, C.dim, C.white));
    lines.push(kv('Taker Flow', `${sm.derivatives.takerFlow.direction} (${sm.derivatives.takerFlow.avgBuySellRatio?.toFixed(3)})`, C.dim, biasColor(sm.derivatives.takerFlow.direction)));

    // Fusion
    lines.push(kv('Smart Money Bias', `${fusion.direction} (${fusion.strength}%)`, C.dim, biasColor(fusion.direction)));
    lines.push(kv('Flow Alignment', `${fusion.flowAlignment}`, C.dim, fusion.flowAlignment === 'STRONG' ? C.brightGreen : fusion.flowAlignment === 'MODERATE' ? C.yellow : C.dim));
  }

  // ── SMC / Structure ───────────────────────────────────────
  if (opp.smc) {
    const smc = opp.smc;
    lines.push(`  ${C.cyan}🏛 SMC / STRUCTURE${C.reset}`);

    lines.push(kv('Trend', `${smc.structure.bias} (${smc.structure.sequence})`, C.dim, biasColor(smc.structure.bias)));

    const bosStr = smc.bos.detected ? `${colored('✅', C.brightGreen)} ${smc.bos.direction} @ ${smc.bos.brokenLevel?.toFixed(2)} (${smc.bos.strength}%)` : `${colored('❌', C.dim)} NONE`;
    lines.push(kv('BOS', bosStr.replace(/\x1b\[[0-9;]*m/g, ''), C.dim, smc.bos.detected ? biasColor(smc.bos.direction) : C.dim));

    const chochStr = smc.choch.detected ? `${smc.choch.direction} @ ${smc.choch.brokenLevel?.toFixed(2)}` : `NONE`;
    lines.push(kv('CHOCH', chochStr, C.dim, smc.choch.detected ? biasColor(smc.choch.direction) : C.dim));

    const sweepStr = smc.liquidity.sweep ? `${smc.liquidity.sweep.direction} @ ${smc.liquidity.sweep.location} (${smc.liquidity.sweep.strength}%)` : `NONE`;
    lines.push(kv('Liquidity Sweep', sweepStr, C.dim, smc.liquidity.sweep ? (smc.liquidity.sweep.direction === 'ABOVE' ? C.brightRed : C.brightGreen) : C.dim));

    const fvgStr = smc.fvg.current ? `${smc.fvg.current.direction} (${smc.fvg.current.status}) @ ${smc.fvg.current.lowerBoundary?.toFixed(2)}-${smc.fvg.current.upperBoundary?.toFixed(2)}` : `NONE`;
    lines.push(kv('FVG', fvgStr, C.dim, smc.fvg.current ? biasColor(smc.fvg.current.direction) : C.dim));

    const dispStr = smc.displacement.detected ? `${smc.displacement.direction} (${smc.displacement.strength}%, ${smc.displacement.rangeRatio.toFixed(1)}x avg)` : `NONE`;
    lines.push(kv('Displacement', dispStr, C.dim, smc.displacement.detected ? biasColor(smc.displacement.direction) : C.dim));

    const bkStr = smc.breakout.detected ? `${smc.breakout.status} (${smc.breakout.direction})` : `NONE`;
    lines.push(kv('Breakout', bkStr, C.dim, smc.breakout.detected ? (smc.breakout.failed ? C.brightRed : C.brightGreen) : C.dim));

    // Protected levels
    if (smc.protectedLevels.protectedHigh) {
      lines.push(kv('Protected High', `${smc.protectedLevels.protectedHigh.price.toFixed(2)}`, C.dim, C.dim));
    }
    if (smc.protectedLevels.protectedLow) {
      lines.push(kv('Protected Low', `${smc.protectedLevels.protectedLow.price.toFixed(2)}`, C.dim, C.dim));
    }

    lines.push(kv('SMC Score', `${smc.smcScore}%`, C.dim, C.brightWhite));
  }

  // ── Technical Evidence ─────────────────────────────────
  if (opp.technical) {
    const tech = opp.technical;
    lines.push(`  ${C.cyan}📊 TECHNICAL EVIDENCE${C.reset}`);

    // RSI
    const rsiDir = tech.rsi.direction === 'RISING' ? '↑' : tech.rsi.direction === 'FALLING' ? '↓' : '→';
    const rsiBias = tech.rsi.momentumContext === 'BULLISH' || tech.rsi.momentumContext === 'OVERBOUGHT' ? 'BULLISH' :
                    tech.rsi.momentumContext === 'BEARISH' || tech.rsi.momentumContext === 'OVERSOLD' ? 'BEARISH' : 'NEUTRAL';
    lines.push(kv('RSI', `${tech.rsi.value} ${rsiDir} ${rsiBias} ${rsiBias !== 'NEUTRAL' ? '✓' : ''}`, C.dim, biasColor(rsiBias)));

    // Momentum
    const momDir = tech.momentum.direction === 'BULLISH' ? '↑' : tech.momentum.direction === 'BEARISH' ? '↓' : '→';
    const momStrength = tech.momentum.strength > 50 ? 'STRONG' : tech.momentum.strength > 25 ? 'MODERATE' : 'WEAK';
    lines.push(kv('Momentum', `${momDir} ${tech.momentum.shortTerm.toFixed(2)} ${momStrength} ${momStrength !== 'WEAK' ? '✓' : ''}`, C.dim, biasColor(tech.momentum.direction)));

    // Momentum acceleration
    const accelDir = tech.momentum.accelerationDirection;
    const accelSym = accelDir === 'ACCELERATING' ? '-++' : accelDir === 'DECELERATING' ? '- --' : '→';
    const accelBias = accelDir === 'ACCELERATING' ? tech.momentum.direction : 'NEUTRAL';
    lines.push(kv('Momentum Change', `${accelSym} ${accelDir} ${accelBias !== 'NEUTRAL' ? '✓' : ''}`, C.dim, biasColor(accelBias)));

    // Volume
    const volBias = tech.volume.expansion === 'EXPANDING' ? tech.momentum.direction :
                    tech.volume.expansion === 'ELEVATED' ? tech.momentum.direction : 'NEUTRAL';
    lines.push(kv('Volume', `${tech.volume.ratio}x avg ${tech.volume.expansion} ${volBias !== 'NEUTRAL' ? '✓' : ''}`, C.dim, biasColor(volBias)));

    // 5m Trend
    const trendBias = tech.trend.direction;
    const trendStrength = tech.trend.strength > 60 ? 'STRONG' : tech.trend.strength > 30 ? 'MODERATE' : 'WEAK';
    lines.push(kv('5m Trend', `${trendBias} ${trendStrength} ${trendStrength !== 'WEAK' ? '✓' : ''}`, C.dim, biasColor(trendBias)));
    lines.push(kv('MA Alignment', tech.trend.alignment.replace('_', ' ').toLowerCase(), C.dim, C.dim));

    // Regime
    const regimeBias = tech.regime.classification.includes('BULL') ? 'BULLISH' :
                       tech.regime.classification.includes('BEAR') ? 'BEARISH' : 'NEUTRAL';
    lines.push(kv('Regime', `${tech.regime.classification.replace('_', ' ')} ${regimeBias !== 'NEUTRAL' ? '✓' : ''}`, C.dim, biasColor(regimeBias)));

    // Volatility
    lines.push(kv('Volatility', `${tech.volatility.pct}% (${tech.volatility.direction})`, C.dim, C.dim));

    // Technical conclusion
    lines.push(kv('Tech Supporting', `${tech.supportingCount} observations`, C.dim, C.brightGreen));
    lines.push(kv('Tech Contradictions', `${tech.contradictingCount} opposing`, C.dim, tech.contradictingCount > 0 ? C.brightRed : C.dim));
    lines.push(kv('Technical Conclusion', `${tech.technicalBias} (${tech.technicalScore}% conviction)`, C.dim, biasColor(tech.technicalBias)));
  }

  // ── Brain Thesis ──────────────────────────────────────────
  lines.push(`  ${C.brightMagenta}🧠 BRAIN THESIS${C.reset}`);

  // Primary thesis
  lines.push(`  ${C.dim}PRIMARY THESIS:${C.reset}`);
  const thesisLines = wrapText(opp.primaryThesis?.narrative || 'N/A', 58);
  for (const tl of thesisLines) {
    lines.push(`    ${C.white}${tl}${C.reset}`);
  }

  // Supporting evidence
  lines.push(`  ${C.dim}SUPPORTING:${C.reset}`);
  if (opp.supporting && opp.supporting.length > 0) {
    for (const e of opp.supporting.slice(0, 10)) {
      const sym = e.source === 'SMC' ? '🏛' : e.source === 'Smart Money' ? '🐋' : e.source === 'Technical' ? '📊' : '●';
      lines.push(`    ${C.brightGreen}${SYMBOLS.check}${C.reset} ${C.dim}${sym}${C.reset} ${C.white}${e.item}${C.reset}`);
    }
  } else {
    lines.push(`    ${C.dim}No supporting evidence${C.reset}`);
  }

  // Contradicting evidence
  lines.push(`  ${C.dim}CONTRADICTING:${C.reset}`);
  if (opp.contradicting && opp.contradicting.length > 0) {
    for (const e of opp.contradicting.slice(0, 8)) {
      const sym = e.source === 'SMC' ? '🏛' : e.source === 'Smart Money' ? '🐋' : e.source === 'Technical' ? '📊' : '●';
      lines.push(`    ${C.brightRed}${SYMBOLS.cross}${C.reset} ${C.dim}${sym}${C.reset} ${C.white}${e.item}${C.reset}`);
    }
  } else {
    lines.push(`    ${C.dim}No contradicting evidence${C.reset}`);
  }

  // Counter-thesis
  lines.push(`  ${C.dim}ALTERNATIVE:${C.reset}`);
  const counterLines = wrapText(opp.counterThesis?.narrative || 'N/A', 58);
  for (const cl of counterLines) {
    lines.push(`    ${C.yellow}${cl}${C.reset}`);
  }

  // Invalidation
  lines.push(`  ${C.dim}INVALIDATION:${C.reset}`);
  const invLines = wrapText(opp.primaryThesis?.invalidation || 'N/A', 58);
  for (const il of invLines) {
    lines.push(`    ${C.brightRed}${il}${C.reset}`);
  }

  // Memory
  if (opp.memory) {
    lines.push(`  ${C.dim}MEMORY:${C.reset}`);
    const memLines = wrapText(opp.memory.notes || 'No historical data.', 58);
    for (const ml of memLines) {
      lines.push(`    ${C.cyan}${ml}${C.reset}`);
    }
    if (opp.memory.found) {
      lines.push(`    ${C.dim}Win rate: ${opp.memory.winRate}% over ${opp.memory.sampleSize} trades → ${opp.memory.recommendation}${C.reset}`);
    }
  }

  // Conclusion
  lines.push(`  ${C.dim}CONCLUSION:${C.reset}`);
  const conclLines = wrapText(opp.conclusion?.reason || 'N/A', 58);
  for (const cl of conclLines) {
    lines.push(`    ${decColor}${cl}${C.reset}`);
  }

  lines.push(`  ${C.dim}DECISION:${C.reset} ${decColor}${C.bold}${decSym} ${decision}${C.reset} ${C.dim}│${C.reset} ${C.dim}Score: ${opp.scores?.brainScore || 0} │ Confidence: ${opp.scores?.confidence || 0} │ Conflict: ${opp.scores?.conflict || 0}${C.reset}`);

  lines.push(`  ${C.dim}${'─'.repeat(62)}${C.reset}`);

  return lines.join('\n');
}

// ──────────────────────────────────────────────────────────────
//  HELPERS
// ──────────────────────────────────────────────────────────────

function wrapText(text, maxWidth) {
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

export { C as Colors };
