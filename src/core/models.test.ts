import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable, Writable } from 'stream';
import { EventEmitter } from 'events';

vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('./transport.js', () => ({
  transportGetAvailableModels: vi.fn(async () => [
    { model: 'system', available: true, source: 'fm-serve' },
    { model: 'pcc', available: true, source: 'fm-serve' },
  ]),
}));

import { spawn } from 'child_process';
import { getAvailableModels, getAvailableModelsDirect, getQuotaUsage } from './models.js';

const mockSpawn = vi.mocked(spawn);

function createMockProcess(stdoutData: string, exitCode = 0, stderrData = '') {
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const proc = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    stdin: new Writable({ write() {} }),
    pid: 1234,
    killed: false,
    kill: vi.fn(),
  });
  setTimeout(() => {
    if (stdoutData) stdout.push(stdoutData);
    stdout.push(null);
    if (stderrData) stderr.push(stderrData);
    stderr.push(null);
    proc.emit('close', exitCode);
  }, 0);
  return proc as any;
}

describe('getAvailableModels', () => {
  it('uses transport', async () => {
    const models = await getAvailableModels();
    expect(models.some((m) => m.model === 'pcc' && m.available)).toBe(true);
  });
});

describe('getAvailableModelsDirect', () => {
  beforeEach(() => vi.clearAllMocks());

  it('parses fm available output', async () => {
    mockSpawn.mockReturnValue(createMockProcess('system: available\npcc: unavailable\n'));
    const models = await getAvailableModelsDirect();
    expect(models).toEqual([
      { model: 'system', available: true, source: 'fm' },
      { model: 'pcc', available: false, source: 'fm' },
    ]);
  });
});

describe('getQuotaUsage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('parses quota lines', async () => {
    mockSpawn.mockReturnValue(createMockProcess('system: 0\npcc: 10%\n'));
    const q = await getQuotaUsage();
    expect(q[0].model).toBe('system');
    expect(q[1].usage).toContain('10%');
  });
});
