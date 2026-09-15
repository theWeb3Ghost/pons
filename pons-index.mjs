#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
   PONS INDEXER v3-final — exact ABIs from verified source (RH-scan).
   Contracts: PonsV2LaunchFactory · PonsV2BondingCurve · PonsV2LauncherToken · PonsV2MemeHook
   Zero deps · Node 18+ · crash-safe · multi-RPC w/ rate learner.

   Tracks per launch: full metadata (from launch-tx input), curve economics, every
   trade, creator earnings decomposed as
     swept + rescued + pending, curve-side + hook-side
   plus buyback comp, and TIME WINDOWS: gen/earn/vol in first 1h and 24h.

   node pons-index.mjs                     backfill → live tail (resumable)
   node pons-index.mjs --backfill          catch up, then exit
   node pons-index.mjs --find-start        first factory activity → START_BLOCK
   node pons-index.mjs --discover [0xADDR] topic census / sanity check
   node pons-index.mjs --timeline 0xTOKEN  per-minute volume/price of one coin
   ═══════════════════════════════════════════════════════════════════════════ */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import readline from 'node:readline';

try { for (const line of fs.readFileSync('.env', 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
} } catch {}

const C = {
  RPC_URLS: process.env.RPC_URLS || '',
  CHAIN_ID: Number(process.env.CHAIN_ID || 4663),
  FACTORY: (process.env.FACTORY || '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e').toLowerCase(),
  HOOK: '', ESCROW: '',                                    // auto-discovered from factory views
  WETH: (process.env.WETH_ADDRESSES || '').split(',').map(s => s.toLowerCase()).filter(Boolean),
  EXPLORER_API: (process.env.EXPLORER_API || '').replace(/\/$/, ''),
  START_BLOCK: Number(process.env.START_BLOCK || 1),
  DATA_DIR: process.env.DATA_DIR || './pons_data',
  CHUNK_INIT: Number(process.env.CHUNK || 20000),
  ADDR_CHUNK: Number(process.env.ADDR_CHUNK || 200),
  POLL_MS: Number(process.env.POLL_MS || 8000),
  CONFIRMATIONS: Number(process.env.CONFIRMATIONS || 5),
  ANCHOR_EVERY: Number(process.env.ANCHOR_EVERY || 5000),
  RPC_MAX_RPS: Number(process.env.RPC_MAX_RPS) || 8,
  RPC_MIN_RPS: Number(process.env.RPC_MIN_RPS) || 0.2,
  RPC_NUDGE_OK: Number(process.env.RPC_NUDGE_OK) || 20,
  TRACK_WALLETS: process.env.TRACK_WALLETS !== '0',
  SAVE_TRADES: process.env.SAVE_TRADES === '1',
  PROBE_PENDING: process.env.PROBE_PENDING !== '0',
    MAX_MINUTES: Number(process.env.INDEX_MAX_MINUTES || 0),   // 0 = no limit (0 is fine on a VPS)
  SUPPLY_FETCH: process.env.SUPPLY_FETCH === '1',
};

/* ── EXACT event signatures (from verified source) ──────────────────── */
const EVENT_CANDIDATES = [
  // PonsV2LaunchFactory
  'TokenLaunched(address indexed token,address indexed curve,address indexed deployer,address pairToken,uint256 launchConfigId,uint256 graduationThreshold)',
  'PoolGraduated(address indexed token,uint256 positionId,uint256 tokenAmount,uint256 pairTokenAmount)',
  'LaunchSwept(address indexed token,uint256 quoteOut,uint256 tokenOut)',
  'LaunchForceSwept(address indexed token)',
  'LaunchGraduationRescued(address indexed token,address indexed recipient,uint256 quoteAmount,uint256 tokenAmount)',
  'GraduationTokensPermanentlyLocked(address indexed token,uint256 amount)',
  'CreatorFeeRecipientUpdated(address indexed token,address indexed previousRecipient,address indexed newRecipient)',
  'BuybackEnabledUpdated(address indexed token,bool enabled,address indexed controller)',
  // PonsV2BondingCurve
  'CurveBuy(address indexed buyer,address indexed recipient,uint256 quoteIn,uint256 tokensOut,uint256 fee,uint256 tax)',
  'CurveBuyRefunded(address indexed buyer,uint256 refund)',
  'CurveSell(address indexed seller,address indexed recipient,uint256 tokensIn,uint256 quoteOut,uint256 fee,uint256 tax)',
  'FeesSwept(uint256 protocolAmount,uint256 buybackAmount,uint256 creatorAmount)',
  'FeesRescued(address indexed protocolRecipient,address indexed creatorRecipient,uint256 protocolAmount,uint256 creatorAmount)',
  'BuybackLocked(uint256 quoteSpent,uint256 tokensLocked)',
  'CurveCompleted(address recipient,uint256 quoteOut,uint256 tokenOut)',
  'Initialized(address token)',
  'CreatorFeeRecipientUpdated(address indexed previousRecipient,address indexed newRecipient)',
  'BuybackEnabledUpdated(bool enabled)',
  'AutoGraduationFailed(address indexed token,uint256 gasRemaining)',
  'SnipeTaxExempted(address indexed account)',
  'SnipeTaxCharged(address indexed recipient,uint256 amount)',
  // PonsV2MemeHook (post-graduation Uniswap V4 fees)
  'PoolRegistered(bytes32 indexed poolId,address memecoin,address quoteToken,address creator)',
  'HookFeeCollected(bytes32 indexed poolId,address currency,uint256 feeAmount,uint256 taxAmount)',
  'PoolFeesSwept(bytes32 indexed poolId,uint256 protocolAmount,uint256 buybackAmount,uint256 creatorAmount,uint256 tokensLocked)',
  'PoolFeesRescued(bytes32 indexed poolId,address indexed quoteToken,uint256 protocolAmount,uint256 creatorAmount)',
  'PoolBuybackSkipped(bytes32 indexed poolId,uint256 foldedBackQuote)',
  'PoolConversionSkipped(bytes32 indexed poolId,uint256 retainedMemecoin)',
  'CreatorFeeRecipientUpdated(bytes32 indexed poolId,address indexed previousRecipient,address indexed newRecipient)',
  'BuybackEnabledUpdated(bytes32 indexed poolId,bool enabled)',
];

/* ── utils ──────────────────────────────────────────────────────────── */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const addr = (s) => (s || '').toLowerCase();
const B = (v) => { try { return BigInt(v ?? 0n); } catch { return 0n; } };
const toHex = (n) => '0x' + n.toString(16);
const fromHex = (h) => (h == null ? 0 : Number(BigInt(h)));
const pad32 = (a) => '0x' + '0'.repeat(24) + addr(a).slice(2);
const padB32 = (h) => { try { return '0x' + BigInt(h).toString(16).padStart(64, '0'); } catch { return '0x' + '0'.repeat(64); } };
const ZERO_ADDR = '0x' + '0'.repeat(40);
const replacer = (_k, v) => (typeof v === 'bigint' ? v.toString() : v);

/* ── keccak256 (node's sha3 ≠ keccak) ───────────────────────────────── */
import jssha from 'js-sha3';
const keccak256 = (buf) => '0x' + jssha.keccak_256(Buffer.from(buf));
if (keccak256(Buffer.alloc(0)) !== '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470') {
  console.error('FATAL: keccak self-test failed'); process.exit(1);
}
const sel = (sig) => keccak256(Buffer.from(sig, 'utf8')).slice(0, 10);

/* ── RPC pool + rate learner (AIMD, per-endpoint, persistent) ───────── */
const RPC_LIST = C.RPC_URLS.split(',').map(s => s.trim()).filter(Boolean);
const RPC_STATE_F = path.join(C.DATA_DIR, 'rpc_state.json');
let RPC_SAVED = {}; try { RPC_SAVED = JSON.parse(fs.readFileSync(RPC_STATE_F, 'utf8')); } catch {}
const EPS = RPC_LIST.map(rawUrl => {
  const u = new URL(rawUrl), s = RPC_SAVED[u.host] || {};
  return { url: rawUrl, u, host: u.host,
    agent: (u.protocol === 'http:' ? http : https).Agent({ keepAlive: true, maxSockets: 1, keepAliveMsecs: 30000 }),
    budget: Number(Math.min(C.RPC_MAX_RPS, Math.max(C.RPC_MIN_RPS, Number(s.budget) || 1))) || 1,
    tokens: Number(s.budget) || 1, lastRefill: Date.now(),
    okStreak: 0, n429: 0, coolUntil: 0, deadUntil: 0, lat: s.lat || 400, reqs: 0, errs: 0, limits: 0 };
});
function refill(ep) { const now = Date.now();
  ep.tokens = Math.min(ep.budget, ep.tokens + (now - ep.lastRefill) / 1000 * ep.budget); ep.lastRefill = now; }
function pickEp() {
  const now = Date.now(); let best = null;
  for (const ep of EPS) {
    if (now < ep.coolUntil || now < ep.deadUntil) continue;
    refill(ep);
    const wait = ep.tokens >= 1 ? 0 : ((1 - ep.tokens) / ep.budget) * 1000;
    const cost = wait + ep.lat * 0.2;
    if (!best || cost < best.cost) best = { ep, wait, cost };
  }
  if (best) return best;
  const times = EPS.map(e => Math.max(e.coolUntil, e.deadUntil)).filter(t => t > now);
  return { ep: EPS[0], wait: Math.max(300, (times.length ? Math.min(...times) : now + 5000) - now) };
}
function rawCall(ep, body) {
  return new Promise((resolve, reject) => {
    const req = (ep.u.protocol === 'http:' ? http : https).request({
      hostname: ep.u.hostname, port: ep.u.port || (ep.u.protocol === 'https:' ? 443 : 80),
      path: ep.u.pathname + ep.u.search, method: 'POST', agent: ep.agent,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ s: res.statusCode, t: d })); });
    req.setTimeout(25000, () => req.destroy(new Error('timeout')));
    req.on('error', reject); req.write(body); req.end();
  });
}
const isLimitMsg = (m) => /rate|limit|429|too many|exceed|quota|capacity|backoff|spam|block range|tier|plan|-32600/i.test(m);
function penalize(ep, detail) {
  const e = new Error(`limit @${ep.host}: ${detail}`);
  e.isLimit = true; e.rateLimited = true;
  ep.limits++; ep.n429++; ep.okStreak = 0;
  ep.budget = Math.max(C.RPC_MIN_RPS, ep.budget * 0.5);
  ep.coolUntil = Date.now() + Math.min(120000, 1000 * 2 ** ep.n429);
  return e;
}
let rpcId = 1;
async function rpc(method, params, tries = 8) {
  if (!EPS.length) throw new Error('no RPC endpoints (set RPC_URLS in .env)');
  let lastErr;
  for (let i = 0; i < tries; i++) {
    let s = pickEp(); if (s.wait > 0) await sleep(s.wait); s = pickEp();
    const ep = s.ep; ep.tokens = Math.max(0, ep.tokens - 1);
    const t0 = Date.now();
    try {
      const body = JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params });
      const res = await rawCall(ep, body);
      ep.lat = ep.lat * 0.8 + (Date.now() - t0) * 0.2; ep.reqs++;
      if (res.s === 429 || res.s === 503) throw penalize(ep, `HTTP ${res.s}`);
      const j = JSON.parse(res.t);
      if (j.error) {
        if (isLimitMsg(JSON.stringify(j.error))) throw penalize(ep, JSON.stringify(j.error).slice(0, 120));
        throw new Error(`${method} @${ep.host}: ${JSON.stringify(j.error).slice(0, 120)}`);
      }
      ep.n429 = 0; ep.errs = 0; ep.okStreak++;
      if (ep.okStreak >= C.RPC_NUDGE_OK) { ep.budget = Math.min(C.RPC_MAX_RPS, ep.budget * 1.1); ep.okStreak = 0; }
      return j.result;
    } catch (e) {
      lastErr = e;
      if (e.isLimit) continue;
      if (++ep.errs >= 3) { ep.deadUntil = Date.now() + 60000; ep.errs = 0; }
      await sleep(Math.min(10000, 400 * 2 ** i));
    }
  }
  throw lastErr;
}
function saveRpcState() {
  if (!EPS.length) return;
  const o = {}; for (const ep of EPS) o[ep.host] = { budget: +ep.budget.toFixed(2), lat: Math.round(ep.lat) };
  const t = RPC_STATE_F + '.tmp'; fs.writeFileSync(t, JSON.stringify(o)); fs.renameSync(t, RPC_STATE_F);
}
async function bootChainCheck() {
  if (!EPS.length) { console.error('FATAL: set RPC_URLS in .env'); process.exit(1); }
  fs.mkdirSync(C.DATA_DIR, { recursive: true });
  await Promise.all(EPS.map(async ep => {
    try {
      const r = await rawCall(ep, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }));
      const cid = Number(BigInt(JSON.parse(r.t).result));
      if (cid !== C.CHAIN_ID) { console.error(`!! ${ep.host} chainId=${cid} ≠ ${C.CHAIN_ID} → disabled`); ep.deadUntil = 8.64e15; }
      else log(`[pool] ${ep.host} ok (chain ${cid})`);
    } catch { console.error(`!! ${ep.host} unreachable → down 60s`); ep.deadUntil = Date.now() + 60000; }
  }));
  setInterval(saveRpcState, 30000).unref();
  setInterval(() => log('[pool]', EPS.map(e => `${e.host} ${e.budget.toFixed(1)}r/s ok=${e.reqs} 429=${e.limits}` +
    `${Date.now() < e.coolUntil ? ' COOL' : ''}${Date.now() < e.deadUntil ? ' DOWN' : ''}`).join(' | ')), 120000).unref();
}

