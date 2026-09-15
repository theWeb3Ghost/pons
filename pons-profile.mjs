#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
   PONS PROFILER v3-final — safe to run WHILE pons-index.mjs runs (atomic reads).
   Ranks by creator earnings for a WINDOW (all-time comp | fees generated in
   first 1h | first 24h), then mechanically profiles the top slice: every
   letter, word, bucket, boolean, pair → "% of winners vs % of rest".

   WINDOW=all  TOP_PCT=1  node pons-profile.mjs     # all-time top 1%
   WINDOW=1h   TOP_PCT=5  node pons-profile.mjs     # first-hour champions, top 5%
   WINDOW=24h  TOP_PCT=1  node pons-profile.mjs
   PCTS=0.1,1,5,10 node pons-profile.mjs            # mine several slices → CSV
   node pons-profile.mjs --top 10                   # + narratives for top 10
   node pons-profile.mjs --explain 0xTOKEN          # one token's math story
   node pons-profile.mjs --pair all                 # include non-native pairs
   ═══════════════════════════════════════════════════════════════════════════ */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

try { for (const line of fs.readFileSync('.env', 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
} } catch {}

const DATA = process.env.DATA_DIR || './pons_data';
const WINDOW = (process.env.WINDOW || 'all').toLowerCase();      // all | 1h | 24h
const TOP_PCT = Number(process.env.TOP_PCT || 1);
const PCTS = (process.env.PCTS || String(TOP_PCT)).split(',').map(Number).filter(x => x > 0 && x < 100);
const MIN_SUP = Number(process.env.MIN_SUPPORT || 5);
const MIN_REST = Number(process.env.MIN_REST || 8);
const SORT = (process.env.SORT || 'lift').toLowerCase();
const SUPPLY_GUESS = Number(process.env.SUPPLY_GUESS || 1e9);
const PAIR_ALL = process.argv.includes('--pair') && process.argv.includes('all');
const topN = (() => { const i = process.argv.indexOf('--top'); return i > -1 ? Number(process.argv[i + 1]) : 0; })();

const med = (a) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const normCdf = (x) => { const t = 1 / (1 + .2316419 * Math.abs(x)), d = .3989422804014327 * Math.exp(-x * x / 2);
  const p = d * t * (.319381530 + t * (-.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429)))); return x > 0 ? 1 - p : p; };
function propTest(w1, n1, w2, n2) {
  if (!n1 || !n2) return { p: 1, diff: 0 };
  const p1 = w1 / n1, p2 = w2 / n2, p = (w1 + w2) / (n1 + n2);
  const sd = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  const z = sd > 0 ? (p1 - p2) / sd : 0;
  return { p: 2 * (1 - normCdf(Math.abs(z))), diff: p1 - p2 };
}
const pctS = (x) => Number.isFinite(x) ? (100 * x).toFixed(0) + '%' : '—';
const pS = (p) => (p < 1e-4 ? p.toExponential(1) : p.toFixed(4));
const liftS = (l) => !Number.isFinite(l) ? 'new' : '×' + l.toFixed(2);

