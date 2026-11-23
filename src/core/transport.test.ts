import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./serve-bootstrap.js', () => ({
  ensureFmServe: vi.fn(async () => ({ status: 'declined', reason: 'off' })),
}));

vi.mock('./fm-serve.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./fm-serve.js')>();
  return {
    ...actual,
    fmServeHealth: vi.fn(),
    fmServeChatCompletion: vi.fn(),
    fmServeAvailable: vi.fn(),
  };
});

import {
  fmServeAvailable,
  fmServeChatCompletion,
  fmServeHealth,
} from './fm-serve.js';
import { ensureFmServe } from './serve-bootstrap.js';
import {
  transportGetAvailableModels,
  transportRespond,
} from './transport.js';

const ensureServe = vi.mocked(ensureFmServe);
const health = vi.mocked(fmServeHealth);
const complete = vi.mocked(fmServeChatCompletion);
const available = vi.mocked(fmServeAvailable);

beforeEach(() => {
  vi.clearAllMocks();
  ensureServe.mockResolvedValue({ status: 'declined', reason: 'off' });
  health.mockResolvedValue(null);
  available.mockResolvedValue(null);
});

describe('transportRespond', () => {
  it('uses fm-serve and forwards instructions and history', async () => {
    health.mockResolvedValue({ status: 'ok', models: [{ name: 'pcc', available: true }] });
    complete.mockResolvedValue({ text: 'from-serve', backend: 'fm-serve' });

    const result = await transportRespond('ping', {
      model: 'pcc',
      instructions: 'Be concise',
      history: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply' },
      ],
    });

    expect(result).toEqual({ text: 'from-serve', backend: 'fm-serve' });
    expect(complete).toHaveBeenCalledWith(
      expect.any(String),
      {
        model: 'pcc',
        messages: [
          { role: 'system', content: 'Be concise' },
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'reply' },
          { role: 'user', content: 'ping' },
        ],
        stream: false,
        signal: undefined,
      },
    );
  });

  it('rechecks serve after a successful bootstrap', async () => {
    health
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ status: 'ok', models: [{ name: 'pcc', available: true }] });
    ensureServe.mockResolvedValue({
      status: 'started',
      socketPath: '/tmp/fm-access-pcc.sock',
      method: 'applescript',
    });
    complete.mockResolvedValue({ text: 'started', backend: 'fm-serve' });

    await expect(transportRespond('ping')).resolves.toEqual({
      text: 'started',
      backend: 'fm-serve',
    });
    expect(ensureServe).toHaveBeenCalledWith({ socketPath: expect.any(String) });
    expect(health).toHaveBeenCalledTimes(2);
  });

  it.each(['system', 'pcc'] as const)('fails explicitly for %s when fm serve is unavailable', async (model) => {
    await expect(transportRespond('ping', { model })).rejects.toThrow(
      'Terminal-hosted fm serve is not reachable',
    );
  });

  it('propagates buffered serve completion errors', async () => {
    health.mockResolvedValue({ status: 'ok', models: [{ name: 'system', available: true }] });
    complete.mockRejectedValue(new Error('serve failed'));

    await expect(transportRespond('ping', { model: 'system' })).rejects.toThrow('serve failed');
  });

  it('propagates cancellation', async () => {
    const controller = new AbortController();
    health.mockResolvedValue({ status: 'ok', models: [{ name: 'system', available: true }] });
    complete.mockImplementation(async () => {
      controller.abort();
      throw new Error('cancelled');
    });

    await expect(transportRespond('ping', {
      model: 'system',
      signal: controller.signal,
    })).rejects.toThrow('cancelled');
  });

  it('uses only fm-serve for streaming', async () => {
    health.mockResolvedValue({ status: 'ok', models: [{ name: 'system', available: true }] });
    complete.mockImplementation(async (_socket, options) => {
      await options.onText?.('one');
      await options.onText?.('two');
      return { text: 'onetwo', backend: 'fm-serve' };
    });

    const chunks: string[] = [];
    for await (const chunk of transportRespond('ping', { model: 'system', stream: true })) {
      chunks.push(chunk.text);
    }

    expect(chunks).toEqual(['one', 'two']);
  });

  it('requires fm-serve for streaming', async () => {
    const stream = transportRespond('ping', { model: 'pcc', stream: true });
    await expect(stream[Symbol.asyncIterator]().next()).rejects.toThrow(
      'Streaming requires Terminal-hosted fm serve',
    );
  });

  it('propagates streaming completion errors', async () => {
    health.mockResolvedValue({ status: 'ok', models: [{ name: 'system', available: true }] });
    complete.mockImplementation(async (_socket, options) => {
      await options.onText?.('partial');
      throw new Error('stream failed');
    });

    const iterator = transportRespond('ping', { model: 'system', stream: true })[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { text: 'partial', backend: 'fm-serve' },
    });
    await expect(iterator.next()).rejects.toThrow('stream failed');
  });
});

describe('transportGetAvailableModels', () => {
  it('prefers fm-serve and filters by model', async () => {
    health.mockResolvedValue({ status: 'ok', models: [] });
    available.mockResolvedValue([
      { model: 'system', available: true, source: 'fm-serve' },
      { model: 'pcc', available: false, reason: 'unavailable', source: 'fm-serve' },
    ]);

    await expect(transportGetAvailableModels('pcc')).resolves.toEqual([
      {
        model: 'pcc',
        available: false,
        reason: 'unavailable',
        source: 'fm-serve',
      },
    ]);
  });

  it('reports both models unavailable when fm serve is unavailable', async () => {
    await expect(transportGetAvailableModels()).resolves.toEqual([
      {
        model: 'system',
        available: false,
        reason: 'Terminal-hosted fm serve is not available',
        source: 'none',
      },
      {
        model: 'pcc',
        available: false,
        reason: 'Terminal-hosted fm serve is not available',
        source: 'none',
      },
    ]);
  });
});