/* ── event registry + decoder ───────────────────────────────────────── */
function evFromSig(sig) {
  const name = sig.slice(0, sig.indexOf('('));
  const inner = sig.slice(sig.indexOf('(') + 1, sig.lastIndexOf(')'));
  const inputs = inner ? inner.split(',').map((p, i) => {
    const indexed = p.includes('indexed'); p = p.replace('indexed', '').trim().split(/\s+/);
    return { type: p[0], name: p[1] || `a${i}`, indexed };
  }) : [];
  const canonical = `${name}(${inputs.map(i => i.type).join(',')})`;   // ← THE FIX
  return { name, inputs, sig: canonical, topic: keccak256(Buffer.from(canonical, 'utf8')) };
}
const EV = new Map();
const reg = (sig) => { const e = evFromSig(sig); if (!EV.has(e.topic)) EV.set(e.topic, e); };
EVENT_CANDIDATES.forEach(reg);
const hx = (h) => Buffer.from((h || '0x').slice(2), 'hex');
function decodeLog(def, topics, dataHex) {
  const out = {};
  try {
    const data = hx(dataHex), w = (o) => data.subarray(o, o + 32);
    const uintAt = (o) => BigInt('0x' + (w(o).toString('hex') || '0'));
    const idx = def.inputs.filter(i => i.indexed), stk = def.inputs.filter(i => !i.indexed);
    if (topics.length - 1 !== idx.length) return out;
    idx.forEach((inp, k) => {
      const t = topics[k + 1] || '';
      out[inp.name] = inp.type === 'address' ? '0x' + t.slice(-40)
        : inp.type.startsWith('uint') || inp.type.startsWith('int') ? BigInt(t)
        : inp.type === 'bool' ? BigInt(t) !== 0n : t;   // bytes32 → raw topic hex string
    });
    let cur = 0;
    for (const inp of stk) {
      if (inp.type === 'string' || inp.type === 'bytes') {
        const off = Number(uintAt(cur * 32)), len = Number(uintAt(off));
        const raw = data.subarray(off + 32, off + 32 + len);
        out[inp.name] = inp.type === 'string' ? raw.toString('utf8') : '0x' + raw.toString('hex');
      } else if (inp.type === 'address') out[inp.name] = '0x' + w(cur * 32).subarray(12).toString('hex');
      else if (inp.type.startsWith('uint')) out[inp.name] = uintAt(cur * 32);
      else if (inp.type === 'bool') out[inp.name] = uintAt(cur * 32) !== 0n;
      else out[inp.name] = '0x' + w(cur * 32).toString('hex');   // static bytes32 in data
      cur++;
    }
  } catch {}
  return out;
}

