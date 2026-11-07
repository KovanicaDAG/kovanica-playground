# Chain-ID Assumptions Inventory (Preparation for Separate `canonical2` Proposal)

> **Scope & Non-Modification Notice:**
> This document is a read-only architectural inventory of all chain-ID assumptions across `kovanica-playground`, the pinned `kovanica-sdk` (`2c88aa782d2049b91248ab6716f74a0f6b94325e`), and the L1 reference boundary.
> **No blanket numeric replacement, chain behavior changes, genesis edits, migrations, or network resets are performed in this PR.**

---

## 1. Registered & Consumed Chain-ID Matrix

| Chain ID | Constant (`CHAIN_IDS`) | Network Name | Consensus Engine | Legacy Hex Address Policy | Mining RPC (`getMiningInfo` / `getDagTips`) | Primary Role |
|---:|---|---|---|---|---|---|
| `1` | `MAINNET` | Mainnet | Mysticeti (uncertified DAG, wave = 3) | **Rejected** (Strict PRO-21 base32 `kvnc...dag` only) | Unsupported (`-32601`) | Production Mainnet |
| `2` | `TESTNET` | Testnet (Legacy ID) | Mysticeti (uncertified DAG, wave = 3) | **Rejected** (Strict PRO-21 base32 `kvnc...dag` only) | Unsupported (`-32601`) | Legacy / Canonical-2 Testnet slot |
| `3` | `DEVNET` | Devnet | Mysticeti (uncertified DAG, wave = 3) | Allowed (`0x<64-hex>`, `<64-hex>`, `kvnc<64-hex>dag`) | Unsupported (`-32601`) | Ephemeral Devnet |
| `4` | `TESTNET_V2` | Testnet V2 | Mysticeti (uncertified DAG, wave = 3) | Allowed (`0x<64-hex>`, `<64-hex>`, `kvnc<64-hex>dag`) | Unsupported (`-32601`) | Active Mysticeti Testnet V2 |
| `5` | `HYBRID_TESTNET` | Hybrid PoW Testnet | Hybrid PoW + GHOSTDAG (`K = 5`, target `4000 ms`, ADR 0003) | Allowed in SDK (`isLegacyAddressAllowed(5) === true`) | **Supported** (`kovanica_getMiningInfo`, `kovanica_getDagTips`) | Experimental Hybrid PoW Testnet |
| `1337` | `LOCAL` | Local Devnet | Mysticeti (uncertified DAG, wave = 3) | Allowed (`0x<64-hex>`, `<64-hex>`, `kvnc<64-hex>dag`) | Unsupported (`-32601`) | Local single-node / cluster testing |

---

## 2. Why Current L1 `hybrid5` (Chain 5) Is NOT Equivalent to `chain2` (Chain 2)

Conflating `HYBRID_TESTNET` (`chain_id = 5`) with `TESTNET` (`chain_id = 2`) or performing a blanket numeric substitution (`5 -> 2` or `4 -> 2`) is architecturally invalid for five independent reasons:

1. **Consensus & Block-Graph Divergence:**
   - **Chain 2 (`TESTNET`)** is a Mysticeti-style uncertified DAG chain (3-round commit wave, validator committee quorum certificates, VRF leader election).
   - **Chain 5 (`HYBRID_TESTNET`)** is defined under ADR 0003 as a Hybrid PoW + GHOSTDAG network (`ghostdag_k = 5`, `target_block_time_ms = 4000`, KovanicaHash PoW difficulty adjustment).
2. **Address Parsing & PRO-21 Strictness (`legacy_address_allowed`):**
   - On **Chain 2**, legacy hex addresses (`0x...` or `kvnc<64-hex>dag`) are **strictly rejected** at both the L1 type layer (`kovanica-types/src/address.rs`: `legacy_address_allowed(2) == false`) and the SDK boundary (`kovanica-sdk/src/chains.ts`: `allowsLegacyAddress: false`). Only 64-character PRO-21 base32 (`kvnc` + 57 base32 chars + `dag` with 29-bit BLAKE3 checksum) addresses are valid.
   - On **Chain 5** (and Chains `3`, `4`, `1337`), legacy hex addresses are currently accepted by `isLegacyAddressAllowed`.
