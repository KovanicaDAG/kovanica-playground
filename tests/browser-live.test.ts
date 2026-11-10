// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Browser, chromium, type Page } from "playwright";
import { startTestServer, type TestServer } from "./helpers/test-server";
import {
  checkRpcReadiness,
  getEffectiveRpcUrl,
  isRequiredLiveMode,
} from "./helpers/rpc-readiness";
import { KovanicaClient } from "kovanica-sdk";

const LIVE_RPC_URL = getEffectiveRpcUrl();
const REQUIRED_LIVE = isRequiredLiveMode();

describe("Browser Live RPC Node Acceptance (Real Headless Chromium)", { timeout: 30000 }, () => {
  let server: TestServer;
  let browser: Browser;

  beforeAll(async () => {
    server = await startTestServer(5173);
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
        `[BLOCKED] Live Kovanica RPC unavailable at ${LIVE_RPC_URL}: ${readiness.reason}`,
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
  it("stronger live acceptance in browser: nonzero height, active peers, executed balance/rewards, truthful sync labels, and lossless KVNC copy", async (ctx) => {
    const readiness = await checkRpcReadiness(LIVE_RPC_URL);
    if (!readiness.available) {
      if (REQUIRED_LIVE) {
        throw new Error(
          `[REQUIRED-LIVE FAILURE] Configured live RPC endpoint unavailable or invalid at ${LIVE_RPC_URL}: ${readiness.reason}`,
        );
      }
      console.warn(
        `[BLOCKED] Live Kovanica RPC unavailable at ${LIVE_RPC_URL}: ${readiness.reason}`,
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
        `[BLOCKED] Stronger nonzero/executed acceptance requires independently demonstrated L1 execution past genesis (current height: ${payload?.committedHeight ?? "unknown"}, peers: ${payload?.peerCount ?? "unknown"}). Read-only genesis interop passed; nonzero execution acceptance remains BLOCKED until execution lane produces committed blocks.`,
      );
      ctx.skip();
      return;
    }

    // Resolve an account address for executed balance & reward assertions (e.g., active validator author)
    const client = new KovanicaClient(LIVE_RPC_URL);
    let targetAddress = process.env.KOVANICA_TEST_ADDRESS || process.env.KOVANICA_PRODUCER_ADDRESS;
    if (!targetAddress) {
      try {
        const validators = await client.getValidators({ timeoutMs: 5000 });
        if (Array.isArray(validators) && validators.length > 0 && validators[0]?.address) {
          targetAddress = validators[0].address;
        }
      } catch {
        // Fallback to canonical PRO-21 address format
      }
    }
    if (!targetAddress) {
      targetAddress = "kvnc8d4z00xwk6jz6c4r4rgz5mcdwdjny9thrh3y8f36cpy2rz6emg54rufktdag";
    }

    const page = await newTestPage();
    try {
      await page.goto(server.url, { waitUntil: "domcontentloaded" });

      const endpointInput = page.locator("#rpc-endpoint-input");
      if ((await endpointInput.inputValue()) !== LIVE_RPC_URL) {
        await endpointInput.fill(LIVE_RPC_URL);
      }

      // 1. Diagnostics assertions: confirmed in-sync and truthful metrics
      const badge = page.locator('[data-testid="sync-status-badge"]');
      await expect
        .poll(async () => (await badge.textContent())?.trim(), { timeout: 10000 })
        .toBe("Synced");

      const headerStatus = page.locator('[data-testid="header-node-status"]');
      await expect
        .poll(async () => (await headerStatus.textContent())?.trim(), { timeout: 10000 })
        .toBe("Online (Synced)");

      const committedHeight = page.locator('[data-testid="diagnostic-committed-height"]');
      await expect
        .poll(
          async () => {
            const txt = (await committedHeight.textContent())?.trim();
            return Number(txt) > 0;
          },
          { timeout: 10000 },
        )
        .toBe(true);

      const tipRound = page.locator('[data-testid="diagnostic-tip-round"]');
      const tipText = (await tipRound.textContent())?.trim();
      expect(Number(tipText)).toBeGreaterThan(0);

      const peerCount = page.locator('[data-testid="diagnostic-peer-count"]');
      const peerText = (await peerCount.textContent())?.trim();
      expect(Number(peerText)).toBeGreaterThanOrEqual(1);

      const catchingUp = page.locator('[data-testid="diagnostic-catching-up"]');
      expect(await catchingUp.textContent()).toMatch(/No/i);

      // 2. Executed balance call in Method Explorer
      const methodSelect = page.locator("#rpc-method-select");
      await methodSelect.selectOption("kovanica_getBalance");

      const addressInput = page.locator("#param-input-address");
      await addressInput.fill(targetAddress);

      const executeBtn = page.getByRole("button", { name: "Execute Call" });
      await executeBtn.click();

      const responseArea = page.locator("text=Response Result");
      await expect
        .poll(async () => responseArea.isVisible(), { timeout: 10000 })
        .toBe(true);

      const responsePre = responseArea.locator("../..").locator("pre");
      await expect
        .poll(
          async () => {
            const txt = await responsePre.textContent();
            return txt?.includes('"atoms"') && txt?.includes('"kvnc"');
          },
          { timeout: 10000 },
        )
        .toBe(true);

      const balanceText = await responsePre.textContent();
      expect(balanceText).toContain('"atoms"');
      expect(balanceText).toContain('"kvnc"');
      expect(balanceText).toContain("KVNC");
      expect(balanceText).not.toContain("KUNA");

      // 3. Executed rewards call in Method Explorer
      await methodSelect.selectOption("kovanica_getRewards");
      await addressInput.fill(targetAddress);
      await executeBtn.click();

      await expect
        .poll(
          async () => {
            const txt = await responsePre.textContent();
            return txt?.includes('"rewards_atoms"') && txt?.includes('"rewards_kvnc"');
          },
          { timeout: 10000 },
        )
        .toBe(true);

      const rewardsText = await responsePre.textContent();
      expect(rewardsText).toContain('"rewards_atoms"');
      expect(rewardsText).toContain('"rewards_kvnc"');
      expect(rewardsText).toContain("KVNC");
      expect(rewardsText).not.toContain("KUNA");

      // 4. Global currency label and copy check
      const footerLabel = page.locator('[data-testid="footer-currency-label"]');
      expect(await footerLabel.textContent()).toContain("KVNC (9 decimals)");
      const pageBodyText = await page.locator("body").innerText();
      expect(pageBodyText).not.toMatch(/\bKUNA\b/);
    } finally {
      await page.close();
    }
  });
});
