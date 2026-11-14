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

  it('parses fm models output', async () => {
    mockSpawn.mockReturnValue(createMockProcess('  Apple Foundation Models\n  ✓ system (AFM 3 Core)\n  ✗ pcc (Private Cloud Compute is not available in this context.)\n', 1));
    const models = await getAvailableModelsDirect();
    expect(models).toEqual([
      { model: 'system', available: true, source: 'fm' },
      { model: 'pcc', available: false, source: 'fm' },
    ]);
  });
});

describe('local model filtering', () => {
  it('does not pass unsupported --model to fm models', async () => {
    mockSpawn.mockReturnValue(createMockProcess('  ✓ system (AFM 3 Core)\n  ✗ pcc\n'));
    expect(await getAvailableModelsDirect('system')).toEqual([
      { model: 'system', available: true, source: 'fm' },
    ]);
    expect(mockSpawn).toHaveBeenLastCalledWith(expect.any(String), ['models']);
  });
});

describe('getQuotaUsage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('parses quota lines', async () => {
    mockSpawn.mockReturnValue(createMockProcess('System: Not applicable (quota only applies to PCC)\nPCC: 10%\n'));
    const q = await getQuotaUsage();
    expect(q[0].model).toBe('system');
    expect(q[1].usage).toContain('10%');
  });
});
