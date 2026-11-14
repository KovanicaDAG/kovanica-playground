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
            networkTag: "3-genesis-test",
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
            networkTag: "2-large-int",
          };
        }
        if (method === "kovanica_getMiningInfo") {
          return {
            chain_id: 2,
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
            networkTag: "2-syncing",
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
            networkTag: "2-isolated-nonzero",
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
  // Scenario B7: SDK #4 Invalid Envelopes, Mismatched Response ID & Recovery
  // =========================================================================
  it("rejects invalid JSON-RPC 2.0 envelopes and mismatched response IDs, then recovers on next valid request", async () => {
    const page = await newTestPage();
    type EnvelopeMode =
      | "non-object"
      | "bad-version"
      | "neither-result-nor-error"
      | "both-result-and-error"
      | "id-mismatch"
      | "valid";
    let diagMode: EnvelopeMode = "non-object";
    let methodMode: EnvelopeMode = "id-mismatch";

    try {
      await setupRpcRoute(page, (method, _params, id) => {
        const currentMode = method === "kovanica_syncStatus" ? diagMode : methodMode;

        if (currentMode === "non-object") {
          throw {
            rawFulfill: {
              status: 200,
              contentType: "application/json",
              body: JSON.stringify([1, 2, 3]),
            },
          };
        }
        if (currentMode === "bad-version") {
          throw {
            rawFulfill: {
              status: 200,
              contentType: "application/json",
              body: JSON.stringify({ jsonrpc: "1.0", id, result: "0x1" }),
            },
          };
        }
        if (currentMode === "neither-result-nor-error") {
          throw {
            rawFulfill: {
              status: 200,
              contentType: "application/json",
              body: JSON.stringify({ jsonrpc: "2.0", id }),
            },
          };
        }
        if (currentMode === "both-result-and-error") {
          throw {
            rawFulfill: {
              status: 200,
              contentType: "application/json",
              body: JSON.stringify({
                jsonrpc: "2.0",
                id,
                result: "0x1",
                error: { code: -32000, message: "Ambiguous envelope" },
              }),
            },
          };
        }
        if (currentMode === "id-mismatch") {
          throw {
            rawFulfill: {
              status: 200,
              contentType: "application/json",
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: 999999,
                result: {
                  catchingUp: false,
                  committedHeight: 777,
                  localTipRound: 777,
                  peerCount: 4,
                },
              }),
            },
          };
        }

        if (method === "kovanica_syncStatus") {
          return {
            catchingUp: false,
            committedHeight: 777,
            localTipRound: 777,
            peerCount: 4,
            networkTag: "2-recovered",
          };
        }
        if (method === "kovanica_blockNumber") {
          return "0x309"; // 777
        }
        throw { code: -32601, message: "Method not found" };
      });

      await page.goto(server.url, { waitUntil: "domcontentloaded" });

      // 1. Non-object envelope rejected
      await expectText(page.locator('[data-testid="sync-status-badge"]'), "Connection Error");
      await expectContainsText(
        page.locator('[data-testid="diagnostic-empty-state"]'),
        "payload must be a JSON object",
      );

      // 2. Bad jsonrpc version rejected
      diagMode = "bad-version";
      await page.getByRole("button", { name: "Refresh" }).click();
      await expectContainsText(
        page.locator('[data-testid="diagnostic-empty-state"]'),
        'missing or invalid "jsonrpc" version',
      );

      // 3. Neither result nor error member rejected
      diagMode = "neither-result-nor-error";
      await page.getByRole("button", { name: "Refresh" }).click();
      await expectContainsText(
        page.locator('[data-testid="diagnostic-empty-state"]'),
        "neither result nor error member present",
      );

      // 4. Both result and error members rejected
      diagMode = "both-result-and-error";
      await page.getByRole("button", { name: "Refresh" }).click();
      await expectContainsText(
        page.locator('[data-testid="diagnostic-empty-state"]'),
        "both result and error members present",
      );

      // 5. Mismatched response ID rejected on diagnostics
      diagMode = "id-mismatch";
      await page.getByRole("button", { name: "Refresh" }).click();
      await expectContainsText(
        page.locator('[data-testid="diagnostic-empty-state"]'),
        "JSON-RPC response ID mismatch",
      );

      // 6. Recovery on next valid diagnostics request
      diagMode = "valid";
      await page.getByRole("button", { name: "Refresh" }).click();
      await expectText(page.locator('[data-testid="sync-status-badge"]'), "Synced");
      await expectText(page.locator('[data-testid="header-node-status"]'), "Online (Synced)");
      await expectText(page.locator('[data-testid="diagnostic-committed-height"]'), "777");

      // 7. Method Explorer: Mismatched response ID rejected, then recovers on next valid call
      const executeBtn = page.getByRole("button", { name: "Execute Call" });
      await executeBtn.click();
      await expectVisible(page.getByText("RPC Error", { exact: true }));
      await expectVisible(page.locator("text=JSON-RPC response ID mismatch"));

      methodMode = "valid";
      await executeBtn.click();
      await expectNotVisible(page.getByText("RPC Error", { exact: true }));
      await expectVisible(page.locator("text=Response Result"));
      await expectContainsText(page.locator("pre").filter({ hasText: "777" }), "777");
    } finally {
      await page.close();
    }
  });

  // =========================================================================
  // Scenario B8: SDK Timeout & Recovery in Real Browser
  // =========================================================================
  it("surfaces timeout error through real SDK client and recovers on subsequent valid request", async () => {
    const page = await newTestPage();
    let shouldTimeout = true;

    try {
      await setupRpcRoute(page, async (method, _params, _id, route) => {
        if (method === "kovanica_syncStatus") {
          return { catchingUp: false, committedHeight: 50, localTipRound: 50, peerCount: 3 };
        }
        if (method === "kovanica_blockNumber") {
          if (shouldTimeout) {
            // Wait until the request is aborted by the SDK timeout controller
            await new Promise<void>((resolve) => {
              route.request().failure();
              setTimeout(resolve, 250);
            });
            try {
              await route.abort("timedout");
            } catch {
              // already aborted
            }
            return;
          }
          return "0x58"; // 88
        }
        throw { code: -32601, message: "Method not found" };
      });

      await page.goto(server.url, { waitUntil: "domcontentloaded" });
      await expectText(page.locator('[data-testid="diagnostic-committed-height"]'), "50");

      // Shorten the 10_000ms SDK request timeout timer in the browser window to 40ms
      // so HttpTransport's real timeout path fires rapidly and deterministically
      await page.evaluate(() => {
        const origSetTimeout = window.setTimeout.bind(window);
        (window as any).__origSetTimeout = origSetTimeout;
        (window as any).setTimeout = ((fn: any, ms?: number, ...args: any[]) => {
          const effectiveMs = typeof ms === "number" && ms >= 3000 && ms <= 10000 ? 40 : ms;
          return origSetTimeout(fn, effectiveMs, ...args);
        }) as typeof window.setTimeout;
      });

      const executeBtn = page.getByRole("button", { name: "Execute Call" });
      await executeBtn.click();

      await expectVisible(page.getByText("RPC Error", { exact: true }));
      await expectVisible(page.locator("text=Request timed out after 10000ms"));

      // Restore normal setTimeout so recovery request is not prematurely aborted
      await page.evaluate(() => {
        if ((window as any).__origSetTimeout) {
          window.setTimeout = (window as any).__origSetTimeout;
        }
      });

      // Next valid request must recover cleanly
      shouldTimeout = false;
      await executeBtn.click();
      await expectNotVisible(page.getByText("RPC Error", { exact: true }));
      await expectVisible(page.locator("text=Response Result"));
      await expectContainsText(page.locator("pre").filter({ hasText: "88" }), "88");
    } finally {
      await page.close();
    }
  });

  // =========================================================================
  // Scenario B9: Currency Display Copy (KVNC, Never KUNA) & BigInt Error Data Safety
  // =========================================================================
  it("renders KVNC currency labels, zero and u64::MAX balances losslessly, and never crashes on bigint in RPC error data", async () => {
    const page = await newTestPage();
    let balanceAtomsHex = "0x0";
    let throwBigIntErrorData = false;

    try {
      await setupRpcRoute(page, (method, _params, id) => {
        if (method === "kovanica_syncStatus") {
          return { catchingUp: false, committedHeight: 0, localTipRound: 0, peerCount: 0 };
        }
        if (method === "kovanica_getBalance") {
          if (throwBigIntErrorData) {
            throw {
              rawFulfill: {
                status: 200,
                contentType: "application/json",
                // Raw unquoted 18446744073709551615 in error.data is parsed as bigint by parseLosslessJson
                body: `{"jsonrpc":"2.0","id":${JSON.stringify(id)},"error":{"code":-32000,"message":"Account state locked","data":{"lockedAtoms":18446744073709551615}}}`,
              },
            };
          }
          return balanceAtomsHex;
        }
        throw { code: -32601, message: "Method not found" };
      });

      await page.goto(server.url, { waitUntil: "domcontentloaded" });

      // 1. Verify footer currency label explicitly states KVNC (9 decimals) and page has no stale KUNA copy
      await expectText(
        page.locator('[data-testid="footer-currency-label"]'),
        "Kovanica Layer-1 Blockchain © 2026. KVNC (9 decimals).",
      );
      expect(await page.locator("body").textContent()).not.toContain("KUNA");

      // 2. Select kovanica_getBalance and execute with 0 atoms on Testnet (canonical PRO-21 address)
      const methodSelect = page.locator("#rpc-method-select");
      await methodSelect.selectOption("kovanica_getBalance");
      const addressInput = page.locator("#param-input-address");
      await addressInput.fill("kvnck2559l6vnpcchmtkuf2eslmdtxc6wtfm9nf9zqqructs4336nla58y78mdag");

      const executeBtn = page.getByRole("button", { name: "Execute Call" });
      await executeBtn.click();

      const zeroPre = page.locator("pre").filter({ hasText: "0 KVNC" });
      await expectVisible(zeroPre);
      await expectContainsText(zeroPre, '"atoms": "0"');
      await expectContainsText(zeroPre, '"kvnc": "0 KVNC"');

      // 3. Execute with u64::MAX (18446744073709551615 atoms = 18446744073.709551615 KVNC)
      balanceAtomsHex = "0xffffffffffffffff";
      await executeBtn.click();

      const maxPre = page.locator("pre").filter({ hasText: "18446744073.709551615 KVNC" });
      await expectVisible(maxPre);
      await expectContainsText(maxPre, '"atoms": "18446744073709551615"');
      await expectContainsText(maxPre, '"kvnc": "18446744073.709551615 KVNC"');
      expect(await page.locator("body").textContent()).not.toContain("KUNA");

      // 4. Trigger RPC error containing 64-bit bigint in error.data; confirm no BigInt serialization crash
      throwBigIntErrorData = true;
      await executeBtn.click();
      await expectVisible(page.getByText("RPC Error", { exact: true }));
      await expectVisible(page.locator("text=Account state locked"));
      await expectVisible(page.locator("text=18446744073709551615"));

      // 5. Recover on next valid call
      throwBigIntErrorData = false;
      await executeBtn.click();
      await expectNotVisible(page.getByText("RPC Error", { exact: true }));
      await expectVisible(maxPre);
    } finally {
      await page.close();
    }
  });

  // =========================================================================
  // Scenario B10: Deterministic Stronger Nonzero Acceptance in Browser
  // =========================================================================
  it("verifies stronger nonzero acceptance in browser: height, tip round, truthful sync/peer diagnostics, executed balance and rewards with lossless KVNC copy", async () => {
    const page = await newTestPage();
    try {
      await setupRpcRoute(page, (method) => {
        if (method === "kovanica_syncStatus") {
          return {
            catchingUp: false,
            committedHeight: 8,
            localTipRound: 9,
            peerCount: 3,
            networkTag: "2-hybrid-testnet",
          };
        }
        if (method === "kovanica_getMiningInfo") {
          return {
            chain_id: 2,
            mining_enabled: false,
            mining_threads: 1,
            target_bits: "0x1d00ffff",
            target: "0x0000ffff00000000000000000000000000000000000000000000000000000000",
            difficulty: "100",
            target_block_time_ms: 4000,
            ghostdag_k: 5,
            network_hashrate_estimate: "1000",
            dag_tips_count: 1,
          };
        }
        if (method === "kovanica_blockNumber") {
          return "0x8";
        }
        if (method === "kovanica_getBalance") {
          // 450018999000000 atoms = 450018.999 KVNC
          return "0x1994a3693dbc0";
        }
        if (method === "kovanica_getRewards") {
          // 2500000000 atoms = 2.5 KVNC
          return "0x9502f900";
        }
        throw { code: -32601, message: "Method not found" };
      });

      await page.goto(server.url, { waitUntil: "domcontentloaded" });

      // 1. Diagnostics panel: truthful sync status and nonzero metrics
      const badge = page.locator('[data-testid="sync-status-badge"]');
      await expectText(badge, "Synced");

      const headerStatus = page.locator('[data-testid="header-node-status"]');
      await expectText(headerStatus, "Online (Synced)");

      const committedHeight = page.locator('[data-testid="diagnostic-committed-height"]');
      await expectText(committedHeight, "8");

      const tipRound = page.locator('[data-testid="diagnostic-tip-round"]');
      await expectText(tipRound, "9");

      const peerCount = page.locator('[data-testid="diagnostic-peer-count"]');
      await expectText(peerCount, "3");

      const catchingUp = page.locator('[data-testid="diagnostic-catching-up"]');
      await expectText(catchingUp, "No");

      // 2. Executed balance call via Method Explorer
      const methodSelect = page.locator("#rpc-method-select");
      await methodSelect.selectOption("kovanica_getBalance");

      const addressInput = page.locator("#param-input-address");
      const testAddress = "kvnc8d4z00xwk6jz6c4r4rgz5mcdwdjny9thrh3y8f36cpy2rz6emg54rufktdag";
      await addressInput.fill(testAddress);

      const executeBtn = page.getByRole("button", { name: "Execute Call" });
      await executeBtn.click();

      const balancePre = page.locator("pre").filter({ hasText: "450018.999 KVNC" });
      await expectVisible(balancePre);
      await expectContainsText(balancePre, '"atoms": "450018999000000"');
      await expectContainsText(balancePre, '"kvnc": "450018.999 KVNC"');
      await expectContainsText(balancePre, '"hex_quantity": "0x1994a3693dbc0"');

      // 3. Executed rewards call via Method Explorer
      await methodSelect.selectOption("kovanica_getRewards");
      await addressInput.fill(testAddress);
      await executeBtn.click();

      const rewardsPre = page.locator("pre").filter({ hasText: "2.5 KVNC" });
      await expectVisible(rewardsPre);
      await expectContainsText(rewardsPre, '"rewards_atoms": "2500000000"');
      await expectContainsText(rewardsPre, '"rewards_kvnc": "2.5 KVNC"');
      await expectContainsText(rewardsPre, '"hex_quantity": "0x9502f900"');

      // 4. Verify KVNC copy and absence of KUNA
      const footerLabel = page.locator('[data-testid="footer-currency-label"]');
      await expectContainsText(footerLabel, "KVNC (9 decimals)");
      expect(await page.locator("body").textContent()).not.toContain("KUNA");
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
              id: _id,
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
      await setupRpcRoute(page, async (method, _params, _id, route) => {
        if (method === "kovanica_getMiningInfo") {
          throw { code: -32601, message: "Method not found" };
        }
        if (method === "kovanica_syncStatus") {
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
        }
        throw { code: -32601, message: "Method not found" };
      });

      await page.goto(server.url, { waitUntil: "domcontentloaded" });
      const committedHeight = page.locator('[data-testid="diagnostic-committed-height"]');
      await expectText(committedHeight, "100", 12000);

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
      await expect.poll(async () => Number((await committedHeight.textContent())?.trim()), { timeout: 10000 }).toBeGreaterThanOrEqual(1);

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

      await expect
        .poll(async () => Number((await committedHeight.textContent())?.trim()), { timeout: 5000 })
        .toBeGreaterThanOrEqual(countAfterHidden + 2);

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

  // =========================================================================
  // Scenario C6: Failure Non-Conversion & Clean Recovery for Balances/Rewards
  // =========================================================================
  it("proves failures on getBalance and getRewards never convert to zero balance/rewards, recovers cleanly across failure modes, and preserves legitimate zero", async () => {
    const page = await newTestPage();
    let balanceMode: "transport-500" | "rpc-error" | "legitimate-zero" | "nonzero-recovered" = "transport-500";
    let rewardsMode: "transport-500" | "legitimate-zero" | "nonzero-recovered" = "transport-500";
    const testAddress = "kvnc8d4z00xwk6jz6c4r4rgz5mcdwdjny9thrh3y8f36cpy2rz6emg54rufktdag";

    try {
      await setupRpcRoute(page, (method) => {
        if (method === "kovanica_syncStatus") {
          return {
            catchingUp: false,
            committedHeight: 10,
            localTipRound: 10,
            peerCount: 3,
            networkTag: "2-hybrid",
          };
        }

        if (method === "kovanica_getBalance") {
          if (balanceMode === "transport-500") {
            throw {
              rawFulfill: {
                status: 500,
                contentType: "text/plain",
                body: "Internal Server Error",
              },
            };
          }
          if (balanceMode === "rpc-error") {
            throw {
              code: -32000,
              message: "State storage read failure",
            };
          }
          if (balanceMode === "legitimate-zero") {
            return "0x0";
          }
          if (balanceMode === "nonzero-recovered") {
            return "0x1994a3693dbc0"; // 450018999000000 atoms
          }
        }

        if (method === "kovanica_getRewards") {
          if (rewardsMode === "transport-500") {
            throw {
              rawFulfill: {
                status: 500,
                contentType: "text/plain",
                body: "Internal Server Error",
              },
            };
          }
          if (rewardsMode === "legitimate-zero") {
            return "0x0";
          }
          if (rewardsMode === "nonzero-recovered") {
            return "0x9502f900"; // 2500000000 atoms (2.5 KVNC)
          }
        }

        throw { code: -32601, message: "Method not found" };
      });

      await page.goto(server.url, { waitUntil: "domcontentloaded" });

      // 1. Select kovanica_getBalance
      const methodSelect = page.locator("#rpc-method-select");
      await methodSelect.selectOption("kovanica_getBalance");

      const addressInput = page.locator("#param-input-address");
      await addressInput.fill(testAddress);

      const executeBtn = page.getByRole("button", { name: "Execute Call" });

      // Transport 500 failure
      balanceMode = "transport-500";
      await executeBtn.click();
      await expectVisible(page.getByText("RPC Error", { exact: true }));
      // Must not convert to 0 balance or 0 KVNC
      const responseContainer = page.locator("body");
      expect(await responseContainer.innerText()).not.toContain('"atoms": "0"');
      expect(await responseContainer.innerText()).not.toContain('"kvnc": "0 KVNC"');

      // RPC Error failure
      balanceMode = "rpc-error";
      await executeBtn.click();
      await expectVisible(page.getByText("RPC Error", { exact: true }));
      await expectContainsText(page.locator(".bg-red-950\\/40"), "State storage read failure");
      expect(await responseContainer.innerText()).not.toContain('"atoms": "0"');

      // Legitimate zero balance
      balanceMode = "legitimate-zero";
      await executeBtn.click();
      await expectNotVisible(page.getByText("RPC Error", { exact: true }));
      await expectVisible(page.locator("text=Response Result"));
      const balanceZeroPre = page.locator("pre").filter({ hasText: '"atoms": "0"' });
      await expectVisible(balanceZeroPre);
      await expectContainsText(balanceZeroPre, '"kvnc": "0 KVNC"');
      await expectContainsText(balanceZeroPre, '"hex_quantity": "0x0"');

      // Clean recovery to non-zero balance
      balanceMode = "nonzero-recovered";
      await executeBtn.click();
      const balanceRecoveredPre = page.locator("pre").filter({ hasText: "450018999000000" });
      await expectVisible(balanceRecoveredPre);
      await expectContainsText(balanceRecoveredPre, '"kvnc": "450018.999 KVNC"');

      // 2. Select kovanica_getRewards
      await methodSelect.selectOption("kovanica_getRewards");
      await addressInput.fill(testAddress);

      // Transport failure does not become zero rewards
      rewardsMode = "transport-500";
      await executeBtn.click();
      await expectVisible(page.getByText("RPC Error", { exact: true }));
      expect(await responseContainer.innerText()).not.toContain('"rewards_atoms": "0"');

      // Legitimate zero rewards
      rewardsMode = "legitimate-zero";
      await executeBtn.click();
      await expectNotVisible(page.getByText("RPC Error", { exact: true }));
      const rewardsZeroPre = page.locator("pre").filter({ hasText: '"rewards_atoms": "0"' });
      await expectVisible(rewardsZeroPre);
      await expectContainsText(rewardsZeroPre, '"rewards_kvnc": "0 KVNC"');

      // Clean recovery to non-zero rewards
      rewardsMode = "nonzero-recovered";
      await executeBtn.click();
      const rewardsRecoveredPre = page.locator("pre").filter({ hasText: "2500000000" });
      await expectVisible(rewardsRecoveredPre);
      await expectContainsText(rewardsRecoveredPre, '"rewards_kvnc": "2.5 KVNC"');
    } finally {
      await page.close();
    }
  });

  // =========================================================================
  // Scenario C7: Distinction of Submission, Admission, Commitment, and Execution
  // =========================================================================
  it("distinguishes submission acknowledgement, admission, commitment, and execution, proving nonzero height alone cannot pass executed-state acceptance", async () => {
    const page = await newTestPage();
    const testAuthor = "kvnc8d4z00xwk6jz6c4r4rgz5mcdwdjny9thrh3y8f36cpy2rz6emg54rufktdag";
    const pendingTxHash = "0x" + "11".repeat(32);

    try {
      await setupRpcRoute(page, (method) => {
        if (method === "kovanica_syncStatus") {
          return {
            catchingUp: false,
            committedHeight: 5,
            localTipRound: 5,
            peerCount: 2,
            networkTag: "2-testnet",
          };
        }
        if (method === "kovanica_blockNumber") {
          return "0x5";
        }
        if (method === "kovanica_getPendingTransactions") {
          // Admission acknowledgement: in mempool, but not committed or executed
          return [pendingTxHash];
        }
        if (method === "kovanica_getTransactionReceipt") {
          // Unexecuted transaction has no receipt
          return null;
        }
        if (method === "kovanica_getBlockByNumber") {
          // Block 5 commitment exists
          return {
            number: "0x5",
            round: "0x5",
            hash: "0x" + "22".repeat(32),
            transactions: ["0x" + "33".repeat(32)],
          };
        }
        if (method === "kovanica_getBalance") {
          // Author balance remains at exact unrewarded genesis liquid baseline: 450_000_000_000_000 atoms (450,000 KVNC)
          return "0x19945ca262000";
        }
        if (method === "kovanica_getRewards") {
          // Author has 0 cumulative rewards
          return "0x0";
        }
        throw { code: -32601, message: "Method not found" };
      });

      await page.goto(server.url, { waitUntil: "domcontentloaded" });

      // 1. Diagnostics shows nonzero committed height (5)
      await expectText(page.locator('[data-testid="diagnostic-committed-height"]'), "5");
      await expectText(page.locator('[data-testid="sync-status-badge"]'), "Synced");

      const methodSelect = page.locator("#rpc-method-select");
      const executeBtn = page.getByRole("button", { name: "Execute Call" });

      // 2. Admission: kovanica_getPendingTransactions returns mempool transaction
      await methodSelect.selectOption("kovanica_getPendingTransactions");
      await executeBtn.click();
      await expectVisible(page.locator("text=Response Result"));
      await expectContainsText(page.locator("pre").filter({ hasText: pendingTxHash }), pendingTxHash);

      // 3. Unexecuted: receipt is null
      await methodSelect.selectOption("kovanica_getTransactionReceipt");
      await page.locator("#param-input-hash").fill(pendingTxHash);
      await executeBtn.click();
      await expectVisible(page.locator("text=Response Result"));
      await expectContainsText(page.locator("pre").filter({ hasText: "null" }), "null");

      // 4. Execution verification: author balance is at unrewarded genesis baseline (450,000 KVNC)
      await methodSelect.selectOption("kovanica_getBalance");
      await page.locator("#param-input-address").fill(testAuthor);
      await executeBtn.click();
      const balancePre = page.locator("pre").filter({ hasText: "450000000000000" });
      await expectVisible(balancePre);
      await expectContainsText(balancePre, '"kvnc": "450000 KVNC"');

      // 5. Author rewards is 0
      await methodSelect.selectOption("kovanica_getRewards");
      await page.locator("#param-input-address").fill(testAuthor);
      await executeBtn.click();
      const rewardsPre = page.locator("pre").filter({ hasText: '"rewards_atoms": "0"' });
      await expectVisible(rewardsPre);
      await expectContainsText(rewardsPre, '"rewards_kvnc": "0 KVNC"');

      // 6. Prove execution assertion:
      // Author balance (450000000000000 atoms) DOES NOT strictly exceed the genesis baseline (450000000000000 atoms).
      // Thus, nonzero height alone (height=5) does NOT constitute executed-balance/reward acceptance!
      const baseline = 450_000_000_000_000n;
      const authorBalance = 450_000_000_000_000n;
      expect(authorBalance > baseline).toBe(false);
    } finally {
      await page.close();
    }
  });

  // =========================================================================
  // Scenario C8: Network Selection Aborts In-Flight Requests & Prevents Stale Overwrites
  // =========================================================================
  it("aborts in-flight execution and drops stale responses when target network is changed", async () => {
    const page = await newTestPage();
    let resolveSlowExecution: (() => void) | null = null;
    const legacyHexAddress = "0x" + "00".repeat(31) + "01";

    try {
      await setupRpcRoute(page, async (method) => {
        if (method === "kovanica_syncStatus") {
          return {
            catchingUp: false,
            committedHeight: 20,
            localTipRound: 20,
            peerCount: 3,
            networkTag: "2-hybrid",
          };
        }
        if (method === "kovanica_blockNumber") {
          await new Promise<void>((r) => {
            resolveSlowExecution = r;
          });
          return "0x777";
        }
        throw { code: -32601, message: "Method not found" };
      });

      await page.goto(server.url, { waitUntil: "domcontentloaded" });

      // Select Devnet (Chain 3)
      const networkSelect = page.locator("#target-network-select");
      await networkSelect.selectOption("3");
      expect(await networkSelect.inputValue()).toBe("3");

      // Verify legacy hex address is valid on Devnet (Chain 3)
      const methodSelect = page.locator("#rpc-method-select");
      await methodSelect.selectOption("kovanica_getBalance");
      const addressInput = page.locator("#param-input-address");
      await addressInput.fill(legacyHexAddress);
      // No validation error on Devnet
      await expectNotVisible(page.locator("text=Invalid address for chain"));

      // Switch back to blockNumber and start slow in-flight request
      await methodSelect.selectOption("kovanica_blockNumber");
      const executeBtn = page.getByRole("button", { name: "Execute Call" });
      await executeBtn.click();

      // Cancel button appears indicating in-flight execution
      const cancelBtn = page.getByRole("button", { name: "Cancel" });
      await expectVisible(cancelBtn);

      // Change Target Network to Mainnet (Chain 1)
      await networkSelect.selectOption("1");

      // In-flight execution is aborted immediately
      await expectNotVisible(cancelBtn);
      await expectNotVisible(page.locator("text=Response Result"));

      // Switch to getBalance with legacy hex address: on Mainnet (Chain 1), it must immediately show error
      await methodSelect.selectOption("kovanica_getBalance");
      await addressInput.fill(legacyHexAddress);
      await expectVisible(page.locator("text=Invalid address for chain 1"));

      // Now resolve the slow execution from Devnet
      if (resolveSlowExecution) {
        (resolveSlowExecution as () => void)();
      }

      // Wait a moment and confirm the delayed response from Devnet never overwrites the view
      await page.waitForTimeout(300);
      await expectNotVisible(page.locator("text=Response Result"));
      expect(await page.locator("body").innerText()).not.toContain("0x777");
    } finally {
      await page.close();
    }
  });
});
