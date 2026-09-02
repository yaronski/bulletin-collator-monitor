# Collator Monitor (Polkadot + Kusama ecosystem)

Tracks whether your collators/nodes are visible on the official [Polkadot Telemetry](https://telemetry.polkadot.io/) — without needing access to the nodes themselves. Works for **any chain in the telemetry registry**: Polkadot Bulletin, Kusama People, Polkadot Asset Hub, the relays themselves, and 150+ more.

Two data sources, one dashboard:

1. **Telemetry** — connects to `wss://feed.telemetry.polkadot.io/feed`, discovers all chains from the live registry and subscribes to every chain that has configured nodes (one WSS connection per chain, in parallel). Matches by **libp2p PeerID** (recommended — stable across restarts) or **telemetry display name** (exact case-insensitive, unambiguous-substring fallback). Answers: *is my node running and visible?*
2. **On-chain** — reads `Session.Validators`, `CollatorSelection.Candidates` and `CollatorSelection.Invulnerables` via `state_getStorage` on public RPC endpoints (no `state_call` needed). Matches your **SS58 address** in any format — Kusama- and Polkadot-style both decode to the same 32-byte account, so either prefix works on any chain. Answers: *is my collator in the active set / still a candidate?*

Runs as a GitHub Actions cron every 2 hours.

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

> **Telemetry carries no addresses** (the GRANDPA authority-set messages are not emitted by the current backend — verified against Polkadot, Kusama and the system parachains), so address monitoring goes on-chain instead: the checker reads the active/candidate sets directly from the chain's storage over public RPC. PeerID remains the right identity for telemetry; display names are operator-chosen and not enforced unique.

**On-chain semantics** (per watched address):

| `chainStatus` | Meaning | Alert |
|---------------|---------|-------|
| `active` | In `Session.Validators` — currently authoring blocks | — |
| `standby` | Candidate/invulnerable, not in this session's active set (normal rotation) | — |
| `missing` | Not in validators, candidates or invulnerables — kicked/unbonded | after N consecutive checks |
| (RPC error) | Endpoint unreachable | no alert (offline counting paused) |

Relay chains (Polkadot/Kusama): the set is era-based and huge (600/700), so addresses there are display-only — `active`/`standby`, no missing-alerts. System parachains: `missing` means your bond left the candidate list — that alerts.

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
      "address": "15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5",
      "label": "My AH collator (by address)"
    }
  ],
  "consecutiveOfflineChecksBeforeAlert": 2
}
```

- `chain` — telemetry chain label (exact, unique substring, or genesis hash)
- `peerId` — recommended for telemetry, stable across node restarts
- `name` — alternative telemetry matcher: exact case-insensitive display name; falls back to substring if exactly one node matches
- `address` — SS58 address (any prefix — Kusama `C…`/`F…`/`G…`/`H…` and Polkadot `1…`/`5…` styles both work; decoded and matched by the raw account). Can be combined with `peerId`/`name` in one entry for full visibility, or used alone
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
| `rpcUrls` (config) | Per-chain RPC endpoints. Defaults: Polkadot, Kusama, both Asset Hubs, both People, both Coretime chains. Bulletin has no public RPC — telemetry-only there. |
| `.github/workflows/monitor.yml` | Cron schedule + git-push logic. |

## Local development

```bash
node scripts/check.mjs        # full run: registry discovery + 5 min listen windows
DISCOVER_MS=8000 LISTEN_MS=20000 node scripts/check.mjs   # short test run
NODES_CONFIG="$(cat my-nodes.json)" node scripts/check.mjs # test with your own config
npx serve . -p 3000           # serve the dashboard locally
```

No `npm install` needed — the checker uses only Node.js built-ins (Node 22+ has native `WebSocket`; the workflow pins Node 22).
