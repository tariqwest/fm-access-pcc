#!/usr/bin/env node
/**
 * Best-effort cua-driver ensure for install.
 * Never fails the package install (network / non-darwin / offline).
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function main() {
  if (process.env.FM_ACCESS_PCC_SKIP_CUA_DRIVER_POSTINSTALL === '1') {
    console.error('[fm-access-pcc] skip cua-driver postinstall (FM_ACCESS_PCC_SKIP_CUA_DRIVER_POSTINSTALL=1)');
    return;
  }
  if (process.platform !== 'darwin') {
    console.error('[fm-access-pcc] skip cua-driver postinstall on non-darwin');
    return;
  }

  const entry = path.join(root, 'scripts', 'ensure-cua-driver-run.mjs');
  const result = spawnSync(process.execPath, [entry], {
    cwd: root,
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.stdout?.trim()) process.stdout.write(result.stdout);
  if (result.stderr?.trim()) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    console.error(
      `[fm-access-pcc] cua-driver ensure exited ${result.status ?? 'null'} (non-fatal). Install manually: curl -fsSL https://cua.ai/driver/install.sh | bash`,
    );
  }
}

main();
