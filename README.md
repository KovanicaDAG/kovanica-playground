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

## Tested SDK Revision & Immutable Resolution

`kovanica-playground` consumes `kovanica-sdk` at the pinned, immutable git revision [`2c88aa782d2049b91248ab6716f74a0f6b94325e`](https://github.com/KovanicaDAG/kovanica-sdk/commit/2c88aa782d2049b91248ab6716f74a0f6b94325e):

- **Manifest Metadata (`package.json`):** Recorded in `kovanicaSdk.testedRevision` (`2c88aa782d2049b91248ab6716f74a0f6b94325e`) and linked via `"kovanica-sdk": "file:../kovanica-sdk"` in `package.json` and `package-lock.json`.
- **Automated Verification (`scripts/prepare-sdk.mjs`):** Running `npm run prepare:sdk` (also invoked automatically during `npm run build`) verifies that `../kovanica-sdk` exists, is checked out at the exact pinned 40-character SHA `2c88aa782d2049b91248ab6716f74a0f6b94325e` (never following a moving `main`), and has compiled `dist/index.js`.
- **CI Enforcement (`.github/workflows/ci.yml` & `tests/methods.test.ts`):** GitHub Actions explicitly checks out `KovanicaDAG/kovanica-sdk` at `ref: 2c88aa782d2049b91248ab6716f74a0f6b94325e`, and unit tests assert that `package.json`, `.github/workflows/ci.yml`, and the resolved `../kovanica-sdk` `HEAD` match this SHA.

---

## Local Integration & Build Workflow

```bash
# 1. Verify/clone and build ../kovanica-sdk at pinned SHA 2c88aa782d2049b91248ab6716f74a0f6b94325e
npm run prepare:sdk

# 2. Install playground dependencies cleanly from lockfile
npm ci

# 3. Install headless Chromium for browser acceptance tests
npx playwright install chromium

# 4. Run typecheck, lint, production build, and test suites
npm run typecheck
npm run lint
npm run build
npm test
npm run test:browser
```

---

## Testing & Verification Modes (Offline, Browser Fixtures, Optional Live, Required Live)

Verification is separated into four explicit, non-conflated layers:

1. **Deterministic Offline Unit & Browser Fixture Tests (`npm test` / `npm run test:browser`):**
   - `tests/methods.test.ts`, `tests/diagnostics-ui.test.tsx`, `tests/live-readiness-modes.test.ts`: SDK pin verification, allowlist checks, and JSDOM regressions.
   - `tests/browser-rpc.test.ts`: Serves the production `dist/` bundle over an ephemeral local HTTP server and drives real Headless Chromium via Playwright with deterministic JSON-RPC route fixtures covering:
     - Genesis / zero-peer state (`0` preserved, badge `Unknown`, availability is not sync)
     - Populated state and lossless `u64::MAX` (`18446744073709551615`) rendering
     - Unknown / missing fields (`—` and `Unknown`, never coerced to `0` or `No`)
     - Nonzero reported `committedHeight` with `0` peers (`Unknown` sync state; reported height is not treated as executed-state evidence)
     - Actively catching-up state (`Catching Up`, `Active`, `behindBy` rounds)
     - Malformed HTTP 200 payloads, JSON-RPC errors, unsupported methods (`-32601`), and unreachable endpoints (honest failure banner without claiming CORS without evidence)
     - Endpoint switch race conditions (delayed Endpoint A cannot overwrite newer Endpoint B), overlapping refreshes, late errors after newer successes, in-flight cancellation, and method-switch abort cleanup
     - Hidden-tab polling pause and visible-tab resume without multiplying intervals
     - Keyboard navigation (`Tab` / `Enter`)

2. **Default / Optional Live Mode (`npm run test:live` / `npm run test:browser:live`):**
   - Connects to `KOVANICA_RPC_URL` (or `LIVE_RPC_URL`, defaulting to `http://127.0.0.1:8545/rpc`).
   - When the live node prerequisite is unavailable, produces a **genuine test skip** (`[skipped]`), separately reported from passing assertions.

3. **Required-Live Mode (`npm run test:live:required` / `npm run test:browser:live:required`):**
   - Enforces live verification (`KOVANICA_REQUIRE_LIVE=1`).
   - Verifies genuine JSON-RPC 2.0 readiness (HTTP 200 alone is insufficient; unreachable endpoints, invalid HTML/JSON payloads, or RPC error objects produce a non-zero exit code).
   - Separates **Basic Read-Only Interoperability** (works on valid genesis / 0-peer nodes) from **Stronger Synced Acceptance** (`committedHeight > 0n`, `peerCount > 0`, `catchingUp === false`, `isNodeSynced(status) === true`).

```bash
# Run deterministic unit + headless Chromium browser fixture tests
npm test
npm run test:browser

# Run optional live RPC & live browser verification (skips if node is unavailable)
npm run test:live
npm run test:browser:live

# Enforce required-live verification (fails with non-zero exit if unavailable or unsynced)
npm run test:live:required
npm run test:browser:live:required
```

---

## Chain-ID Inventory

See [`docs/chain-id-inventory.md`](docs/chain-id-inventory.md) for the complete inventory of chain-ID assumptions across `kovanica-playground` and `kovanica-sdk`, including why L1 `hybrid5` (Chain 5) is not equivalent to `chain2` (Chain 2).

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
