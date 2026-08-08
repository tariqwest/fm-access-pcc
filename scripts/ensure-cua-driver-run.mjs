#!/usr/bin/env node
/**
 * Runtime ensure for cua-driver (used by postinstall wrapper).
 * Compiles/loads TypeScript via dynamic import of built dist if present,
 * otherwise uses a minimal inline installer matching core/cua-driver.ts.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

function resolveCua() {
  const env = process.env;
  for (const key of ['CUA_DRIVER_BIN', 'CUA_DRIVER_PATH']) {
    const v = env[key]?.trim();
    if (v && fs.existsSync(v)) return v;
  }
  const home = env.HOME || os.homedir();
  const candidates = [
    path.join(home, '.local', 'bin', 'cua-driver'),
    '/Applications/CuaDriver.app/Contents/MacOS/cua-driver',
    '/opt/homebrew/bin/cua-driver',
    '/usr/local/bin/cua-driver',
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  // PATH
  for (const dir of (env.PATH || '').split(':')) {
    if (!dir) continue;
    const c = path.join(dir, 'cua-driver');
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function main() {
  if (process.env.FM_ACCESS_PCC_ENSURE_CUA_DRIVER === '0') {
    console.error('[fm-access-pcc] skip cua-driver ensure (FM_ACCESS_PCC_ENSURE_CUA_DRIVER=0)');
    return;
  }
  const existing = resolveCua();
  if (existing) {
    console.error(`[fm-access-pcc] cua-driver present: ${existing}`);
    return;
  }
  if (process.platform !== 'darwin') {
    console.error('[fm-access-pcc] cua-driver auto-install only on macOS');
    process.exitCode = 0;
    return;
  }
  const binDir = process.env.CUA_DRIVER_BIN_DIR || path.join(process.env.HOME || os.homedir(), '.local', 'bin');
  fs.mkdirSync(binDir, { recursive: true, mode: 0o700 });
  const url = process.env.CUA_DRIVER_INSTALL_URL || 'https://cua.ai/driver/install.sh';
  const script = `set -euo pipefail; curl -fsSL ${JSON.stringify(url)} | bash -s -- --bin-dir ${JSON.stringify(binDir)} --no-modify-path`;
  const r = spawnSync('/bin/bash', ['-lc', script], {
    env: { ...process.env, CI: process.env.CI || '1', CUA_DRIVER_NO_MODIFY_PATH: '1' },
    encoding: 'utf8',
  });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  const after = resolveCua();
  if (!after) {
    console.error('[fm-access-pcc] cua-driver install finished but binary not found');
    process.exitCode = 1;
    return;
  }
  console.error(`[fm-access-pcc] installed cua-driver at ${after}`);
}

void require;
main();
