import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./transport.js', () => ({
  transportChatCompletion: vi.fn(async ({ messages }) => {
    const last = messages[messages.length - 1];
    return { text: `echo:${last.content}`, backend: 'fm-serve' };
  }),
}));

import { createChatSession, closeChatSession } from './chat.js';

describe('createChatSession (transport)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('maintains history across turns', async () => {
    const chat = await createChatSession({ model: 'pcc', instructions: 'Be brief' });
    const a = await chat.send('hello');
    expect(a).toBe('echo:hello');
    const b = await chat.send('again');
    expect(b).toBe('echo:again');
    await chat.close();
    expect(closeChatSession(chat.id)).toBe(false);
  });
});
