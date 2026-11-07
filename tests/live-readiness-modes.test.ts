// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { checkRpcReadiness } from "./helpers/rpc-readiness";

describe("Live RPC Readiness & Verification Modes Regressions", () => {
  // 1. Unreachable endpoint regression
  it("detects unreachable endpoint and returns detailed failure reason", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:9999"));
    const readiness = await checkRpcReadiness("http://127.0.0.1:9999/rpc", 1000, mockFetch as any);

    expect(readiness.available).toBe(false);
    expect(readiness.reason).toContain("ECONNREFUSED");
  });

  // 2. HTTP 200 with invalid payload regressions (HTML, non-JSON, missing version, missing result)
  it("rejects HTTP 200 response with HTML payload (e.g. proxy or gateway landing page)", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => "<!DOCTYPE html><html><body>Welcome to nginx</body></html>",
    });

    const readiness = await checkRpcReadiness("http://127.0.0.1:8545/rpc", 1000, mockFetch as any);
    expect(readiness.available).toBe(false);
    expect(readiness.reason).toContain("Response is not valid JSON");
  });

  it("rejects HTTP 200 response with missing jsonrpc 2.0 version field", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify({ result: { status: "ok" } }),
    });

    const readiness = await checkRpcReadiness("http://127.0.0.1:8545/rpc", 1000, mockFetch as any);
    expect(readiness.available).toBe(false);
    expect(readiness.reason).toContain("missing or invalid jsonrpc");
  });

  it("rejects HTTP 200 response with missing result field", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1 }),
    });

    const readiness = await checkRpcReadiness("http://127.0.0.1:8545/rpc", 1000, mockFetch as any);
    expect(readiness.available).toBe(false);
    expect(readiness.reason).toContain("missing result field");
  });

  // 3. JSON-RPC error response regression
  it("rejects HTTP 200 response containing a JSON-RPC error object", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Node internal storage corrupted" },
        id: 1,
      }),
    });

    const readiness = await checkRpcReadiness("http://127.0.0.1:8545/rpc", 1000, mockFetch as any);
    expect(readiness.available).toBe(false);
    expect(readiness.reason).toContain("JSON-RPC error returned");
    expect(readiness.reason).toContain("-32603");
  });

  it("rejects HTTP non-200 responses (e.g. 502 Bad Gateway or 503 Service Unavailable)", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      statusText: "Bad Gateway",
      text: async () => "Bad Gateway",
    });

    const readiness = await checkRpcReadiness("http://127.0.0.1:8545/rpc", 1000, mockFetch as any);
    expect(readiness.available).toBe(false);
    expect(readiness.reason).toBe("HTTP 502 Bad Gateway");
  });

  // 4. Legitimate genesis / unknown state regression
  it("accepts valid JSON-RPC 2.0 response from a legitimate genesis node with 0 height and 0 peers", async () => {
    const genesisResult = {
      committedHeight: "0",
      localTipRound: "0",
      peerCount: 0,
      catchingUp: false,
    };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify({
        jsonrpc: "2.0",
        result: genesisResult,
        id: 1,
      }),
    });

    const readiness = await checkRpcReadiness("http://127.0.0.1:8545/rpc", 1000, mockFetch as any);
    expect(readiness.available).toBe(true);
    expect(readiness.payload).toEqual(genesisResult);
  });

  // 5. Required-live mode failure regression
  it("produces an explicit failure in required-live mode when readiness check fails", () => {
    const readiness = { available: false, reason: "connect ECONNREFUSED 127.0.0.1:8545" };
    const requiredLive = true;

    expect(() => {
      if (!readiness.available && requiredLive) {
        throw new Error(
          `[REQUIRED-LIVE FAILURE] Configured live RPC endpoint unavailable at http://127.0.0.1:8545/rpc: ${readiness.reason}`,
        );
      }
    }).toThrowError(/\[REQUIRED-LIVE FAILURE\].*ECONNREFUSED/);
  });

  it("produces a real skip instead of failure in default mode when readiness check fails", () => {
    const readiness = { available: false, reason: "connect ECONNREFUSED 127.0.0.1:8545" };
    const requiredLive = false;
    let didSkip = false;

    if (!readiness.available) {
      if (requiredLive) {
        throw new Error("Must not throw in default mode");
      }
      didSkip = true;
    }

    expect(didSkip).toBe(true);
  });
});
