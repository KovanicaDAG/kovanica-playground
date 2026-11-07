# kovanica-playground

A lightweight, accessible developer console and read-only JSON-RPC explorer for the **Kovanica (KVNC)** Layer-1 blockchain, powered by `kovanica-sdk`.

> [!IMPORTANT]
> **Developer Console Boundaries:**
> - This is a specialized developer console and RPC explorer, **not** a replacement for `kovanica-web`'s block explorer, staking UI, or wallet application.
> - **Zero Private Key Handling:** This console does not import seed phrases, hold keys, sign transactions, claim faucet tokens, or submit mining solutions.
> - **Direct Browser Connectivity:** All RPC requests are dispatched directly from your browser without an intermediary server-side proxy.

---

## Visual DNA

Kovanica Playground reflects the established Kovanica design system:
- **Backgrounds:** Deep dark zinc (`#09090b` canvas, `#121214` card surface, `#1a1a1e` elevated surface, `#2a2a30` border).
- **Accents:** Restrained Kovanica Gold (`#F2A900`).
- **Typography:** IBM Plex Sans / Inter system font for crisp readability and IBM Plex Mono for addresses, hashes, and integer quantities.

---

## Features

1. **Network & Endpoint Selector:**
   - Choose between Mainnet (1), Testnet (2), Devnet (3), Testnet V2 (4), Hybrid PoW Testnet (5), and Local Devnet (1337).
   - Configurable RPC URL (defaults to local loopback node `http://127.0.0.1:8545/rpc`).
   - **Chain Mismatch Warning:** Alerts the developer immediately if the connected node reports a Chain ID that does not match the active target network.
   - **Honest Connectivity Diagnostics:** Surfaces detailed connection failure diagnostics explaining possible root causes (node offline, port closed, network unreachable, CORS) without falsely claiming CORS is confirmed without evidence.

2. **Allowlisted Read-Only RPC Method Explorer:**
   - Category filtering across Chain, Account, Transaction, Staking, Diagnostics, and Mining.
   - Dynamic parameter forms with live chain-aware validation (e.g. enforcing canonical 64-character PRO-21 base32 address format `kvnc...dag` on Mainnet/Testnet while allowing legacy hex on Devnet/Chain 5).
   - Formatted request payload, response payload, and millisecond execution timer.
   - Cancellation support via `AbortController`.

3. **Node Diagnostics & Hybrid PoW / Chain 5 Panels:**
   - Distinct node synchronization states: **Catching Up**, **Synced** (SDK-confirmed), **Unknown** (indeterminate/unconfirmed), and **Connection Error**. A successful RPC response alone is not treated as proof of synchronization.
   - Preserves explicit zeros (`0`, `0n`) and full 64-bit integer precision (`bigint`). Missing or uninitialized quantities render clearly as `—` rather than misleading zeros.
   - Dedicated Chain 5 panel displaying target block time (4000 ms), GHOSTDAG K (5), mining difficulty, target bits, and active DAG tips. Shows clear fallback notice on non-hybrid chains.

4. **Resource-Conscious Polling & Endpoint Isolation:**
   - Listens to `document.visibilityState`: pauses background polling whenever the browser tab is hidden or minimized, resuming immediately upon returning.
   - Aborts in-flight requests when switching methods or endpoints.
   - Instantly clears stale network and mining diagnostics upon endpoint change, and discards delayed in-flight responses from prior endpoints.

---

## Tested SDK Revision

`kovanica-playground` consumes `kovanica-sdk` at tested and verified revision [`2c88aa782d2049b91248ab6716f74a0f6b94325e`](https://github.com/KovanicaDAG/kovanica-sdk/commit/2c88aa782d2049b91248ab6716f74a0f6b94325e).

---

## Local Integration & Build Workflow

### 1. Build the SDK at the Tested Revision

```bash
cd ../kovanica-sdk
git checkout 2c88aa782d2049b91248ab6716f74a0f6b94325e
npm install
npm run build
```

### 2. Install Dependencies & Build Playground

From the `kovanica-playground` root:

```bash
# Install dependencies (links to adjacent ../kovanica-sdk)
npm install

# Run type check
npm run typecheck

# Run linter
npm run lint

# Run unit and UI regression tests
npm test

# Build production bundle
npm run build

# Start local development server
npm run dev
```

---

## Testing & Live RPC Verification Modes

The test suite supports two explicit modes for live RPC verification:

1. **Default / Offline Mode (`npm test`):**
   - Offline unit tests, allowlist assertions, and rendered UI regressions run and assert deterministically against isolated fixtures.
   - When live node prerequisites are unavailable, live integration tests produce a **real test skip** (`[skipped]`), separately reported from passing assertions rather than counting as passed.

2. **Required-Live Mode (`npm run test:live:required` or `KOVANICA_REQUIRE_LIVE=1 npm test`):**
   - Enforces live verification against a configured endpoint (`KOVANICA_RPC_URL` or `LIVE_RPC_URL`, defaulting to `http://127.0.0.1:8545/rpc`).
   - Verifies genuine JSON-RPC 2.0 readiness (HTTP 200 alone is insufficient; invalid payloads, non-JSON HTML, or RPC error objects produce a non-zero failure exit).
   - Separates verification into two distinct scenarios:
     - **Basic Read-Only Interoperability:** Verifies canonical RPC queries (`kovanica_syncStatus`, `kovanica_blockNumber`) across any valid node, accommodating legitimate genesis and 0-peer unsynced states.
     - **Stronger Synced Acceptance:** Enforces strict advanced node conditions (`committedHeight > 0n`, active `peerCount > 0`, `catchingUp === false`, and `isNodeSynced(status) === true`).

```bash
# Run all offline and UI tests (skips live verification if node is unavailable)
npm test

# Run live RPC verification against an isolated node
npm run test:live

# Enforce required-live verification (fails with non-zero exit if unavailable)
npm run test:live:required
```

---

## CI / Clean Checkout Workflow

In CI or isolated environments, the SDK is checked out at the exact pinned revision before building:

```bash
git clone https://github.com/KovanicaDAG/kovanica-sdk.git
cd kovanica-sdk
git checkout 2c88aa782d2049b91248ab6716f74a0f6b94325e
npm ci
npm run build

cd ..
git clone https://github.com/KovanicaDAG/kovanica-playground.git
cd kovanica-playground
npm ci
npm run typecheck
npm run lint
npm test
npm run build
```

---

## License

MIT License (`LICENSE`).
