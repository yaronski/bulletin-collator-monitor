/**
 * Multi-chain collator telemetry + on-chain monitor (Polkadot / Kusama ecosystem)
 *
 * Two data sources, one status.json:
 *
 * 1. Telemetry (wss://feed.telemetry.polkadot.io/feed)
 *    Nodes matched by libp2p PeerID (recommended, stable) or display name.
 *    -> "is my node running and visible?"
 *
 * 2. On-chain RPC (state_getStorage, no state_call needed)
 *    Nodes matched by SS58 address (Kusama- or Polkadot-style, any prefix —
 *    decoded to the raw 32-byte account, so both styles work everywhere).
 *      Session.Validators                 = active collator/validator set
 *      CollatorSelection.Candidates       = bonded candidates (parachains)
 *      CollatorSelection.Invulnerables    = system collators (parachains)
 *    -> "is my collator in the active set / still a candidate?"
 *    Parachains: alert when the address disappears from the candidate list
 *    (kicked/unbonded). active<->standby rotation is normal — no alert.
 *    Relay chains: display only (rotation is era-based), no alerts.
 *
 * Storage keys are twox128(module)+(name), SS58 via blake2b512 checksum —
 * all implemented locally, zero dependencies (Node 22+, crypto + WebSocket
 * built-ins). Alerting via Telegram, state in status.json.
 *
 * Protocol notes (paritytech/substrate-telemetry, feed.ts):
 *   client sends:  "subscribe:<genesis-hash>" and "ping:<id>"
 *   server sends binary frames: [opcode, payload, ...]
 *     3 AddedNode / 4 RemovedNode / 6 ImportedBlock / 7 FinalizedBlock /
 *     8 NodeStats / 11 AddedChain / 12 RemovedChain / 13 SubscribedTo / 20 StaleNode
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const ROOT = join(dirname(__filename), '..');

const DEFAULT_FEED_URL = 'wss://feed.telemetry.polkadot.io/feed';
const DISCOVER_MS = Number(process.env.DISCOVER_MS) || 12 * 1000;
const LISTEN_MS = Number(process.env.LISTEN_MS) || 5 * 60 * 1000;

// Public RPC endpoints (verified via state_getStorage probes). Override or
// extend per chain with "rpcUrls" in config. Bulletin has no public RPC.
const DEFAULT_RPCS = {
  'Polkadot': 'https://rpc.polkadot.io',
  'Kusama': 'https://kusama-rpc.polkadot.io',
  'Polkadot Asset Hub': 'https://polkadot-asset-hub-rpc.polkadot.io',
  'Kusama Asset Hub': 'https://kusama-asset-hub-rpc.polkadot.io',
  'Polkadot People': 'https://polkadot-people-rpc.polkadot.io',
  'Kusama People': 'https://kusama-people-rpc.polkadot.io',
  'Polkadot Coretime': 'https://polkadot-coretime-rpc.polkadot.io',
  'Kusama Coretime': 'https://kusama-coretime-rpc.polkadot.io',
};

const readJSON = (p) => JSON.parse(readFileSync(p, 'utf8'));
const writeJSON = (p, d) => writeFileSync(p, JSON.stringify(d, null, 2) + '\n');
const shortPeer = (id) => id.slice(0, 10) + '…' + id.slice(-4);
const shortAddr = (a) => a.slice(0, 6) + '…' + a.slice(-4);

// ── XXH64 / twox128 storage keys ───────────────────────────────────────────
const P1 = 0x9e3779b185ebca87n, P2 = 0xc2b2ae3d27d4eb4fn, P3 = 0x165667b19e3779f9n;
const P4 = 0x85ebca77c2b2ae63n, P5 = 0x27d4eb2f165667c5n;
const U64 = 0xffffffffffffffffn;
const rotl = (x, r) => ((x << r) | (x >> (64n - r))) & U64;
const rd64 = (b, o) => { let v = 0n; for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[o + i]); return v; };
const rd32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const xrnd = (acc, val) => rotl((acc + val * P2) & U64, 31n) * P1 & U64;
const mrg = (acc, val) => (rotl(acc ^ xrnd(0n, val), 27n) * P1 + P4) & U64;

function xxh64(buf, seed = 0n) {
  const n = buf.length; let h;
  if (n >= 32) {
    let v1 = (seed + P1 + P2) & U64, v2 = (seed + P2) & U64, v3 = seed, v4 = (seed - P1) & U64;
    for (let o = 0; o + 32 <= n; o += 32) { v1 = xrnd(v1, rd64(buf, o)); v2 = xrnd(v2, rd64(buf, o + 8)); v3 = xrnd(v3, rd64(buf, o + 16)); v4 = xrnd(v4, rd64(buf, o + 24)); }
    h = (rotl(v1, 1n) + rotl(v2, 7n) + rotl(v3, 12n) + rotl(v4, 18n)) & U64;
    h = (h + mrg(0n, v1) + mrg(0n, v2) + mrg(0n, v3) + mrg(0n, v4) + BigInt(n)) & U64;
    let o = n & ~31;
    while (o + 8 <= n) { h = mrg(h, rd64(buf, o)); o += 8; }
    if (o + 4 <= n) { h ^= (BigInt(rd32(buf, o)) * P1) & U64; h = (rotl(h, 23n) * P2 + P3) & U64; o += 4; }
    while (o < n) { h ^= (BigInt(buf[o]) * P5) & U64; h = rotl(h, 11n) * P1 & U64; o++; }
  } else {
    h = (seed + P5 + BigInt(n)) & U64; let o = 0;
    while (o + 8 <= n) { h = mrg(h, rd64(buf, o)); o += 8; }
    if (o + 4 <= n) { h ^= (BigInt(rd32(buf, o)) * P1) & U64; h = (rotl(h, 23n) * P2 + P3) & U64; o += 4; }
    while (o < n) { h ^= (BigInt(buf[o]) * P5) & U64; h = rotl(h, 11n) * P1 & U64; o++; }
  }
  h ^= h >> 33n; h = h * P2 & U64; h ^= h >> 29n; h = h * P3 & U64; h ^= h >> 32n;
  return h;
}
function twox128(s) {
  const b = Buffer.from(s, 'utf8'); const out = Buffer.alloc(16);
  out.writeBigUInt64LE(xxh64(b, 0n), 0); out.writeBigUInt64LE(xxh64(b, 1n), 8);
  return out.toString('hex');
}
const storageKey = (mod, item) => '0x' + twox128(mod) + twox128(item);
const KEY_VALIDATORS = storageKey('Session', 'Validators');
const KEY_CANDIDATES = storageKey('CollatorSelection', 'Candidates');
const KEY_INVULN = storageKey('CollatorSelection', 'Invulnerables');

// ── SS58 ────────────────────────────────────────────────────────────────────
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58decode(s) {
  const idx = {}; for (let i = 0; i < B58.length; i++) idx[B58[i]] = i;
  const bytes = [0];
  for (const ch of s) {
    const v = idx[ch]; if (v === undefined) throw new Error('bad base58 char');
    let carry = v;
    for (let i = 0; i < bytes.length; i++) { carry += bytes[i] * 58; bytes[i] = carry & 0xff; carry >>= 8; }
    while (carry) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  let zeros = 0; while (zeros < s.length && s[zeros] === '1') zeros++;
  return Buffer.concat([Buffer.alloc(zeros), Buffer.from(bytes.reverse())]);
}
function b58encode(buf) {
  const digits = [0];
  for (const byte of buf) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) { carry += digits[i] << 8; digits[i] = carry % 58; carry = (carry / 58) | 0; }
    while (carry) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let zeros = 0; while (zeros < buf.length && buf[zeros] === 0) zeros++;
  let d = digits.reverse();
  while (d.length && d[0] === 0) d = d.slice(1);
  return '1'.repeat(zeros) + d.map((x) => B58[x]).join('');
}
const ss58Checksum = (body) => createHash('blake2b512').update(Buffer.concat([Buffer.from('SS58PRE'), body])).digest().subarray(0, 2);
function ss58Encode(rawHex, prefix) {
  const body = Buffer.concat([Buffer.from([prefix]), Buffer.from(rawHex.replace(/^0x/, ''), 'hex')]);
  return b58encode(Buffer.concat([body, ss58Checksum(body)]));
}
function ss58Decode(addr) {
  if (/^0x[0-9a-fA-F]{64}$/.test(addr)) return { raw: addr.toLowerCase(), prefix: null };
  const raw = b58decode(addr);
  if (raw.length < 35) throw new Error('too short');
  const prefix = raw[0];
  if (prefix > 63) throw new Error('2-byte ss58 prefix not supported');
  const body = raw.subarray(0, raw.length - 2);
  if (!ss58Checksum(body).equals(raw.subarray(raw.length - 2))) throw new Error('checksum mismatch (prefix ' + prefix + ')');
  const rawHex = '0x' + body.subarray(1).toString('hex');
  if (body.length - 1 !== 32) throw new Error('not a 32-byte AccountId (len ' + (body.length - 1) + ')');
  return { raw: rawHex, prefix };
}

// ── SCALE decoding ─────────────────────────────────────────────────────────
function readCompact(b, o) {
  const first = b[o];
  if ((first & 3) === 0) return { v: first >> 2, o: o + 1 };
  if ((first & 3) === 1) return { v: ((first >> 2) | (b[o + 1] << 6)) + 1, o: o + 2 };
  if ((first & 3) === 2) return { v: (((first >> 2) | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0) + 1, o: o + 4 };
  // big compact (u128 max needed for deposits)
  const nBig = ((first >> 2) & 0b111) + 4;
  let v = 0n;
  for (let i = nBig - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[o + 1 + i]);
  return { v: v + 1n, o: o + 1 + nBig };
}
function parseVecAccountId(hex) {
  const b = Buffer.from(hex.replace(/^0x/, ''), 'hex');
  const { v: len, o } = readCompact(b, 0);
  const out = [];
  for (let i = 0; i < len && o + 32 * (i + 1) <= b.length; i++) {
    out.push('0x' + b.subarray(o + 32 * i, o + 32 * i + 32).toString('hex'));
  }
  return out;
}
// Vec<CandidateInfo{ who: AccountId32, deposit: Compact<Balance> }>
function parseCandidates(hex) {
  const b = Buffer.from(hex.replace(/^0x/, ''), 'hex');
  const { v: len, o: start } = readCompact(b, 0);
  const out = [];
  let p = start;
  for (let i = 0; i < len && p + 32 <= b.length; i++) {
    const who = '0x' + b.subarray(p, p + 32).toString('hex');
    p += 32;
    const c = readCompact(b, p);
    out.push({ who, deposit: BigInt.asUintN(64, c.v) });
    p = c.o;
  }
  return out;
}

// ── JSON-RPC helper ────────────────────────────────────────────────────────
async function rpc(url, method, params, tries = 3) {
  let lastErr;
  for (let t = 0; t < tries; t++) {
    try {
      const res = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(12000),
      });
      const j = await res.json();
      if (j.error) throw new Error(j.error.message.slice(0, 80));
      return j.result;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1500 * (t + 1)));
    }
  }
  throw lastErr;
}

// ── Telegram ───────────────────────────────────────────────────────────────
async function sendTelegram(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatIds = process.env.TELEGRAM_CHAT_ID?.split(',').map((s) => s.trim()).filter(Boolean);
  if (!token || !chatIds?.length) {
    console.log('  [Telegram] No credentials set — skipping notification.');
    return;
  }
  for (const chatId of chatIds) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' }),
      });
      if (!res.ok) console.error('  [Telegram] Send failed:', (await res.text()).slice(0, 120));
      else console.log('  [Telegram] Alert sent to', chatId);
    } catch (err) {
      console.error('  [Telegram] Error:', err.message);
    }
  }
}

// ── Telemetry feed session ─────────────────────────────────────────────────
function feedSession(feedUrl, genesis, ms) {
  return new Promise((resolve) => {
    const registry = new Map();
    const nodes = new Map();
    const out = { connected: false, subscribed: false, error: null, registry, online: new Map() };
    let done = false;

    const ws = new WebSocket(feedUrl);
    ws.binaryType = 'arraybuffer';

    const finish = (reason) => {
      if (done) return;
      done = true;
      if (reason) console.log(`  [feed] ${reason}`);
      for (const [, n] of nodes) out.online.set(n.peerId, { ...n });
      try { ws.close(); } catch {}
      resolve(out);
    };

    ws.onopen = () => { out.connected = true; if (genesis) ws.send(`subscribe:${genesis}`); };
    ws.onmessage = (ev) => {
      let data;
      try { data = typeof ev.data === 'string' ? JSON.parse(ev.data) : JSON.parse(new TextDecoder().decode(ev.data)); } catch { return; }
      if (!Array.isArray(data)) return;
      for (let i = 0; i < data.length; i += 2) {
        const op = data[i], p = data[i + 1];
        switch (op) {
          case 3: {
            const [id, details, stats, io, hw, blockDetails, , startupTime] = p;
            if (!details?.[4]) break;
            const tsAvg = hw[2]?.length ? hw[2].reduce((a, b) => a + b, 0) / hw[2].length : Date.now();
            nodes.set(id, {
              name: details[0], impl: details[1], version: details[2], peerId: details[4],
              peers: stats?.[0] ?? null, txs: stats?.[1] ?? null,
              best: blockDetails[0], bestHash: blockDetails[1], ttpb: blockDetails[2],
              blockTs: blockDetails[3] || Math.round(tsAvg),
              finalized: null,
              stateSize: io?.[0]?.length ? io[0][io[0].length - 1] : null,
              uploadAvgBs: hw[0]?.length ? Math.round(hw[0].reduce((a, b) => a + b, 0) / hw[0].length) : null,
              downloadAvgBs: hw[1]?.length ? Math.round(hw[1].reduce((a, b) => a + b, 0) / hw[1].length) : null,
              startupTime: startupTime || null,
              stale: false,
              lastUpdate: Date.now(),
            });
            break;
          }
          case 4: nodes.delete(p); break;
          case 6: { const [id, bd] = p; const n = nodes.get(id); if (n) { n.best = bd[0]; n.bestHash = bd[1]; n.ttpb = bd[2]; n.blockTs = bd[3] || n.blockTs; n.lastUpdate = Date.now(); n.stale = false; } break; }
          case 7: { const [id, height] = p; const n = nodes.get(id); if (n) { n.finalized = height; n.lastUpdate = Date.now(); } break; }
          case 8: { const [id, stats] = p; const n = nodes.get(id); if (n) { n.peers = stats[0]; n.txs = stats[1]; n.lastUpdate = Date.now(); } break; }
          case 20: { const n = nodes.get(p); if (n) n.stale = true; break; }
          case 11: { if (p?.[1]) registry.set(String(p[1]).toLowerCase(), { label: p[0], count: p[2] }); break; }
          case 12: { if (p) registry.delete(String(p).toLowerCase()); break; }
          case 13: out.subscribed = true; break;
        }
      }
    };
    ws.onerror = () => { if (!done) out.error = 'websocket error'; };
    ws.onclose = () => { if (!done) { out.error = out.error || 'connection closed before listen window ended'; finish(null); } };
    setTimeout(() => finish(null), ms);
  });
}

const MAX_HISTORY = 168;
function appendHistory(prev, key, best, timestamp) {
  const existing = prev?.nodes?.[key]?.history || [];
  return [...existing, { ts: timestamp, best }].slice(-MAX_HISTORY);
}

function matchNode(cfg, onlineNodes) {
  if (cfg.peerId) {
    return { snap: onlineNodes.get(cfg.peerId), how: 'peerId' };
  }
  if (cfg.name) {
    const all = [...onlineNodes.values()];
    const exact = all.filter((n) => String(n.name).toLowerCase() === String(cfg.name).toLowerCase());
    if (exact.length === 1) return { snap: exact[0], how: 'name (exact)' };
    if (exact.length > 1) return { snap: null, how: 'name', err: `ambiguous name: ${exact.length} exact matches` };
    const sub = all.filter((n) => String(n.name).toLowerCase().includes(String(cfg.name).toLowerCase()));
    if (sub.length === 1) return { snap: sub[0], how: 'name (substring)' };
    if (sub.length > 1) return { snap: null, how: 'name', err: `ambiguous name: ${sub.length} substring matches` };
    return { snap: null, how: 'name' };
  }
  return { snap: null, how: 'none', err: 'no peerId and no name configured' };
}

const relayOf = (label) => (/kusama/i.test(label) ? 'kusama' : /polkadot/i.test(label) ? 'polkadot' : 'other');
const isRelay = (label) => /^(kusama|polkadot)$/i.test(String(label).trim());

async function main() {
  const envConfig = process.env.NODES_CONFIG ? JSON.parse(process.env.NODES_CONFIG) : null;
  const fileConfig = readJSON(join(ROOT, 'config.json'));
  const watch = envConfig?.nodes || fileConfig.nodes || [];
  const threshold = envConfig?.consecutiveOfflineChecksBeforeAlert ?? fileConfig.consecutiveOfflineChecksBeforeAlert ?? 1;
  const feedUrl = envConfig?.feedUrl || fileConfig.feedUrl || DEFAULT_FEED_URL;
  const rpcUrls = { ...DEFAULT_RPCS, ...(envConfig?.rpcUrls || fileConfig.rpcUrls || {}) };

  console.log(`\nMulti-chain collator monitor — ${new Date().toISOString()}`);
  console.log(`Watching ${watch.length} node(s) on ${new Set(watch.map((n) => n.chain)).size} chain(s)…`);

  // ── Decode addresses up front ─────────────────────────────────────────────
  for (const cfg of watch) {
    if (cfg.address) {
      try {
        const dec = ss58Decode(cfg.address);
        cfg._raw = dec.raw;
      } catch (e) {
        cfg._addrError = `invalid address: ${e.message}`;
      }
    }
  }

  // ── Telemetry: discover chains ───────────────────────────────────────────
  const telemetryWatch = watch.filter((n) => (n.peerId || n.name) && !n._chainError);
  console.log(`\nDiscovering chains (${DISCOVER_MS / 1000}s)…`);
  const discovery = await feedSession(feedUrl, null, DISCOVER_MS);
  if (!discovery.connected || discovery.registry.size === 0) {
    console.log('  ✗ Feed unreachable or registry empty:', discovery.error || 'no chains seen');
  } else {
    console.log(`  ✓ ${discovery.registry.size} chains in registry`);
  }

  const labelToGenesis = new Map();
  for (const [, v] of discovery.registry) labelToGenesis.set(v.label.toLowerCase(), v);
  const chainsWanted = new Map();
  for (const cfg of telemetryWatch) {
    const want = String(cfg.chain || '').trim().toLowerCase();
    if (!want) { cfg._chainError = 'no chain configured'; continue; }
    let hit = labelToGenesis.get(want);
    if (!hit) {
      const subs = [...labelToGenesis.values()].filter((v) => v.label.toLowerCase().includes(want));
      if (subs.length === 1) hit = subs[0];
      else if (subs.length > 1) { cfg._chainError = `ambiguous chain "${cfg.chain}": ${subs.map((s) => s.label).join(', ')}`; continue; }
    }
    if (!hit && /^0x[0-9a-f]{64}$/i.test(want)) {
      const g = discovery.registry.get(want);
      if (g) hit = g;
    }
    if (!hit && !(cfg.address && !cfg.peerId && !cfg.name)) { cfg._chainError = `chain "${cfg.chain}" not found in telemetry registry`; continue; }
    if (hit) {
      cfg._genesis = [...discovery.registry.entries()].find(([g]) => discovery.registry.get(g) === hit)?.[0] || want;
      cfg._chainLabel = hit.label;
      chainsWanted.set(cfg._genesis, hit.label);
    }
  }

  // ── Telemetry: parallel listen sessions ──────────────────────────────────
  const sessions = new Map();
  if (chainsWanted.size) {
    console.log(`\nListening ${LISTEN_MS / 60000} min on ${chainsWanted.size} chain(s) in parallel: ${[...chainsWanted.values()].join(', ')}`);
    await Promise.all([...chainsWanted.keys()].map(async (genesis) => {
      sessions.set(genesis, await feedSession(feedUrl, genesis, LISTEN_MS));
    }));
  }

  // ── On-chain: active sets for chains with watched addresses ──────────────
  const addressWatch = watch.filter((n) => n.address);
  const rpcChains = new Map(); // chain label -> rpc result
  for (const label of new Set(addressWatch.filter((n) => n._raw).map((n) => String(n.chain).trim()))) {
    const url = rpcUrls[label];
    if (!url) {
      rpcChains.set(label, { error: `no RPC endpoint configured for "${label}" (add rpcUrls in config)` });
      continue;
    }
    try {
      console.log(`\nOn-chain check: ${label} (${url})`);
      const [valHex, candHex, invHex] = await Promise.all([
        rpc(url, 'state_getStorage', [KEY_VALIDATORS]),
        isRelay(label) ? Promise.resolve(null) : rpc(url, 'state_getStorage', [KEY_CANDIDATES]),
        isRelay(label) ? Promise.resolve(null) : rpc(url, 'state_getStorage', [KEY_INVULN]),
      ]);
      const validators = valHex ? parseVecAccountId(valHex) : [];
      const candidates = candHex ? parseCandidates(candHex) : null;
      const invulnerables = invHex ? parseVecAccountId(invHex) : null;
      console.log(`  ✓ ${validators.length} in Session.Validators` + (candidates ? `, ${candidates.length} candidates, ${invulnerables.length} invulnerables` : ' (relay)'));
      rpcChains.set(label, { url, validators, candidates, invulnerables, relay: isRelay(label) });
    } catch (e) {
      rpcChains.set(label, { error: `RPC failed: ${e.message.slice(0, 80)}` });
    }
  }

  // ── Evaluate ──────────────────────────────────────────────────────────────
  const statusPath = join(ROOT, 'status.json');
  const prev = existsSync(statusPath) ? readJSON(statusPath) : { nodes: {} };
  const now = new Date().toISOString();

  const next = {
    lastUpdated: now,
    feed: {
      connected: discovery.connected,
      registrySize: discovery.registry.size,
      error: discovery.connected ? null : (discovery.error || 'feed not connected'),
    },
    chains: {},
    nodes: {},
  };

  // chain aggregates from telemetry sessions
  for (const [genesis, label] of chainsWanted) {
    const s = sessions.get(genesis);
    const online = s ? [...s.online.values()] : [];
    next.chains[label] = {
      genesis,
      feedOk: !!(s && s.connected && !s.error && s.subscribed),
      feedError: s?.error || (s && !s.subscribed ? 'subscription not confirmed' : null),
      relay: relayOf(label),
      nodeCount: online.length,
      bestBlock: online.reduce((m, n) => Math.max(m, n.best || 0), 0),
      finalizedBlock: online.reduce((m, n) => Math.max(m, n.finalized || 0), 0),
      nodesTable: online
        .map((n) => ({
          name: n.name, peerId: n.peerId, version: n.version,
          best: n.best, finalized: n.finalized, peers: n.peers, ttpb: n.ttpb,
          stateSize: n.stateSize, uploadAvgBs: n.uploadAvgBs, downloadAvgBs: n.downloadAvgBs,
          stale: n.stale,
        }))
        .sort((a, b) => (b.best || 0) - (a.best || 0) || String(a.name).localeCompare(String(b.name))),
    };
  }

  // merge on-chain chain data
  for (const [label, r] of rpcChains) {
    const flavor = relayOf(label) === 'kusama' ? 2 : relayOf(label) === 'polkadot' ? 0 : 42;
    const entry = next.chains[label] || { genesis: null, relay: relayOf(label) };
    if (r.error) {
      entry.rpcError = r.error;
    } else {
      entry.rpcOk = true;
      entry.isRelay = r.relay;
      entry.activeSetSize = r.validators.length;
      entry.candidateSetSize = r.candidates ? r.candidates.length : null;
      entry.invulnerableSetSize = r.invulnerables ? r.invulnerables.length : null;
      entry.activeSet = r.validators.map((raw) => ss58Encode(raw, flavor));
    }
    next.chains[label] = entry;
  }

  // per watched node
  for (const cfg of watch) {
    const chainLabel = cfg._chainLabel || String(cfg.chain || '').trim() || null;
    const keyBase = cfg.peerId ? shortPeer(cfg.peerId) : cfg.address ? shortAddr(cfg.address) : cfg.name || '?';
    const key = `${chainLabel || '?'}:${keyBase}`;
    const p = prev.nodes?.[key] ?? {};
    const chainInfo = chainLabel ? next.chains[chainLabel] : null;

    // address errors (bad ss58)
    if (cfg._addrError) {
      next.nodes[key] = { ...p, label: cfg.label || keyBase, chain: chainLabel, peerId: cfg.peerId || null, addressShort: cfg.address ? shortAddr(cfg.address) : null, statusText: 'error', lastError: cfg._addrError, lastChecked: now, history: p.history || [] };
      console.log(`\n  ${cfg.label || key}: ERROR — ${cfg._addrError}`);
      continue;
    }

    // telemetry part
    let snap = null, how = 'none', telErr = null, telOk = true;
    if (cfg.peerId || cfg.name) {
      if (cfg._chainError && !cfg.address) {
        next.nodes[key] = { ...p, label: cfg.label || keyBase, chain: chainLabel, peerId: cfg.peerId || null, addressShort: cfg._raw ? shortAddr(cfg.address) : null, statusText: 'error', lastError: cfg._chainError, lastChecked: now, history: p.history || [] };
        console.log(`\n  ${cfg.label || key}: ERROR — ${cfg._chainError}`);
        continue;
      }
      if (!cfg._chainError) {
        if (chainInfo && chainInfo.feedOk === false) {
          telOk = false;
        } else {
          const m = matchNode(cfg, sessions.get(cfg._genesis)?.online || new Map());
          snap = m.snap; how = m.how; telErr = m.err || null;
        }
      } else if (cfg.address) {
        // telemetry chain failed to resolve but address monitoring still proceeds
        telOk = false;
      }
    }

    // on-chain part
    let chainStatus = null, deposit = null, invulnerable = false, rpcErr = null;
    if (cfg._raw) {
      const r = chainLabel ? rpcChains.get(chainLabel) : null;
      if (!r) {
        rpcErr = 'no on-chain data for this chain';
      } else if (r.error) {
        rpcErr = r.error;
      } else {
        const inVal = r.validators.includes(cfg._raw);
        const cand = r.candidates ? r.candidates.find((c) => c.who === cfg._raw) : null;
        invulnerable = !!(r.invulnerables && r.invulnerables.includes(cfg._raw));
        deposit = cand ? cand.deposit : null;
        if (inVal) chainStatus = 'active';
        else if (cand || invulnerable) chainStatus = 'standby';
        else chainStatus = r.relay ? 'inactive' : 'missing';
      }
    }

    // ── statuses & alerts ──────────────────────────────────────────────────
    let statusText;
    if (cfg.peerId || cfg.name) {
      if (!telOk) statusText = 'error';
      else if (snap && snap.stale) statusText = 'stale';
      else if (snap) statusText = 'online';
      else if (cfg._raw && chainStatus) statusText = chainStatus === 'active' ? 'online' : 'standby';
      else statusText = 'offline';
    } else {
      statusText = rpcErr ? 'error' : (chainStatus === 'active' ? 'online' : chainStatus === 'missing' ? 'offline' : chainStatus === 'standby' ? 'standby' : 'standby');
    }

    const telemetryOffline = (cfg.peerId || cfg.name) && telOk && !snap && !(cfg._raw && chainStatus);
    const consecutiveOffline = telemetryOffline ? (p.consecutiveOffline ?? 0) + 1 : 0;
    const wasAlertedOffline = p.alertedOffline ?? false;
    const triggerOfflineAlert = telemetryOffline && consecutiveOffline >= threshold && !wasAlertedOffline;

    const addrMissing = cfg._raw && !rpcErr && chainStatus === 'missing';
    const consecutiveMissing = addrMissing ? (p.consecutiveMissing ?? 0) + 1 : 0;
    const wasAlertedMissing = p.alertedMissing ?? false;
    const triggerMissingAlert = addrMissing && consecutiveMissing >= threshold && !wasAlertedMissing;
    const triggerMissingRecovery = !addrMissing && (p.consecutiveMissing ?? 0) > 0 && wasAlertedMissing && !rpcErr && chainStatus;

    const wasAlertedRecovery = p.alertedRecovery ?? false;
    const triggerRecoveryAlert = (cfg.peerId || cfg.name) && telOk && snap && wasAlertedOffline && !wasAlertedRecovery;

    const displayLabel = cfg.label || snap?.name || cfg.address || key;
    console.log(`\n  ${displayLabel}${chainLabel ? ` (${chainLabel})` : ''}: ${statusText}`);
    if (snap) console.log(`    telemetry [${how}]: best=${snap.best} finalized=${snap.finalized ?? '–'} peers=${snap.peers} v${snap.version}`);
    if (telErr) console.log(`    ✗ ${telErr}`);
    if (telemetryOffline && !cfg._raw) console.log(`    Offline for ${consecutiveOffline}/${threshold} consecutive checks.`);
    if (rpcErr) console.log(`    ✗ on-chain: ${rpcErr}`);
    if (chainStatus) console.log(`    on-chain: ${chainStatus}${invulnerable ? ' (invulnerable)' : ''}${deposit != null ? ` deposit=${deposit}` : ''}`);

    if (triggerOfflineAlert) {
      await sendTelegram(
        `🚨 <b>Collator offline</b>\n\n<b>${displayLabel}</b>\n<code>${cfg.peerId || cfg.name}</code>\n` +
        `Chain: ${chainLabel}\nSeen offline for ${consecutiveOffline} consecutive checks.`
      );
    }
    if (triggerRecoveryAlert) {
      await sendTelegram(
        `✅ <b>Collator back online</b>\n\n<b>${displayLabel}</b>\n<code>${cfg.peerId || snap.peerId}</code>\n` +
        `Chain: ${chainLabel} · Best block: ${snap.best} · Peers: ${snap.peers}`
      );
    }
    if (triggerMissingAlert) {
      await sendTelegram(
        `🚨 <b>Collator dropped from candidate set</b>\n\n<b>${displayLabel}</b>\n<code>${cfg.address}</code>\n` +
        `Chain: ${chainLabel}\nNot in Session.Validators, CollatorSelection.Candidates or Invulnerables for ${consecutiveMissing} consecutive checks.`
      );
    }
    if (triggerMissingRecovery) {
      await sendTelegram(
        `✅ <b>Collator back in selection</b>\n\n<b>${displayLabel}</b>\n<code>${cfg.address}</code>\n` +
        `Chain: ${chainLabel} · Status: ${chainStatus}`
      );
    }

    next.nodes[key] = {
      peerId: cfg.peerId || snap?.peerId || p.peerId || null,
      addressShort: cfg.address ? shortAddr(cfg.address) : null,
      hasAddress: !!cfg._raw,
      matchedBy: how !== 'none' ? how : null,
      label: displayLabel,
      chain: chainLabel,
      isOnline: !!snap,
      stale: snap?.stale ?? null,
      version: snap?.version ?? null,
      impl: snap?.impl ?? null,
      name: snap?.name ?? p.name ?? null,
      best: snap?.best ?? null,
      finalized: snap?.finalized ?? null,
      peers: snap?.peers ?? null,
      ttpb: snap?.ttpb ?? null,
      stateSize: snap?.stateSize ?? null,
      uploadAvgBs: snap?.uploadAvgBs ?? null,
      downloadAvgBs: snap?.downloadAvgBs ?? null,
      startupTime: snap?.startupTime ?? null,
      lastBlockAt: snap ? new Date(snap.blockTs).toISOString() : null,
      chainStatus,
      invulnerable: invulnerable || null,
      deposit: deposit != null ? deposit.toString() : null,
      consecutiveOffline,
      consecutiveMissing,
      alertedOffline: telemetryOffline ? (triggerOfflineAlert || wasAlertedOffline) : false,
      alertedRecovery: triggerRecoveryAlert ? true : (p.alertedRecovery && snap ? true : false),
      alertedMissing: addrMissing ? (triggerMissingAlert || wasAlertedMissing) : false,
      statusText,
      lastChecked: now,
      lastError: rpcErr || telErr || (!telOk && !cfg._raw ? 'chain feed unhealthy' : null),
      history: appendHistory(prev, key, snap?.best ?? null, now),
    };
  }

  writeJSON(statusPath, next);
  console.log('\nstatus.json written.');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
