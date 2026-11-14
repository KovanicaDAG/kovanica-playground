import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import App from "../src/App";

describe("Playground Node Diagnostics UI Regressions", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
  });

  function mockRpc(handler: (method: string, params: any[]) => any) {
    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      const res = await handler(body.method, body.params || []);
      if (res instanceof Error) {
        throw res;
      }
      return {
        ok: true,
        text: async () => JSON.stringify({ jsonrpc: "2.0", result: res, id: body.id }),
        json: async () => ({ jsonrpc: "2.0", result: res, id: body.id }),
      };
    });
  }

  // 1. Missing fields / uninitialized node storage
  it("renders unknown/dash for missing fields and does not coerce to zero or false", async () => {
    mockRpc((method) => {
      if (method === "kovanica_syncStatus") {
        return {
          // localTipRound omitted
          // committedHeight omitted
          // catchingUp omitted
          // peerCount omitted
        };
      }
      if (method === "kovanica_getMiningInfo") {
        throw new Error("Mining not supported");
      }
      return null;
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("sync-status-badge").textContent).toBe("Unknown");
    });

    // Missing committed height and tip round must display "—", NOT "0"
    expect(screen.getByTestId("diagnostic-committed-height").textContent).toBe("—");
    expect(screen.getByTestId("diagnostic-tip-round").textContent).toBe("—");
    expect(screen.getByTestId("diagnostic-peer-count").textContent).toBe("—");

    // Missing catching_up must display "Unknown", NOT "No"
    expect(screen.getByTestId("diagnostic-catching-up").textContent).toBe("Unknown");
    expect(screen.getByTestId("header-node-status").textContent).toBe("Online (Sync Unknown)");
  });

  // 2. Preservation of explicit zeros and bigint precision
  it("preserves explicit zeros (0, 0n) and handles max u64 quantities without precision loss", async () => {
    mockRpc((method) => {
      if (method === "kovanica_syncStatus") {
        return {
          committedHeight: "0",
          localTipRound: "0",
          peerCount: 0,
          catchingUp: false,
        };
      }
      if (method === "kovanica_getMiningInfo") {
        throw new Error("Method not found");
      }
      return null;
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("diagnostic-committed-height").textContent).toBe("0");
    });

    expect(screen.getByTestId("diagnostic-tip-round").textContent).toBe("0");
    expect(screen.getByTestId("diagnostic-peer-count").textContent).toBe("0");
    expect(screen.getByTestId("diagnostic-catching-up").textContent).toBe("No");
  });

  it("preserves large u64 bigint precision up to u64::MAX without truncation", async () => {
    const maxU64 = "18446744073709551615";
    mockRpc((method) => {
      if (method === "kovanica_syncStatus") {
        return {
          committedHeight: maxU64,
          localTipRound: maxU64,
          peerCount: 5,
          catchingUp: false,
        };
      }
      if (method === "kovanica_getMiningInfo") {
        throw new Error("Method not found");
      }
      return null;
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("diagnostic-committed-height").textContent).toBe(maxU64);
    });

    expect(screen.getByTestId("diagnostic-tip-round").textContent).toBe(maxU64);
    expect(screen.getByTestId("sync-status-badge").textContent).toBe("Synced");
  });

  // 3. No peers connected: successful RPC alone is NOT proof of synchronization
  it("displays Unknown state when peerCount is 0 even if catchingUp is false", async () => {
    mockRpc((method) => {
      if (method === "kovanica_syncStatus") {
        return {
          committedHeight: "5000",
          localTipRound: "5000",
          peerCount: 0,
          catchingUp: false,
        };
      }
      if (method === "kovanica_getMiningInfo") {
        throw new Error("Method not found");
      }
      return null;
    });

    render(<App />);

    await waitFor(() => {
      // With 0 peers, SDK isNodeSynced is undefined; state must be Unknown, NOT Synced
      expect(screen.getByTestId("sync-status-badge").textContent).toBe("Unknown");
    });

    expect(screen.getByTestId("header-node-status").textContent).toBe("Online (Sync Unknown)");
    expect(screen.getByTestId("header-peer-count").textContent).toBe("(0 peers)");
  });

  // 4. Catching up state
  it("displays distinct Catching Up state when node reports catchingUp=true", async () => {
    mockRpc((method) => {
      if (method === "kovanica_syncStatus") {
        return {
          committedHeight: "1200",
          localTipRound: "1400",
          peerCount: 8,
          catchingUp: true,
          behindBy: "350",
          networkTag: "2-d41d8cd98f00b204",
        };
      }
      if (method === "kovanica_getMiningInfo") {
        throw new Error("Method not found");
      }
      return null;
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("sync-status-badge").textContent).toBe("Catching Up");
    });

    expect(screen.getByTestId("diagnostic-catching-up").textContent).toBe("Active");
    expect(screen.getByTestId("diagnostic-behind-by").textContent).toBe("350 rounds");
    expect(screen.getByTestId("header-node-status").textContent).toBe("Online (Catching Up)");
    expect(screen.getByTestId("header-peer-count").textContent).toBe("(8 peers)");
  });

  // 5. SDK-confirmed Synced state
  it("displays Synced state only when SDK confirms in-sync with active peers and tip", async () => {
    mockRpc((method) => {
      if (method === "kovanica_syncStatus") {
        return {
          committedHeight: "42592",
          localTipRound: "264339",
          peerCount: 3,
          catchingUp: false,
        };
      }
      if (method === "kovanica_getMiningInfo") {
        throw new Error("Method not found");
      }
      return null;
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("sync-status-badge").textContent).toBe("Synced");
    });

    expect(screen.getByTestId("diagnostic-catching-up").textContent).toBe("No");
    expect(screen.getByTestId("header-node-status").textContent).toBe("Online (Synced)");
  });

  // 6. Browser fetch failure without CORS evidence: honest diagnostic
  it("surfaces honest network error banner without claiming CORS is confirmed when evidence is absent", async () => {
    mockRpc(() => {
      throw new TypeError("Failed to fetch");
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("sync-status-badge").textContent).toBe("Connection Error");
    });

    expect(screen.getByTestId("header-node-status").textContent).toBe("Connection Error");
    expect(screen.getByTestId("diagnostic-empty-state").textContent).toContain("Cannot reach node: Failed to fetch");

    // Banner must state Network / Connection Failure and disclose multiple causes, NOT claim CORS is confirmed
    const banner = screen.getByTestId("network-error-banner");
    expect(banner.textContent).toContain("Browser Network / Connection Failure");
    expect(banner.textContent).toContain("Browser fetch failures can have multiple causes and do not prove a CORS policy issue without explicit evidence");
    expect(banner.textContent).toContain("Node Offline / Port Closed");
  });

  // 7. Browser fetch failure WITH explicit CORS evidence
  it("surfaces CORS restriction banner only when explicit CORS error evidence is present", async () => {
    mockRpc(() => {
      throw new Error("Blocked by CORS policy: No 'Access-Control-Allow-Origin' header");
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("sync-status-badge").textContent).toBe("Connection Error");
    });

    const banner = screen.getByTestId("network-error-banner");
    expect(banner.textContent).toContain("Browser Cross-Origin (CORS) Restriction");
  });

  // 8. Endpoint change immediately clears stale network & mining diagnostics
  it("immediately clears stale diagnostics when changing endpoints", async () => {
    let currentEndpoint = "http://127.0.0.1:8545/rpc";

    mockRpc((method) => {
      if (currentEndpoint === "http://127.0.0.1:8545/rpc") {
        if (method === "kovanica_syncStatus") {
          return {
            committedHeight: "7777",
            localTipRound: "8888",
            peerCount: 4,
            catchingUp: false,
          };
        }
        if (method === "kovanica_getMiningInfo") {
          return {
            chain_id: 2,
            target_block_time_ms: 4000,
            ghostdag_k: 5,
            target_bits: "0x1e0ffff0",
            difficulty: "100",
            network_hashrate_estimate: "5000",
            dag_tips_count: 2,
            mining_threads: 4,
          };
        }
      }
      // New endpoint is slow/unresponsive
      return new Promise(() => {});
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("diagnostic-committed-height").textContent).toBe("7777");
    });
    expect(screen.getByText("5000 H/s")).toBeDefined();

    // Now change endpoint URL
    const input = screen.getByLabelText("RPC Endpoint URL");
    currentEndpoint = "http://remote-node:8545/rpc";
    fireEvent.change(input, { target: { value: "http://remote-node:8545/rpc" } });

    // Stale data from the previous endpoint must be cleared immediately
    expect(screen.queryByText("7777")).toBeNull();
    expect(screen.queryByText("5000 H/s")).toBeNull();
    expect(screen.getByTestId("sync-status-badge").textContent).toBe("Offline");
  });

  // 9. Delayed response from previous endpoint does not overwrite newer endpoint state
  it("prevents delayed response from a previous endpoint from overwriting current state", async () => {
    let resolveFirstEndpoint: (val: any) => void;
    const firstEndpointPromise = new Promise((resolve) => {
      resolveFirstEndpoint = resolve;
    });

    globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      if (url.includes("127.0.0.1")) {
        const res = await firstEndpointPromise;
        return {
          ok: true,
          text: async () => JSON.stringify({ jsonrpc: "2.0", result: res, id: body.id }),
          json: async () => ({ jsonrpc: "2.0", result: res, id: body.id }),
        };
      }
      if (url.includes("second-node")) {
        if (body.method === "kovanica_syncStatus") {
          const res = {
            committedHeight: "999",
            localTipRound: "999",
            peerCount: 2,
            catchingUp: false,
          };
          return {
            ok: true,
            text: async () => JSON.stringify({ jsonrpc: "2.0", result: res, id: body.id }),
            json: async () => ({ jsonrpc: "2.0", result: res, id: body.id }),
          };
        }
      }
      throw new Error("Method not found");
    });

    render(<App />);

    // Switch to second endpoint
    const input = screen.getByLabelText("RPC Endpoint URL");
    fireEvent.change(input, { target: { value: "http://second-node:8545/rpc" } });

    await waitFor(() => {
      expect(screen.getByTestId("diagnostic-committed-height").textContent).toBe("999");
    });

    // Now first endpoint resolves with old stale data
    await act(async () => {
      resolveFirstEndpoint({
        committedHeight: "111",
        localTipRound: "111",
        peerCount: 1,
        catchingUp: false,
      });
    });

    // Second endpoint's state must NOT be overwritten by the delayed response from the first endpoint
    expect(screen.getByTestId("diagnostic-committed-height").textContent).toBe("999");
  });

  // 10. Hidden-tab polling behavior
  it("pauses polling when tab is hidden and triggers probe when tab becomes visible again", async () => {
    let probeCount = 0;
    mockRpc((method) => {
      if (method === "kovanica_syncStatus") {
        probeCount++;
        return {
          committedHeight: "100",
          localTipRound: "100",
          peerCount: 1,
          catchingUp: false,
        };
      }
      return null;
    });

    render(<App />);

    await waitFor(() => {
      expect(probeCount).toBeGreaterThanOrEqual(1);
    });

    const initialProbes = probeCount;

    // Simulate tab hiding
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    fireEvent(document, new Event("visibilitychange"));

    // Advance timers or check that no probes are triggered while hidden
    expect(probeCount).toBe(initialProbes);

    // Simulate tab becoming visible again
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    fireEvent(document, new Event("visibilitychange"));

    await waitFor(() => {
      expect(probeCount).toBeGreaterThan(initialProbes);
    });
  });

  // 11. SDK #4 envelope & ID mismatch rejection and recovery
  it("rejects invalid JSON-RPC 2.0 envelopes and mismatched response IDs, then recovers on next valid probe", async () => {
    let mode: "id-mismatch" | "invalid-envelope" | "valid" = "id-mismatch";

    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      if (mode === "id-mismatch") {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              jsonrpc: "2.0",
              id: 999999,
              result: { committedHeight: "100", localTipRound: "100", peerCount: 2, catchingUp: false },
            }),
        };
      }
      if (mode === "invalid-envelope") {
        return {
          ok: true,
          text: async () => JSON.stringify({ jsonrpc: "2.0", id: body.id }),
        };
      }
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: { committedHeight: "321", localTipRound: "321", peerCount: 4, catchingUp: false },
          }),
      };
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("sync-status-badge").textContent).toBe("Connection Error");
    });
    expect(screen.getByTestId("diagnostic-empty-state").textContent).toContain(
      "JSON-RPC response ID mismatch",
    );

    mode = "invalid-envelope";
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => {
      expect(screen.getByTestId("diagnostic-empty-state").textContent).toContain(
        "neither result nor error member present",
      );
    });

    mode = "valid";
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => {
      expect(screen.getByTestId("sync-status-badge").textContent).toBe("Synced");
    });
    expect(screen.getByTestId("diagnostic-committed-height").textContent).toBe("321");
  });

  // 12. User-visible currency copy is KVNC, never KUNA
  it("renders KVNC currency copy and never renders stale KUNA ticker in user-visible UI", async () => {
    mockRpc((method) => {
      if (method === "kovanica_syncStatus") {
        return { committedHeight: "0", localTipRound: "0", peerCount: 0, catchingUp: false };
      }
      return null;
    });

    const { container } = render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("footer-currency-label").textContent).toContain("KVNC (9 decimals)");
    });
    expect(container.textContent).not.toContain("KUNA");
  });

  // 13. Non-conversion of getBalance failure to zero balance & preservation of legitimate zero
  it("proves transport or RPC failure on getBalance does not produce zero balance and legitimate zero is preserved", async () => {
    let balanceResult: any = new Error("Transport connection reset");
    const testAddress = "kvnc8d4z00xwk6jz6c4r4rgz5mcdwdjny9thrh3y8f36cpy2rz6emg54rufktdag";

    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      if (body.method === "kovanica_syncStatus") {
        return {
          ok: true,
          text: async () => JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: { committedHeight: "10", localTipRound: "10", peerCount: 2, catchingUp: false },
          }),
        };
      }
      if (body.method === "kovanica_getBalance") {
        if (balanceResult instanceof Error) {
          throw balanceResult;
        }
        if (balanceResult?.rpcError) {
          return {
            ok: true,
            text: async () => JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              error: balanceResult.rpcError,
            }),
          };
        }
        return {
          ok: true,
          text: async () => JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: balanceResult,
          }),
        };
      }
      return {
        ok: true,
        text: async () => JSON.stringify({ jsonrpc: "2.0", id: body.id, result: null }),
      };
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("sync-status-badge").textContent).toBe("Synced");
    });

    // Select kovanica_getBalance
    fireEvent.change(screen.getByLabelText("RPC Method"), {
      target: { value: "kovanica_getBalance" },
    });

    const addressInput = screen.getByLabelText(/Account Address/i);
    fireEvent.change(addressInput, { target: { value: testAddress } });

    // 1. Transport failure: click execute
    fireEvent.click(screen.getByRole("button", { name: "Execute Call" }));
    await waitFor(() => {
      expect(screen.getByText("RPC Error")).toBeDefined();
    });
    // Must NOT display zero balance or zero KVNC
    expect(screen.queryByText(/"atoms": "0"/)).toBeNull();
    expect(screen.queryByText(/"kvnc": "0 KVNC"/)).toBeNull();

    // 2. RPC Error response
    balanceResult = { rpcError: { code: -32000, message: "State lookup failed" } };
    fireEvent.click(screen.getByRole("button", { name: "Execute Call" }));
    await waitFor(() => {
      expect(screen.getByText(/State lookup failed/)).toBeDefined();
    });
    expect(screen.queryByText(/"atoms": "0"/)).toBeNull();

    // 3. Legitimate zero balance: "0x0"
    balanceResult = "0x0";
    fireEvent.click(screen.getByRole("button", { name: "Execute Call" }));
    await waitFor(() => {
      expect(screen.getByText(/Response Result/)).toBeDefined();
    });
    expect(screen.getByText(/"atoms": "0"/)).toBeDefined();
    expect(screen.getByText(/"kvnc": "0 KVNC"/)).toBeDefined();
    expect(screen.queryByText("RPC Error")).toBeNull();

    // 4. Non-zero balance recovery: "0x1994a3693dbc0" (450018999000000 atoms)
    balanceResult = "0x1994a3693dbc0";
    fireEvent.click(screen.getByRole("button", { name: "Execute Call" }));
    await waitFor(() => {
      expect(screen.getByText(/"atoms": "450018999000000"/)).toBeDefined();
    });
    expect(screen.getByText(/"kvnc": "450018.999 KVNC"/)).toBeDefined();
  });

  // 14. Non-conversion of getRewards failure to zero rewards & preservation of legitimate zero
  it("proves transport or RPC failure on getRewards does not produce zero rewards and legitimate zero is preserved", async () => {
    let rewardsResult: any = new Error("Connection timed out");
    const testAddress = "kvnc8d4z00xwk6jz6c4r4rgz5mcdwdjny9thrh3y8f36cpy2rz6emg54rufktdag";

    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      if (body.method === "kovanica_syncStatus") {
        return {
          ok: true,
          text: async () => JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: { committedHeight: "10", localTipRound: "10", peerCount: 2, catchingUp: false },
          }),
        };
      }
      if (body.method === "kovanica_getRewards") {
        if (rewardsResult instanceof Error) {
          throw rewardsResult;
        }
        if (rewardsResult?.rpcError) {
          return {
            ok: true,
            text: async () => JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              error: rewardsResult.rpcError,
            }),
          };
        }
        return {
          ok: true,
          text: async () => JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: rewardsResult,
          }),
        };
      }
      return {
        ok: true,
        text: async () => JSON.stringify({ jsonrpc: "2.0", id: body.id, result: null }),
      };
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("sync-status-badge").textContent).toBe("Synced");
    });

    fireEvent.change(screen.getByLabelText("RPC Method"), {
      target: { value: "kovanica_getRewards" },
    });

    const addressInput = screen.getByLabelText(/Account Address/i);
    fireEvent.change(addressInput, { target: { value: testAddress } });

    // 1. Failure does not become 0 rewards
    fireEvent.click(screen.getByRole("button", { name: "Execute Call" }));
    await waitFor(() => {
      expect(screen.getByText("RPC Error")).toBeDefined();
    });
    expect(screen.queryByText(/"rewards_atoms": "0"/)).toBeNull();
    expect(screen.queryByText(/"rewards_kvnc": "0 KVNC"/)).toBeNull();

    // 2. Legitimate zero rewards
    rewardsResult = "0x0";
    fireEvent.click(screen.getByRole("button", { name: "Execute Call" }));
    await waitFor(() => {
      expect(screen.getByText(/Response Result/)).toBeDefined();
    });
    expect(screen.getByText(/"rewards_atoms": "0"/)).toBeDefined();
    expect(screen.getByText(/"rewards_kvnc": "0 KVNC"/)).toBeDefined();

    // 3. Clean recovery to nonzero rewards
    rewardsResult = "0x9502f900"; // 2.5 KVNC
    fireEvent.click(screen.getByRole("button", { name: "Execute Call" }));
    await waitFor(() => {
      expect(screen.getByText(/"rewards_atoms": "2500000000"/)).toBeDefined();
    });
    expect(screen.getByText(/"rewards_kvnc": "2.5 KVNC"/)).toBeDefined();
  });

  // 15. Target network change aborts in-flight requests and prevents stale overwrite
  it("aborts in-flight execution and drops stale responses when target network changes", async () => {
    let slowResolve: (() => void) | null = null;

    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      if (body.method === "kovanica_syncStatus") {
        return {
          ok: true,
          text: async () => JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: { committedHeight: "10", localTipRound: "10", peerCount: 2, catchingUp: false },
          }),
        };
      }
      if (body.method === "kovanica_blockNumber") {
        await new Promise<void>((r) => {
          slowResolve = r;
        });
        return {
          ok: true,
          text: async () => JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: "0x999",
          }),
        };
      }
      return {
        ok: true,
        text: async () => JSON.stringify({ jsonrpc: "2.0", id: body.id, result: null }),
      };
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("sync-status-badge").textContent).toBe("Synced");
    });

    // Start slow execution on Testnet (Chain 2)
    fireEvent.click(screen.getByRole("button", { name: "Execute Call" }));
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDefined();

    // Switch Target Network to Mainnet (Chain 1)
    fireEvent.change(screen.getByLabelText("Target Network"), {
      target: { value: "1" },
    });

    // In-flight execution cancelled immediately
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();

    // Now resolve the slow request from the previous network
    if (slowResolve) {
      (slowResolve as () => void)();
    }

    // Wait and verify the stale response never lands
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText(/Response Result/)).toBeNull();
    expect(screen.queryByText("0x999")).toBeNull();
  });
});
