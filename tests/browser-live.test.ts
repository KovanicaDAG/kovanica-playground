// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Browser, chromium, type Page } from "playwright";
import { startTestServer, type TestServer } from "./helpers/test-server";
import {
  checkRpcReadiness,
  getEffectiveRpcUrl,
  isRequiredLiveMode,
} from "./helpers/rpc-readiness";

const LIVE_RPC_URL = getEffectiveRpcUrl();
const REQUIRED_LIVE = isRequiredLiveMode();

describe("Browser Live RPC Node Acceptance (Real Headless Chromium)", { timeout: 30000 }, () => {
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

  // =========================================================================
  // Scenario D1: Basic Live Read-Only Browser RPC Interoperability
  // =========================================================================
  it("basic read-only RPC UI interoperability against live node", async (ctx) => {
    // 1. Genuine pre-readiness verification (HTTP 200 alone is insufficient)
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

    const page = await newTestPage();
    try {
      await page.goto(server.url, { waitUntil: "domcontentloaded" });

      // Point endpoint input to actual live RPC URL if different from default
      const endpointInput = page.locator("#rpc-endpoint-input");
      const currentVal = await endpointInput.inputValue();
      if (currentVal !== LIVE_RPC_URL) {
        await endpointInput.fill(LIVE_RPC_URL);
      }

      // Wait for diagnostics panel to receive live syncStatus response
      const committedHeight = page.locator('[data-testid="diagnostic-committed-height"]');
      await expect
        .poll(
          async () => {
            const txt = (await committedHeight.textContent())?.trim();
            return txt && txt !== "—";
          },
          { timeout: 10000 },
        )
        .toBe(true);

      const heightText = (await committedHeight.textContent())?.trim();
      expect(heightText).toBeDefined();
      expect(heightText).not.toBe("—");

      // Verify header status is online
      const headerStatus = page.locator('[data-testid="header-node-status"]');
      const headerText = await headerStatus.textContent();
      expect(headerText).toMatch(/Online/);

      // Execute live read-only method via UI
      const executeBtn = page.getByRole("button", { name: "Execute Call" });
      await executeBtn.click();

      // Wait for response result
      const responseArea = page.locator("text=Response Result");
      await expect
        .poll(async () => responseArea.isVisible(), { timeout: 10000 })
        .toBe(true);
    } finally {
      await page.close();
    }
  });

  // =========================================================================
  // Scenario D2: Stronger Live Synced Acceptance
  // =========================================================================
  it("stronger live acceptance in browser: nonzero height, active peers, and confirmed in-sync", async (ctx) => {
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

    const payload = readiness.payload;
    const isStrongerEligible =
      payload &&
      typeof payload === "object" &&
      payload.committedHeight !== undefined &&
      Number(payload.committedHeight) > 0 &&
      payload.peerCount !== undefined &&
      Number(payload.peerCount) > 0;

    if (!isStrongerEligible) {
      if (REQUIRED_LIVE) {
        throw new Error(
          `[REQUIRED-LIVE FAILURE] Node at ${LIVE_RPC_URL} does not satisfy stronger synced acceptance: committedHeight=${payload?.committedHeight}, peerCount=${payload?.peerCount}, catchingUp=${payload?.catchingUp}`,
        );
      }
      console.warn(
        `[SKIP] Node at ${LIVE_RPC_URL} is in legitimate genesis/unsynced state (committedHeight=${payload?.committedHeight}, peerCount=${payload?.peerCount}); skipping stronger nonzero/synced acceptance.`,
      );
      ctx.skip();
      return;
    }

    const page = await newTestPage();
    try {
      await page.goto(server.url, { waitUntil: "domcontentloaded" });

      const endpointInput = page.locator("#rpc-endpoint-input");
      if ((await endpointInput.inputValue()) !== LIVE_RPC_URL) {
        await endpointInput.fill(LIVE_RPC_URL);
      }

      // Stronger live assertions: badge must be Synced
      const badge = page.locator('[data-testid="sync-status-badge"]');
      await expect
        .poll(async () => (await badge.textContent())?.trim(), { timeout: 10000 })
        .toBe("Synced");

      const headerStatus = page.locator('[data-testid="header-node-status"]');
      await expect
        .poll(async () => (await headerStatus.textContent())?.trim(), { timeout: 10000 })
        .toBe("Online (Synced)");

      const committedHeight = page.locator('[data-testid="diagnostic-committed-height"]');
      const heightText = (await committedHeight.textContent())?.trim();
      expect(Number(heightText)).toBeGreaterThan(0);
    } finally {
      await page.close();
    }
  });
});
