/**
 * Alchemist Brain — Scorecard Renderer
 *
 * Formatted to match the exact scorecard layout:
 *   Header → SMC → Breakout/Trap → Squeeze → Momentum → Smart Money
 *   → Regime → Confluence bars → Brain Verdict → Analysis
 */

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m', white: '\x1b[37m',
  brightRed: '\x1b[91m', brightGreen: '\x1b[92m', brightYellow: '\x1b[93m',
  brightBlue: '\x1b[94m', brightMagenta: '\x1b[95m', brightCyan: '\x1b[96m', brightWhite: '\x1b[97m',
};

const W = 64; // Fixed width for all sections

function line(char = '─') {
  return C.dim + char.repeat(W) + C.reset;
}

function doubleLine() {
  return C.brightMagenta + '═'.repeat(W) + C.reset;
}

function section(title) {
  return `\n${C.cyan}${title}${C.reset}\n${line()}`;
}

function kv(key, value, valColor = C.white) {
  const k = (key || '').padEnd(22);
  return `  ${C.dim}${k}${C.reset} ${valColor}${value}${C.reset}`;
}

function kvCheck(key, value, ok) {
  const sym = ok ? `${C.brightGreen}✅${C.reset}` : `${C.dim}❌${C.reset}`;
  const k = (key || '').padEnd(22);
  return `  ${C.dim}${k}${C.reset} ${sym} ${C.white}${value}${C.reset}`;
}

function biasC(bias) {
  if (bias === 'BULLISH' || bias === 'LONG' || bias === 'BULL') return C.brightGreen;
  if (bias === 'BEARISH' || bias === 'SHORT' || bias === 'BEAR') return C.brightRed;
  return C.dim;
}