/* ── storage / state / progress ─────────────────────────────────────── */
const P = {
  launches: path.join(C.DATA_DIR, 'pons_launches.jsonl'),
  events:   path.join(C.DATA_DIR, 'pons_events.jsonl'),
  trades:   path.join(C.DATA_DIR, 'pons_trades.jsonl'),
  state:    path.join(C.DATA_DIR, 'state.json'),
  progress: path.join(C.DATA_DIR, 'progress.json'),
  anchors:  path.join(C.DATA_DIR, 'anchors.json'),
};
const BIGS = ['creatorTaxBps','curveFeeBps','snipeTaxStartBps','snipeTaxSeconds','totalSupply',
  'graduationThreshold','launchConfigId','buyVolume','sellVolume',
  'gradQuote','gradTokens','gradSweptQuote','gradSweptTokens','rescuedQuote','lockedTokens',
  'sweptCurve','rescuedCreator','poolCreator','poolRescued','pendingCurve','pendingHook',
  'buybackQuote','buybackTokens','snipeTaxTotal',
  'earn1h','earn24h','gen1h','gen24h','genTotal','vol1h','bb1h','protocolShareBps','buybackBurnBps'];
const STATE = { v: 3, factoryBlock: C.START_BLOCK - 1, activityBlock: C.START_BLOCK - 1, chunk: C.CHUNK_INIT, satsFound: false };
try { Object.assign(STATE, JSON.parse(fs.readFileSync(P.state, 'utf8'))); } catch {}
const anchors = new Map(Object.entries((() => { try { return JSON.parse(fs.readFileSync(P.anchors, 'utf8')); } catch { return {}; } })())
  .map(([k, v]) => [Number(k), v]));
const L = new Map(), curveToToken = new Map(), poolToToken = new Map(), poolQuote = new Map();
const saveState = () => { const t = `${P.state}.tmp`; fs.writeFileSync(t, JSON.stringify(STATE, replacer)); fs.renameSync(t, P.state); };
const appendLines = (file, rows) => { if (rows.length) fs.appendFileSync(file, rows.map(r => JSON.stringify(r, replacer)).join('\n') + '\n'); };
function saveLaunches() {
  const rows = [...L.values()].map(l => {
    const earnings = l.sweptCurve + l.rescuedCreator + l.poolCreator + l.poolRescued + l.pendingCurve + l.pendingHook;
    return { ...l, buyers: [...l.buyers], sellers: [...l.sellers], snipers: [...l.snipers],
      creatorReward: earnings,
      totalVolume: l.buyVolume + l.sellVolume,
      buybackTotalQuote: l.buybackQuote,
      creatorComp: earnings + l.buybackQuote };
  });
  const t = `${P.launches}.tmp`;
  fs.writeFileSync(t, rows.map(r => JSON.stringify(r, replacer)).join('\n') + '\n');
  fs.renameSync(t, P.launches);
}
async function loadLaunches() {
  if (!fs.existsSync(P.launches)) return;
  const rl = readline.createInterface({ input: fs.createReadStream(P.launches), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    for (const f of BIGS) r[f] = B(r[f]);
    r.earlyVolMin = (r.earlyVolMin || []).map(B); while (r.earlyVolMin.length < 30) r.earlyVolMin.push(0n);
    r.buyers = new Set(r.buyers || []); r.sellers = new Set(r.sellers || []); r.snipers = new Set(r.snipers || []);
    if (r.token) { L.set(r.token, r);
      if (r.curve) curveToToken.set(r.curve, r.token);
      if (r.poolId && !String(r.poolId).startsWith('v4pos:')) poolToToken.set(String(r.poolId).toLowerCase(), r.token); }
  }
  log(`[resume] ${L.size} launches loaded`);
}
const progSamples = [];
function progress(phase, headBlock) {
  const cur = Math.max(STATE.factoryBlock, 0), span = Math.max(1, headBlock - C.START_BLOCK);
  progSamples.push({ t: Date.now(), c: cur }); if (progSamples.length > 40) progSamples.shift();
  let bps = 0;
  if (progSamples.length > 4) { const a = progSamples[0], b = progSamples[progSamples.length - 1];
    bps = Math.max(0, (b.c - a.c) / ((b.t - a.t) / 1000)); }
  const p = { phase, currentBlock: cur, headBlock, pct: +(100 * (cur - C.START_BLOCK) / span).toFixed(2),
    launches: L.size, chunk: STATE.chunk, blocksPerSec: +bps.toFixed(1),
    etaMinutes: bps > 0 ? +(Math.max(0, headBlock - cur) / bps / 60).toFixed(1) : null,
    pid: process.pid, updatedAt: new Date().toISOString() };
  const t = `${P.progress}.tmp`; fs.writeFileSync(t, JSON.stringify(p, null, 2)); fs.renameSync(t, P.progress);
  return p;
}

/* ── block timestamps: sparse anchors + interpolation ───────────────── */
async function ensureAnchor(b) {
  if (anchors.has(b)) return;
  try { const h = await rpc('eth_getBlockByNumber', [toHex(b), false]); if (h?.timestamp) anchors.set(b, fromHex(h.timestamp)); } catch {}
}
async function persistAnchors() {
  const o = {}; for (const [k, v] of anchors) o[k] = v;
  const t = `${P.anchors}.tmp`; fs.writeFileSync(t, JSON.stringify(o)); fs.renameSync(t, P.anchors);
}
function tsOf(block) {
  const ks = [...anchors.keys()].sort((a, b) => a - b);
  if (!ks.length) return 0;
  if (block <= ks[0]) return anchors.get(ks[0]);
  if (block >= ks[ks.length - 1]) {
    if (ks.length >= 2) { const a = ks[ks.length - 2], b2 = ks[ks.length - 1];
      const spb = (anchors.get(b2) - anchors.get(a)) / Math.max(1, b2 - a);
      return Math.round(anchors.get(b2) + (block - b2) * spb); }
    return anchors.get(ks[ks.length - 1]);
  }
  let lo = 0, hi = ks.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; ks[m] <= block ? lo = m : hi = m; }
  const t0 = anchors.get(ks[lo]), t1 = anchors.get(ks[hi]);
  return ks[hi] === ks[lo] ? t0 : Math.round(t0 + (t1 - t0) * (block - ks[lo]) / (ks[hi] - ks[lo]));
}

