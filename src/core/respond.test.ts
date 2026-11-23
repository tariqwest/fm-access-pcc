import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./transport.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./transport.js')>();
  return {
    ...actual,
    transportRespond: vi.fn((prompt: string, opts: { stream?: boolean } = {}) => {
      if (opts.stream) {
        return (async function* () {
          yield { text: 'chunk1', backend: 'fm-serve' as const };
          yield { text: 'chunk2', backend: 'fm-serve' as const };
        })();
      }
      return (async () => {
        if (prompt === 'fail') throw new Error('model unavailable');
        return { text: 'Swift is a language', backend: 'fm-serve' as const };
      })();
    }),
  };
});

import { respond } from './respond.js';
import { transportRespond } from './transport.js';

const mockTransport = vi.mocked(transportRespond);

describe('respond', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('delegates buffered requests to the transport', async () => {
    const result = await respond('What is Swift?', {
      model: 'system',
      instructions: 'Be concise',
    });

    expect(result).toEqual({ text: 'Swift is a language', backend: 'fm-serve' });
    expect(mockTransport).toHaveBeenCalledWith('What is Swift?', {
      model: 'system',
      instructions: 'Be concise',
    });
  });

  it('rejects on transport error', async () => {
    await expect(respond('fail')).rejects.toThrow('model unavailable');
  });

  it('returns an async iterable for streaming requests', async () => {
    const chunks: string[] = [];
    for await (const chunk of respond('Stream this', { stream: true })) {
      chunks.push(chunk.text);
    }

    expect(chunks).toEqual(['chunk1', 'chunk2']);
  });
});
