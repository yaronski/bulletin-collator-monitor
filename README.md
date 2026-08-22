# Bulletin Collator Monitor

Tracks whether your Bulletin (Polkadot) collators are visible on the official [Polkadot Telemetry](https://telemetry.polkadot.io/#/0x2761c95259d59e55ae3daf756c1413b46e45a5a2987299f8ef8e5d8e4776cbc4) — without needing access to the node itself.

Connects to `wss://feed.telemetry.polkadot.io/feed`, subscribes to the Polkadot Bulletin chain feed (genesis `0x2761…6cbc4`), and matches your nodes by **libp2p PeerID** (stable across restarts — unlike telemetry display names or per-connection feed IDs). Runs as a GitHub Actions cron every hour with a 5-minute listen window.

**Privacy**: Node PeerIDs are stored in GitHub Secrets, not in the repo. The public `status.json` only shows truncated PeerIDs (`12D3KooW…MRnr`).

## How it works

```
GitHub Actions (every hour)
  └─ scripts/check.mjs
       ├─ reads  NODES_CONFIG secret           (your nodes - private)
       ├─ opens  WSS to feed.telemetry.polkadot.io/feed
       ├─ sends  subscribe:<genesis-hash>
       ├─ listens 5 minutes (AddedNode/RemovedNode/StaleNode/
       │           ImportedBlock/FinalizedBlock/NodeStats messages)
       ├─ detects offline transitions (2 consecutive checks default)
       ├─ sends  Telegram alert on transition
       └─ writes status.json              (PeerIDs truncated, committed to repo)

GitHub Pages
  └─ index.html fetches status.json every 5 min and renders the dashboard
```

A node counts as **offline** only if it does not appear in the feed at the end of the listen window. If the telemetry feed itself is unreachable or sends no data, the check marks everything `error` and pauses offline counting — a broken telemetry server never causes false "offline" alerts.

| Status | Meaning |
|--------|---------|
| `online` | Present in the telemetry feed with fresh blocks |
| `stale` | Present but flagged stale (no fresh telemetry for ~2 min) |
| `offline` | Not in the feed — alerts after 2 consecutive checks |
| `error` | Telemetry feed itself unreachable — offline counting paused |

---

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
      "peerId": "12D3KooWMc7ZJ6JGiehG1H45JL69QTPivEBnzm8LihkEEFjYMRnr",
      "label": "ExtraCoin"
    }
  ],
  "consecutiveOfflineChecksBeforeAlert": 2
}
```

> **Where to find the PeerID**: run `journalctl -u <service> -b | grep "Local node identity"` on the node, or check the identity column on telemetry. The PeerID survives restarts; node names do not have to be unique.

#### Getting Telegram credentials

1. **Create bot**: Message [@BotFather](https://t.me/botfather) → `/newbot` → follow prompts → copy the token
2. **Get your chat ID**:
   - Open Telegram and send any message to your new bot (e.g. `/start`)
   - Open `https://api.telegram.org/botYOUR_TOKEN/getUpdates` in your browser
   - Look for `"chat":{"id":123456789` — that number is your `TELEGRAM_CHAT_ID`

### 3. Enable GitHub Pages

1. **Settings → Pages** → Source: **Deploy from a branch** → Branch: `main`, folder: `/ (root)`
2. Your dashboard: `https://YOUR_USERNAME.github.io/bulletin-collator-monitor/`

### 4. Trigger first run

**Actions → Bulletin collator monitor → Run workflow**

---

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
node scripts/check.mjs        # runs a full 5-minute listen window
npx serve . -p 3000           # serve the dashboard locally
```

No `npm install` needed — the checker uses only Node.js built-ins (Node 20+ has native `WebSocket`).

## Changing the check interval

Edit `.github/workflows/monitor.yml`:

```yaml
schedule:
  - cron: '0 * * * *'   # every hour — change as needed
```

## Adding more nodes

Add entries to the `NODES_CONFIG` secret (or `config.json` for local runs). Any node on the Bulletin telemetry feed can be watched — the full node table on the dashboard shows every PeerID currently visible.

## Monitoring a different chain

`config.json` / `NODES_CONFIG` accept `feedUrl` and `genesisHash` overrides, so the same tool works for any chain on telemetry.polkadot.io.