/* ── load ───────────────────────────────────────────────────────────── */
async function load() {
  const file = path.join(DATA, 'pons_launches.jsonl');
  if (!fs.existsSync(file)) { console.error(`no ${file} — run pons-index.mjs first`); process.exit(1); }
  const rows = [];
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    const pd = Number(r.pairDecimals ?? 18), hu = (v) => Number(v ?? 0) / 10 ** pd;
    const early = (r.earlyVolMin || []).map(hu);
    const vol = hu(r.totalVolume), reward = hu(r.creatorReward), comp = hu(r.creatorComp ?? r.creatorReward);
    if (!vol && !reward && !comp) continue;
    const supRaw = Number(r.totalSupply ?? 0);
    const supply = supRaw > 0 ? supRaw / 1e18 : SUPPLY_GUESS;
    rows.push({
      token: r.token, symbol: r.symbol || '', name: r.name || '', desc: r.description || '',
      creator: r.creator || '', feeRecipient: r.feeRecipient || r.creator || '', tx: r.launchTx || '',
      pair: !r.pairAsset || r.pairAsset === '0x0000000000000000000000000000000000000000' ? 'native' : r.pairAsset,
      ethPair: r.ethPair !== false,
      tax: Number(r.creatorTaxBps ?? 0), curveFee: Number(r.curveFeeBps ?? 0),
      reward, comp, vol, realizedBps: 0,
      trades: (r.buys || 0) + (r.sells || 0), buyers: (r.buyers || []).length,
      vol1m: early[0] || 0, vol5m: early.slice(0, 5).reduce((s, x) => s + x, 0), vol30m: early.reduce((s, x) => s + x, 0),
      shareFirst30: vol > 0 ? early.reduce((s, x) => s + x, 0) / vol : 0,
      graduated: !!r.graduated, tGradH: r.gradTs && r.launchTs ? (r.gradTs - r.launchTs) / 3600 : NaN,
      lifeH: Math.max(1 / 60, ((r.lastTradeTs || r.gradTs || r.launchTs) - r.launchTs) / 3600),
      supply, supplyEst: !(supRaw > 0), peakMcap: (r.peakPrice || 0) * supply,
      socials: [r.website, r.twitter, r.telegram, r.discord, r.farcaster].filter(Boolean).length,
      hasTw: r.twitter ? 1 : 0, hasTg: r.telegram ? 1 : 0, hasWeb: r.website ? 1 : 0, hasDisc: r.discord ? 1 : 0, hasImg: r.image ? 1 : 0,
      nameLen: (r.name || '').length, symLen: (r.symbol || '').length, descLen: (r.description || '').length,
      snipers: (r.snipers || []).length, snipeTaxQ: hu(r.snipeTaxTotal),
      snipeExempt: Math.max((r.snipeExemptions || []).length, Number(r.snipeExemptCount || 0)),
      usedBuyback: Number(r.buybackQuote ?? 0) > 0 ? 1 : 0, buybackVal: hu(r.buybackQuote ?? 0),
      earn1h: hu(r.earn1h ?? 0), earn24h: hu(r.earn24h ?? 0),
      gen1h: hu(r.gen1h ?? 0), gen24h: hu(r.gen24h ?? 0), genTotal: hu(r.genTotal ?? 0),
      vol1h: hu(r.vol1h ?? 0), trades1h: Number(r.trades1h ?? 0), bb1h: hu(r.bb1h ?? 0),
      pending: hu((r.pendingCurve ?? 0) + (r.pendingHook ?? 0)),
      launchTs: r.launchTs || 0,
      hour: r.launchTs ? new Date(r.launchTs * 1000).getUTCHours() : NaN,
      dow: r.launchTs ? new Date(r.launchTs * 1000).getUTCDay() : NaN,
      month: r.launchTs ? new Date(r.launchTs * 1000).toISOString().slice(0, 7) : '?',
      rw: 0, vw: 0,
    });
  }
  return rows;
}
const all = (await load()).filter(r => PAIR_ALL || r.ethPair);

/* WINDOW switch — rw/vw feed every downstream stat */
for (const r of all) {
  if (WINDOW === '1h')       { r.rw = r.gen1h;  r.vw = r.vol1h; }
  else if (WINDOW === '24h') { r.rw = r.gen24h; r.vw = r.vol; }
  else                       { r.rw = r.comp || r.reward; r.vw = r.vol; }
  r.realizedBps = r.vw > 0 ? r.rw / r.vw * 1e4 : 0;
}
const traded = all.filter(r => r.vw > 0);
const rewarded = traded.filter(r => r.rw > 0).sort((a, b) => b.rw - a.rw);
const N = rewarded.length;
if (N < 20) { console.error(`only ${N} earning launches in this window — need more history`); process.exit(1); }
console.log(`WINDOW=${WINDOW} (${WINDOW === 'all' ? 'all-time comp = earnings+buyback' : `fees GENERATED in first ${WINDOW}`}) · ` +
  `traded=${traded.length} · earners=${N} · graveyard=${(100 * (1 - N / Math.max(traded.length, 1))).toFixed(0)}%` +
  (PAIR_ALL ? ' · [pair=all]' : ''));