/* ── getLogs, adaptive chunking ─────────────────────────────────────── */
let okStreak = 0;
async function fetchLogs(addresses, topics, from, to) {
  const out = [];
  let s = from;
  while (s <= to) {
    const e = Math.min(s + STATE.chunk - 1, to);
    if ((s - from) % C.ANCHOR_EVERY < STATE.chunk) await Promise.all([ensureAnchor(s), ensureAnchor(e)]);
    let ok = true;
    for (let i = 0; i < addresses.length; i += C.ADDR_CHUNK) {
      const part = addresses.slice(i, i + C.ADDR_CHUNK);
      try {
        const logs = await rpc('eth_getLogs', [{ address: part, topics, fromBlock: toHex(s), toBlock: toHex(e) }]);
        out.push(...(logs || []));
        if (++okStreak > 5 && STATE.chunk < C.CHUNK_INIT) { STATE.chunk = Math.min(C.CHUNK_INIT, STATE.chunk * 2); okStreak = 0; }
      } catch (err) {
        if (err.rateLimited) { STATE.chunk = Math.max(500, STATE.chunk >> 1); okStreak = 0; ok = false; break; }
        throw err;
      }
    }
    if (ok) s = e + 1; else await sleep(1500);
  }
  return out;
}

/* ── contract reads ─────────────────────────────────────────────────── */
async function ethCall(to, data) { try { const r = await rpc('eth_call', [{ to, data }, 'latest']); return r && r.length > 2 ? r : null; } catch { return null; } }
async function callUint(to, sigStr) { const r = await ethCall(to, sel(sigStr)); return r ? BigInt(r) : 0n; }
async function callAddr(to, sigStr) { const r = await ethCall(to, sel(sigStr)); return r && r.length >= 42 ? addr('0x' + r.slice(-40)) : ''; }
const decimalsOf = async (t) => { const r = await ethCall(t, sel('decimals()')); return r ? Number(BigInt(r)) : 18; };
const SELS = {
  lt3:  sel('launchToken((string,string,string,string,(string,string,string,string,string),address,uint16,bool,bytes32,bytes32),uint256,address)'),
  lt4:  sel('launchToken((string,string,string,string,(string,string,string,string,string),address,uint16,bool,bytes32,bytes32),uint256,address,address[])'),
  ltf5: sel('launchTokenFor((string,string,string,string,(string,string,string,string,string),address,uint16,bool,bytes32,bytes32),uint256,address,address,address[])'),
  glt: sel('getLaunchedToken(address)'),
  socials: sel('socials()'), logo: sel('logo()'), description: sel('description()'),
  hpf: sel('pendingFees(bytes32,address)'), hpct: sel('pendingCreatorTax(bytes32,address)'),
  memeHook: sel('memeHook()'), feeEscrow: sel('feeEscrow()'), buybackVault: sel('buybackVault()'), locker: sel('locker()'),
};

/* ── launch-tx metadata: TokenParams from input data ──────────────────
   Head words (after 4-byte selector), word k at byte 4+32k:
     w0 paramsOffset · w1 configId · w2 pairToken
     launchToken 4-arg:      w3 = exemptions[] offset
     launchTokenFor 5-arg:   w3 = originalDeployer · w4 = exemptions[] offset
   Params tuple (base P0, offsets rel. P0):
     0 name · 32 symbol · 64 logo · 96 description · 128 socialsOffset
     160 feeRecipient · 192 creatorTaxBps · 224 buybackEnabled · 256 econ · 288 salt */
async function fetchLaunchTxMeta(txHash) {
  try {
    const tx = await rpc('eth_getTransactionByHash', [txHash]);
    if (!tx?.input || tx.input.length < 400) return null;
    const d = hx(tx.input);
    const s0 = d.subarray(0, 4).toString('hex');
    const isFor = s0 === SELS.ltf5.slice(2), isLt4 = s0 === SELS.lt4.slice(2), isLt3 = s0 === SELS.lt3.slice(2);
    if (!isFor && !isLt4 && !isLt3) return null;
    const head = (k) => 4 + 32 * k;
    const wAt = (o) => { try { return BigInt('0x' + (d.subarray(o, o + 32).toString('hex') || '0')); } catch { return 0n; } };
    const sIn = (base, k) => { try { const off = base + Number(wAt(base + 32 * k)); if (off + 32 > d.length) return '';
      const len = Number(wAt(off)); if (len > 8192 || off + 32 + len > d.length) return '';
      return d.subarray(off + 32, off + 32 + len).toString('utf8'); } catch { return ''; } };
    const aIn = (base, k) => { try { const o = base + 32 * k;
      return o + 32 <= d.length ? '0x' + d.subarray(o + 12, o + 32).toString('hex') : ZERO_ADDR; } catch { return ZERO_ADDR; } };
    const P0 = head(0) + Number(wAt(head(0)));
    const S = P0 + Number(wAt(P0 + 128));
    const socials = []; for (let i = 0; i < 5; i++) socials.push(sIn(S, i));
    const out = {
      name: sIn(P0, 0), symbol: sIn(P0, 1), logo: sIn(P0, 2), description: sIn(P0, 3),
      socials, feeRecipient: aIn(P0, 5), taxBps: Number(wAt(P0 + 192)), buyback: wAt(P0 + 224) !== 0n,
      launchConfigId: wAt(head(1)), pairToken: aIn(head(2)), originalDeployer: '', exemptions: [],
    };
    if (isFor) out.originalDeployer = aIn(head(3));
    const exK = isFor ? 4 : (isLt4 ? 3 : -1);
    if (exK >= 0 && d.length >= head(exK) + 32) {
      try { const A = head(0) + Number(wAt(head(exK))); const n = Math.min(Number(wAt(A)), 20);
        for (let i = 0; i < n; i++) out.exemptions.push('0x' + d.subarray(A + 32 + 32 * i + 12, A + 32 + 32 * i + 32).toString('hex'));
      } catch {}
    }
    return out;
  } catch { return null; }
}
function decodeLaunchedToken(ret) {   // getLaunchedToken → 15 static words
  try {
    const d = hx(ret); if (d.length < 480) return null;
    const w = (i) => { const s = d.subarray(i * 32, i * 32 + 32).toString('hex'); return s ? BigInt('0x' + s) : 0n; };
    const a = (i) => '0x' + d.subarray(i * 32 + 12, i * 32 + 32).toString('hex');
    return { curve: a(1), deployer: a(2), creatorFeeRecipient: a(3), pairToken: a(4),
      graduationThreshold: w(5), poolFee: Number(w(6)), tickSpacing: Number(BigInt.asIntN(24, w(7))),
      creatorTaxBps: Number(w(8)), buybackEnabled: w(9) !== 0n, phase: Number(w(10)), exists: w(14) !== 0n };
  } catch { return null; }
}
function decodeOneString(ret) {
  try { const d = hx(ret); if (d.length < 64) return '';
    const off = Number(BigInt('0x' + d.subarray(0, 32).toString('hex')));
    const len = Number(BigInt('0x' + d.subarray(off, off + 32).toString('hex')));
    return d.subarray(off + 32, off + 32 + Math.min(len, 4096)).toString('utf8');
  } catch { return ''; }
}
function decodeSocials5(ret) {        // socials() → 5 strings (heads: 160, then offsets rel. base)
  try {
    const d = hx(ret);
    const w = (o) => Number(BigInt('0x' + (d.subarray(o, o + 32).toString('hex') || '0')));
    if (d.length < 32 || w(0) !== 160) return null;
    const s = [];
    for (let i = 0; i < 5; i++) { const off = w(i * 32); if (off + 32 > d.length) return null;
      s.push(d.subarray(off + 32, off + 32 + Math.min(w(off), 2048)).toString('utf8')); }
    return s;
  } catch { return null; }
}

