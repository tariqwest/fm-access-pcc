import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ensurePrivateDir } from './private-fs.js';
import { fmServeHealth } from './fm-serve.js';
import {
  AUTO_SERVE_ENV,
  AUTO_SERVE_TIMEOUT_ENV,
  defaultFmServeSocket,
  defaultServeLauncherPath,
  readEnvBoolDefaultTrue,
  readEnvInt,
  resolveFmBin,
  SERVE_SOCK_ENV,
} from './config.js';

export type ServeBootstrapResult =
  | { status: 'already_running'; socketPath: string }
  | { status: 'started'; socketPath: string; method: 'applescript' | 'open-terminal' }
  | { status: 'declined'; reason: string }
  | { status: 'failed'; reason: string };

export type ServeBootstrapOptions = {
  auto?: boolean | null;
  socketPath?: string;
  launcherPath?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  spawnFn?: typeof spawn;
  healthFn?: typeof fmServeHealth;
};

export function buildServeLauncherScript(socketPath: string, fmBin = '/usr/bin/fm'): string {
  const sock = socketPath.replace(/'/g, `'\"'\"'`);
  const bin = fmBin.replace(/'/g, `'\"'\"'`);
  return [
    '#!/bin/zsh',
    'set -euo pipefail',
    `SOCK='${sock}'`,
    `BIN='${bin}'`,
    'mkdir -p "$(dirname "$SOCK")"',
    'exec "$BIN" serve --socket "$SOCK"',
    '',
  ].join('\n');
}

export async function ensureServeLauncher(opts: {
  socketPath: string;
  launcherPath: string;
  fmBin?: string;
}): Promise<string> {
  await ensurePrivateDir(path.dirname(opts.launcherPath));
  const body = buildServeLauncherScript(opts.socketPath, opts.fmBin ?? '/usr/bin/fm');
  let existing: string | null = null;
  try {
    existing = await fsp.readFile(opts.launcherPath, 'utf8');
  } catch {
    existing = null;
  }
  if (existing !== body) {
    await fsp.writeFile(opts.launcherPath, body, { mode: 0o700 });
  }
  try {
    await fsp.chmod(opts.launcherPath, 0o700);
  } catch {
    // ignore
  }
  return opts.launcherPath;
}

export function buildAppleScriptLaunchArgs(launcherPath: string): string[] {
  return [
    '-e', 'on run argv',
    '-e', 'tell application "Terminal" to do script (quoted form of (item 1 of argv))',
    '-e', 'end run', launcherPath,
  ];
}

function runLauncher(spawner: typeof spawn, command: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawner(command, args, { env, stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (err) {
      resolve((err as Error).message);
      return;
    }
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    let finished = false;
    const timer = setTimeout(() => {
      child.kill();
      finish('launch timed out');
    }, Math.max(1, timeoutMs));
    function finish(error: string | null) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(error);
    }
    child.on('error', (error) => finish(error.message));
    child.on('close', (code) => finish(code === 0 ? null : stderr.trim() || `exit code ${code}`));
  });
}

export async function waitForFmServe(
  socketPath: string,
  timeoutMs: number,
  healthFn: typeof fmServeHealth = fmServeHealth,
  signal?: AbortSignal,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (signal?.aborted) return false;
    const h = await healthFn(socketPath, signal);
    if (h) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return Boolean(await healthFn(socketPath, signal));
}

const inFlight = new Map<string, Promise<ServeBootstrapResult>>();

/** Ensure Terminal-hosted `fm serve --socket` is reachable. */
export function ensureFmServe(opts: ServeBootstrapOptions = {}): Promise<ServeBootstrapResult> {
  const socketPath = opts.socketPath ?? defaultFmServeSocket(opts.env ?? process.env);
  const existing = inFlight.get(socketPath);
  if (existing) return existing;
  const task = startFmServe(opts, socketPath);
  inFlight.set(socketPath, task);
  void task.finally(() => { if (inFlight.get(socketPath) === task) inFlight.delete(socketPath); }).catch(() => {});
  return task;
}

async function startFmServe(opts: ServeBootstrapOptions, socketPath: string): Promise<ServeBootstrapResult> {
  const env = opts.env ?? process.env;
  const launcherPath = opts.launcherPath ?? defaultServeLauncherPath(env);
  const timeoutMs = opts.timeoutMs ?? readEnvInt(env, AUTO_SERVE_TIMEOUT_ENV, 12_000);
  const healthFn = opts.healthFn ?? fmServeHealth;
  const spawner = opts.spawnFn ?? spawn;

  if (await healthFn(socketPath)) {
    return { status: 'already_running', socketPath };
  }

  const auto = opts.auto ?? readEnvBoolDefaultTrue(env, AUTO_SERVE_ENV);
  if (!auto) {
    return {
      status: 'declined',
      reason:
        `fm serve not running at ${socketPath}; start it in Terminal.app, or leave ${AUTO_SERVE_ENV} enabled ` +
        `(default) to auto-launch Terminal`,
    };
  }

  const fmBin =
    resolveFmBin(env) ||
    (existsSync('/usr/bin/fm') ? '/usr/bin/fm' : 'fm');

  try {
    await ensureServeLauncher({ socketPath, launcherPath, fmBin });
  } catch (err) {
    return {
      status: 'failed',
      reason: `failed to write serve launcher: ${(err as Error).message}`,
    };
  }

  const errors: string[] = [];
  const methods = [
    { method: 'applescript' as const, label: 'AppleScript', command: '/usr/bin/osascript', args: buildAppleScriptLaunchArgs(launcherPath) },
    { method: 'open-terminal' as const, label: 'open -a Terminal', command: '/usr/bin/open', args: ['-a', 'Terminal', launcherPath] },
  ];
  for (const item of methods) {
    if (errors.length && await healthFn(socketPath)) {
      return { status: 'started', socketPath, method: 'applescript' };
    }
    const error = await runLauncher(spawner, item.command, item.args, env, timeoutMs);
    if (error) {
      errors.push(`${item.label}: ${error}`);
      continue;
    }
    if (await waitForFmServe(socketPath, timeoutMs, healthFn)) {
      return { status: 'started', socketPath, method: item.method };
    }
    errors.push(`${item.label}: socket not healthy within ${timeoutMs}ms`);
  }

  return {
    status: 'failed',
    reason: `${errors.join(' | ')}. Start fm serve manually in Terminal using ${SERVE_SOCK_ENV}=${socketPath}`,
  };
}