/* ── TRAIT CATALOG (enumerated, not hand-picked) ────────────────────── */
const STOP = new Set('the and for with this that you your our are was has have its not all out get one two new who why how what when coin token meme official just about more than then them they from will can now'.split(' '));
const nameWords = (r) => new Set(((r.name + ' ' + r.symbol).toLowerCase().match(/[a-z]{3,}/g) || []).filter(w => !STOP.has(w)));
const descWords = (r) => new Set(((r.desc || '').toLowerCase().match(/[a-z]{4,}/g) || []).filter(w => !STOP.has(w)));
function bump(m, k) { m.set(k, (m.get(k) || 0) + 1); }

function buildTraits() {
  const T = [];
  const add = (cat, id, test) => T.push({ cat, id, test });
  const b = (cat, id, lo, hi, f) => add(cat, id, r => { const v = f(r); return v >= lo && v <= hi; });
  add('meta', 'has image', r => r.hasImg);
  add('meta', 'has website', r => r.hasWeb);
  add('meta', 'has twitter', r => r.hasTw);
  add('meta', 'has telegram', r => r.hasTg);
  add('meta', 'has discord', r => r.hasDisc);
  add('meta', 'has ALL 3+ socials', r => r.socials >= 3);
  add('meta', 'has ≥1 social', r => r.socials >= 1);
  add('meta', 'has description', r => r.descLen > 0);
  add('meta', 'desc ≥ 100 chars', r => r.descLen >= 100);
  add('meta', 'symbol ALL-CAPS', r => /^[A-Z0-9]+$/.test(r.symbol));
  add('meta', 'symbol letters only', r => /^[A-Za-z]+$/.test(r.symbol));
  add('meta', 'graduated to V4 pool', r => r.graduated);
  add('meta', 'used buyback-and-lock', r => r.usedBuyback);
  add('shape', 'graduated < 1h', r => r.graduated && r.tGradH < 1);
  add('shape', 'graduated < 6h', r => r.graduated && r.tGradH < 6);
  add('shape', 'still trading after 48h', r => r.lifeH >= 48);
  add('war', 'got sniped (≥1 sniper)', r => r.snipers >= 1);
  b('war', 'snipers 1-3', 1, 3, r => r.snipers);
  b('war', 'snipers 4+', 4, 999, r => r.snipers);
  add('war', 'declared snipe exemptions', r => r.snipeExempt > 0);
  b('name length', 'name 1-6 chars', 1, 6, r => r.nameLen);
  b('name length', 'name 7-10 chars', 7, 10, r => r.nameLen);
  b('name length', 'name 11-14 chars', 11, 14, r => r.nameLen);
  b('name length', 'name 15-18 chars', 15, 18, r => r.nameLen);
  b('name length', 'name 19-24 chars', 19, 24, r => r.nameLen);
  b('name length', 'name 25+ chars', 25, 999, r => r.nameLen);
  b('symbol length', 'sym 1-3', 1, 3, r => r.symLen);
  b('symbol length', 'sym 4', 4, 4, r => r.symLen);
  b('symbol length', 'sym 5', 5, 5, r => r.symLen);
  b('symbol length', 'sym 6', 6, 6, r => r.symLen);
  b('symbol length', 'sym 7-8', 7, 8, r => r.symLen);
  b('symbol length', 'sym 9+', 9, 99, r => r.symLen);
  b('desc length', 'desc 1-40', 1, 40, r => r.descLen);
  b('desc length', 'desc 41-100', 41, 100, r => r.descLen);
  b('desc length', 'desc 101-180', 101, 180, r => r.descLen);
  b('desc length', 'desc 181+', 181, 1e9, r => r.descLen);
  b('creator tax', 'tax 0 bps', 0, 0, r => r.tax);
  b('creator tax', 'tax 1-100 bps', 1, 100, r => r.tax);
  b('creator tax', 'tax 101-300 bps', 101, 300, r => r.tax);
  b('creator tax', 'tax 301-500 bps', 301, 500, r => r.tax);
  b('creator tax', 'tax 501-1000 bps', 501, 1000, r => r.tax);
  b('creator tax', 'tax 1001+ bps', 1001, 1e9, r => r.tax);
  b('speed', 'vol@5m 0.01-1', 0.01, 1, r => r.vol5m);
  b('speed', 'vol@5m 1-5', 1, 5, r => r.vol5m);
  b('speed', 'vol@5m 5-20', 5, 20, r => r.vol5m);
  b('speed', 'vol@5m 20-100', 20, 100, r => r.vol5m);
  b('speed', 'vol@5m 100+', 100, 1e12, r => r.vol5m);
  b('audience', 'buyers 1-9', 1, 9, r => r.buyers);
  b('audience', 'buyers 10-49', 10, 49, r => r.buyers);
  b('audience', 'buyers 50-199', 50, 199, r => r.buyers);
  b('audience', 'buyers 200+', 200, 1e9, r => r.buyers);
  b('efficiency', 'realized ≤20 bps', 0, 20, r => r.realizedBps);
  b('efficiency', 'realized 20-50 bps', 20, 50, r => r.realizedBps);
  b('efficiency', 'realized 50-150 bps', 50, 150, r => r.realizedBps);
  b('efficiency', 'realized >150 bps', 150, 1e9, r => r.realizedBps);
  for (let h = 0; h < 24; h++) b('launch hour UTC', `hour ${String(h).padStart(2, '0')}:00`, h, h, r => r.hour);
  for (let d = 0; d < 7; d++) b('launch day', `day ${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d]}`, d, d, r => r.dow);
  for (const ch of 'abcdefghijklmnopqrstuvwxyz') {
    add('letters (name/sym)', `name contains '${ch}'`, r => (r.name + r.symbol).toLowerCase().includes(ch));
    add('letters (description)', `desc contains '${ch}'`, r => r.desc.toLowerCase().includes(ch));
  }
  for (const d of '0123456789') add('digits', `contains '${d}'`, r => (r.name + r.symbol).includes(d));
  const wcount = new Map();
  for (const r of rewarded) { for (const w of nameWords(r)) bump(wcount, w); for (const w of descWords(r)) bump(wcount, w + '@desc'); }
  for (const [w, n] of wcount) {
    if (n < MIN_SUP) continue;
    if (w.endsWith('@desc')) add('words (description)', `desc word '${w.slice(0, -5)}'`, r => descWords(r).has(w.slice(0, -5)));
    else add('words (name/sym)', `name word '${w}'`, r => nameWords(r).has(w));
  }
  return T;
}
const countIf = (rows, test) => { let c = 0; for (const r of rows) if (test(r)) c++; return c; };

