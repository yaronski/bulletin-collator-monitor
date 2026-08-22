# Collator Monitor (Polkadot + Kusama ecosystem)

Tracks whether your collators/nodes are visible on the official [Polkadot Telemetry](https://telemetry.polkadot.io/) — without needing access to the nodes themselves. Works for **any chain in the telemetry registry**: Polkadot Bulletin, Kusama People, Polkadot Asset Hub, the relays themselves, and 150+ more.

Connects to `wss://feed.telemetry.polkadot.io/feed`, discovers all chains from the live registry, subscribes to every chain that has configured nodes (one WSS connection per chain, in parallel), and matches your nodes by **libp2p PeerID** (recommended — stable across restarts) or by **telemetry display name** (exact case-insensitive match, with unambiguous-substring fallback). Runs as a GitHub Actions cron every hour.

**Privacy**: Node PeerIDs are stored in GitHub Secrets, not in the repo. The public `status.json` only shows truncated PeerIDs (`12D3KooW…MRnr`).

## How it works

```
GitHub Actions (every hour)
  └─ scripts/check.mjs
       ├─ reads  NODES_CONFIG secret           (your nodes - private)
       ├─ opens  WSS to feed.telemetry.polkadot.io/feed
       ├─ harvests the chain registry (AddedChain messages — no hardcoded genesis hashes)
       ├─ resolves each configured chain by label (exact or unique substring)
       ├─ opens one parallel listen session per chain (5 min)
       ├─ matches nodes by PeerID or display name
       ├─ detects offline transitions (2 consecutive checks default)
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
| `offline` | Not in the feed — alerts after 2 consecutive checks |
| `error` | Chain feed unreachable / chain unknown — offline counting paused |

> **Why PeerID instead of SS58 address?** The telemetry feed no longer carries validator/authority addresses (the GRANDPA authority-set messages are not emitted by the current backend — verified against Polkadot, Kusama and the system parachains), so there is nothing to match an address against. The libp2p PeerID is the only stable identity in the feed; display names work too but are operator-chosen and not enforced unique.

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

- `chain` — telemetry chain label, resolved against the live registry. Exact match first, then unique substring (e.g. `"Kusama People"` or just `"people kusama"`). A raw genesis hash (`0x…`, 64 hex chars) also works.
- `peerId` — recommended. Run `journalctl -u <service> -b | grep "Local node identity"` on the node, or copy it from the dashboard's full node table (hover a truncated PeerID to see the full one).
- `name` — alternative matcher: exact case-insensitive telemetry display name; falls back to substring if exactly one node matches. Fails loudly (`error`) when ambiguous.

#### Getting Telegram credentials

1. **Create bot**: Message [@BotFather](https://t.me/botfather) → `/newbot` → follow prompts → copy the token
2. **Set bot profile pic** (optional): `/setuserpic` → upload `telegramBotProfilePic.png` from this repo
3. **Get your chat ID**: send any message to your bot, then open `https://api.telegram.org/botYOUR_TOKEN/getUpdates` and look for `"chat":{"id":123456789`

### 3. Enable GitHub Pages

**Settings → Pages** → Source: **Deploy from a branch** → Branch: `main`, folder: `/ (root)`

Dashboard: `https://YOUR_USERNAME.github.io/bulletin-collator-monitor/`

### 4. Trigger first run

**Actions → Collator monitor → Run workflow**

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
node scripts/check.mjs        # full run: registry discovery + 5 min listen windows
DISCOVER_MS=8000 LISTEN_MS=20000 node scripts/check.mjs   # short test run
npx serve . -p 3000           # serve the dashboard locally
```

No `npm install` needed — the checker uses only Node.js built-ins (Node 22+ has native `WebSocket`; the workflow pins Node 22).

## Changing the check interval

Edit `.github/workflows/monitor.yml`:

```yaml
schedule:
  - cron: '0 * * * *'   # every hour — change as needed
```

## Adding nodes on other chains

Add entries to the `NODES_CONFIG` secret with the chain label of the target network. Any chain visible on telemetry.polkadot.io works — the registry is discovered live every run, so new chains are picked up automatically. The per-chain "Show all nodes" table on the dashboard lists every node (name + full PeerID on hover) currently visible, which is the easiest way to find PeerIDs of nodes you want to watch.
