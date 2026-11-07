// @vitest-environment node
import { describe, expect, it } from "vitest";
import { isNodeSynced, KovanicaClient } from "kovanica-sdk";
import {
  checkRpcReadiness,
  getEffectiveRpcUrl,
  isRequiredLiveMode,
} from "./helpers/rpc-readiness";

const LIVE_RPC_URL = getEffectiveRpcUrl();
const REQUIRED_LIVE = isRequiredLiveMode();

describe("Playground Live RPC Node Integration", () => {
  it("basic read-only RPC interoperability against live node", async (ctx) => {
    const readiness = await checkRpcReadiness(LIVE_RPC_URL);
    if (!readiness.available) {
      if (REQUIRED_LIVE) {
        throw new Error(
          `[REQUIRED-LIVE FAILURE] Configured live RPC endpoint unavailable or invalid at ${LIVE_RPC_URL}: ${readiness.reason}`,
        );
      }
      console.warn(
        `[SKIP] Live Kovanica RPC unavailable at ${LIVE_RPC_URL}: ${readiness.reason}`,
      );
      ctx.skip();
      return;
    }

    const client = new KovanicaClient(LIVE_RPC_URL);

    // 1. Live syncStatus query
    const status = await client.syncStatus({ timeoutMs: 5000 });
    expect(status).toBeDefined();

    // Basic read-only compatibility: works even on genesis / unsynced / 0-peer node
    if (status.committedHeight !== undefined) {
      expect(typeof status.committedHeight).toBe("bigint");
      expect(status.committedHeight).toBeGreaterThanOrEqual(0n);
    }
    if (status.localTipRound !== undefined) {
      expect(typeof status.localTipRound).toBe("bigint");
      expect(status.localTipRound).toBeGreaterThanOrEqual(0n);
    }
    if (status.peerCount !== undefined) {
      expect(typeof status.peerCount).toBe("number");
      expect(status.peerCount).toBeGreaterThanOrEqual(0);
    }
    if (status.catchingUp !== undefined) {
      expect(typeof status.catchingUp).toBe("boolean");
    }

    // 2. Live blockNumber query
    const blockNumber = await client.blockNumber({ timeoutMs: 5000 });
    expect(typeof blockNumber).toBe("bigint");
    expect(blockNumber).toBeGreaterThanOrEqual(0n);
  });

  it("stronger live acceptance: nonzero height, active peers, and confirmed in-sync", async (ctx) => {
    const readiness = await checkRpcReadiness(LIVE_RPC_URL);
    if (!readiness.available) {
      if (REQUIRED_LIVE) {
        throw new Error(
          `[REQUIRED-LIVE FAILURE] Configured live RPC endpoint unavailable or invalid at ${LIVE_RPC_URL}: ${readiness.reason}`,
        );
      }
      console.warn(
        `[SKIP] Live Kovanica RPC unavailable at ${LIVE_RPC_URL}: ${readiness.reason}`,
      );
      ctx.skip();
      return;
    }

    const client = new KovanicaClient(LIVE_RPC_URL);
    const status = await client.syncStatus({ timeoutMs: 5000 });

    const isStrongerEligible =
      status.committedHeight !== undefined &&
      status.committedHeight > 0n &&
      status.peerCount !== undefined &&
      status.peerCount > 0;

    if (!isStrongerEligible) {
      if (REQUIRED_LIVE) {
        throw new Error(
          `[REQUIRED-LIVE FAILURE] Node at ${LIVE_RPC_URL} does not satisfy stronger synced acceptance: committedHeight=${status.committedHeight}, peerCount=${status.peerCount}, catchingUp=${status.catchingUp}`,
        );
      }
      console.warn(
        `[SKIP] Node at ${LIVE_RPC_URL} is in legitimate genesis/unsynced state (committedHeight=${status.committedHeight}, peerCount=${status.peerCount}); skipping stronger nonzero/synced acceptance.`,
      );
      ctx.skip();
      return;
    }

    // Stronger acceptance assertions: must not be weakened
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

    // blockNumber equals committed height
    const blockNumber = await client.blockNumber({ timeoutMs: 5000 });
    expect(typeof blockNumber).toBe("bigint");
    expect(blockNumber).toBe(status.committedHeight);
  });
});
