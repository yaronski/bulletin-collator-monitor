/**
 * Bulletin collator telemetry monitor
 *
 * Connects to wss://feed.telemetry.polkadot.io/feed, subscribes to the
 * Polkadot Bulletin chain feed, watches configured nodes (matched by PeerID),
 * detects offline/stale transitions, sends Telegram alerts, and writes the
 * result back to status.json.
 *
 * Protocol (from paritytech/substrate-telemetry frontend/src/common/feed.ts):
 *   client sends:  "subscribe:<genesis-hash>" and "ping:<id>"
 *   server sends:  [opcode, payload, opcode, payload, ...]
 *     3  = AddedNode [id, details, stats, io, hw, blockDetails, location, startupTime]
 *     4  = RemovedNode id
 *     6  = ImportedBlock [id, [height, hash, ttpb, ts, blockLen]]
 *     7  = FinalizedBlock [id, height, hash]
 *     8  = NodeStats [id, [peers, txs]]
 *     20 = StaleNode id
 *
 * Called by GitHub Actions every hour (5 min listen window).
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const ROOT = join(dirname(__filename), '..');

const DEFAULT_FEED_URL = 'wss://feed.telemetry.polkadot.io/feed';
const DEFAULT_GENESIS = '0x2761c95259d59e55ae3daf756c1413b46e45a5a2987299f8ef8e5d8e4776cbc4';
const LISTEN_MS = Number(process.env.LISTEN_MS) || 5 * 60 * 1000; // listen window, overridable for tests

const readJSON = (p) => JSON.parse(readFileSync(p, 'utf8'));
const writeJSON = (p, d) => writeFileSync(p, JSON.stringify(d, null, 2) + '\n');

function shortPeer(peerId) {
  // 12D3KooWMc7ZJ6JGiehG1H45JL69QTPivEBnzm8LihkEEFjYMRnr -> 12D3KooW…MRnr
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
 * Listen to the telemetry feed for LISTEN_MS.
 * Resolves { connected, chainLabel, chainError, online: Map<peerId, snapshot> }
 */
