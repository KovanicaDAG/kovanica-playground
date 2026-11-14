# Canonical Chain-ID Inventory (`kovanica-playground` & `kovanica-sdk`)

> **Scope & Alignment Notice:**
> This document records the canonical 4-chain registry across `kovanica-playground`, `kovanica-sdk`, and the Kovanica L1 reference boundary (`crates/kovanica-params/src/lib.rs`, `crates/kovanica-types/src/address.rs`, and `crates/kovanica-types/src/signing.rs`).
> Legacy/experimental Chain IDs `4` (`TESTNET_V2`) and `5` (`hybrid5`) are retired.

---

## 1. Canonical Chain-ID Matrix

| Chain ID | Constant (`CHAIN_IDS`) | Network Name | Consensus Engine | Legacy Hex Address Policy | Mining RPC (`getMiningInfo` / `getDagTips`) | Primary Role |
|---:|---|---|---|---|---|---|
| `1` | `MAINNET` | Mainnet | Hybrid PoW + GHOSTDAG (`K = 5`, target `4000 ms`, KovanicaHash, no stake in consensus) | **Rejected** (Strict PRO-21 base32 `kvnc...dag` only) | **Supported** (`kovanica_getMiningInfo`, `kovanica_getDagTips`) | Production Mainnet |
| `2` | `TESTNET` / `HYBRID_TESTNET` | Testnet | Hybrid PoW + GHOSTDAG (`K = 5`, target `4000 ms`, KovanicaHash, no stake in consensus, ADR 0003) | **Rejected** (Strict PRO-21 base32 `kvnc...dag` only) | **Supported** (`kovanica_getMiningInfo`, `kovanica_getDagTips`) | Public Hybrid PoW Testnet |
| `3` | `DEVNET` | Devnet | Mysticeti (development parameter profile) | Allowed (`0x<64-hex>`, `<64-hex>`, `kvnc<72-hex>dag`) | Unsupported (`-32601` / `-32600`) | Ephemeral Devnet |
| `1337` | `LOCAL` | Local Devnet | Mysticeti (development parameter profile) | Allowed (`0x<64-hex>`, `<64-hex>`, `kvnc<72-hex>dag`) | Unsupported (`-32601` / `-32600`) | Local single-node / cluster testing |

---

## 2. Protocol Properties of Canonical Chains `1` & `2`

1. **Consensus & Block-Graph Architecture (Hybrid PoW + GHOSTDAG):**
   - Both **Mainnet (`1`)** and **Testnet (`2`, aliased as `HYBRID_TESTNET = 2`)** execute Hybrid PoW + GHOSTDAG consensus (`ghostdag_k = 5`, `target_block_time_ms = 4000`, KovanicaHash PoW difficulty adjustment, `NoStake82M` emission policy with no stake in consensus).
   - **Devnet (`3`)** and **Local (`1337`)** use development parameter profiles for fast local cluster testing.
2. **Address Parsing & PRO-21 Strictness (`legacy_address_allowed`):**
   - On **Mainnet (`1`)** and **Testnet (`2`)**, legacy hex addresses (`0x...` or `kvnc<72-hex>dag`) are **strictly rejected** at both the L1 type layer (`kovanica-types/src/address.rs`: `legacy_address_allowed(chain_id) == false`) and the SDK boundary (`kovanica-sdk/src/chains.ts`: `isLegacyAddressAllowed(chainId) === false`). Only 64-character PRO-21 base32 (`kvnc` + 57 base32 chars + `dag` with 29-bit BLAKE3 checksum) addresses are valid.
   - On **Devnet (`3`)** and **Local (`1337`)**, legacy hex addresses (with lowercase `0x` prefix or bare 64-char hex) are accepted by `isLegacyAddressAllowed`.
3. **RPC Handler Surface:**
   - **Mainnet (`1`)** and **Testnet (`2`)** expose PoW and DAG RPC methods (`kovanica_getMiningInfo`, `kovanica_getDagTips`) returning `chain_id`, `difficulty`, `network_hashrate_estimate`, `target_bits`, and `ghostdag_k`.
4. **Cryptographic Domain Separation & Replay Protection:**
   - Every signed L1 artifact embeds `chain_id` (`u64` little-endian) in its domain-separated preimage (`"KVNC/tx/v1"`, `"KVNC/vote/v1"`, `"KVNC/timeout/v1"`, `"KVNC/commit/v1"`, `"KVNC-VRF1-v1"`).
5. **Network Identity Tag (`networkTag`) Handshake:**
   - `kovanica_syncStatus` returns `networkTag` formatted as `<chain_id>-<16_hex_genesis_prefix>` (e.g., `1-fedcba9876543210` or `2-a1b2c3d4e5f60718`), which the Playground parses to detect mismatches between the user-selected network and the connected RPC endpoint.

---