/* ── enrichment ─────────────────────────────────────────────────────── */
const enrichQueue = [];
async function drainEnrich() {
  let n = 0;
  while (enrichQueue.length) {
    const token = enrichQueue.shift();
    const l = L.get(token); if (!l || (l.enriched && l.metaFromTx)) continue;
    try {
      if (l.launchTx && !l.metaFromTx) {
        const m = await fetchLaunchTxMeta(l.launchTx);
        if (m) {
          if (m.name) l.name = m.name;
          if (m.symbol) l.symbol = m.symbol;
          if (m.logo) l.image = m.logo;
          if (m.description) l.description = m.description;
          [l.twitter, l.telegram, l.discord, l.website, l.farcaster] = m.socials;
          if (m.feeRecipient && m.feeRecipient !== ZERO_ADDR) l.feeRecipient = m.feeRecipient;
          if (m.taxBps) l.creatorTaxBps = BigInt(m.taxBps);
          l.buybackEnabled = m.buyback;
          l.snipeExemptions = m.exemptions;
          if (m.originalDeployer && m.originalDeployer !== ZERO_ADDR) l.originalDeployer = m.originalDeployer;
          if (m.pairToken && m.pairToken !== ZERO_ADDR) { l.pairAsset = m.pairToken; l.ethPair = C.WETH.includes(m.pairToken); }
          l.metaFromTx = true;
        }
      }
      if (!l.curve) { const c = await callAddr(token, 'curve()'); if (c && c !== ZERO_ADDR) { l.curve = c; curveToToken.set(c, token); } }
      const g = decodeLaunchedToken(await ethCall(C.FACTORY, SELS.glt + pad32(token)));
      if (g?.exists) {
        if (!l.feeRecipient && g.creatorFeeRecipient && g.creatorFeeRecipient !== ZERO_ADDR) l.feeRecipient = g.creatorFeeRecipient;
        if (!l.creatorTaxBps && g.creatorTaxBps) l.creatorTaxBps = BigInt(g.creatorTaxBps);
        if (g.pairToken && g.pairToken !== ZERO_ADDR) { l.pairAsset = g.pairToken; l.ethPair = C.WETH.includes(g.pairToken); }
        if (g.graduationThreshold) l.graduationThreshold = g.graduationThreshold;
        l.poolFee = g.poolFee; l.tickSpacing = g.tickSpacing; l.phase = g.phase;
      }
      if (l.curve) {   // exact per-curve economics (immutables → one-time)
        if (!l.creatorTaxBps) l.creatorTaxBps = await callUint(l.curve, 'creatorTaxBps()');
        if (!l.curveFeeBps) l.curveFeeBps = await callUint(l.curve, 'feeBps()');
        if (!l.protocolShareBps) l.protocolShareBps = await callUint(l.curve, 'protocolFeeShareBps()');
        if (!l.buybackBurnBps) l.buybackBurnBps = await callUint(l.curve, 'buybackBurnBps()');
        if (!l.snipeTaxStartBps) l.snipeTaxStartBps = await callUint(l.curve, 'snipeTaxStartBps()');
        if (!l.snipeTaxSeconds) l.snipeTaxSeconds = await callUint(l.curve, 'snipeTaxSeconds()');
      }
      if (!l.name)   l.name   = decodeOneString(await ethCall(token, sel('name()')))   || l.name;
      if (!l.symbol) l.symbol = decodeOneString(await ethCall(token, sel('symbol()'))) || l.symbol;
      if (!l.twitter && !l.description) {   // token-view metadata fallback
        const soc = decodeSocials5(await ethCall(token, SELS.socials));
        if (soc) { [l.twitter, l.telegram, l.discord, l.website, l.farcaster] = soc; }
        l.description = decodeOneString(await ethCall(token, SELS.description)) || l.description;
        l.image = decodeOneString(await ethCall(token, SELS.logo)) || l.image;
      }
      if (l.pairAsset && l.pairAsset !== ZERO_ADDR && !l.ethPair && l.pairDecimals === 18) l.pairDecimals = await decimalsOf(l.pairAsset);
      if (C.SUPPLY_FETCH && !(l.totalSupply > 0n)) l.totalSupply = await callUint(token, 'totalSupply()');
      l.enriched = true;
    } catch {}
    if (++n % 20 === 0) await sleep(100);
  }
}

/* ── window buckets (cumulative: 1h ⊂ 24h ⊂ all) ────────────────────── */
function wOf(l, ts) { const dt = ts - l.launchTs; return dt <= 3600 ? 3 : dt <= 86400 ? 2 : 1; }
function addW(l, base, amt, ts) { const w = wOf(l, ts);
  if (w >= 2) l[base + '24h'] = (l[base + '24h'] ?? 0n) + amt;
  if (w === 3) l[base + '1h'] = (l[base + '1h'] ?? 0n) + amt; }
function genCreator(l, fee, tax) {   // exact per contract: tax→creator in full; fee→protocol cut then creator/buyback split
  const ps = l.protocolShareBps || 3000n, bb = l.buybackBurnBps || 5000n;
  let fc = fee - (fee * ps) / 10000n;
  if (l.buybackEnabled) fc -= (fc * bb) / 10000n;
  return tax + (fc > 0n ? fc : 0n);
}

/* ── exact pending-creator probe (curve state + hook mappings) ──────── */
async function probePending(l) {
  try {
    if (l.curve && !l.graduated) {
      const qf = await callUint(l.curve, 'quoteFeeBalance()');
      const ct = await callUint(l.curve, 'creatorTaxBalance()');
      const bb = await callUint(l.curve, 'buybackQuoteBalance()');
      const ps = await callUint(l.curve, 'protocolFeeShareBps()');
      const bucket = qf - (qf * ps) / 10000n;
      l.pendingCurve = ct + (bucket > bb ? bucket - bb : 0n);
    }
    if (C.HOOK && l.poolId && l.graduated && !String(l.poolId).startsWith('v4pos:')) {
      const pid = padB32(l.poolId);
      const q = poolQuote.get(String(l.poolId).toLowerCase()) || ZERO_ADDR;
      const F = await ethCall(C.HOOK, SELS.hpf + pid + pad32(q));
      const T = await ethCall(C.HOOK, SELS.hpct + pid + pad32(q));
      const psH = await callUint(C.HOOK, 'protocolFeeShareBps()');
      const f = F ? BigInt(F) : 0n, t = T ? BigInt(T) : 0n;
      l.pendingHook = t + (f - (f * psH) / 10000n);
    }
  } catch {}
}

/* ── reducers ───────────────────────────────────────────────────────── */
function ensureRow(token) {
  let l = L.get(token);
  if (!l) l = L.get(token) = {
    token, curve: '', creator: '', originalDeployer: '', feeRecipient: '',
    name: '', symbol: '', description: '', image: '', website: '', twitter: '', telegram: '', discord: '', farcaster: '',
    pairAsset: ZERO_ADDR, pairDecimals: 18, ethPair: true,
    creatorTaxBps: 0n, curveFeeBps: 0n, snipeTaxStartBps: 0n, snipeTaxSeconds: 0n,
    protocolShareBps: 0n, buybackBurnBps: 0n,
    totalSupply: 0n, graduationThreshold: 0n, launchConfigId: 0n, poolFee: 0, tickSpacing: 0, phase: 0,
    buybackEnabled: false, snipeExemptions: [], snipeExemptCount: 0,
    launchBlock: 0, launchTs: 0, launchTx: '', metaFromTx: false, enriched: false,
    buyVolume: 0n, sellVolume: 0n, buys: 0, sells: 0, buyers: new Set(), sellers: new Set(),
    firstTradeTs: 0, lastTradeTs: 0, lastTradeBlock: 0, earlyVolMin: Array(30).fill(0n),
    vol1h: 0n, trades1h: 0,
    peakPrice: 0, lastPrice: 0, peakBlock: 0,
    graduated: false, gradBlock: 0, gradTs: 0, gradFailed: false, poolId: '',
    gradQuote: 0n, gradTokens: 0n, gradSweptQuote: 0n, gradSweptTokens: 0n, rescuedQuote: 0n, lockedTokens: 0n,
    sweptCurve: 0n, rescuedCreator: 0n, poolCreator: 0n, poolRescued: 0n, pendingCurve: 0n, pendingHook: 0n,
    buybackQuote: 0n, buybackTokens: 0n,
    earn1h: 0n, earn24h: 0n, gen1h: 0n, gen24h: 0n, genTotal: 0n, bb1h: 0n,
    snipeTaxTotal: 0n, snipers: new Set(),
  };
  return l;
}
const topicAddr = (t) => (t && t.length === 66 ? '0x' + t.slice(-40) : undefined);
const byCurve = (lg) => L.get(curveToToken.get(addr(lg.address)) || '');
const byPool = (pid) => L.get(poolToToken.get(String(pid ?? '').toLowerCase()) || '');

