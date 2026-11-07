export interface RpcReadinessResult {
  available: boolean;
  reason?: string;
  payload?: any;
}

/**
 * Validates that an endpoint is reachable and speaks genuine Kovanica JSON-RPC 2.0.
 * A plain HTTP 200 is insufficient: response must be valid JSON-RPC 2.0.
 */
export async function checkRpcReadiness(
  rpcUrl: string,
  timeoutMs: number = 3000,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<RpcReadinessResult> {
  try {
    const res = await fetchFn(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "kovanica_syncStatus",
        params: [],
        id: 1,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      return {
        available: false,
        reason: `HTTP ${res.status} ${res.statusText}`,
      };
    }

    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      return {
        available: false,
        reason: "Response is not valid JSON (HTTP 200 with invalid payload)",
      };
    }

    if (json?.jsonrpc !== "2.0") {
      return {
        available: false,
        reason: "Response is not JSON-RPC 2.0 (missing or invalid jsonrpc version)",
      };
    }

    if (json?.error) {
      return {
        available: false,
        reason: `JSON-RPC error returned: ${json.error.message || JSON.stringify(json.error)} (code ${json.error.code})`,
      };
    }

    if (json?.result === undefined) {
      return {
        available: false,
        reason: "JSON-RPC response missing result field",
      };
    }

    return {
      available: true,
      payload: json.result,
    };
  } catch (err: any) {
    return {
      available: false,
      reason: err?.message || String(err),
    };
  }
}

declare const process: {
  env: Record<string, string | undefined>;
};

export function getEffectiveRpcUrl(): string {
  return (
    process.env.KOVANICA_RPC_URL ||
    process.env.LIVE_RPC_URL ||
    "http://127.0.0.1:8545/rpc"
  );
}

export function isRequiredLiveMode(): boolean {
  const val = process.env.KOVANICA_REQUIRE_LIVE || process.env.REQUIRE_LIVE;
  return Boolean(val && val !== "0" && val !== "false");
}
