import { describe, it, expect, vi, beforeEach } from 'vitest';

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

vi.mock('./lab-bridge.js', () => ({
  labBridgeAvailable: vi.fn(async () => null),
  labBridgeChatCompletion: vi.fn(async () => {
    throw new Error('Lab Agent Bridge descriptor not found at x');
  }),
}));

import { fmServeHealth, fmServeChatCompletion } from './fm-serve.js';
import { transportRespond, buildRespondArgs } from './transport.js';

const health = vi.mocked(fmServeHealth);
const complete = vi.mocked(fmServeChatCompletion);

describe('buildRespondArgs', () => {
  it('builds model flag', () => {
    expect(buildRespondArgs('hi', { model: 'system' })).toEqual(['respond', '--model', 'system', 'hi']);
  });
});

describe('transportRespond', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses fm-serve when healthy', async () => {
    health.mockResolvedValue({ status: 'ok', models: [{ name: 'pcc', available: true }] });
    complete.mockResolvedValue({ text: 'from-serve', backend: 'fm-serve' });
    const r = await transportRespond('ping', { model: 'pcc' });
    expect(r).toEqual({ text: 'from-serve', backend: 'fm-serve' });
    expect(complete).toHaveBeenCalled();
  });

  it('fails closed for pcc without serve', async () => {
    health.mockResolvedValue(null);
    await expect(transportRespond('ping', { model: 'pcc' })).rejects.toThrow(/pcc requires Terminal-hosted/i);
  });
});
