/**
 * Multi-chain collator telemetry monitor (Polkadot / Kusama ecosystem)
 *
 * Connects to wss://feed.telemetry.polkadot.io/feed, discovers all chains from
 * the live chain registry (AddedChain messages — no hardcoded genesis hashes),
 * subscribes to every chain that has configured nodes (one WSS connection per
 * chain, in parallel), matches nodes by libp2p PeerID (recommended, stable
 * across restarts) or by telemetry display name (exact, case-insensitive —
 * with unambiguous substring fallback), detects offline/stale transitions,
 * sends Telegram alerts, and writes the result back to status.json.
 *
 * Note on addresses: the telemetry feed no longer carries validator/authority
 * addresses (AfgAuthoritySet etc. are not emitted by the current backend), so
 * SS58 addresses cannot be matched. PeerID is the only stable identity.
 *
 * Protocol (from paritytech/substrate-telemetry frontend/src/common/feed.ts):
 *   client sends:  "subscribe:<genesis-hash>" and "ping:<id>"
 *   server sends:  [opcode, payload, opcode, payload, ...]
 *     3  = AddedNode [id, details, stats, io, hw, blockDetails, location, startupTime]
 *     4  = RemovedNode id
 *     6  = ImportedBlock [id, [height, hash, ttpb, ts, blockLen]]
 *     7  = FinalizedBlock [id, height, hash]
 *     8  = NodeStats [id, [peers, txs]]
 *     11 = AddedChain [label, genesisHash, nodeCount]
 *     12 = RemovedChain genesisHash
 *     20 = StaleNode id
 *
 * Called by GitHub Actions every hour (chain discovery + parallel listen windows).
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const ROOT = join(dirname(__filename), '..');

const DEFAULT_FEED_URL = 'wss://feed.telemetry.polkadot.io/feed';
const DISCOVER_MS = Number(process.env.DISCOVER_MS) || 12 * 1000; // chain registry harvest
const LISTEN_MS = Number(process.env.LISTEN_MS) || 5 * 60 * 1000; // per-chain listen window

const readJSON = (p) => JSON.parse(readFileSync(p, 'utf8'));
const writeJSON = (p, d) => writeFileSync(p, JSON.stringify(d, null, 2) + '\n');

function shortPeer(peerId) {
  return peerId.slice(0, 10) + '…' + peerId.slice(-4);
}

async function sendTelegram(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatIds = process.env.TELEGRAM_CHAT_ID?.split(',').map(s => s.trim()).filter(Boolean);
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
      if (!res.ok) console.error('  [Telegram] Send failed:', await res.text());
      else console.log('  [Telegram] Alert sent to', chatId);
    } catch (err) {
      console.error('  [Telegram] Error:', err.message);
    }
  }
}

/**
 * Open one feed connection. If genesis is given, subscribe to that chain.
 * Collects: chain registry (label -> genesis), per-feedId node state.
 * Resolves after ms millis with a snapshot of all nodes seen.
 */