function onLaunch(a, lg) {
  const token = addr(a.token || topicAddr(lg.topics?.[1]));
  if (!token) return;
  const l = ensureRow(token);
  const curve = addr(a.curve || topicAddr(lg.topics?.[2]));
  if (curve) { l.curve = curve; curveToToken.set(curve, token); }
  l.creator = addr(a.deployer || topicAddr(lg.topics?.[3])) || l.creator;
  const pa = addr(a.pairToken || '');
  if (pa && pa !== ZERO_ADDR) { l.pairAsset = pa; l.ethPair = C.WETH.includes(pa); }
  if (a.graduationThreshold !== undefined) l.graduationThreshold = B(a.graduationThreshold);
  if (a.launchConfigId !== undefined) l.launchConfigId = B(a.launchConfigId);
  l.launchBlock = Number(lg.blockNumber); l.launchTx = lg.transactionHash || ''; l.launchTs = tsOf(l.launchBlock);
  enrichQueue.push(token);
}
async function onTrade(name, a, lg, ts) {
  const l = byCurve(lg); if (!l) return;
  if (!l.protocolShareBps && l.curve) {   // lazy policy fetch so gen is exact from trade #1
    l.protocolShareBps = await callUint(l.curve, 'protocolFeeShareBps()');
    l.buybackBurnBps = await callUint(l.curve, 'buybackBurnBps()');
  }
  const isBuy = name === 'CurveBuy';
  const fee = B(a.fee), tax = B(a.tax);
  const q = isBuy ? B(a.quoteIn) : B(a.quoteOut) + fee + tax;   // gross quote turnover
  const tok = isBuy ? B(a.tokensOut) : B(a.tokensIn);
  if (isBuy) { l.buys++; l.buyVolume += q; } else { l.sells++; l.sellVolume += q; }
  const trader = addr(a.buyer || a.seller);
  if (C.TRACK_WALLETS && trader) (isBuy ? l.buyers : l.sellers).add(trader);
  if (!l.firstTradeTs) l.firstTradeTs = ts;
  l.lastTradeTs = ts; l.lastTradeBlock = Number(lg.blockNumber);
  const m = Math.floor((ts - l.launchTs) / 60);
  if (m >= 0 && m < 30) l.earlyVolMin[m] += q;
  const gen = genCreator(l, fee, tax);
  l.genTotal += gen; addW(l, 'gen', gen, ts);
  if (wOf(l, ts) === 3) { l.vol1h += q; l.trades1h++; }
  if (tok > 0n && q > 0n) { const price = Number(q) / Number(tok);
    l.lastPrice = price; if (price > l.peakPrice) { l.peakPrice = price; l.peakBlock = l.lastTradeBlock; } }
  if (C.SAVE_TRADES) appendLines(P.trades, [{ token: l.token, type: isBuy ? 'buy' : 'sell',
    quote: q.toString(), tok: tok.toString(), fee: fee.toString(), tax: tax.toString(),
    block: l.lastTradeBlock, ts, tx: lg.transactionHash }]);
}
function onGradEvent(a, lg, viaCurve) {
  const token = viaCurve ? (curveToToken.get(addr(lg.address)) || '') : addr(a.token || topicAddr(lg.topics?.[1]));
  const l = token && L.get(token); if (!l) return;
  const first = !l.graduated;
  l.graduated = true; l.gradBlock = Number(lg.blockNumber); l.gradTs = tsOf(l.gradBlock);
  if (first) {
    if (a.quoteOut !== undefined) l.gradQuote += B(a.quoteOut);
    if (a.tokenOut !== undefined) l.gradTokens += B(a.tokenOut);
    if (a.pairTokenAmount !== undefined) l.gradQuote += B(a.pairTokenAmount);
    if (a.tokenAmount !== undefined && a.quoteOut === undefined) l.gradTokens += B(a.tokenAmount);
    const pid = a.positionId !== undefined ? 'v4pos:' + a.positionId : undefined;
    if (pid && !l.poolId) l.poolId = pid;
  }
}

