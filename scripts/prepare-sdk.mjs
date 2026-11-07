#!/usr/bin/env node
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PLAYGROUND_ROOT = resolve(__dirname, "..");

const pkg = JSON.parse(readFileSync(join(PLAYGROUND_ROOT, "package.json"), "utf8"));
const PINNED_SDK_SHA = pkg?.kovanicaSdk?.testedRevision;
const SDK_REPO_URL = `${pkg?.kovanicaSdk?.repository || "https://github.com/KovanicaDAG/kovanica-sdk"}.git`;
const SIBLING_SDK_DIR = resolve(PLAYGROUND_ROOT, "../kovanica-sdk");
const INSTALLED_SDK_DIR = join(PLAYGROUND_ROOT, "node_modules", "kovanica-sdk");

const cleanEnv = { ...process.env };
delete cleanEnv.npm_config_allow_scripts;
delete cleanEnv.NPM_CONFIG_ALLOW_SCRIPTS;

if (!PINNED_SDK_SHA || !/^[0-9a-f]{40}$/.test(PINNED_SDK_SHA)) {
  console.error("[prepare-sdk] Invalid or missing kovanicaSdk.testedRevision in package.json:", PINNED_SDK_SHA);
  process.exit(1);
}

// 1. If ../kovanica-sdk does not exist at all (clean standalone clone prior to npm ci),
//    clone and build the exact pinned SHA at ../kovanica-sdk.
if (!existsSync(SIBLING_SDK_DIR)) {
  console.log(`[prepare-sdk] Sibling SDK not found at ${SIBLING_SDK_DIR}. Cloning pinned SHA ${PINNED_SDK_SHA}...`);
  execSync(`git clone --no-checkout "${SDK_REPO_URL}" "${SIBLING_SDK_DIR}"`, { stdio: "inherit" });
  execSync(`git -C "${SIBLING_SDK_DIR}" checkout --detach ${PINNED_SDK_SHA}`, { stdio: "inherit" });
  execSync("npm ci", { cwd: SIBLING_SDK_DIR, stdio: "inherit", env: cleanEnv });
  execSync("npm run build", { cwd: SIBLING_SDK_DIR, stdio: "inherit", env: cleanEnv });
}

// 2. Check whether ../kovanica-sdk is currently at PINNED_SDK_SHA and clean
let siblingHead = "";
let siblingClean = false;
try {
  siblingHead = execSync(`git -C "${SIBLING_SDK_DIR}" rev-parse HEAD`, { encoding: "utf8" }).trim();
  const statusOut = execSync(`git -C "${SIBLING_SDK_DIR}" status --porcelain`, { encoding: "utf8" }).trim();
  siblingClean = statusOut.length === 0;
} catch {
  siblingHead = "";
}

if (!existsSync(join(PLAYGROUND_ROOT, "node_modules"))) {
  // Pre-install invocation; sibling exists now so npm ci can proceed
  process.exit(0);
}

// 3. If ../kovanica-sdk is at the exact pinned SHA and clean, ensure its dist/ is built
const markerPath = join(INSTALLED_SDK_DIR, ".tested-revision");
const installedIsSymlink = existsSync(INSTALLED_SDK_DIR) && lstatSync(INSTALLED_SDK_DIR).isSymbolicLink();

if (siblingHead === PINNED_SDK_SHA && siblingClean && installedIsSymlink) {
  const siblingDist = join(SIBLING_SDK_DIR, "dist", "index.js");
  if (!existsSync(siblingDist)) {
    console.log(`[prepare-sdk] Building sibling SDK at pinned SHA ${PINNED_SDK_SHA}...`);
    execSync("npm ci", { cwd: SIBLING_SDK_DIR, stdio: "inherit", env: cleanEnv });
    execSync("npm run build", { cwd: SIBLING_SDK_DIR, stdio: "inherit", env: cleanEnv });
  }
  console.log(`[prepare-sdk] Verified SDK at pinned SHA ${PINNED_SDK_SHA}`);
  process.exit(0);
}

