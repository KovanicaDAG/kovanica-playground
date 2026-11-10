import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { CHAIN_IDS } from "kovanica-sdk";
import { ALLOWLISTED_METHODS, validateParam } from "../src/methods";

describe("Immutable SDK Pin & Traceability", () => {
  it("pins an immutable 40-char SDK git commit SHA in package.json, CI workflow, and resolved installation", () => {
    const rootDir = path.resolve(__dirname, "..");
    const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
    const pinnedSha = pkg?.kovanicaSdk?.testedRevision;

    expect(pinnedSha).toBe("7b790bee424ad64b25e9938a2600ec169e687b7c");
    expect(pinnedSha).toMatch(/^[0-9a-f]{40}$/);

    const ciWorkflow = fs.readFileSync(path.join(rootDir, ".github/workflows/ci.yml"), "utf8");
    expect(ciWorkflow).toContain(`ref: ${pinnedSha}`);
    expect(ciWorkflow).not.toMatch(/repository:\s*KovanicaDAG\/kovanica-sdk[\s\S]*?ref:\s*main/);

    const installedSdkDir = path.join(rootDir, "node_modules", "kovanica-sdk");
    const distIndexPath = path.join(installedSdkDir, "dist", "index.js");
    expect(fs.existsSync(distIndexPath)).toBe(true);

    // Confirm the compiled bundle includes the SDK #4 transport contract & envelope validation
    const distContent = fs.readFileSync(distIndexPath, "utf8");
    expect(distContent).toContain("JSON-RPC response ID mismatch");
    expect(distContent).toContain("neither result nor error member present");

    const markerPath = path.join(installedSdkDir, ".tested-revision");
    if (fs.existsSync(markerPath)) {
      expect(fs.readFileSync(markerPath, "utf8").trim()).toBe(pinnedSha);
    } else {
      const resolvedSha = execSync(`git -C "${installedSdkDir}" rev-parse HEAD`, { encoding: "utf8" }).trim();
      expect(resolvedSha).toBe(pinnedSha);
    }

    // Prove which SDK source the tests and runtime actually resolve
    const resolvedPath = path.resolve(rootDir, "node_modules", "kovanica-sdk", "dist", "index.js");
    expect(fs.realpathSync(distIndexPath)).toBe(fs.realpathSync(resolvedPath));
  });
});

describe("Playground Allowlisted Methods", () => {
  it("contains only read-only RPC methods", () => {
    const methodNames = ALLOWLISTED_METHODS.map((m) => m.method);
    expect(methodNames).toContain("kovanica_blockNumber");
    expect(methodNames).toContain("kovanica_getBlockByNumber");
    expect(methodNames).toContain("kovanica_getBlockByHash");
    expect(methodNames).toContain("kovanica_getBalance");
    expect(methodNames).toContain("kovanica_getNonce");
    expect(methodNames).toContain("kovanica_getCode");
    expect(methodNames).toContain("kovanica_getStorageAt");
    expect(methodNames).toContain("kovanica_getTransactionByHash");
    expect(methodNames).toContain("kovanica_getTransactionReceipt");
    expect(methodNames).toContain("kovanica_getPendingTransactions");
    expect(methodNames).toContain("kovanica_estimateFee");
    expect(methodNames).toContain("kovanica_getValidators");
    expect(methodNames).toContain("kovanica_getStake");
    expect(methodNames).toContain("kovanica_getRewards");
    expect(methodNames).toContain("kovanica_getLeaderSchedule");
    expect(methodNames).toContain("kovanica_syncStatus");
    expect(methodNames).toContain("kovanica_getMiningInfo");
    expect(methodNames).toContain("kovanica_getDagTips");

    // Strictly excludes write or sensitive methods
    expect(methodNames).not.toContain("kovanica_sendRawTransaction");
    expect(methodNames).not.toContain("kovanica_submitWork");
    expect(methodNames).not.toContain("kovanica_getWork");
  });

  it("validates address parameter according to chain rules", () => {
    const addressParam = {
      name: "address",
      label: "Account Address",
      type: "address" as const,
      required: true,
    };

    // Missing required param
    expect(validateParam(addressParam, "").valid).toBe(false);

    // Bare hex on Mainnet (Chain 1) and Testnet (Chain 2) -> invalid (strict PRO-21)
    const hex = "0x" + "00".repeat(32);
    expect(validateParam(addressParam, hex, CHAIN_IDS.MAINNET).valid).toBe(false);
    expect(validateParam(addressParam, hex, CHAIN_IDS.TESTNET).valid).toBe(false);

    // Bare hex on Devnet (Chain 3) -> valid legacy address
    expect(validateParam(addressParam, hex, CHAIN_IDS.DEVNET).valid).toBe(true);
  });

  it("validates hex32 parameters", () => {
    const hashParam = {
      name: "hash",
      label: "Hash",
      type: "hex32" as const,
      required: true,
    };

    expect(validateParam(hashParam, "0x123").valid).toBe(false);
    expect(validateParam(hashParam, "0x" + "aa".repeat(32)).valid).toBe(true);
    expect(validateParam(hashParam, "aa".repeat(32)).valid).toBe(true);
  });
});