function bar(pct) {
  const filled = Math.round(pct / 10);
  const empty = 10 - filled;
  return `${C.brightCyan}${'█'.repeat(filled)}${C.dim}${'░'.repeat(empty)}${C.reset} ${pct}%`;
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

/**
 * Render the full scorecard for one opportunity.
 */
export function renderScoreCard(opp) {
  const L = [];
  const dir = opp.conclusion?.direction || 'NEUTRAL';
  const dirColor = biasC(dir);
  const sym = opp.symbol || '???';
  const score = opp.scores?.brainScore || 0;
  const conf = opp.scores?.confidence || 0;
  const conflict = opp.scores?.conflict || 0;
  const smc = opp.smc;
  const sm = opp.smartMoney;
  const tech = opp.technical;

  // ── HEADER ───────────────────────────────────────────────
  L.push('');
  L.push(doubleLine());
  L.push(`  ${C.brightWhite}${C.bold}${sym}${C.reset} · ${dirColor}${C.bold}${dir}${C.reset}`);
  L.push(`  ${C.dim}Brain Score${C.reset} ${C.brightWhite}${C.bold}${score}${C.reset}${C.dim} / 100${C.reset}`);
  
  // Confidence level
  let confLabel = 'LOW';
  let confColor = C.dim;
  if (conf >= 75) { confLabel = 'HIGH'; confColor = C.brightGreen; }
  else if (conf >= 50) { confLabel = 'MEDIUM'; confColor = C.brightYellow; }
  L.push(`  ${C.dim}Confidence${C.reset}     ${confColor}${confLabel}${C.reset}`);
  
  // Verdict
  const dec = opp.conclusion?.decision || 'WAIT';
  const decSym = dec === 'ENTER' ? '🔴' : dec === 'WAIT' ? '🟡' : '⚪';
  const decColor = dec === 'ENTER' ? C.brightRed : dec === 'WAIT' ? C.brightYellow : C.dim;
  const dirLabel = dir === 'BULLISH' ? 'LONG' : dir === 'BEARISH' ? 'SHORT' : 'NEUTRAL';
  L.push(`  ${C.dim}Verdict${C.reset}        ${decColor}${decSym} ${dec} ${dirLabel}${C.reset}`);
  
  // Setup type
  const setupType = _getSetupType(smc, tech);
  L.push(`  ${C.dim}Setup${C.reset}          ${C.brightCyan}${setupType}${C.reset}`);
  L.push(doubleLine());

  // ── SMC / MARKET STRUCTURE ───────────────────────────────
  L.push(section('🏛 SMC / MARKET STRUCTURE'));
  if (smc) {
    L.push(kv('Trend', smc.structure?.bias || 'N/A', biasC(smc.structure?.bias)));
    L.push(kv('Market Structure', smc.structure?.bias || 'N/A', biasC(smc.structure?.bias)));
    L.push(kvCheck('BOS', smc.bos?.detected ? `${smc.bos.direction} CONFIRMED` : 'NONE', smc.bos?.detected));
    L.push(kvCheck('CHOCH', smc.choch?.detected ? smc.choch.direction : 'NONE', smc.choch?.detected));
    L.push(kv('Swing Structure', smc.structure?.sequence || 'N/A'));
    if (smc.liquidity?.sweep) {
      L.push(kvCheck('Liquidity Sweep', `${smc.liquidity.sweep.direction} @ ${smc.liquidity.sweep.location}`, true));
    } else {
      L.push(kvCheck('Liquidity Sweep', 'NONE', false));
    }
    if (smc.liquidity?.liquidityTargets?.[0]) {
      const t = smc.liquidity.liquidityTargets[0];
      L.push(kv('Liquidity Target', `${t.direction} @ ${t.level.toFixed(2)}`, biasC(t.direction === 'UP' ? 'BULLISH' : 'BEARISH')));
    }
    if (smc.fvg?.current) {
      L.push(kv('FVG', `${smc.fvg.current.direction}`, biasC(smc.fvg.current.direction)));
      L.push(kv('FVG Status', smc.fvg.current.status));
    } else {
      L.push(kv('FVG', 'NONE'));
    }
    L.push(kvCheck('Displacement', smc.displacement?.detected ? `${smc.displacement.direction} (${smc.displacement.strength}%)` : 'NONE', smc.displacement?.detected));
  }
  // Order book liquidity
  if (smc.orderBookLiquidity) {
    const ob = smc.orderBookLiquidity;
    L.push(kv('Order Book', `${ob.direction} (${(ob.imbalance * 100).toFixed(0)}% bid)`));
    L.push(kv('Bid/Ask Vol', `${ob.totalBidVolume} / ${ob.totalAskVolume}`));
  }
  // Whale trades
  if (smc.whaleTrades) {
    const wt = smc.whaleTrades;
    L.push(kv('Whale Trades', `${wt.largeTradeCount} large (${wt.largeBuys}B / ${wt.largeSells}S)`));
    L.push(kv('Whale Flow', `${wt.direction} (net ${wt.netFlow})`));
  }
  L.push(line());

  // ── BREAKOUT / TRAP ──────────────────────────────────────
  L.push(section('💥 BREAKOUT / TRAP'));
  if (smc?.breakout?.detected) {
    const bk = smc.breakout;
    L.push(kvCheck('Breakout', `${bk.direction}`, true));
    L.push(kv('Breakout Strength', `${bk.strength}%`));
    L.push(kvCheck('Retest', bk.retest ? 'YES' : 'NO', bk.retest));
    L.push(kvCheck('Retest Held', bk.retestHeld ? 'YES' : 'NO', bk.retestHeld));
    L.push(kvCheck('False Breakout', bk.failed ? 'YES' : 'NO', bk.failed));
    if (bk.failed) {
      const trapType = bk.direction === 'BULLISH' ? '🐻 BULL TRAP' : '🐻 BEAR TRAP';
      L.push(kv('Trap Type', trapType));
    }
  } else {
    L.push(kv('Breakout', 'NONE'));
  }
  L.push(line());

  // ── SQUEEZE / VOLATILITY ─────────────────────────────────
  L.push(section('🔥 SQUEEZE / VOLATILITY'));
  if (tech?.volatility) {
    const v = tech.volatility;
    L.push(kv('Volatility', `${v.pct}% (${v.expansion})`));
    L.push(kv('Vol Direction', v.direction));
    if (v.direction === 'CONTRACTING') {
      L.push(kvCheck('Squeeze', 'ACTIVE', true));
      L.push(kv('Compression', `${100 - Math.round(v.pct * 20)}%`));
    } else if (v.direction === 'EXPANDING') {
      L.push(kvCheck('Expansion', 'CONFIRMED', true));
      L.push(kv('Expansion Dir', tech.momentum?.direction || 'N/A', biasC(tech.momentum?.direction)));
    } else {
      L.push(kv('Squeeze', 'NONE'));
    }
  }
  L.push(line());

  // ── MOMENTUM / FLOW ──────────────────────────────────────
  L.push(section('📊 MOMENTUM / FLOW'));
  if (tech) {
    L.push(kv('RSI', `${tech.rsi?.value || 'N/A'}`, C.white));
    const rsiDir = tech.rsi?.direction === 'RISING' ? '↑' : tech.rsi?.direction === 'FALLING' ? '↓' : '→';
    L.push(kv('RSI Direction', rsiDir));
    const momStr = tech.momentum?.strength > 50 ? 'STRONG' : tech.momentum?.strength > 25 ? 'MODERATE' : 'WEAK';
    L.push(kv('Momentum', `${momStr} ${tech.momentum?.direction || ''}`, biasC(tech.momentum?.direction)));
    const accelSym = tech.momentum?.accelerationDirection === 'ACCELERATING' ? '-++' : tech.momentum?.accelerationDirection === 'DECELERATING' ? '- --' : '→';
    L.push(kv('Momentum Change', accelSym));
    L.push(kv('Volume', `${tech.volume?.ratio || 0}x average`));
    L.push(kvCheck('Volume Expansion', tech.volume?.expansion === 'EXPANDING' || tech.volume?.expansion === 'ELEVATED' ? 'YES' : 'NO', tech.volume?.expansion === 'EXPANDING' || tech.volume?.expansion === 'ELEVATED'));
  }
  if (sm?.derivatives) {
    L.push(kv('Taker Flow', `${sm.derivatives.takerFlow?.avgBuySellRatio?.toFixed(2) || 'N/A'}`, biasC(sm.derivatives.takerFlow?.direction)));
    L.push(kv('Derivatives', `${sm.derivatives.contribution?.toFixed(2) || 'N/A'}`, biasC(sm.derivatives.contribution > 0 ? 'BULLISH' : sm.derivatives.contribution < 0 ? 'BEARISH' : 'NEUTRAL')));
  }
  L.push(line());

  // ── SMART MONEY ──────────────────────────────────────────
  L.push(section('🐋 SMART MONEY'));
  if (sm) {
    L.push(kv('Whale Bias', `${sm.topTraders?.bias?.toFixed(2) || 'N/A'} ${sm.topTraders?.direction === 'BEARISH' ? '🔴' : sm.topTraders?.direction === 'BULLISH' ? '🟢' : '⚪'}`, biasC(sm.topTraders?.direction)));
    L.push(kv('Top Trader Bias', `${sm.topTraders?.longPct || 0}%L / ${sm.topTraders?.shortPct || 0}%S`, biasC(sm.topTraders?.direction)));
    L.push(kv('Smart Money', `${sm.fusion?.direction || 'N/A'} (${sm.fusion?.strength || 0}%)`, biasC(sm.fusion?.direction)));
    L.push(kv('Flow Alignment', sm.fusion?.flowAlignment || 'N/A', sm.fusion?.flowAlignment === 'STRONG' ? C.brightGreen : sm.fusion?.flowAlignment === 'MODERATE' ? C.brightYellow : C.dim));
  }
  L.push(line());

  // ── MARKET REGIME ────────────────────────────────────────
  L.push(section('🌡 MARKET REGIME'));
  if (tech?.regime) {
    L.push(kv('Regime', tech.regime.classification?.replace('_', ' ') || 'N/A', biasC(tech.regime.classification?.includes('BULL') ? 'BULLISH' : tech.regime.classification?.includes('BEAR') ? 'BEARISH' : 'NEUTRAL')));
    L.push(kv('Volatility', tech.volatility?.expansion || 'N/A'));
    L.push(kv('Trend Quality', `${tech.trend?.strength || 0}%`));
  }
  L.push(line());

  // ── CONFLUENCE ───────────────────────────────────────────
  L.push(section('🎯 CONFLUENCE'));
  if (smc) L.push(kv('SMC', bar(smc.smcScore || 0)));
  if (smc?.breakout?.detected) L.push(kv('Breakout', bar(smc.breakout.strength || 0)));
  if (smc?.liquidity?.sweep) L.push(kv('Liquidity', bar(smc.liquidity.sweep.strength || 0)));
  if (tech?.technicalDirection) L.push(kv('Momentum', bar(tech.technicalDirection.conviction || 0)));
  if (tech?.volume) L.push(kv('Volume', bar(Math.min(100, Math.round((tech.volume.ratio || 1) * 35))) ));
  if (sm?.fusion) L.push(kv('Smart Money', bar(sm.fusion.strength || 0)));
  if (tech?.volatility?.direction === 'EXPANDING') L.push(kv('Squeeze', bar(90)));

  const bullPct = Math.round((opp.supporting?.filter(e => e.direction !== 'BEARISH').length || 0) / Math.max(1, (opp.supporting?.length || 1)) * 100);
  const bearPct = 100 - bullPct;
  L.push('');
  L.push(`  ${C.brightGreen}Bull Evidence ${bullPct}%${C.reset}  ${C.brightRed}Bear Evidence ${bearPct}%${C.reset}`);
  L.push(`  ${C.dim}Conflict${C.reset} ${conflict < 20 ? C.brightGreen + 'LOW' : conflict < 40 ? C.brightYellow + 'MEDIUM' : C.brightRed + 'HIGH'}${C.reset}`);

  // ── BRAIN VERDICT ────────────────────────────────────────
  L.push('');
  L.push(doubleLine());
  L.push(`  ${C.brightMagenta}${C.bold}🧠 BRAIN VERDICT${C.reset}`);
  L.push('');

  // Verdict chain
  const chain = _buildVerdictChain(smc, sm, tech, dir);
  for (const c of chain) {
    L.push(`  ${C.white}${c}${C.reset}`);
  }

  L.push('');
  L.push(`  ${C.dim}Score${C.reset}             ${C.brightWhite}${C.bold}${score}${C.reset}${C.dim} / 100${C.reset}`);
  L.push(`  ${C.dim}Confidence${C.reset}       ${confColor}${confLabel}${C.reset}`);
  const quality = score >= 85 ? 'A+' : score >= 75 ? 'A' : score >= 65 ? 'B' : score >= 50 ? 'C' : 'D';
  L.push(`  ${C.dim}Setup Quality${C.reset}    ${C.brightCyan}${quality}${C.reset}`);

  // ── ANALYSIS ─────────────────────────────────────────────
  L.push('');
  L.push(`  ${C.brightWhite}${C.bold}Analysis${C.reset}`);
  L.push(`  ${line('─')}`);
  const analysis = _buildAnalysis(opp, smc, sm, tech, dir, dec);
  for (const a of wrap(analysis, 60)) {
    L.push(`  ${C.white}${a}${C.reset}`);
  }

  // Counter-thesis
  if (opp.counterThesis?.narrative) {
    L.push('');
    L.push(`  ${C.brightYellow}⚠ Counter-thesis${C.reset}`);
    for (const a of wrap(opp.counterThesis.narrative, 60)) {
      L.push(`  ${C.yellow}${a}${C.reset}`);
    }
  }

  // Invalidation
  if (opp.primaryThesis?.invalidation) {
    L.push('');
    L.push(`  ${C.dim}Invalidation${C.reset}`);
    for (const a of wrap(opp.primaryThesis.invalidation, 60)) {
      L.push(`  ${C.brightRed}${a}${C.reset}`);
    }
  }

  // Memory
  if (opp.memory?.found) {
    L.push('');
    L.push(`  ${C.dim}Memory${C.reset} ${C.cyan}${opp.memory.winRate}% win rate over ${opp.memory.sampleSize} trades → ${opp.memory.recommendation}${C.reset}`);
  }

  L.push(doubleLine());
  L.push('');

  return L.join('\n');
}

function _getSetupType(smc, tech) {
  const parts = [];
  if (smc?.breakout?.failed) parts.push('FAILED BREAKOUT');
  if (smc?.liquidity?.sweep) parts.push('LIQUIDITY SWEEP');
  if (smc?.bos?.detected) parts.push('BOS');
  if (smc?.choch?.detected) parts.push('CHOCH');
  if (smc?.displacement?.detected) parts.push('DISPLACEMENT');
  if (parts.length === 0) parts.push('STRUCTURE');
  return parts.join(' + ');
}

function _buildVerdictChain(smc, sm, tech, dir) {
  const chain = [];
  if (smc?.breakout?.failed) {
    chain.push(`FAILED ${smc.breakout.direction === 'BULLISH' ? 'BULLISH' : 'BEARISH'} BREAKOUT`);
    chain.push('  ↓');
  }
  if (smc?.liquidity?.sweep) {
    chain.push(`LIQUIDITY SWEEP ${smc.liquidity.sweep.direction}`);
    chain.push('  ↓');
  }
  if (smc?.displacement?.detected) {
    chain.push(`${smc.displacement.direction} DISPLACEMENT`);
    chain.push('  ↓');
  }
  if (smc?.bos?.detected) {
    chain.push(`BOS ${smc.bos.direction} CONFIRMED`);
    chain.push('  ↓');
  }
  if (sm?.fusion?.direction && sm.fusion.direction !== 'NEUTRAL') {
    chain.push(`SMART MONEY ${sm.fusion.direction === 'BULLISH' ? 'ALIGNED' : 'ALIGNED'}`);
  }
  if (tech?.technicalDirection?.direction && tech.technicalDirection.direction !== 'NEUTRAL') {
    chain.push(`TECHNICALS ${tech.technicalDirection.direction}`);
  }
  if (chain.length === 0) chain.push('Insufficient evidence for directional thesis');
  return chain;
}

function _buildAnalysis(opp, smc, sm, tech, dir, dec) {
  const parts = [];

  if (dec === 'ENTER') {
    parts.push(`The Brain is entering a ${dir} position on ${opp.symbol}.`);
  } else if (dec === 'WAIT') {
    parts.push(`The Brain is waiting before entering ${opp.symbol}.`);
  } else {
    parts.push(`The Brain has rejected a trade on ${opp.symbol}.`);
  }

  // SMC reasoning
  if (smc?.breakout?.failed) {
    parts.push(`A ${smc.breakout.direction.toLowerCase()} breakout failed, which is a ${dir === 'BEARISH' ? 'bearish' : 'bullish'} signal.`);
  }
  if (smc?.liquidity?.sweep) {
    parts.push(`Price swept liquidity ${smc.liquidity.sweep.direction.toLowerCase()} at ${smc.liquidity.sweep.location}, suggesting a reversal.`);
  }
  if (smc?.bos?.detected) {
    parts.push(`Break of structure confirmed ${smc.bos.direction.toLowerCase()}, validating the ${dir.toLowerCase()} thesis.`);
  }
  if (smc?.displacement?.detected) {
    parts.push(`${smc.displacement.direction} displacement (${smc.displacement.strength}% strength) confirms institutional participation.`);
  }

  // Smart money
  if (sm?.fusion?.direction && sm.fusion.direction !== 'NEUTRAL') {
    if (sm.fusion.direction === dir) {
      parts.push(`Smart money is aligned ${sm.fusion.direction.toLowerCase()} with ${sm.fusion.strength}% strength and ${sm.fusion.flowAlignment.toLowerCase()} flow alignment.`);
    } else {
      parts.push(`However, smart money is ${sm.fusion.direction.toLowerCase()}, diverging from the thesis.`);
    }
  }

  // Technicals
  if (tech?.technicalDirection?.direction && tech.technicalDirection.direction !== 'NEUTRAL') {
    if (tech.technicalDirection.direction === dir) {
      parts.push(`Technical indicators support the move: ${tech.supportingCount} signals aligned with ${tech.technicalDirection.conviction}% conviction.`);
    } else {
      parts.push(`Technicals are ${tech.technicalDirection.direction.toLowerCase()}, creating conflict.`);
    }
  }

  // Conflict
  const conflict = opp.scores?.conflict || 0;
  if (conflict > 40 && dec !== 'REJECT') {
    parts.push(`There is ${conflict > 60 ? 'high' : 'moderate'} conflict in the evidence, which is why the Brain is cautious.`);
  }

  // Counter
  if (opp.counterThesis?.narrative && dec === 'ENTER') {
    parts.push(`The main risk is: ${opp.counterThesis.narrative.split('.')[0]}.`);
  }

  // Reason
  if (opp.conclusion?.reason) {
    parts.push(opp.conclusion.reason);
  }

  return parts.join(' ');
}

/**
 * Render the account summary header.
 */
export function renderAccountSummary(accountState, memoryStats) {
  const L = [];
  const bal = accountState?.balance || 0;
  const pnl = accountState?.totalPnL || 0;
  const pnlPct = accountState?.totalPnLPct || 0;
  const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
  const pnlColor = pnl >= 0 ? C.brightGreen : C.brightRed;
  const open = accountState?.openPositions?.length || 0;

  L.push(`  ${C.brightWhite}${C.bold}Balance${C.reset} ${C.brightGreen}$${bal.toFixed(2)}${C.reset}  ${C.dim}│${C.reset}  ${C.dim}PnL${C.reset} ${pnlColor}${pnlStr} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%)${C.reset}  ${C.dim}│${C.reset}  ${C.dim}Open${C.reset} ${C.brightCyan}${open}${C.reset}`);

  if (memoryStats && memoryStats.totalTrades > 0) {
    const wr = ((memoryStats.wins / memoryStats.totalTrades) * 100).toFixed(1);
    L.push(`  ${C.dim}Trades${C.reset} ${memoryStats.totalTrades}  ${C.dim}Win Rate${C.reset} ${C.brightGreen}${wr}%${C.reset}  ${C.dim}Avg Win${C.reset} ${C.brightGreen}+${memoryStats.avgWinPct}%${C.reset}  ${C.dim}Avg Loss${C.reset} ${C.brightRed}${memoryStats.avgLossPct}%${C.reset}`);
  }

  return L.join('\n');
}

export { C as Colors };