## 3. Exact Source Inventory in `kovanica-playground`

### 3.1 `src/App.tsx`
- **Line 36 (`selectedChainId` default state):**
  - `const [selectedChainId, setSelectedChainId] = useState<number>(CHAIN_IDS.TESTNET);`
  - Default UI target network dropdown starts at `CHAIN_IDS.TESTNET` (`2`).
- **Lines 133–155 (`probeNode` chain-ID detection):**
  - Attempts `client.getMiningInfo()` first; if supported, sets `connectedNodeChainId(mining.chain_id)`.
  - If `getMiningInfo()` throws (standard on non-hybrid development chains `3` and `1337`), falls back to parsing the `<chain_id>-<genesis_hex>` prefix from `sync.networkTag`:
    ```ts
    const cid = Number.parseInt(sync.networkTag.split("-")[0], 10);
    ```
- **Lines 208 & 317 (`validateParam` calls):**
  - Passes `selectedChainId` into `validateParam(param, val, selectedChainId)`, which enforces chain-specific address rules (`isValidAddress(str, chainId)`).
- **Lines 419–421 & 540–552 (`hasNetworkMismatch` warning banner):**
  - Compares `connectedNodeChainId !== selectedChainId` and renders the `Chain Identity Mismatch Detected` warning banner with `selectedChainConfig?.name`, `selectedChainId`, and `connectedNodeChainId`.
- **Lines 507–510 (Target Network `<select>` options):**
  - Lists the four canonical networks:
    - `CHAIN_IDS.MAINNET` (`1`) — `"Mainnet (Chain 1)"`
    - `CHAIN_IDS.TESTNET` (`2`) — `"Testnet (Chain 2)"`
    - `CHAIN_IDS.DEVNET` (`3`) — `"Devnet (Chain 3)"`
    - `CHAIN_IDS.LOCAL` (`1337`) — `"Local Devnet (Chain 1337)"`
- **Lines 868–940 (Hybrid PoW & DAG Info side panel):**
  - Dynamically labels `kovanica_getMiningInfo` metrics for Chain 1 (`"Mainnet metrics (Hybrid PoW + GHOSTDAG)"` / `"Chain 1"`) or Chain 2 (`"Chain 2 testnet metrics (ADR 0003)"` / `"Chain 2"`), with empty-state explanation: `"PoW Mining info is available on Hybrid PoW + GHOSTDAG networks: Mainnet (Chain 1) and Testnet (Chain 2). Devnet (Chain 3) and Local Devnet (Chain 1337) use development parameter profiles."`

### 3.2 `src/methods.ts`
- **Lines 331–348 (`kovanica_getMiningInfo` & `kovanica_getDagTips` descriptors):**
  - Documented as `(Hybrid PoW / Chains 1 & 2)` methods under category `"Mining & DAG"`.
- **Lines 354–393 (`validateParam`):**
  - Defaults `chainId: number = CHAIN_IDS.MAINNET` (`1`, fail-closed strict PRO-21 validation).
  - Calls `isValidAddress(str, chainId)` from `kovanica-sdk`.

### 3.3 `tests/`
- **`tests/methods.test.ts`:**
  - Verifies that bare hex addresses (`0x00...00`) are rejected on `CHAIN_IDS.MAINNET` (`1`) and `CHAIN_IDS.TESTNET` (`2`), and accepted on `CHAIN_IDS.DEVNET` (`3`) and `CHAIN_IDS.LOCAL` (`1337`).
- **`tests/diagnostics-ui.test.tsx`:**
  - Uses canonical `chain_id: 2` / `"2-..."` fixtures for `kovanica_getMiningInfo` rendering and endpoint-change clearing tests.
- **`tests/browser-rpc.test.ts`:**
  - Exercises both non-hybrid `3-*` `networkTag` fixtures and `2-*` Hybrid PoW `kovanica_getMiningInfo` large-integer fixtures.

---

## 4. Upstream SDK Boundary (`kovanica-sdk`)

- **`src/chains.ts`:**
  - Exports `CHAIN_IDS` (`MAINNET: 1`, `TESTNET: 2`, `HYBRID_TESTNET: 2`, `DEVNET: 3`, `LOCAL: 1337`), `KNOWN_CHAINS`, `getChainConfig(chainId)`, and `isLegacyAddressAllowed(chainId)`.
  - `isLegacyAddressAllowed(chainId)` returns `true` only for `DEVNET (3)` and `LOCAL (1337)`. It returns `false` for `MAINNET (1)`, `TESTNET (2)`, and all retired/unknown chain IDs.
- **`src/address.ts`:**
  - `isValidAddress(address, chainId)` and `parseAddressForChain(address, chainId)` delegate legacy fallback permission to `isLegacyAddressAllowed(chainId)` and enforce lowercase `0x` prefix on legacy hex strings.
