// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Browser, chromium, type Locator, type Page, type Route } from "playwright";
import { startTestServer, type TestServer } from "./helpers/test-server";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

describe("Browser RPC Acceptance & Diagnostics UI (Headless Chromium)", { timeout: 25000 }, () => {
  let server: TestServer;
  let browser: Browser;

  beforeAll(async () => {
    server = await startTestServer();
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
  }, 30000);

  afterAll(async () => {
    if (browser) {
      await browser.close();
    }
    if (server) {
      await server.close();
    }
  });

  async function newTestPage(): Promise<Page> {
    return browser.newPage();
  }

  // Vitest-compatible polling helpers for Playwright Locators
  async function expectText(locator: Locator, expected: string, timeout = 5000) {
    await expect
      .poll(async () => (await locator.textContent())?.trim(), { timeout })
      .toBe(expected);
  }

  async function expectVisible(locator: Locator, timeout = 5000) {
    await expect
      .poll(async () => locator.isVisible(), { timeout })
      .toBe(true);
  }

  async function expectNotVisible(locator: Locator, timeout = 5000) {
    await expect
      .poll(async () => locator.isVisible(), { timeout })
      .toBe(false);
  }

  async function expectContainsText(locator: Locator, expectedSubstring: string, timeout = 5000) {
    await expect
      .poll(async () => (await locator.textContent()) || "", { timeout })
      .toContain(expectedSubstring);
  }

  async function expectFocused(locator: Locator, timeout = 5000) {
    await expect
      .poll(
        async () =>
          locator.evaluate((el: HTMLElement) => document.activeElement === el),
        { timeout },
      )
      .toBe(true);
  }

  /**
   * Helper to set up deterministic JSON-RPC 2.0 route interception with full CORS support.
   */
  async function setupRpcRoute(
    page: Page,
    handler: (method: string, params: any[], id: number | string, route: Route) => any | Promise<any>,
    urlPattern = "**/rpc",
  ) {
    await page.route(urlPattern, async (route) => {
      if (route.request().method() === "OPTIONS") {
        await route.fulfill({
          status: 204,
          headers: CORS_HEADERS,
        });
        return;
      }

      let body: any = {};
      try {
        body = JSON.parse(route.request().postData() || "{}");
      } catch {
        // non-json
      }

      try {
        const res = await handler(body.method, body.params || [], body.id ?? 1, route);
        if (res === undefined) {
          // handled manually inside handler
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          headers: CORS_HEADERS,
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: body.id ?? 1,
            result: res,
          }),
        });
      } catch (err: any) {
        if (err?.abort) {
          await route.abort(err.abort);
          return;
        }
        if (err?.rawFulfill) {
          await route.fulfill({
            ...err.rawFulfill,
            headers: { ...CORS_HEADERS, ...err.rawFulfill.headers },
          });
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          headers: CORS_HEADERS,
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: body.id ?? 1,
            error: {
              code: err?.code || -32603,
              message: err?.message || String(err),
            },
          }),
        });
      }
    });
  }

  // =========================================================================
  // Scenario B1: Genesis & Zero Peers (Availability is NOT Sync)
  // =========================================================================
  it("renders explicit zero for genesis state without claiming synced", async () => {
    const page = await newTestPage();
    try {
      await setupRpcRoute(page, (method) => {
        if (method === "kovanica_syncStatus") {
          return {
            catchingUp: false,
            committedHeight: 0,
            localHeight: 0,
            localTipRound: 0,
            peerCount: 0,
            peers: [],
            networkTag: "4-genesis-test",
          };
        }
        if (method === "kovanica_getMiningInfo") {
          throw { code: -32601, message: "Method not found: kovanica_getMiningInfo" };
        }
        return "0x0";
      });

      await page.goto(server.url, { waitUntil: "domcontentloaded" });

      // Verify explicit zeros are preserved (not coerced to "—")
      await expectText(page.locator('[data-testid="diagnostic-committed-height"]'), "0");
      await expectText(page.locator('[data-testid="diagnostic-tip-round"]'), "0");
      await expectText(page.locator('[data-testid="diagnostic-peer-count"]'), "0");
      await expectText(page.locator('[data-testid="diagnostic-catching-up"]'), "No");

      // Badge must be "Unknown" because peerCount is 0 (availability is NOT sync)
      await expectText(page.locator('[data-testid="sync-status-badge"]'), "Unknown");
      await expectText(page.locator('[data-testid="header-node-status"]'), "Online (Sync Unknown)");
    } finally {
      await page.close();
    }
  });

  // =========================================================================
  // Scenario B2: Populated State & Large BigInt Precision (No Floating-Point Loss)
  // =========================================================================
  it("renders large u64 integers losslessly in syncStatus and miningInfo and displays Synced when confirmed", async () => {
    const page = await newTestPage();
    const largeCommittedHeight = "18446744073709551615"; // u64::MAX
    const largeTipRound = "18446744073709551614";
    const largeDifficulty = "9007199254740993123"; // > Number.MAX_SAFE_INTEGER
    const largeHashrate = "18446744073709551000";

    try {
      await setupRpcRoute(page, (method) => {
        if (method === "kovanica_syncStatus") {
          return {
            catchingUp: false,
            committedHeight: largeCommittedHeight,
            localTipRound: largeTipRound,
            peerCount: 8,
            networkTag: "5-large-int",
          };
        }
        if (method === "kovanica_getMiningInfo") {
          return {
            chain_id: 5,
            target_block_time_ms: 4000,
            ghostdag_k: 5,
            target_bits: "0x1d00ffff",
            difficulty: largeDifficulty,
            network_hashrate_estimate: largeHashrate,
            dag_tips_count: 3,
            mining_threads: 4,
          };
        }
        throw { code: -32601, message: "Method not found" };
      });

      await page.goto(server.url, { waitUntil: "domcontentloaded" });

      await expectText(page.locator('[data-testid="diagnostic-committed-height"]'), largeCommittedHeight);
      await expectText(page.locator('[data-testid="diagnostic-tip-round"]'), largeTipRound);
      await expectText(page.locator('[data-testid="diagnostic-peer-count"]'), "8");
      await expectText(page.locator('[data-testid="diagnostic-catching-up"]'), "No");

      // In-sync confirmed by SDK helper (peers > 0, catchingUp === false, tip known)
      await expectText(page.locator('[data-testid="sync-status-badge"]'), "Synced");
      await expectText(page.locator('[data-testid="header-node-status"]'), "Online (Synced)");
      await expectText(page.locator('[data-testid="header-peer-count"]'), "(8 peers)");

      // Verify large MiningInfo bigints rendered losslessly
      await expectVisible(page.locator(`text=${largeDifficulty}`));
      await expectVisible(page.locator(`text=${largeHashrate} H/s`));
    } finally {
      await page.close();
    }
  });

  // =========================================================================
  // Scenario B3: Unknown / Missing Fields (Unknown is NOT Zero)
  // =========================================================================
  it("renders dashes and unknown badge for missing fields and does not coerce to 0 or false", async () => {
    const page = await newTestPage();
    try {
      await setupRpcRoute(page, (method) => {
        if (method === "kovanica_syncStatus") {
          // All optional fields omitted: committedHeight, localTipRound, peerCount, catchingUp
          return {};
        }
        throw { code: -32601, message: "Method not found" };
      });

      await page.goto(server.url, { waitUntil: "domcontentloaded" });

      // Missing fields must render as "—", NOT "0"
      await expectText(page.locator('[data-testid="diagnostic-committed-height"]'), "—");
      await expectText(page.locator('[data-testid="diagnostic-tip-round"]'), "—");
      await expectText(page.locator('[data-testid="diagnostic-peer-count"]'), "—");
      await expectText(page.locator('[data-testid="diagnostic-catching-up"]'), "Unknown");

      await expectText(page.locator('[data-testid="sync-status-badge"]'), "Unknown");
      await expectText(page.locator('[data-testid="header-node-status"]'), "Online (Sync Unknown)");
    } finally {
      await page.close();
    }
  });

  // =========================================================================
  // Scenario B4: Actively Catching Up State
  // =========================================================================
  it("renders catching-up badge, Active status, and behind-by metrics", async () => {
    const page = await newTestPage();
    try {
      await setupRpcRoute(page, (method) => {
        if (method === "kovanica_syncStatus") {
          return {
            catchingUp: true,
            committedHeight: 120,
            localTipRound: 500,
            peerCount: 4,
            behindBy: 380,
            networkTag: "4-syncing",
          };
        }
        throw { code: -32601, message: "Method not found" };
      });

      await page.goto(server.url, { waitUntil: "domcontentloaded" });

      await expectText(page.locator('[data-testid="diagnostic-catching-up"]'), "Active");
      await expectText(page.locator('[data-testid="diagnostic-behind-by"]'), "380 rounds");
      await expectText(page.locator('[data-testid="sync-status-badge"]'), "Catching Up");
      await expectText(page.locator('[data-testid="header-node-status"]'), "Online (Catching Up)");
    } finally {
      await page.close();
    }
  });

  // =========================================================================
  // Scenario B5a: Unreachable Endpoint & Honest Error Banner
  // =========================================================================
  it("diagnoses unreachable node honestly without claiming CORS is proven", async () => {
    const page = await newTestPage();
    try {
      await setupRpcRoute(page, () => {
        throw { abort: "failed" };
      });

      await page.goto(server.url, { waitUntil: "domcontentloaded" });

      const banner = page.locator('[data-testid="network-error-banner"]');
      await expectVisible(banner);
      await expectContainsText(banner, "Browser Network / Connection Failure");
      await expectContainsText(banner, "do not prove a CORS policy issue without explicit evidence");

      await expectText(page.locator('[data-testid="sync-status-badge"]'), "Connection Error");
      await expectText(page.locator('[data-testid="header-node-status"]'), "Connection Error");
    } finally {
      await page.close();
    }
  });

  // =========================================================================
  // Scenario B5b: Malformed HTTP 200 Payloads & JSON-RPC Errors
  // =========================================================================
  it("handles malformed HTTP 200 payload and JSON-RPC error on diagnostics without claiming online or synced", async () => {
    const page = await newTestPage();
    let mode: "malformed-html" | "jsonrpc-error" = "malformed-html";

    try {
      await setupRpcRoute(page, () => {
        if (mode === "malformed-html") {
          throw {
            rawFulfill: {
              status: 200,
              contentType: "text/html",
              body: "<html><body>502 Bad Gateway</body></html>",
            },
          };
        }
        throw {
          code: -32000,
          message: "Storage engine unavailable",
        };
      });

      await page.goto(server.url, { waitUntil: "domcontentloaded" });

      // 1. HTTP 200 with HTML payload must fail honestly, never claiming Online or Synced
      await expectText(page.locator('[data-testid="sync-status-badge"]'), "Connection Error");
      await expectText(page.locator('[data-testid="header-node-status"]'), "Connection Error");
      await expectContainsText(page.locator('[data-testid="diagnostic-empty-state"]'), "Cannot reach node:");

      // 2. Switch to JSON-RPC error payload and click Refresh
      mode = "jsonrpc-error";
      await page.getByRole("button", { name: "Refresh" }).click();

      await expectText(page.locator('[data-testid="sync-status-badge"]'), "Connection Error");
      await expectContainsText(
        page.locator('[data-testid="diagnostic-empty-state"]'),
        "Storage engine unavailable",
      );
    } finally {
      await page.close();
    }
  });

  // =========================================================================
  // Scenario B5c: Nonzero Reported Height Without Peers is Not Synced / Executed State
  // =========================================================================
  it("does not treat nonzero reported committedHeight without active peers as synced or executed-state evidence", async () => {
    const page = await newTestPage();
    try {
      await setupRpcRoute(page, (method) => {
        if (method === "kovanica_syncStatus") {
          return {
            catchingUp: false,
            committedHeight: 500,
            localTipRound: 1500,
            peerCount: 0,
            networkTag: "4-isolated-nonzero",
          };
        }
        throw { code: -32601, message: "Method not found" };
      });

      await page.goto(server.url, { waitUntil: "domcontentloaded" });

      // Reported height is displayed as Committed Height (not claimed as executed-state proof or synced)
      await expectText(page.locator('[data-testid="diagnostic-committed-height"]'), "500");
      await expectText(page.locator('[data-testid="diagnostic-tip-round"]'), "1500");
      await expectText(page.locator('[data-testid="diagnostic-peer-count"]'), "0");

      // Because peerCount is 0, sync state is Unknown, NOT Synced
      await expectText(page.locator('[data-testid="sync-status-badge"]'), "Unknown");
      await expectText(page.locator('[data-testid="header-node-status"]'), "Online (Sync Unknown)");
    } finally {
      await page.close();
    }
  });

  // =========================================================================
  // Scenario B6a: Method Explorer Execution & BigInt Response Formatting
  // =========================================================================
  it("executes read-only method and renders formatted result with large integers", async () => {
    const page = await newTestPage();
    const largeBlockNumber = "18446744073709551615";

    try {
      await setupRpcRoute(page, (method) => {
        if (method === "kovanica_syncStatus") {
          return { catchingUp: false, committedHeight: 10, localTipRound: 10, peerCount: 2 };
        }
        if (method === "kovanica_blockNumber") {
          return largeBlockNumber;
        }
        throw { code: -32601, message: "Method not found" };
      });

      await page.goto(server.url, { waitUntil: "domcontentloaded" });

      const executeBtn = page.getByRole("button", { name: "Execute Call" });
      await executeBtn.click();

      // Wait for response payload preview
      const responseArea = page.locator("text=Response Result");
      await expectVisible(responseArea);

      const pre = page.locator("pre").filter({ hasText: largeBlockNumber });
      await expectVisible(pre);
      await expectContainsText(pre, largeBlockNumber);
    } finally {
      await page.close();
    }
  });

  // =========================================================================
  // Scenario B6b: Unsupported Method / JSON-RPC Error in Method Explorer
  // =========================================================================
  it("surfaces unsupported method / JSON-RPC error clearly in Method Explorer", async () => {
    const page = await newTestPage();
    try {
      await setupRpcRoute(page, (method) => {
        if (method === "kovanica_syncStatus") {
          return { catchingUp: false, committedHeight: 10, localTipRound: 10, peerCount: 2 };
        }
        throw {
          code: -32601,
          message: `Method not found: ${method} is not supported on Mysticeti chain`,
        };
      });

      await page.goto(server.url, { waitUntil: "domcontentloaded" });

      // Select kovanica_getMiningInfo and execute it
      const methodSelect = page.locator("#rpc-method-select");
      await methodSelect.selectOption("kovanica_getMiningInfo");

      const executeBtn = page.getByRole("button", { name: "Execute Call" });
      await executeBtn.click();

      const rpcErrorHeading = page.getByText("RPC Error", { exact: true });
      await expectVisible(rpcErrorHeading);
      await expectVisible(
        page.locator("text=Method not found: kovanica_getMiningInfo is not supported on Mysticeti chain"),
      );
    } finally {
      await page.close();
    }
  });

  // =========================================================================
  // Scenario C1: State Race — Delay Endpoint A, Switch to B, Finish A
  // =========================================================================
  it("prevents delayed response from endpoint A overwriting newer endpoint B", async () => {
    const page = await newTestPage();
    let resolveSlowEndpoint: (() => void) | null = null;

    try {
      await setupRpcRoute(page, async (_method, _params, _id, route) => {
        const url = route.request().url();
        if (url.includes("slow-endpoint")) {
          await new Promise<void>((res) => {
            resolveSlowEndpoint = res;
          });
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            headers: CORS_HEADERS,
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              result: {
                catchingUp: false,
                committedHeight: 111,
                localTipRound: 111,
                peerCount: 1,
                networkTag: "slow-endpoint-tag",
              },
            }),
          });
          return;
        }

        if (url.includes("fast-endpoint")) {
          return {
            catchingUp: false,
            committedHeight: 999,
            localTipRound: 999,
            peerCount: 9,
            networkTag: "fast-endpoint-tag",
          };
        }

        // Default initial probe
        return {
          catchingUp: false,
          committedHeight: 50,
          localTipRound: 50,
          peerCount: 2,
        };
      });

      await page.goto(server.url, { waitUntil: "domcontentloaded" });

      const committedHeight = page.locator('[data-testid="diagnostic-committed-height"]');
      await expectText(committedHeight, "50");

      // Switch to slow-endpoint A
      const endpointInput = page.locator("#rpc-endpoint-input");
      await endpointInput.fill("http://127.0.0.1:9999/slow-endpoint/rpc");
      // Diagnostics cleared immediately (empty state rendered while in-flight probe is slow)
      await expectVisible(page.locator('[data-testid="diagnostic-empty-state"]'));

      // Switch to fast-endpoint B before slow resolves
      await endpointInput.fill("http://127.0.0.1:9999/fast-endpoint/rpc");

      // Fast-endpoint B resolves
      await expectText(committedHeight, "999");
      const networkTag = page.locator('[data-testid="diagnostic-network-tag"]');
      await expectText(networkTag, "fast-endpoint-tag");

      // Now let delayed slow-endpoint A complete
      if (resolveSlowEndpoint) {
        (resolveSlowEndpoint as () => void)();
      }

      // Wait a bit to ensure delayed A cannot overwrite B
      await page.waitForTimeout(300);

      // Endpoint B's data MUST remain intact!
      await expectText(committedHeight, "999");
      await expectText(networkTag, "fast-endpoint-tag");
    } finally {
      await page.close();
    }
  });

  // =========================================================================
  // Scenario C2: Overlapping Refreshes & Late Error Dropped
  // =========================================================================
  it("drops late errors from superseded probes after a newer success", async () => {
    const page = await newTestPage();
    let probeCount = 0;
    let resolveFirstProbeErr: (() => void) | null = null;

    try {
      await setupRpcRoute(page, async (_method, _params, _id, route) => {
        probeCount++;
        if (probeCount === 1) {
          return { catchingUp: false, committedHeight: 100, localTipRound: 100, peerCount: 2 };
        }
        if (probeCount === 2) {
          await new Promise<void>((res) => {
            resolveFirstProbeErr = res;
          });
          await route.abort("failed");
          return;
        }
        return { catchingUp: false, committedHeight: 200, localTipRound: 200, peerCount: 4 };
      });

      await page.goto(server.url, { waitUntil: "domcontentloaded" });
      const committedHeight = page.locator('[data-testid="diagnostic-committed-height"]');
      await expectText(committedHeight, "100");

      const refreshBtn = page.getByRole("button", { name: "Refresh" });

      // Click refresh to trigger Probe 2 (delayed)
      await refreshBtn.click();
      // Click refresh again to trigger Probe 3 (succeeds)
      await refreshBtn.click();

      // Probe 3 success updates height to 200
      await expectText(committedHeight, "200");

      // Now release Probe 2 error
      if (resolveFirstProbeErr) {
        (resolveFirstProbeErr as () => void)();
      }
      await page.waitForTimeout(200);

      // Height must still be 200; Probe 2 error must NOT wipe out diagnostics
      await expectText(committedHeight, "200");
      const banner = page.locator('[data-testid="network-error-banner"]');
      await expectNotVisible(banner);
    } finally {
      await page.close();
    }
  });

  // =========================================================================
  // Scenario C3a: In-Flight Method Execution Cancellation
  // =========================================================================
  it("cancels running method execution cleanly when Cancel button is clicked", async () => {
    const page = await newTestPage();
    let resolveCall: (() => void) | null = null;

    try {
      await setupRpcRoute(page, async (method) => {
        if (method === "kovanica_syncStatus") {
          return { catchingUp: false, committedHeight: 1, localTipRound: 1, peerCount: 1 };
        }
        if (method === "kovanica_blockNumber") {
          await new Promise<void>((res) => {
            resolveCall = res;
          });
          return "1";
        }
        throw { code: -32601, message: "Method not found" };
      });

      await page.goto(server.url, { waitUntil: "domcontentloaded" });

      const executeBtn = page.getByRole("button", { name: "Execute Call" });
      await executeBtn.click();

      const cancelBtn = page.getByRole("button", { name: "Cancel" });
      await expectVisible(cancelBtn);
      await expectVisible(page.getByRole("button", { name: "Executing..." }));

      // Click Cancel
      await cancelBtn.click();

      // Loading state ends, Cancel button removed, and no spurious RPC Error rendered
      await expectNotVisible(cancelBtn);
      await expectVisible(page.getByRole("button", { name: "Execute Call" }));

      if (resolveCall) {
        (resolveCall as () => void)();
      }
      await page.waitForTimeout(200);
      await expectNotVisible(page.locator("text=RPC Error"));
    } finally {
      await page.close();
    }
  });

  // =========================================================================
  // Scenario C3b: Method Switch / Navigation Aborts In-Flight Call Cleanly
  // =========================================================================
  it("aborts in-flight method execution on method switch without leaking stale response or error", async () => {
    const page = await newTestPage();
    let resolveBlockNumber: (() => void) | null = null;

    try {
      await setupRpcRoute(page, async (method) => {
        if (method === "kovanica_syncStatus") {
          return { catchingUp: false, committedHeight: 10, localTipRound: 10, peerCount: 2 };
        }
        if (method === "kovanica_blockNumber") {
          await new Promise<void>((res) => {
            resolveBlockNumber = res;
          });
          return "777777";
        }
        throw { code: -32601, message: "Method not found" };
      });

      await page.goto(server.url, { waitUntil: "domcontentloaded" });

      // Start slow execution on kovanica_blockNumber
      await page.getByRole("button", { name: "Execute Call" }).click();
      await expectVisible(page.getByRole("button", { name: "Cancel" }));

      // Switch method to kovanica_getValidators while kovanica_blockNumber is in-flight
      await page.locator("#rpc-method-select").selectOption("kovanica_getValidators");

      // Loading state must immediately reset
      await expectNotVisible(page.getByRole("button", { name: "Cancel" }));
      await expectVisible(page.getByRole("button", { name: "Execute Call" }));

      // Release the old in-flight response
      if (resolveBlockNumber) {
        (resolveBlockNumber as () => void)();
      }
      await page.waitForTimeout(250);

      // Neither the stale response nor an AbortError should appear on the newly selected method
      await expectNotVisible(page.locator("text=Response Result"));
      await expectNotVisible(page.locator("text=RPC Error"));
    } finally {
      await page.close();
    }
  });

  // =========================================================================
  // Scenario C4: Tab Visibility & Resource-Conscious Polling (No Timer Multiplication)
  // =========================================================================
  it("pauses background polling when tab is hidden and resumes on visible without duplicate timers", async () => {
    const page = await newTestPage();
    let pollCount = 0;

    try {
      await setupRpcRoute(page, (method) => {
        if (method === "kovanica_syncStatus") {
          pollCount++;
          return {
            catchingUp: false,
            committedHeight: pollCount,
            localTipRound: pollCount,
            peerCount: 1,
          };
        }
        throw { code: -32601, message: "Method not found" };
      });

      await page.goto(server.url, { waitUntil: "domcontentloaded" });
      const committedHeight = page.locator('[data-testid="diagnostic-committed-height"]');
      await expectText(committedHeight, "1");

      // Instrumentation: count active intervals created via window.setInterval
      await page.evaluate(() => {
        const origSetInterval = window.setInterval.bind(window);
        const origClearInterval = window.clearInterval.bind(window);
        const activeIds = new Set<number>();
        (window as any).__activeIntervalCount = () => activeIds.size;
        (window as any).setInterval = ((fn: any, ms?: number, ...args: any[]) => {
          const id = origSetInterval(fn, ms, ...args);
          activeIds.add(id as unknown as number);
          return id;
        }) as typeof window.setInterval;
        (window as any).clearInterval = ((id?: number) => {
          if (id !== undefined) activeIds.delete(id);
          return origClearInterval(id);
        }) as typeof window.clearInterval;
      });

      // Simulate tab hidden
      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", {
          value: "hidden",
          writable: true,
          configurable: true,
        });
        document.dispatchEvent(new Event("visibilitychange"));
      });

      const countAfterHidden = pollCount;
      await page.waitForTimeout(400);
      expect(pollCount).toBe(countAfterHidden);
      expect(await page.evaluate(() => (window as any).__activeIntervalCount())).toBe(0);

      // Simulate multiple rapid visible -> hidden -> visible transitions
      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", {
          value: "visible",
          writable: true,
          configurable: true,
        });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await expectText(committedHeight, String(countAfterHidden + 1));

      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", {
          value: "hidden",
          writable: true,
          configurable: true,
        });
        document.dispatchEvent(new Event("visibilitychange"));
        Object.defineProperty(document, "visibilityState", {
          value: "visible",
          writable: true,
          configurable: true,
        });
        document.dispatchEvent(new Event("visibilitychange"));
      });

      await expectText(committedHeight, String(countAfterHidden + 2));

      // Exactly 1 active polling interval exists after multiple visibility transitions
      expect(await page.evaluate(() => (window as any).__activeIntervalCount())).toBe(1);
    } finally {
      await page.close();
    }
  });

  // =========================================================================
  // Scenario C5: Keyboard Navigation & Accessible Interaction
  // =========================================================================
  it("supports keyboard navigation through endpoint and method controls", async () => {
    const page = await newTestPage();
    try {
      await setupRpcRoute(page, (method) => {
        if (method === "kovanica_syncStatus") {
          return {
            catchingUp: false,
            committedHeight: 42,
            localTipRound: 42,
            peerCount: 3,
          };
        }
        if (method === "kovanica_blockNumber") {
          return "42";
        }
        throw { code: -32601, message: "Method not found" };
      });

      await page.goto(server.url, { waitUntil: "domcontentloaded" });

      const endpointInput = page.locator("#rpc-endpoint-input");
      await endpointInput.focus();
      await expectFocused(endpointInput);

      await page.keyboard.press("Tab");
      const localDefaultBtn = page.getByRole("button", { name: "Local Default" });
      await expectFocused(localDefaultBtn);

      const methodSelect = page.locator("#rpc-method-select");
      await methodSelect.focus();
      await expectFocused(methodSelect);

      // Tab to Execute Call button and activate via Enter key
      await page.keyboard.press("Tab");
      const executeBtn = page.getByRole("button", { name: "Execute Call" });
      await expectFocused(executeBtn);
      await page.keyboard.press("Enter");

      await expectVisible(page.locator("text=Response Result"));
    } finally {
      await page.close();
    }
  });
});