function mine(winners, rest, traits) {
  const nw = winners.length, nr = rest.length;
  const single = [];
  for (const t of traits) {
    const w1 = countIf(winners, t.test), w2 = countIf(rest, t.test);
    if (w1 < Math.min(MIN_SUP, nw) && w2 < MIN_REST) continue;
    const pw = w1 / nw, pr = nr ? w2 / nr : 0;
    const lift = pr > 0 ? pw / pr : (pw > 0 ? Infinity : 1);
    const { p } = propTest(w1, nw, w2, nr);
    single.push({ cat: t.cat, id: t.id, winPct: pw, restPct: pr, lift, p, w1, w2, test: t.test, pair: false });
  }
  const seeds = single.filter(r => r.lift > 1.05 && r.w1 >= 3).sort((a, b) => a.p - b.p).slice(0, 25);
  const pairs = [];
  for (let i = 0; i < seeds.length; i++) for (let j = i + 1; j < seeds.length; j++) {
    const test = (r) => seeds[i].test(r) && seeds[j].test(r);
    const w1 = countIf(winners, test), w2 = countIf(rest, test);
    if (w1 < Math.max(2, Math.min(MIN_SUP, nw) - 1)) continue;
    const pw = w1 / nw, pr = nr ? w2 / nr : 0;
    const lift = pr > 0 ? pw / pr : (pw > 0 ? Infinity : 1);
    const { p } = propTest(w1, nw, w2, nr);
    pairs.push({ cat: 'pairs', id: `${seeds[i].id} + ${seeds[j].id}`, winPct: pw, restPct: pr, lift, p, w1, w2, pair: true });
  }
  return { single, pairs };
}
function show(res, title, n = 30) {
  const rows = res.single;
  const byWin = [...rows].sort((a, b) => b.winPct - a.winPct || b.lift - a.lift);
  const byLift = [...rows].sort((a, b) => (b.lift === Infinity ? 99 : b.lift) - (a.lift === Infinity ? 99 : a.lift));
  const order = SORT === 'win' ? byWin : byLift;
  console.log(`\n── ${title}: TRAITS BY ${SORT === 'win' ? 'PREVALENCE IN WINNERS' : 'SURPRISE (lift)'} ──`);
  const fmt = (r) => ({ trait: r.id, winners: pctS(r.winPct), rest: pctS(r.restPct), lift: liftS(r.lift), p: pS(r.p), n: r.w1 });
  console.table(order.slice(0, n).map(fmt));
  const neg = [...rows].filter(r => r.lift < 0.75 && r.w2 >= MIN_REST).sort((a, b) => a.lift - b.lift).slice(0, 10);
  if (neg.length) { console.log('── traits that LOSE (avoid?) ──'); console.table(neg.map(fmt)); }
  const prs = [...res.pairs].sort((a, b) => (b.lift === Infinity ? 99 : b.lift) - (a.lift === Infinity ? 99 : a.lift)).slice(0, 12);
  if (prs.length) { console.log('── trait PAIRS over-indexed in winners ──'); console.table(prs.map(fmt)); }
}

