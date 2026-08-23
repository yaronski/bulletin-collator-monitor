# Collator Monitor (Polkadot + Kusama ecosystem)

Tracks whether your collators/nodes are visible on the official [Polkadot Telemetry](https://telemetry.polkadot.io/) — without needing access to the nodes themselves. Works for **any chain in the telemetry registry**: Polkadot Bulletin, Kusama People, Polkadot Asset Hub, the relays themselves, and 150+ more.

Connects to `wss://feed.telemetry.polkadot.io/feed`, discovers all chains from the live registry, subscribes to every chain that has configured nodes (one WSS connection per chain, in parallel), and matches your nodes by **libp2p PeerID** (recommended — stable across restarts) or by **telemetry display name** (exact case-insensitive match, with unambiguous-substring fallback). Runs as a GitHub Actions cron every 2 hours.

**Privacy**: Node PeerIDs are stored in GitHub Secrets, not in the repo. The public `status.json` only shows truncated PeerIDs (`12D3KooW…MRnr`).

## How it works

```
GitHub Actions (every 2 hours)
  └─ scripts/check.mjs
       ├─ reads  NODES_CONFIG secret           (your nodes - private)
       ├─ opens  WSS to feed.telemetry.polkadot.io/feed
       ├─ harvests the chain registry (AddedChain messages — no hardcoded genesis hashes)
       ├─ resolves each configured chain by label (exact or unique substring)
       ├─ opens one parallel listen session per chain (5 min)
       ├─ matches nodes by PeerID or display name
       ├─ detects offline transitions (alerts on first missed check by default)
       ├─ sends  Telegram alert on transition
       └─ writes status.json              (PeerIDs truncated, committed to repo)

GitHub Pages
  └─ index.html fetches status.json every 5 min and renders the dashboard
```

A node counts as **offline** only if it does not appear in its chain's feed at the end of the listen window. If a chain's feed (or the whole telemetry server) is unreachable, affected nodes are marked `error` and offline counting pauses — a broken telemetry server never causes false "offline" alerts.

| Status | Meaning |
|--------|---------|
| `online` | Present in the telemetry feed with fresh blocks |
| `stale` | Present but flagged stale (no fresh telemetry for ~2 min) |
| `offline` | Not in the feed — alerts on the first missed check |
| `error` | Chain feed unreachable / chain unknown — offline counting paused |

> **Why PeerID instead of SS58 address?** The telemetry feed no longer carries validator/authority addresses (the GRANDPA authority-set messages are not emitted by the current backend — verified against Polkadot, Kusama and the system parachains), so there is nothing to match an address against. The libp2p PeerID is the only stable identity in the feed; display names work too but are operator-chosen and not enforced unique. SS58 (Kusama- or Polkadot-style) address support would require joining this with on-chain queries (e.g. `session.validators` via RPC) — not implemented.

## Dashboard

- **Watched collators** — one card per configured node. The colored left edge shows the relay (purple = Polkadot, orange = Kusama, grey = other) and a vertical label with the chain name, relay prefix stripped: a Polkadot Bulletin card says **bulletin**, Kusama People says **people**, a relay itself says **polkadot**/**kusama**. Each card shows best/finalized block, peers, TtPB, average upload/download, state cache size, client version, uptime, consecutive-offline count and a best-block history sparkline.
- **All nodes on telemetry** — per chain: every node currently visible on telemetry, with block lag vs. chain best, one "Show all N nodes" toggle per chain. Hover a truncated PeerID to see the full one — the easiest way to find PeerIDs of nodes you want to watch.
- Cards sort offline/stale/error first, then by chain. The banner at the top lists offline nodes; if the telemetry feed itself is down, it says so and offline detection pauses.

## Adding nodes

Add entries to the `NODES_CONFIG` secret (or `config.json`). Any chain visible on [telemetry.polkadot.io](https://telemetry.polkadot.io/) works — the chain registry is discovered live every run, so new chains are picked up automatically. Polkadot- and Kusama-side chains are equally supported.

**Where to get the PeerID:**

| Source | How |
|--------|-----|
| On the node itself | `journalctl -u <service> -b \| grep "Local node identity"` (or docker logs) |
| Telemetry dashboard | Chain section → "Show all nodes" → hover the truncated PeerID for the full one |
| status.json | `chains.<label>.nodesTable[].peerId` (full value; only the watched-node section truncates) |

**Chain label resolution**: `chain` is matched against the live telemetry registry — exact label first (e.g. `"Polkadot Bulletin"`), then unique substring (`"people kusama"`, `"asset hub"`). A raw genesis hash (`0x…`, 64 hex chars) also works. Ambiguous substrings (e.g. just `"people"` when several People chains exist) fail loudly with `error` instead of silently matching the wrong chain.

**Name matching** (`name` instead of `peerId`): exact case-insensitive display-name match, falling back to substring if exactly one node matches. Ambiguity → `error`. Names are operator-chosen; PeerID is safer.

## Quick start

### 1. Fork this repo

### 2. Add GitHub Secrets

Go to **Settings → Secrets and variables → Actions** and add these repository secrets:

| Secret | Required | Example value |
|--------|----------|---------------|
| `NODES_CONFIG` | **Yes** | See below |
| `TELEGRAM_BOT_TOKEN` | Optional | `123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11` |
| `TELEGRAM_CHAT_ID` | Optional (but required if token is set) | `123456789` or `123456789,987654321` |

#### `NODES_CONFIG` format

```json
{
  "nodes": [
    {
      "chain": "Polkadot Bulletin",
      "peerId": "12D3KooWMc7ZJ6JGiehG1H45JL69QTPivEBnzm8LihkEEFjYMRnr",
      "label": "ExtraCoin"
    },
    {
      "chain": "Kusama People",
      "name": "ExtraCoin",
      "label": "ExtraCoin (People)"
    },
    {
      "chain": "Polkadot Asset Hub",
      "peerId": "12D3KooW…full peer id…",
      "label": "AH node"
    }
  ],
  "consecutiveOfflineChecksBeforeAlert": 2
}
```

- `chain` — telemetry chain label (exact, unique substring, or genesis hash)
- `peerId` — recommended, stable across node restarts
- `name` — alternative matcher: exact case-insensitive telemetry display name; falls back to substring if exactly one node matches
- `label` — what the dashboard card shows
- `consecutiveOfflineChecksBeforeAlert` — default 1: alert fires on the first missed check, so max latency = one schedule interval (2 h). Raise it to damp single-run hiccups (e.g. telemetry restarts).

#### Getting Telegram credentials

1. **Create bot**: Message [@BotFather](https://t.me/botfather) → `/newbot` → follow prompts → copy the token
2. **Set bot profile pic** (optional): `/setuserpic` → upload `telegramBotProfilePic.png` from this repo
3. **Get your chat ID**: send any message to your bot, then open `https://api.telegram.org/botYOUR_TOKEN/getUpdates` and look for `"chat":{"id":123456789`

### 3. Enable GitHub Pages

**Settings → Pages** → Source: **Deploy from a branch** → Branch: `main`, folder: `/ (root)`

Dashboard: `https://YOUR_USERNAME.github.io/bulletin-collator-monitor/`

### 4. Trigger first run

**Actions → Collator monitor → Run workflow**

## GitHub Actions usage

The scheduled workflow runs **every 2 hours** (12 runs/day, ~6 min each ≈ 72 min of Actions time per day — far below any free-tier limit). One run covers **all** configured chains and nodes: the checker opens one telemetry session per chain in parallel, so adding more nodes/chains does not add runs or minutes.

- To change the cadence: edit `.github/workflows/monitor.yml` (`schedule → cron`, currently `7 */2 * * *` — minute 7 avoids the top-of-hour rush on shared runners).
- `status.json` commits use `[skip ci]`, so they never trigger additional runs.
- Alert latency = schedule × `consecutiveOfflineChecksBeforeAlert` (default 1 × 2 h = 2 h).

## Files

| File | Purpose |
|------|---------|
| `config.json` | Template only. Real config comes from `NODES_CONFIG` secret. |
| `status.json` | Auto-updated by CI. PeerIDs are truncated for privacy. |
| `index.html` | Dashboard. Fetches `status.json` every 5 min. |
| `scripts/check.mjs` | Node.js checker. Runs in GitHub Actions. No dependencies. |
| `.github/workflows/monitor.yml` | Cron schedule + git-push logic. |

## Local development

```bash
node scripts/check.mjs        # full run: registry discovery + 5 min listen windows
DISCOVER_MS=8000 LISTEN_MS=20000 node scripts/check.mjs   # short test run
NODES_CONFIG="$(cat my-nodes.json)" node scripts/check.mjs # test with your own config
npx serve . -p 3000           # serve the dashboard locally
```

No `npm install` needed — the checker uses only Node.js built-ins (Node 22+ has native `WebSocket`; the workflow pins Node 22).
