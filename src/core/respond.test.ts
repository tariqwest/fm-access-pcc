import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./transport.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./transport.js')>();
  return {
    ...actual,
    transportRespond: vi.fn((prompt: string, opts: any = {}) => {
      if (opts?.stream) {
        return (async function* () {
          yield { text: 'chunk1', backend: 'fm' };
          yield { text: 'chunk2', backend: 'fm' };
        })();
      }
      return (async () => {
        if (prompt === 'fail') throw new Error('Error: model unavailable');
        return { text: 'Swift is a language', backend: 'fm' };
      })();
    }),
  };
});

import { respond, buildRespondArgs } from './respond.js';
import { transportRespond } from './transport.js';

const mockTransport = vi.mocked(transportRespond);

describe('buildRespondArgs', () => {
  it('builds minimal args', () => {
    expect(buildRespondArgs('Hello', {})).toEqual(['respond', 'Hello']);
  });

  it('adds --model flag', () => {
    const args = buildRespondArgs('Hello', { model: 'pcc' });
    expect(args).toContain('--model');
    expect(args).toContain('pcc');
  });

  it('adds --resume', () => {
    const args = buildRespondArgs('Hello', { transcript: '/tmp/t.json' });
    expect(args).toContain('--resume');
  });
});

describe('respond', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('delegates to transport', async () => {
    const result = await respond('What is Swift?');
    expect(result.text).toBe('Swift is a language');
    expect(mockTransport).toHaveBeenCalled();
  });

  it('rejects on transport error', async () => {
    await expect(respond('fail')).rejects.toThrow('Error: model unavailable');
  });

  it('streams via transport', async () => {
    const chunks: string[] = [];
    for await (const c of respond('Hello', { stream: true })) {
      chunks.push(c.text);
    }
    expect(chunks).toEqual(['chunk1', 'chunk2']);
  });
});
