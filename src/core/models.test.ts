import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('./transport.js', () => ({
  transportGetAvailableModels: vi.fn(),
}));

import { spawn } from 'node:child_process';
import { getAvailableModels, getQuotaUsage } from './models.js';
import { transportGetAvailableModels } from './transport.js';

const mockSpawn = vi.mocked(spawn);
const mockTransportGetAvailableModels = vi.mocked(transportGetAvailableModels);

function mockProcess(stdout: string, stderr = '', code = 0) {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  mockSpawn.mockReturnValue(proc as never);
  queueMicrotask(() => {
    if (stdout) proc.stdout.emit('data', Buffer.from(stdout));
    if (stderr) proc.stderr.emit('data', Buffer.from(stderr));
    proc.emit('close', code);
  });
}

describe('getAvailableModels', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('delegates discovery to the serve transport', async () => {
    const expected = [
      { model: 'system' as const, available: true, source: 'fm-serve' as const },
      { model: 'pcc' as const, available: false, source: 'none' as const },
    ];
    mockTransportGetAvailableModels.mockResolvedValue(expected);

    await expect(getAvailableModels()).resolves.toEqual(expected);
    expect(mockTransportGetAvailableModels).toHaveBeenCalledWith(undefined);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('forwards model filtering', async () => {
    mockTransportGetAvailableModels.mockResolvedValue([
      { model: 'pcc', available: true, source: 'fm-serve' },
    ]);

    await expect(getAvailableModels('pcc')).resolves.toEqual([
      { model: 'pcc', available: true, source: 'fm-serve' },
    ]);
    expect(mockTransportGetAvailableModels).toHaveBeenCalledWith('pcc');
  });
});

describe('getQuotaUsage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('parses quota output from the standalone CLI', async () => {
    mockProcess('System: Not applicable (on-device model)\nPCC: 10%');

    await expect(getQuotaUsage()).resolves.toEqual([
      { model: 'system', usage: 'Not applicable (on-device model)' },
      { model: 'pcc', usage: '10%' },
    ]);
    expect(mockSpawn).toHaveBeenCalledWith(
      '/usr/bin/fm',
      ['quota-usage'],
    );
  });

  it('adds a model filter to quota-usage', async () => {
    mockProcess('PCC: 10%');

    await expect(getQuotaUsage('pcc')).resolves.toEqual([
      { model: 'pcc', usage: '10%' },
    ]);
    expect(mockSpawn).toHaveBeenCalledWith(
      '/usr/bin/fm',
      ['quota-usage', '--model', 'pcc'],
    );
  });

  it('rejects when quota-usage fails', async () => {
    mockProcess('', 'quota unavailable', 1);
    await expect(getQuotaUsage()).rejects.toThrow('quota unavailable');
  });
});