// 4. Otherwise, ../kovanica-sdk is on a different branch/commit or dirty (e.g. moving main or feature branch).
//    Do NOT mutate ../kovanica-sdk. Instead, materialize the exact pinned SHA in an isolated cache
//    and populate node_modules/kovanica-sdk so consumption is strictly immutable.

if (
  !installedIsSymlink &&
  existsSync(join(INSTALLED_SDK_DIR, "dist", "index.js")) &&
  existsSync(join(INSTALLED_SDK_DIR, "node_modules", "@noble", "hashes")) &&
  existsSync(markerPath) &&
  readFileSync(markerPath, "utf8").trim() === PINNED_SDK_SHA
) {
  console.log(`[prepare-sdk] Verified isolated node_modules/kovanica-sdk at pinned SHA ${PINNED_SDK_SHA}`);
  process.exit(0);
}

console.log(
  `[prepare-sdk] Sibling SDK is at ${siblingHead || "unknown"} (expected ${PINNED_SDK_SHA}). Materializing immutable SHA in isolated worktree without modifying sibling checkout...`,
);

const buildCacheDir = join(tmpdir(), `kovanica-sdk-build-${PINNED_SDK_SHA}`);
if (!existsSync(join(buildCacheDir, "dist", "index.js"))) {
  rmSync(buildCacheDir, { recursive: true, force: true });
  mkdirSync(buildCacheDir, { recursive: true });

  const siblingGit = join(SIBLING_SDK_DIR, ".git");
  const refArg = existsSync(siblingGit) ? `--reference-if-able "${siblingGit}" ` : "";
  execSync(`git clone --no-checkout ${refArg}"${SDK_REPO_URL}" "${buildCacheDir}"`, { stdio: "inherit" });
  execSync(`git -C "${buildCacheDir}" checkout --detach ${PINNED_SDK_SHA}`, { stdio: "inherit" });

  const verifiedHead = execSync(`git -C "${buildCacheDir}" rev-parse HEAD`, { encoding: "utf8" }).trim();
  if (verifiedHead !== PINNED_SDK_SHA) {
    console.error(`[prepare-sdk] SHA verification failed: expected ${PINNED_SDK_SHA}, got ${verifiedHead}`);
    process.exit(1);
  }

  execSync("npm ci", { cwd: buildCacheDir, stdio: "inherit", env: cleanEnv });
  execSync("npm run build", { cwd: buildCacheDir, stdio: "inherit", env: cleanEnv });
}

if (installedIsSymlink) {
  unlinkSync(INSTALLED_SDK_DIR);
} else if (existsSync(INSTALLED_SDK_DIR)) {
  rmSync(INSTALLED_SDK_DIR, { recursive: true, force: true });
}

mkdirSync(INSTALLED_SDK_DIR, { recursive: true });
cpSync(join(buildCacheDir, "package.json"), join(INSTALLED_SDK_DIR, "package.json"));
cpSync(join(buildCacheDir, "dist"), join(INSTALLED_SDK_DIR, "dist"), { recursive: true });
if (existsSync(join(buildCacheDir, "node_modules", "@noble"))) {
  mkdirSync(join(INSTALLED_SDK_DIR, "node_modules"), { recursive: true });
  cpSync(join(buildCacheDir, "node_modules", "@noble"), join(INSTALLED_SDK_DIR, "node_modules", "@noble"), {
    recursive: true,
  });
}
if (existsSync(join(buildCacheDir, "README.md"))) {
  cpSync(join(buildCacheDir, "README.md"), join(INSTALLED_SDK_DIR, "README.md"));
}
if (existsSync(join(buildCacheDir, "LICENSE"))) {
  cpSync(join(buildCacheDir, "LICENSE"), join(INSTALLED_SDK_DIR, "LICENSE"));
}
writeFileSync(markerPath, `${PINNED_SDK_SHA}\n`, "utf8");

console.log(`[prepare-sdk] Materialized immutable SDK (${PINNED_SDK_SHA}) into node_modules/kovanica-sdk`);