3. **RPC Handler Surface:**
   - **Chain 5** exposes PoW-specific RPC methods (`kovanica_getMiningInfo`, `kovanica_getDagTips`) returning `chain_id`, `difficulty`, `network_hashrate_estimate`, `target_bits`, and `ghostdag_k`.
   - Mysticeti chains (`1`, `2`, `3`, `4`, `1337`) do not run PoW mining and either omit or reject `kovanica_getMiningInfo`.
4. **Cryptographic Domain Separation & Replay Protection:**
   - Every signed L1 artifact embeds `chain_id` (`u64` little-endian) in its domain-separated preimage:
     - Transactions: `"KUNA/tx/v1" || chain_id || ...`
     - DAG Votes: `"KUNA/vote/v1" || chain_id || epoch || ...`
     - Timeout Certificates: `"KUNA/timeout/v1" || chain_id || genesis_hash || ...`
     - Light Client Seals: `"KUNA/commit/v1" || chain_id || header_hash`
     - VRF Inputs: `"KUNA-VRF1-v1:<chain_id>:<round>:<author>:0"`
   - Any numeric change invalidates existing signatures, genesis hashes, and `networkTag` (`<chain_id>-<genesis_prefix16>`) commitments.
5. **Network Identity Tag (`networkTag`) Handshake:**
   - `kovanica_syncStatus` returns `networkTag` formatted as `<chain_id>-<16_hex_genesis_prefix>` (e.g., `4-0eacd5699210b145` or `5-b102528fe5abbf05`), which the Playground parses to detect mismatches between the user-selected network and the connected RPC endpoint.

---

## 3. Exact Source Inventory in `kovanica-playground`

### 3.1 `src/App.tsx`
- **Line 36 (`selectedChainId` default state):**
  - `const [selectedChainId, setSelectedChainId] = useState<number>(CHAIN_IDS.HYBRID_TESTNET);`
  - Default UI target network dropdown starts at `CHAIN_IDS.HYBRID_TESTNET` (`5`).
- **Lines 132–154 (`probeNode` chain-ID detection):**
  - Attempts `client.getMiningInfo()` first; if supported, sets `connectedNodeChainId(mining.chain_id)`.
  - If `getMiningInfo()` throws (standard on Mysticeti chains `1`, `2`, `3`, `4`, `1337`), falls back to parsing the `<chain_id>-<genesis_hex>` prefix from `sync.networkTag`:
    ```ts
    const cid = Number.parseInt(sync.networkTag.split("-")[0], 10);
    ```
- **Lines 289 & 316 (`validateParam` calls):**
  - Passes `selectedChainId` into `validateParam(param, val, selectedChainId)`, which enforces chain-specific address rules (`isValidAddress(str, chainId)`).
- **Lines 386–390 & 511–523 (`hasNetworkMismatch` warning banner):**
  - Compares `connectedNodeChainId !== selectedChainId` and renders the `Chain Identity Mismatch Detected` warning banner with `selectedChainConfig?.name`, `selectedChainId`, and `connectedNodeChainId`.
- **Lines 477–482 (Target Network `<select>` options):**
  - Explicitly lists all six SDK chain constants:
    - `CHAIN_IDS.MAINNET` (`1`) — `"Mainnet (Chain 1)"`
    - `CHAIN_IDS.TESTNET` (`2`) — `"Testnet (Chain 2 - Legacy)"`
    - `CHAIN_IDS.DEVNET` (`3`) — `"Devnet (Chain 3)"`
    - `CHAIN_IDS.TESTNET_V2` (`4`) — `"Testnet V2 (Chain 4)"`
    - `CHAIN_IDS.HYBRID_TESTNET` (`5`) — `"Hybrid PoW Testnet (Chain 5)"`
    - `CHAIN_IDS.LOCAL` (`1337`) — `"Local Devnet (Chain 1337)"`