/* ── run all slices ─────────────────────────────────────────────────── */
const traits = buildTraits();
const allResults = [];
function explain(r) {
  const i = rewarded.findIndex(x => x.token === r.token);
  console.log(`\n═══ ${r.symbol} (${r.name || 'unnamed'}) ═══
token      ${r.token}
creator    ${r.creator}
fee wallet ${r.feeRecipient}   tx ${r.tx}
window     rw=${r.rw.toFixed(4)} on vw=${r.vw.toFixed(1)} (${WINDOW}) · realized ${r.realizedBps.toFixed(1)} bps
money      earnings ${r.reward.toFixed(4)} · buyback ${r.buybackVal.toFixed(4)} → comp ${r.comp.toFixed(4)} · pending ${r.pending.toFixed(4)}
windows    gen1h ${r.gen1h.toFixed(3)} (earn ${r.earn1h.toFixed(3)}, vol ${r.vol1h.toFixed(1)}, trades ${r.trades1h}) · gen24h ${r.gen24h.toFixed(3)} (earn ${r.earn24h.toFixed(3)})
rank       #${i + 1} of ${N} · top ${(((i + 1) / N) * 100).toFixed(2)}%
shape      trades ${r.trades} · buyers ${r.buyers} · vol@1m ${r.vol1m.toFixed(2)} · @5m ${r.vol5m.toFixed(2)} · @30m ${r.vol30m.toFixed(2)}
           first-30m = ${(r.shareFirst30 * 100).toFixed(0)}% of lifetime · life ${r.lifeH.toFixed(1)}h${r.graduated ? ` · graduated ${r.tGradH.toFixed(2)}h` : ' · never graduated'}
war        snipers ${r.snipers} · snipe tax collected ${r.snipeTaxQ.toFixed(4)} · declared exemptions ${r.snipeExempt}
settings   tax ${r.tax} bps + curve fee ${r.curveFee} bps · buyback ${r.usedBuyback ? 'ON' : 'off'}
meta       socials ${r.socials} (tw ${r.hasTw} tg ${r.hasTg} dc ${r.hasDisc} web ${r.hasWeb}) · img ${r.hasImg} · desc ${r.descLen} chars
           name ${r.nameLen} · sym ${r.symLen} · hour ${r.hour}UTC (${r.month})${r.supplyEst ? ' · supply≈guess' : ''}`);
}
for (const p of PCTS) {
  const k = Math.max(1, Math.round(N * p / 100));
  const winners = rewarded.slice(0, k), rest = rewarded.slice(k);
  console.log(`\n════ SLICE top ${p}% → ${k} tokens (rw ≥ ${winners.at(-1)?.rw.toFixed(4)}) vs ${rest.length} rest ════`);
  const res = mine(winners, rest, traits);
  const tests = res.single.length + res.pairs.length;
  console.log(`(${tests} traits tested · Bonferroni guard: act on p < ${(0.05 / Math.max(tests, 1)).toFixed(5)})`);
  show(res, `top ${p}%`);
  if (p === PCTS[0]) {
    console.log(`\n── RANKING: top ${Math.min(k, 20)} by rw (WINDOW=${WINDOW}) ──`);
    console.table(winners.slice(0, 20).map((r, i) => ({ '#': i + 1, symbol: r.symbol || '?',
      rw: +r.rw.toFixed(4), gen1h: +r.gen1h.toFixed(3), earn1h: +r.earn1h.toFixed(3),
      allTimeEarn: +r.reward.toFixed(3), pending: +r.pending.toFixed(3),
      buyback: +r.buybackVal.toFixed(2), vol: +r.vol.toFixed(0), vol1h: +r.vol1h.toFixed(1),
      bps: +r.realizedBps.toFixed(1), trades: r.trades, buyers: r.buyers, snipers: r.snipers,
      grad: r.graduated ? '✓' : '', hour: r.hour, token: r.token.slice(0, 10) + '…' })));
  }
  if (topN > 0 && p === PCTS[0]) for (const r of winners.slice(0, topN)) explain(r);
  for (const r of [...res.single, ...res.pairs]) allResults.push({ slicePct: p, ...r, winPct: +r.winPct.toFixed(4), restPct: +r.restPct.toFixed(4) });
}