/* ── scan passes ────────────────────────────────────────────────────── */
const ACTIVITY_NAMES = /curvebuy$|curvesell$|feesswept|feesrescued|buybacklocked|curvecompleted|snipetax|initialized|autograduationfailed|poolregistered|hookfeecollected|poolfeesswept|poolfeesrescued|poolbuybackskipped|poolconversionskipped|creatorfeerecipientupdated|buybackenabledupdated/;
async function processLogs(logs) {
  const raws = [];
  for (const lg of logs) {
    const t0 = (lg.topics?.[0] || '').toLowerCase();
    const def = EV.get(t0);
    if (!def) continue;
    const a = decodeLog(def, lg.topics, lg.data);
    const n = def.name.toLowerCase();
    const src = addr(lg.address);
    const ts = tsOf(Number(lg.blockNumber));
    if (n === 'tokenlaunched') onLaunch(a, lg);
    else if (n === 'curvebuy' || n === 'curvesell') await onTrade(def.name, a, lg, ts);
    else if (n === 'initialized') { const tok = addr(a.token); if (tok && !curveToToken.get(src)) { curveToToken.set(src, tok); ensureRow(tok).curve = src; } }
    else if (n === 'feesswept') { const l = byCurve(lg); if (l) { const amt = B(a.creatorAmount); l.sweptCurve += amt; addW(l, 'earn', amt, ts); } }
    else if (n === 'feesrescued') { const l = byCurve(lg); if (l) { const amt = B(a.creatorAmount); l.rescuedCreator += amt; addW(l, 'earn', amt, ts); } }
    else if (n === 'buybacklocked') { const l = byCurve(lg); if (l) { l.buybackQuote += B(a.quoteSpent); l.buybackTokens += B(a.tokensLocked); addW(l, 'bb', B(a.quoteSpent), ts); } }
    else if (n === 'snipetaxcharged') { const l = byCurve(lg); if (l) { l.snipeTaxTotal += B(a.amount); if (C.TRACK_WALLETS && a.recipient) l.snipers.add(addr(a.recipient)); } }
    else if (n === 'snipetaxexempted') { const l = byCurve(lg); if (l) l.snipeExemptCount++; }
    else if (n === 'curvecompleted') onGradEvent(a, lg, true);
    else if (n === 'poolgraduated') onGradEvent(a, lg, false);
    else if (n === 'launchswept') { const l = L.get(addr(a.token || topicAddr(lg.topics?.[1]))); if (l) { l.gradSweptQuote += B(a.quoteOut); l.gradSweptTokens += B(a.tokenOut); l.graduated = true; if (!l.gradTs) l.gradTs = ts; } }
    else if (n === 'launchforceswept') { const l = L.get(addr(a.token || topicAddr(lg.topics?.[1]))); if (l) { l.graduated = true; if (!l.gradTs) l.gradTs = ts; } }
    else if (n === 'launchgraduationrescued') { const l = L.get(addr(a.token || topicAddr(lg.topics?.[1]))); if (l) l.rescuedQuote += B(a.quoteAmount); }
    else if (n === 'graduationtokenspermanentlylocked') { const l = L.get(addr(a.token || topicAddr(lg.topics?.[1]))); if (l) l.lockedTokens += B(a.amount); }
    else if (n === 'poolregistered') {
      const tok = addr(a.memecoin);
      poolToToken.set(String(a.poolId).toLowerCase(), tok);
      poolQuote.set(String(a.poolId).toLowerCase(), addr(a.quoteToken));
      const l = ensureRow(tok);
      if (!l.poolId) { l.poolId = String(a.poolId);
        if (!l.graduated) { l.graduated = true; l.gradBlock = Number(lg.blockNumber); l.gradTs = ts; } }
    }
    else if (n === 'hookfeecollected') { const l = byPool(a.poolId); if (l) {
      const savePS = l.protocolShareBps, saveBB = l.buybackBurnBps;
      l.protocolShareBps = C.HOOK_PS || 3000n; l.buybackBurnBps = C.HOOK_BB || 5000n;
      const gen = genCreator(l, B(a.feeAmount), B(a.taxAmount));
      l.protocolShareBps = savePS; l.buybackBurnBps = saveBB;
      l.genTotal += gen; addW(l, 'gen', gen, ts); } }
    else if (n === 'poolfeesswept') { const l = byPool(a.poolId); if (l) {
      const amt = B(a.creatorAmount); l.poolCreator += amt; addW(l, 'earn', amt, ts);
      l.buybackQuote += B(a.buybackAmount); l.buybackTokens += B(a.tokensLocked); addW(l, 'bb', B(a.buybackAmount), ts); } }
    else if (n === 'poolfeesrescued') { const l = byPool(a.poolId); if (l) { const amt = B(a.creatorAmount); l.poolRescued += amt; addW(l, 'earn', amt, ts); } }
    else if (n === 'creatorfeerecipientupdated') {
      if (src === C.FACTORY) { const l = L.get(addr(a.token)); if (l && a.newRecipient) l.feeRecipient = addr(a.newRecipient); }
      else if (src === C.HOOK) { const l = byPool(a.poolId); if (l && a.newRecipient) l.feeRecipient = addr(a.newRecipient); }
      else { const l = byCurve(lg); if (l && a.newRecipient) l.feeRecipient = addr(a.newRecipient); }
    }
    else if (n === 'buybackenabledupdated') {
      if (src === C.FACTORY) { const l = L.get(addr(a.token)); if (l) l.buybackEnabled = !!a.enabled; }
      else if (src === C.HOOK) { const l = byPool(a.poolId); if (l) l.buybackEnabled = !!a.enabled; }
      else { const l = byCurve(lg); if (l) l.buybackEnabled = !!a.enabled; }
    }
    else if (n === 'autograduationfailed') { const l = L.get(addr(a.token)); if (l && !l.graduated) l.gradFailed = true; }
    raws.push({ ev: def.name, block: Number(lg.blockNumber), ts, tx: lg.transactionHash, src, args: a });
  }
  appendLines(P.events, raws);
  if (enrichQueue.length) await drainEnrich();
  return raws.length;
}
async function scanFactory(a, b) { return processLogs(await fetchLogs([C.FACTORY], null, a, b)); }
async function scanActivity(a, b) {
  const targets = [...curveToToken.keys()];
  if (C.HOOK) targets.push(C.HOOK);
  if (!targets.length) return 0;
  const t = [[...EV.entries()].filter(([, d]) => ACTIVITY_NAMES.test(d.name.toLowerCase())).map(([k]) => k)];
  return processLogs(await fetchLogs(targets, t, a, b));
}

/* ── backfill + live ────────────────────────────────────────────────── */
const head = async () => fromHex(await rpc('eth_blockNumber', []));
let lastProg = 0, lastAnchorSave = 0, lastFullSave = 0;
function tick(force, headBlock, phase) {
  const now = Date.now();
  if (force || now - lastProg > 5000) { lastProg = now; const p = progress(phase, headBlock);
    process.stdout.write(`\r${phase} ${p.pct}% · blk ${p.currentBlock}/${p.headBlock} · ${p.blocksPerSec} blk/s · ETA ${p.etaMinutes ?? '—'}m · ${p.launches} launches   `); }
  if (now - lastAnchorSave > 60000) { lastAnchorSave = now; persistAnchors(); saveState(); saveRpcState(); }
  if (now - lastFullSave > 60000) { lastFullSave = now; saveLaunches(); }
}

async function backfill() {
  const t0 = Date.now();                                                        // ← NEW
  const outOfTime = () => C.MAX_MINUTES > 0 && (Date.now() - t0) / 60000 > C.MAX_MINUTES;  // ← NEW
  const h0 = await head();
  log(`head=${h0} · resume factory@${STATE.factoryBlock + 1} activity@${STATE.activityBlock + 1} · chunk=${STATE.chunk}`);
  if (!STATE.satsFound) {
    try {
      const hook = await callAddr(C.FACTORY, 'memeHook()'), esc = await callAddr(C.FACTORY, 'feeEscrow()');
      const vault = await callAddr(C.FACTORY, 'buybackVault()'), lock = await callAddr(C.FACTORY, 'locker()');
      if (hook && hook !== ZERO_ADDR) { C.HOOK = hook; log(`[auto] memeHook=${hook}`); }
      if (esc && esc !== ZERO_ADDR) log(`[auto] feeEscrow=${esc}`);
      log(`[auto] buybackVault=${vault || '—'} locker=${lock || '—'}`);
      if (C.HOOK) {
        C.HOOK_PS = await callUint(C.HOOK, 'protocolFeeShareBps()');
        C.HOOK_BB = await callUint(C.HOOK, 'buybackBurnBps()');
        log(`[auto] hook policy: protocolShare=${C.HOOK_PS}bps buybackBurn=${C.HOOK_BB}bps`);
      }
      try { const num = await callUint(C.FACTORY, 'snipeTaxSeconds()'); const bps = await callUint(C.FACTORY, 'snipeTaxStartBps()');
        log(`[protocol] snipe tax ${bps}bps → 0 over ${num}s · maxCreatorTax ${await callUint(C.FACTORY, 'maxCreatorTaxBps()')}bps`); } catch {}
      STATE.satsFound = true; saveState();
    } catch (e) { log('[auto] satellite discovery failed:', String(e).slice(0, 90)); }
  }
  for (;;) {
    if (outOfTime()) { log('[time] cap reached — saving & exiting; next run resumes from checkpoint'); break; }   // ← NEW
    const h = (await head()) - C.CONFIRMATIONS;
    if (STATE.factoryBlock >= h) break;
    const to = Math.min(STATE.factoryBlock + STATE.chunk, h);
    const n = await scanFactory(STATE.factoryBlock + 1, to);
    STATE.factoryBlock = to; tick(false, h, 'factory');
    if (n) process.stdout.write(`(+${n} factory ev)`);
  }
  saveState(); console.log('');
  while (STATE.activityBlock < STATE.factoryBlock) {
    if (outOfTime()) { log('[time] cap reached — saving & exiting; next run resumes from checkpoint'); break; }   // ← NEW
    const to = Math.min(STATE.activityBlock + STATE.chunk, STATE.factoryBlock);
    const n = await scanActivity(STATE.activityBlock + 1, to);
    STATE.activityBlock = to; tick(false, STATE.factoryBlock, 'activity');
    if (n) process.stdout.write(`(+${n})`);
  }
  for (const l of L.values()) if (!l.enriched || !l.metaFromTx) enrichQueue.push(l.token);
  await drainEnrich();
  if (C.PROBE_PENDING && !outOfTime()) {                                        // ← NEW (skip probe when time's up)
    let i = 0;
    for (const l of L.values()) { await probePending(l); if (++i % 200 === 0) { log(`[pending] ${i}/${L.size}`); saveLaunches(); } }
  }
  const chk = [...L.values()].filter(l => l.genTotal > 0n)
    .map(l => Number(l.sweptCurve + l.rescuedCreator + l.poolCreator + l.poolRescued + l.pendingCurve + l.pendingHook) / Number(l.genTotal)).sort((a, b) => a - b);
  if (chk.length) log(`[check] generated-vs-credited ratio: median ${chk[chk.length >> 1].toFixed(2)} over ${chk.length} earners (≈1 = consistent · >1.3 or <0.7 = investigate)`);
  saveLaunches(); persistAnchors(); saveState(); saveRpcState();
  progress(outOfTime() ? 'time-capped' : 'backfill-done', await head());        // ← NEW (honest label)
  const totals = [...L.values()].reduce((s, l) => s + l.sweptCurve + l.rescuedCreator + l.poolCreator + l.poolRescued + l.pendingCurve + l.pendingHook, 0n);
  console.log(`\n[done] ${L.size} launches · protocol-wide creator earnings: ${Number(totals) / 1e18} (quote units) → ${P.launches}`);
}


