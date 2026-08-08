import { describe, it, expect } from 'vitest';
import { parseChatCompletionSse } from './fm-serve.js';

describe('parseChatCompletionSse', () => {
  it('concatenates delta content', () => {
    const raw = [
      'data: {"choices":[{"delta":{"content":"Hel"}}]}',
      '',
      'data: {"choices":[{"delta":{"content":"lo"}}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    expect(parseChatCompletionSse(raw)).toBe('Hello');
  });

  it('ignores malformed chunks', () => {
    const raw = 'data: not-json\n\ndata: {"choices":[{"delta":{"content":"x"}}]}\n\n';
    expect(parseChatCompletionSse(raw)).toBe('x');
  });
});