- **Lines 841–908 (Hybrid PoW & DAG Info side panel):**
  - Labels `kovanica_getMiningInfo` metrics specifically as `"Chain 5 testnet metrics (ADR 0003)"` with badge `"Chain 5"` and empty-state explanation: `"PoW Mining info is available on Chain 5 (Hybrid PoW testnet). Chains 1–4 operate under Mysticeti consensus."`

### 3.2 `src/methods.ts`
- **Lines 327–344 (`kovanica_getMiningInfo` & `kovanica_getDagTips` descriptors):**
  - Documented as `(Hybrid PoW / Chain 5)` methods under category `"Mining & DAG"`.
- **Lines 350–372 (`validateParam`):**
  - Defaults `chainId: number = CHAIN_IDS.MAINNET` (`1`, fail-closed strict PRO-21 validation).
  - Calls `isValidAddress(str, chainId)` from `kovanica-sdk`.

### 3.3 `tests/`
- **`tests/methods.test.ts` (Lines 56–73):**
  - Verifies that bare hex addresses (`0x00...00`) are rejected on `CHAIN_IDS.MAINNET` (`1`) and accepted on `CHAIN_IDS.HYBRID_TESTNET` (`5`).
- **`tests/diagnostics-ui.test.tsx` (Lines 258–269):**
  - Uses `chain_id: 5` fixture for `kovanica_getMiningInfo` rendering and endpoint-change clearing tests.
- **`tests/browser-rpc.test.ts`:**
  - Exercises both Mysticeti `4-*` `networkTag` fixtures (where `kovanica_getMiningInfo` returns `-32601`) and `5-*` Hybrid PoW `kovanica_getMiningInfo` large-integer fixtures.

---

## 4. Upstream SDK Boundary (`kovanica-sdk` @ `2c88aa782d2049b91248ab6716f74a0f6b94325e`)

- **`src/chains.ts` (Lines 7–14, 32–97, 110–116):**
  - Exports `CHAIN_IDS`, `KNOWN_CHAINS`, `getChainConfig(chainId)`, and `isLegacyAddressAllowed(chainId)`.
  - `isLegacyAddressAllowed(chainId)` returns `true` only for `DEVNET (3)`, `TESTNET_V2 (4)`, `HYBRID_TESTNET (5)`, and `LOCAL (1337)`. It returns `false` for `MAINNET (1)` and `TESTNET (2)`.
- **`src/address.ts` (Lines 148–178):**
  - `isValidAddress(address, chainId)` and `parseAddressForChain(address, chainId)` delegate legacy fallback permission to `isLegacyAddressAllowed(chainId)`.

---

## 5. Checklist for a Future Separate `canonical2` Proposal

When a dedicated `canonical2` proposal is executed in a separate coordinated change across L1, SDK, and Playground:

1. **Preserve Explicit Separation Between Mysticeti Testnet (`2` / `4`) and Hybrid PoW (`5`):**
   - Do not alias or overwrite `CHAIN_IDS.HYBRID_TESTNET` (`5`) with `2`. If Chain 2 is promoted as the canonical Mysticeti public testnet, Chain 5 must remain a distinct entry (or be explicitly retired via its own ADR) rather than silently renumbered.
2. **Confirm Address Policy Intentionally:**
   - Decide explicitly whether `canonical2` enforces strict PRO-21 base32 addresses (`legacy_address_allowed(2) == false`, matching `MAINNET`) or permits legacy hex during transition.
3. **Update Default Selected Chain ID in Playground (`src/App.tsx:36`):**
   - Only switch `useState<number>(CHAIN_IDS.HYBRID_TESTNET)` to the canonical testnet constant once the target testnet RPC endpoint and SDK metadata are aligned.
4. **Update Labels Without Breaking Mismatch Detection:**
   - Update `<option value={CHAIN_IDS.TESTNET}>` label in `src/App.tsx:478` and `KNOWN_CHAINS[CHAIN_IDS.TESTNET]` in `kovanica-sdk/src/chains.ts:43–52` while keeping `networkTag` (`<chain_id>-<genesis_prefix16>`) mismatch detection intact.