async function live() {
  log(`[live] tail every ${C.POLL_MS}ms — Ctrl-C anytime, resume is automatic`);
  for (;;) {
    try {
      const h = (await head()) - C.CONFIRMATIONS;
      if (h > STATE.factoryBlock) {
        const nA = await scanFactory(STATE.factoryBlock + 1, h); STATE.factoryBlock = h;
        const nB = await scanActivity(STATE.activityBlock + 1, h); STATE.activityBlock = h;
        saveState();
        if (nA + nB) { saveLaunches(); log(`[live] +${nA} factory, +${nB} activity · total ${L.size}`); }
      }
      tick(true, h, 'live'); persistAnchors();
    } catch (e) { log('[live]', String(e).slice(0, 140)); }
    await sleep(C.POLL_MS);
  }
}

/* ── helper commands ────────────────────────────────────────────────── */
async function discover(target) {
  const a = addr(target || C.FACTORY);
  const h = (await head()) - C.CONFIRMATIONS;
  log(`[discover] ${a} · ${C.START_BLOCK} → ${h}`);
  const census = new Map(); let ch = STATE.chunk, s = C.START_BLOCK;
  while (s <= h) {
    const e = Math.min(s + ch - 1, h);
    try {
      const logs = await rpc('eth_getLogs', [{ address: a, fromBlock: toHex(s), toBlock: toHex(e) }]);
      for (const lg of logs || []) { const t = (lg.topics?.[0] || '').toLowerCase(); if (!census.has(t)) census.set(t, { n: 0, sample: lg }); census.get(t).n++; }
      process.stdout.write(`\r  …${e}/${h} (chunk ${ch})   `); s = e + 1;
    } catch (err) { if (err.rateLimited) { ch = Math.max(500, ch >> 1); await sleep(1500); } else { s = e + 1; } }
  }
  console.log('');
  for (const [t, { n, sample }] of [...census].sort((x, y) => y[1].n - x[1].n).slice(0, 30)) {
    const def = EV.get(t);
    console.log(`\n${t} ×${n} ${def ? `= ${def.sig}` : '= UNKNOWN'}`);
    console.log(' ', def ? JSON.stringify(decodeLog(def, sample.topics, sample.data), replacer).slice(0, 400)
                          : `topics=${sample.topics.join(',')} data=${(sample.data || '').slice(0, 160)}`);
  }
  fs.writeFileSync(path.join(C.DATA_DIR, 'discover_topics.json'), JSON.stringify([...census.keys()], null, 2));
}
async function findStart() {
  const h = await head();
  for (let s = C.START_BLOCK; s < h; s += 5000) {
    const e = Math.min(s + 4999, h);
    const logs = await rpc('eth_getLogs', [{ address: C.FACTORY, fromBlock: toHex(s), toBlock: toHex(e) }]).catch(() => null);
    if (logs === null) continue;
    process.stdout.write(`\rscanned to ${e}   `);
    if (logs.length) {
      const at = async (b) => (await rpc('eth_getLogs', [{ address: C.FACTORY, fromBlock: toHex(b), toBlock: toHex(b) }]).catch(() => [])).length > 0;
      let lo = s, hi2 = e;
      while (lo < hi2) { const m = (lo + hi2) >> 1; (await at(m)) ? hi2 = m : lo = m + 1; }
      console.log(`\nfirst factory activity ≈ block ${lo} → START_BLOCK=${lo}`);
      return;
    }
  }
  console.log('\nno factory activity found up to head');
}
async function timeline(tokenArg) {
  const l = L.get(addr(tokenArg));
  if (!l?.curve) return console.error('token/curve not in registry — run the indexer first');
  const to = (await head()) - C.CONFIRMATIONS;
  const t = [[...EV.entries()].filter(([, d]) => /^Curve(Buy|Sell)$/.test(d.name)).map(([k]) => k)];
  const logs = await fetchLogs([l.curve], t, l.launchBlock || C.START_BLOCK, to);
  const mins = new Map();
  for (const lg of logs) {
    const def = EV.get((lg.topics?.[0] || '').toLowerCase()); if (!def) continue;
    const a = decodeLog(def, lg.topics, lg.data);
    const isBuy = def.name === 'CurveBuy';
    const ts = tsOf(Number(lg.blockNumber)), m = Math.floor((ts - l.launchTs) / 60);
    const fee = B(a.fee), tax = B(a.tax);
    const q = isBuy ? B(a.quoteIn) : B(a.quoteOut) + fee + tax;
    const tok = isBuy ? B(a.tokensOut) : B(a.tokensIn);
    const r = mins.get(m) || { minute: m, vol: 0n, buys: 0, sells: 0, price: 0 };
    r.vol += q; if (isBuy) r.buys++; else r.sells++;
    if (tok > 0n && q > 0n) r.price = Number(q) / Number(tok);
    mins.set(m, r);
  }
  const file = path.join(C.DATA_DIR, `timeline_${(l.symbol || l.token.slice(0, 8)).replace(/\W/g, '')}.jsonl`);
  fs.writeFileSync(file, [...mins.values()].sort((a, b) => a.minute - b.minute).map(r => JSON.stringify({ ...r, vol: r.vol.toString() }, replacer)).join('\n') + '\n');
  const sum = (a2, b2) => [...mins.values()].filter(r => r.minute >= a2 && r.minute <= b2).reduce((s2, r) => s2 + r.vol, 0n);
  const pd = l.pairDecimals || 18;
  console.log(JSON.stringify({ symbol: l.symbol, pair: l.pairAsset === ZERO_ADDR ? 'native' : l.pairAsset,
    totalVol: Number(l.buyVolume + l.sellVolume) / 10 ** pd,
    volFirst1m: Number(sum(0, 0)) / 10 ** pd, volFirst5m: Number(sum(0, 4)) / 10 ** pd,
    volFirst30m: Number(sum(0, 29)) / 10 ** pd, peakPrice: l.peakPrice, file }, replacer, 2));
}

/* ── main ───────────────────────────────────────────────────────────── */
const argv = new Set(process.argv.slice(2));
const target = process.argv.slice(2).find(a => /^0x[0-9a-f]{40}$/i.test(a));
process.on('SIGINT', async () => { console.log('\n[shutdown] flushing…'); try { saveLaunches(); saveState(); persistAnchors(); saveRpcState(); } catch {} process.exit(0); });
await bootChainCheck();
await loadLaunches();
if (argv.has('--discover')) await discover(target);
else if (argv.has('--find-start')) await findStart();
else if (argv.has('--timeline') && target) await timeline(target);
else { await backfill(); if (!argv.has('--backfill')) await live(); }
