#!/usr/bin/env node
// Tarball smoke test for @run402/nwc: the packed package installs in a clean
// consumer, its entry point imports, a NIP-44 round trip works, and the
// tarball carries the built code only.

import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = resolve(__dirname, "..");
const SCRATCH = mkdtempSync(join(tmpdir(), "run402-nwc-smoke-"));

function run(cmd, opts = {}) {
  return execSync(cmd, { stdio: "pipe", encoding: "utf-8", ...opts });
}

function step(label, fn) {
  process.stdout.write(`${label} ... `);
  try {
    const out = fn();
    process.stdout.write("OK\n");
    return out;
  } catch (err) {
    process.stdout.write("FAIL\n");
    console.error(err.stdout?.toString() ?? "");
    console.error(err.stderr?.toString() ?? "");
    console.error(err.message);
    process.exit(1);
  }
}

try {
  let tarball;
  step("npm run build", () => {
    run("npm run build", { cwd: PACKAGE_DIR });
  });
  step("npm pack", () => {
    run(`npm pack --pack-destination "${SCRATCH}"`, { cwd: PACKAGE_DIR });
    const tgz = readdirSync(SCRATCH).find((file) => file.endsWith(".tgz"));
    if (!tgz) throw new Error("npm pack produced no tarball");
    tarball = join(SCRATCH, tgz);
  });

  const installDir = join(SCRATCH, "install");
  mkdirSync(installDir);
  step("install tarball in clean consumer", () => {
    run("npm init -y", { cwd: installDir });
    run(`npm install --before=9999-12-31 "${tarball}"`, { cwd: installDir });
  });

  step("import public entrypoint", () => {
    const result = run(
      `node --input-type=module -e "import { parseNwcUri, nip44ConversationKey, nip44Encrypt, nip44Decrypt, createNwcRelayPool, nwcRequest, closeNwcConnections, NwcError, NWC_TRANSPORT_ERROR_CODES } from '@run402/nwc'; const c = parseNwcUri('nostr+walletconnect://' + 'f7914d8f701d8788fd1d74b53141ecad6e0a69ab38730677da094ee5a824b5a0' + '?relay=wss://relay.test&secret=' + '01'.padStart(64, '0')); if (c.clientPubkey !== '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798') process.exit(1); const k = nip44ConversationKey(c.secretHex, c.walletPubkey); if (nip44Decrypt(k, nip44Encrypt(k, 'smoke')) !== 'smoke') process.exit(1); if (typeof createNwcRelayPool().transport !== 'function' || typeof nwcRequest !== 'function') process.exit(1); closeNwcConnections(); if (!NWC_TRANSPORT_ERROR_CODES.has('RELAY_TIMEOUT') || new NwcError('X', 'y').code !== 'X') process.exit(1); console.log('nwc smoke OK');"`,
      { cwd: installDir },
    );
    if (!result.includes("nwc smoke OK")) {
      throw new Error(`unexpected smoke output: ${result}`);
    }
  });

  step("tarball carries the built code only", () => {
    const listing = run(`tar -tzf "${tarball}"`);
    const required = ["package/dist/index.js", "package/dist/index.d.ts", "package/LICENSE", "package/README.md"];
    const missing = required.filter((needle) => !listing.includes(needle));
    if (missing.length > 0) {
      throw new Error(`missing tarball entries: ${missing.join(", ")}`);
    }
    const forbidden = [".test.", "package/src/", "run402-" + "private", "packages/" + "gateway", ".env"];
    const found = forbidden.filter((needle) => listing.includes(needle));
    if (found.length > 0) {
      throw new Error(`forbidden tarball entries: ${found.join(", ")}`);
    }
  });

  console.log("All @run402/nwc smoke checks passed");
} finally {
  rmSync(SCRATCH, { recursive: true, force: true });
}