/* ── outputs ────────────────────────────────────────────────────────── */
const q = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
fs.writeFileSync(path.join(DATA, 'pons_traits.csv'),
  ['slicePct','cat','trait','winnersPct','restPct','lift','p','winnersN','restN','isPair']
    .concat(allResults.map(r => [r.slicePct, r.cat, r.id, (100 * r.winPct).toFixed(1) + '%', (100 * r.restPct).toFixed(1) + '%',
      Number.isFinite(r.lift) ? r.lift.toFixed(2) : 'new', r.p.toExponential(2), r.w1, r.w2, r.pair].map(q).join(',')))
    .join('\n') + '\n');
const first = PCTS[0], bestK = Math.max(1, Math.round(N * first / 100)), winners0 = rewarded.slice(0, bestK);
fs.writeFileSync(path.join(DATA, `pons_recipe_${WINDOW}.md`), `# Pons winning profile — WINDOW=${WINDOW} · top ${first}% (rw ≥ ${winners0.at(-1)?.rw.toFixed(4)}) · ${new Date().toISOString()}
Winners = ${bestK} of ${N} earning launches. Key: ${WINDOW === 'all' ? 'creatorComp (swept+rescued+pending, curve+hook, + buyback quote)' : `creator fees GENERATED in first ${WINDOW}`}.

## What winners have
 ${allResults.filter(r => r.slicePct === first && !r.pair && r.w1 >= Math.min(MIN_SUP, bestK))
  .sort((a, b) => b.winPct - a.winPct).slice(0, 18)
  .map(r => `- **${(100 * r.winPct).toFixed(0)}%** had ${r.id} (rest: ${(100 * r.restPct).toFixed(0)}% · ${liftS(r.lift)} · p=${pS(r.p)})`).join('\n')}

## Combos that over-index
 ${allResults.filter(r => r.slicePct === first && r.pair).sort((a, b) => b.lift - a.lift).slice(0, 8)
  .map(r => `- ${(100 * r.winPct).toFixed(0)}% had **${r.id}** (${liftS(r.lift)} · p=${pS(r.p)})`).join('\n') || '—'}

## What losers look like
 ${allResults.filter(r => r.slicePct === first && !r.pair && r.lift < 0.75 && r.w2 >= MIN_REST).sort((a, b) => a.lift - b.lift).slice(0, 8)
  .map(r => `- ${(100 * r.winPct).toFixed(0)}% had ${r.id} vs ${(100 * r.restPct).toFixed(0)}% baseline (${liftS(r.lift)})`).join('\n') || '—'}

## Read me
- Require lift ≥ 1.3 AND p below the Bonferroni line printed in console.
- Snipe tax suppresses first-minute buys by design — read vol@1m traits with that in mind.
- Letters/words are correlational and rotate; re-run weekly, diff pons_traits.csv.
- Correlation ≠ causation: validate by launching variants and re-profiling with this same pipeline.
`);
console.log(`\nwrote: pons_traits.csv (${allResults.length} rows) · pons_recipe_${WINDOW}.md`);

const exAddr = process.argv.find(a => /^0x[0-9a-f]{40}$/i.test(a));
if (exAddr) {
  const r = all.find(x => x.token === exAddr.toLowerCase());
  if (!r) console.error('token not in dataset (never traded?)');
  else explain(r);
}