function feedSession(feedUrl, genesis, ms) {
  return new Promise((resolve) => {
    const registry = new Map(); // genesis(lower) -> {label, count}
    const nodes = new Map(); // feedId -> live node state
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

    ws.onopen = () => {
      out.connected = true;
      if (genesis) ws.send(`subscribe:${genesis}`);
    };
    ws.onmessage = (ev) => {
      let data;
      try {
        data = typeof ev.data === 'string' ? JSON.parse(ev.data) : JSON.parse(new TextDecoder().decode(ev.data));
      } catch { return; }
      if (!Array.isArray(data)) return;
      for (let i = 0; i < data.length; i += 2) {
        const op = data[i], p = data[i + 1];
        switch (op) {
          case 3: { // AddedNode
            const [id, details, stats, io, hw, blockDetails, , startupTime] = p;
            if (!details?.[4]) break; // no PeerID — cannot track
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
          case 4: nodes.delete(p); break; // RemovedNode
          case 6: { // ImportedBlock
            const [id, bd] = p;
            const n = nodes.get(id);
            if (n) { n.best = bd[0]; n.bestHash = bd[1]; n.ttpb = bd[2]; n.blockTs = bd[3] || n.blockTs; n.lastUpdate = Date.now(); n.stale = false; }
            break;
          }
          case 7: { // FinalizedBlock
            const [id, height] = p;
            const n = nodes.get(id);
            if (n) { n.finalized = height; n.lastUpdate = Date.now(); }
            break;
          }
          case 8: { // NodeStats
            const [id, stats] = p;
            const n = nodes.get(id);
            if (n) { n.peers = stats[0]; n.txs = stats[1]; n.lastUpdate = Date.now(); }
            break;
          }
          case 20: { // StaleNode
            const n = nodes.get(p);
            if (n) n.stale = true;
            break;
          }
          case 11: { // AddedChain [label, genesis, count]
            if (p?.[1]) registry.set(String(p[1]).toLowerCase(), { label: p[0], count: p[2] });
            break;
          }
          case 12: // RemovedChain
            if (p) registry.delete(String(p).toLowerCase());
            break;
          case 13: // SubscribedTo
            out.subscribed = true;
            break;
        }
      }
    };
    ws.onerror = () => { if (!done) out.error = 'websocket error'; };
    ws.onclose = () => {
      if (!done) {
        out.error = out.error || 'connection closed before listen window ended';
        finish(null);
      }
    };

    setTimeout(() => finish(null), ms);
  });
}

const MAX_HISTORY = 168;

function appendHistory(prev, key, best, timestamp) {
  const existing = prev?.nodes?.[key]?.history || [];
  return [...existing, { ts: timestamp, best }].slice(-MAX_HISTORY);
}

/** Resolve which feed node a config entry refers to. */
function matchNode(cfg, onlineNodes) {
  if (cfg.peerId) {
    const snap = onlineNodes.get(cfg.peerId);
    return { snap, how: 'peerId' };
  }
  if (cfg.name) {
    const all = [...onlineNodes.values()];
    const exact = all.filter(n => String(n.name).toLowerCase() === String(cfg.name).toLowerCase());
    if (exact.length === 1) return { snap: exact[0], how: 'name (exact)' };
    if (exact.length > 1) return { snap: null, how: 'name', err: `ambiguous name: ${exact.length} exact matches` };
    const sub = all.filter(n => String(n.name).toLowerCase().includes(String(cfg.name).toLowerCase()));
    if (sub.length === 1) return { snap: sub[0], how: 'name (substring)' };
    if (sub.length > 1) return { snap: null, how: 'name', err: `ambiguous name: ${sub.length} substring matches` };
    return { snap: null, how: 'name' };
  }
  return { snap: null, how: 'none', err: 'no peerId and no name configured' };
}

async function main() {
  const envConfig = process.env.NODES_CONFIG ? JSON.parse(process.env.NODES_CONFIG) : null;
  const fileConfig = readJSON(join(ROOT, 'config.json'));
  const watch = envConfig?.nodes || fileConfig.nodes || [];
  const threshold = envConfig?.consecutiveOfflineChecksBeforeAlert ?? fileConfig.consecutiveOfflineChecksBeforeAlert ?? 1;
  const feedUrl = envConfig?.feedUrl || fileConfig.feedUrl || DEFAULT_FEED_URL;

  console.log(`\nMulti-chain collator monitor — ${new Date().toISOString()}`);
  console.log(`Watching ${watch.length} node(s) on ${new Set(watch.map(n => n.chain)).size} chain(s)…`);

  // ── Phase 1: discover chains from the live registry ──────────────────────
  console.log(`\nDiscovering chains (${DISCOVER_MS / 1000}s)…`);
  const discovery = await feedSession(feedUrl, null, DISCOVER_MS);
  if (!discovery.connected || discovery.registry.size === 0) {
    console.log('  ✗ Feed unreachable or registry empty:', discovery.error || 'no chains seen');
  } else {
    console.log(`  ✓ ${discovery.registry.size} chains in registry`);
  }

  // Resolve chain label / genesis for each config entry
  const labelToGenesis = new Map();
  for (const [, v] of discovery.registry) labelToGenesis.set(v.label.toLowerCase(), v);
  const chainsWanted = new Map(); // genesis(lower) -> label
  for (const cfg of watch) {
    const want = String(cfg.chain || '').trim().toLowerCase();
    if (!want) { cfg._chainError = 'no chain configured'; continue; }
    // exact label match, then unique substring match
    let hit = labelToGenesis.get(want);
    if (!hit) {
      const subs = [...labelToGenesis.values()].filter(v => v.label.toLowerCase().includes(want));
      if (subs.length === 1) hit = subs[0];
      else if (subs.length > 1) {
        cfg._chainError = `ambiguous chain "${cfg.chain}": ${subs.map(s => s.label).join(', ')}`;
        continue;
      }
    }
    // also allow configuring the genesis hash directly
    if (!hit && /^0x[0-9a-f]{64}$/i.test(want)) {
      const g = discovery.registry.get(want);
      if (g) hit = g;
    }
    if (!hit) { cfg._chainError = `chain "${cfg.chain}" not found in telemetry registry`; continue; }
    cfg._genesis = [...discovery.registry.entries()].find(([g]) => discovery.registry.get(g) === hit)?.[0] || want;
    cfg._chainLabel = hit.label;
    chainsWanted.set(cfg._genesis, hit.label);
  }

  // ── Phase 2: one parallel listen session per chain ───────────────────────
  const sessions = new Map(); // genesis -> session result
  if (chainsWanted.size) {
    console.log(`\nListening ${LISTEN_MS / 60000} min on ${chainsWanted.size} chain(s) in parallel: ${[...chainsWanted.values()].join(', ')}`);
    const jobs = [...chainsWanted.keys()].map(async (genesis) => {
      const s = await feedSession(feedUrl, genesis, LISTEN_MS);
      sessions.set(genesis, s);
    });
    await Promise.all(jobs);
  }

  // ── Phase 3: evaluate ─────────────────────────────────────────────────────
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

  // Per-chain aggregates + full node tables
  for (const [genesis, label] of chainsWanted) {
    const s = sessions.get(genesis);
    const online = s ? [...s.online.values()] : [];
    next.chains[label] = {
      genesis,
      feedOk: !!(s && s.connected && !s.error && s.subscribed),
      feedError: s?.error || (s && !s.subscribed ? 'subscription not confirmed' : null),
      relay: /kusama/i.test(label) ? 'kusama' : /polkadot/i.test(label) ? 'polkadot' : 'other',
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

  // Per watched node
  for (const cfg of watch) {
    if (cfg._chainError) {
      console.log(`\n  ✗ ${cfg.label || cfg.name || cfg.peerId}: ${cfg._chainError}`);
      next.nodes[`${cfg.chain || '?'}:${cfg.peerId ? shortPeer(cfg.peerId) : cfg.name || '?'}`] = {
        peerId: cfg.peerId || null,
        label: cfg.label || cfg.name || shortPeer(cfg.peerId || ''),
        chain: cfg.chain || null,
        statusText: 'error',
        lastError: cfg._chainError,
        lastChecked: now,
      };
      continue;
    }

    const label = cfg._chainLabel;
    const genesis = cfg._genesis;
    const key = `${label}:${cfg.peerId ? shortPeer(cfg.peerId) : cfg.name}`;
    const p = prev.nodes?.[key] ?? {};
    const session = sessions.get(genesis);
    const chainInfo = next.chains[label];

    // Chain feed broken -> error, never false-offline
    if (!chainInfo.feedOk) {
      next.nodes[key] = {
        ...p,
        peerId: cfg.peerId || p.peerId || null,
        label: cfg.label || cfg.name || key,
        chain: label,
        statusText: 'error',
        lastError: chainInfo.feedError || 'chain feed unhealthy',
        lastChecked: now,
        history: p.history || [],
      };
      console.log(`\n  ${cfg.label || key}: ERROR (chain feed unhealthy — no offline counting)`);
      continue;
    }

    const { snap, how, err } = matchNode(cfg, session.online);
    const isOnline = !!snap && !snap.stale;
    const consecutiveOffline = isOnline ? 0 : (p.consecutiveOffline ?? 0) + 1;

    const wasAlertedOffline = p.alertedOffline ?? false;
    const triggerOfflineAlert = !isOnline && consecutiveOffline >= threshold && !wasAlertedOffline;
    const triggerRecoveryAlert = isOnline && wasAlertedOffline;

    let statusText;
    if (snap && snap.stale) statusText = 'stale';
    else if (isOnline) statusText = 'online';
    else statusText = 'offline';

    const displayLabel = cfg.label || snap?.name || key;
    console.log(`\n  ${displayLabel} (${label}): ${statusText}` + (snap ? ` [matched by ${how}]` : ''));
    if (snap) {
      console.log(`    best=${snap.best} finalized=${snap.finalized ?? '–'} peers=${snap.peers} ttpb=${snap.ttpb}ms v${snap.version}`);
    } else if (err) {
      console.log(`    ✗ ${err}`);
    } else {
      console.log(`    Offline for ${consecutiveOffline}/${threshold} consecutive checks.`);
    }

    if (triggerOfflineAlert) {
      await sendTelegram(
        `🚨 <b>Collator offline</b>\n\n` +
        `<b>${displayLabel}</b>\n<code>${cfg.peerId || snap?.peerId || cfg.name}</code>\n` +
        `Chain: ${label} · Chain best block: ${chainInfo.bestBlock}\n` +
        `Seen offline for ${consecutiveOffline} consecutive checks.`
      );
    }
    if (triggerRecoveryAlert) {
      await sendTelegram(
        `✅ <b>Collator back online</b>\n\n` +
        `<b>${displayLabel}</b>\n<code>${cfg.peerId || snap.peerId}</code>\n` +
        `Chain: ${label} · Best block: ${snap.best} · Peers: ${snap.peers}`
      );
    }

    next.nodes[key] = {
      peerId: cfg.peerId || snap?.peerId || p.peerId || null,
      matchedBy: how,
      label: displayLabel,
      chain: label,
      isOnline,
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
      consecutiveOffline,
      alertedOffline: !isOnline && (triggerOfflineAlert || wasAlertedOffline),
      statusText,
      lastChecked: now,
      lastError: err || null,
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
