import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildAppleScriptLaunchArgs, buildServeLauncherScript, ensureFmServe } from './serve-bootstrap.js';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const healthy = { status: 'ok' as const, models: [] };
async function options() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fm-bootstrap-test-'));
  dirs.push(dir);
  return { socketPath: path.join(dir, 'fm.sock'), launcherPath: path.join(dir, 'start.command'), timeoutMs: 10 };
}
function mockSpawn(results: Array<{ code?: number; error?: string; stderr?: string; hang?: boolean }>) {
  return vi.fn((_cmd: string, _args: string[]) => {
    const result = results.shift() ?? {};
    const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter; kill: () => boolean };
    child.stderr = new EventEmitter();
    child.kill = () => true;
    if (!result.hang) queueMicrotask(() => {
      if (result.stderr) child.stderr.emit('data', Buffer.from(result.stderr));
      if (result.error) child.emit('error', new Error(result.error));
      else child.emit('close', result.code ?? 0);
    });
    return child;
  });
}

describe('Terminal bootstrap', () => {
  it('quotes shell paths and passes the AppleScript path as a separate argument', () => {
    expect(buildServeLauncherScript("/tmp/a'b.sock")).toContain("'\"'\"'");
    const unsafe = "/tmp/a 'quoted';$(touch nope).command";
    const args = buildAppleScriptLaunchArgs(unsafe);
    expect(args.at(-1)).toBe(unsafe);
    expect(args.slice(0, -1).join(' ')).toContain('quoted form of (item 1 of argv)');
    expect(args.slice(0, -1).join(' ')).not.toContain(unsafe);
  });
  it('returns already running or declined without launching', async () => {
    const opts = await options();
    expect((await ensureFmServe({ ...opts, healthFn: async () => healthy })).status).toBe('already_running');
    expect((await ensureFmServe({ ...opts, auto: false, healthFn: async () => null })).status).toBe('declined');
  });
  it('launches AppleScript and coalesces concurrent calls', async () => {
    const opts = await options();
    const spawnFn = mockSpawn([{}]);
    const healthFn = vi.fn().mockResolvedValueOnce(null).mockResolvedValue(healthy);
    const args = { ...opts, spawnFn: spawnFn as unknown as typeof spawn, healthFn };
    const [a, b] = await Promise.all([ensureFmServe(args), ensureFmServe(args)]);
    expect(a).toEqual({ status: 'started', socketPath: opts.socketPath, method: 'applescript' });
    expect(b).toEqual(a);
    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(spawnFn.mock.calls[0][0]).toBe('/usr/bin/osascript');
  });
  it('falls back after denied Automation permission', async () => {
    const opts = await options();
    const spawnFn = mockSpawn([{ code: 1, stderr: 'Not authorized to send Apple events (-1743)' }, {}]);
    const healthFn = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValue(healthy);
    const result = await ensureFmServe({ ...opts, spawnFn: spawnFn as unknown as typeof spawn, healthFn });
    expect(result).toEqual({ status: 'started', socketPath: opts.socketPath, method: 'open-terminal' });
    expect(spawnFn.mock.calls[1][0]).toBe('/usr/bin/open');
  });
  it('reports both subprocess errors', async () => {
    const opts = await options();
    const spawnFn = mockSpawn([{ error: 'spawn failed' }, { code: 1, stderr: 'open failed' }]);
    const result = await ensureFmServe({ ...opts, spawnFn: spawnFn as unknown as typeof spawn, healthFn: async () => null });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.reason).toMatch(/spawn failed.*open failed/);
  });
  it('times out hung launchers and reports failure', async () => {
    const opts = await options();
    const spawnFn = mockSpawn([{ hang: true }, { hang: true }]);
    const result = await ensureFmServe({ ...opts, spawnFn: spawnFn as unknown as typeof spawn, healthFn: async () => null });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.reason).toContain('launch timed out');
    expect(spawnFn).toHaveBeenCalledTimes(2);
  });
  it('falls back when AppleScript exits successfully but health never appears', async () => {
    const opts = await options();
    const spawnFn = mockSpawn([{}, {}]);
    const result = await ensureFmServe({ ...opts, spawnFn: spawnFn as unknown as typeof spawn, healthFn: async () => null });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.reason).toContain('socket not healthy');
    expect(spawnFn).toHaveBeenCalledTimes(2);
  });
});
