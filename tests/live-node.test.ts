// @vitest-environment node
import { describe, expect, it } from "vitest";
import { isNodeSynced, KovanicaClient } from "kovanica-sdk";

const LIVE_RPC_URL = "http://127.0.0.1:8545/rpc";

async function isLiveNodeAvailable(): Promise<boolean> {
  try {
    const res = await fetch(LIVE_RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "kovanica_syncStatus",
        params: [],
        id: 1,
      }),
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

describe("Playground Live RPC Node Integration", () => {
  it("queries live Kovanica node and evaluates canonical SyncStatus contract", async () => {
    const available = await isLiveNodeAvailable();
    if (!available) {
      console.warn("BLOCKED: Local Kovanica node not reachable at " + LIVE_RPC_URL);
      return;
    }

    const client = new KovanicaClient(LIVE_RPC_URL);

    // 1. Live syncStatus query
    const status = await client.syncStatus({ timeoutMs: 5000 });

    // Canonical SDK fields
    expect(status.committedHeight).toBeDefined();
    expect(typeof status.committedHeight).toBe("bigint");
    expect(status.committedHeight).toBeGreaterThan(0n);

    expect(status.localTipRound).toBeDefined();
    expect(typeof status.localTipRound).toBe("bigint");
    expect(status.localTipRound).toBeGreaterThan(0n);

    expect(status.peerCount).toBeDefined();
    expect(typeof status.peerCount).toBe("number");
    expect(status.peerCount).toBeGreaterThan(0);

    expect(typeof status.catchingUp).toBe("boolean");
    expect(status.catchingUp).toBe(false);

    // SDK helper confirmation
    const confirmedSynced = isNodeSynced(status);
    expect(confirmedSynced).toBe(true);

    // 2. Live blockNumber query
    const blockNumber = await client.blockNumber({ timeoutMs: 5000 });
    expect(typeof blockNumber).toBe("bigint");
    expect(blockNumber).toBe(status.committedHeight);
  });
});
