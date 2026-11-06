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
   - **Honest CORS Diagnostics:** If the browser fetch fails due to CORS, clear setup instructions are surfaced instead of an obscure network failure.

2. **Allowlisted Read-Only RPC Method Explorer:**
   - Category filtering across Chain, Account, Transaction, Staking, Diagnostics, and Mining.
   - Dynamic parameter forms with live chain-aware validation (e.g. enforcing canonical 64-character PRO-21 base32 address format `kvnc...dag` on Mainnet/Testnet while allowing legacy hex on Devnet/Chain 5).
   - Formatted request payload, response payload, and millisecond execution timer.
   - Cancellation support via `AbortController`.

3. **Node Diagnostics & Hybrid PoW / Chain 5 Panels:**
   - Real-time peer count, committed height, local tip round, and sync status.
   - Dedicated Chain 5 panel displaying target block time (4000 ms), GHOSTDAG K (5), mining difficulty, target bits, and active DAG tips. Shows clear fallback notice on non-hybrid chains.

4. **Resource-Conscious Polling:**
   - Listens to `document.visibilityState`: pauses background polling whenever the browser tab is hidden or minimized.
   - Aborts in-flight requests when switching methods or endpoints.

---

## Local Integration & Build Workflow

`kovanica-playground` consumes `kovanica-sdk` as a real package dependency.

### 1. Build the SDK

```bash
cd ../kovanica-sdk
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

# Run unit tests
npm test

# Build production bundle
npm run build

# Start local development server
npm run dev
```

---

## CI / Clean Checkout Workflow

In CI or isolated environments, the SDK is built first before building the playground:

```bash
git clone https://github.com/KovanicaDAG/kovanica-sdk.git
git clone https://github.com/KovanicaDAG/kovanica-playground.git

cd kovanica-sdk
npm ci
npm run build

cd ../kovanica-playground
npm ci
npm run typecheck
npm test
npm run build
```

---

## License

MIT License (`LICENSE`).