function listenToFeed(feedUrl, genesis) {
  return new Promise((resolve) => {
    const nodes = new Map(); // feedId -> live node state
    const out = { connected: false, chainLabel: null, chainError: null, online: new Map() };
    let sawAnyData = false;
    let done = false;

    const ws = new WebSocket(feedUrl);
    ws.binaryType = 'arraybuffer';

    const finish = (reason) => {
      if (done) return;
      done = true;
      console.log(`  Feed window ended (${reason}).`);
      for (const [, n] of nodes) {
        out.online.set(n.peerId, { ...n });
      }
      try { ws.close(); } catch {}
      resolve(out);
    };

    ws.onopen = () => {
      out.connected = true;
      console.log('  Connected to feed.');
      ws.send(`subscribe:${genesis}`);
    };
    ws.onmessage = (ev) => {
      let data;
      try {
        data = typeof ev.data === 'string' ? JSON.parse(ev.data) : JSON.parse(new TextDecoder().decode(ev.data));
      } catch { return; }
      if (!Array.isArray(data)) return;
      sawAnyData = true;
      for (let i = 0; i < data.length; i += 2) {
        const op = data[i], p = data[i + 1];
        switch (op) {
          case 3: { // AddedNode
            const [id, details, stats, io, hw, blockDetails, , startupTime] = p;
            const tsAvg = hw[2]?.length ? hw[2].reduce((a, b) => a + b, 0) / hw[2].length : Date.now();
            nodes.set(id, {
              name: details[0], impl: details[1], version: details[2], peerId: details[4],
              peers: stats?.[0] ?? null, txs: stats?.[1] ?? null,
              best: blockDetails[0], bestHash: blockDetails[1], ttpb: blockDetails[2],
              blockTs: blockDetails[3] || Math.round(tsAvg),
              finalized: null,
              // io = [stateCacheSize[]] — flat time series of Bytes; take latest
              stateSize: io?.[0]?.length ? io[0][io[0].length - 1] : null,
              // hw = [upload[] (Bytes/s), download[] (Bytes/s), chartstamps[]]
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
          case 11: { // AddedChain [label, genesis, nodeCount]
            if (String(p[1]).toLowerCase() === String(genesis).toLowerCase()) out.chainLabel = p[0];
            break;
          }
          case 13: // SubscribedTo
            console.log(`  Subscribed: ${p}`);
            break;
        }
      }
    };
    ws.onerror = () => { if (!done) out.chainError = 'websocket error'; };
    ws.onclose = () => {
      if (!done) {
        out.chainError = out.chainError || 'connection closed before listen window ended';
        finish('connection closed early');
      }
    };

    setTimeout(() => finish('listen window over'), LISTEN_MS);

    // Abort faster if we connected but never received any data within 90s
    setTimeout(() => {
      if (!sawAnyData && !done) {
        out.chainError = 'connected but no feed data received within 90s';
        finish('no data');
      }
    }, 90000);
  });
}

const MAX_HISTORY = 168;

function appendHistory(prev, key, best, timestamp) {
  const existing = prev?.nodes?.[key]?.history || [];
  return [...existing, { ts: timestamp, best }].slice(-MAX_HISTORY);
}

async function main() {
  const envConfig = process.env.NODES_CONFIG ? JSON.parse(process.env.NODES_CONFIG) : null;
  const fileConfig = readJSON(join(ROOT, 'config.json'));
  const watch = envConfig?.nodes || fileConfig.nodes || [];
  const threshold = envConfig?.consecutiveOfflineChecksBeforeAlert ?? fileConfig.consecutiveOfflineChecksBeforeAlert ?? 2;
  const genesis = envConfig?.genesisHash || fileConfig.genesisHash || DEFAULT_GENESIS;
  const feedUrl = envConfig?.feedUrl || fileConfig.feedUrl || DEFAULT_FEED_URL;

  console.log(`\nBulletin collator monitor — ${new Date().toISOString()}`);
  console.log(`Watching ${watch.length} node(s), listening for ${LISTEN_MS / 60000} min…`);

  const feed = await listenToFeed(feedUrl, genesis);

  const statusPath = join(ROOT, 'status.json');
  const prev = existsSync(statusPath) ? readJSON(statusPath) : { nodes: {} };
  const now = new Date().toISOString();

  const feedHealthy = feed.connected && !feed.chainError && feed.online.size >= 0 && feed.chainLabel !== null;

  const next = {
    lastUpdated: now,
    feed: {
      connected: feed.connected,
      chainLabel: feed.chainLabel,
      error: feed.chainError || null,
    },
    nodes: {},
  };

  if (!feed.connected || feed.chainError) {
    console.log('  ✗ Feed problem:', feed.chainError || 'not connected');
  }

  // Chain-wide stats from the feed
  const online = [...feed.online.values()];
  next.chain = {
    label: feed.chainLabel || 'Polkadot Bulletin',
    nodeCount: online.length,
    bestBlock: online.reduce((m, n) => Math.max(m, n.best || 0), 0),
    finalizedBlock: online.reduce((m, n) => Math.max(m, n.finalized || 0), 0),
  };

  // Full node table (sorted by best block desc, then name)
  next.nodesTable = online
    .map((n) => ({
      name: n.name,
      peerId: n.peerId,
      version: n.version,
      best: n.best,
      finalized: n.finalized,
      peers: n.peers,
      ttpb: n.ttpb,
      stateSize: n.stateSize,
      uploadAvgBs: n.uploadAvgBs,
      downloadAvgBs: n.downloadAvgBs,
      stale: n.stale,
    }))
    .sort((a, b) => (b.best || 0) - (a.best || 0) || String(a.name).localeCompare(String(b.name)));

  // Per watched node
  for (const cfg of watch) {
    const peerId = cfg.peerId;
    if (!peerId || peerId === 'YOUR_NODE_PEER_ID_HERE') {
      console.warn(`Skipping node "${cfg.label}" — no peerId set.`);
      continue;
    }
    const key = shortPeer(peerId);
    const p = prev.nodes?.[key] ?? {};
    const snap = feed.online.get(peerId);

    // If the feed itself is broken, mark error instead of offline
    // (never burn "offline" alerts because telemetry is down)
    if (!feedHealthy) {
      next.nodes[key] = {
        ...p,
        peerId,
        label: cfg.label || p.label || key,
        statusText: 'error',
        lastError: feed.chainError || 'feed not connected',
        lastChecked: now,
        history: appendHistory(prev, key, snap?.best ?? p.history?.at(-1)?.best ?? null, now),
      };
      console.log(`\n  ${cfg.label || key}: ERROR (feed unhealthy — no offline counting)`);
      continue;
    }

    const isOnline = !!snap && !snap.stale;
    const consecutiveOffline = isOnline ? 0 : (p.consecutiveOffline ?? 0) + 1;

    const wasAlertedOffline = p.alertedOffline ?? false;
    const triggerOfflineAlert = !isOnline && consecutiveOffline >= threshold && !wasAlertedOffline;
    const triggerRecoveryAlert = isOnline && wasAlertedOffline;

    let statusText;
    if (snap && snap.stale) statusText = 'stale';
    else if (isOnline) statusText = 'online';
    else statusText = 'offline';

    const label = cfg.label || snap?.name || key;
    console.log(`\n  ${label} (${key}): ${statusText}`);
    if (snap) {
      console.log(`    best=${snap.best} finalized=${snap.finalized ?? '–'} peers=${snap.peers} ttpb=${snap.ttpb}ms v${snap.version}`);
    } else {
      console.log(`    Offline for ${consecutiveOffline}/${threshold} consecutive checks.`);
    }

    if (triggerOfflineAlert) {
      await sendTelegram(
        `🚨 <b>Collator offline</b>\n\n` +
        `<b>${label}</b>\n<code>${peerId}</code>\n` +
        `Chain: ${next.chain.label} · Chain best block: ${next.chain.bestBlock}\n` +
        `Seen offline for ${consecutiveOffline} consecutive checks.`
      );
    }
    if (triggerRecoveryAlert) {
      await sendTelegram(
        `✅ <b>Collator back online</b>\n\n` +
        `<b>${label}</b>\n<code>${peerId}</code>\n` +
        `Chain: ${next.chain.label} · Best block: ${snap.best} · Peers: ${snap.peers}`
      );
    }

    next.nodes[key] = {
      peerId,
      label,
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
      lastError: null,
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
