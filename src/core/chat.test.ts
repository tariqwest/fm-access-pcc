import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./transport.js', () => ({
  transportChatCompletion: vi.fn(),
}));

import { closeChatSession, createChatSession, getSession } from './chat.js';
import { transportChatCompletion } from './transport.js';

const complete = vi.mocked(transportChatCompletion);

describe('createChatSession', () => {
  beforeEach(() => {
    complete.mockReset();
  });

  it('keeps multi-turn history through the transport', async () => {
    const calls: Parameters<typeof transportChatCompletion>[0][] = [];
    complete.mockImplementation(async (options) => {
      calls.push({ ...options, messages: options.messages.map((entry) => ({ ...entry })) });
      return { text: `echo:${options.messages.at(-1)?.content ?? ''}`, backend: 'fm-serve' };
    });
    const session = await createChatSession({ model: 'pcc', instructions: 'Be concise' });

    await expect(session.send('hello')).resolves.toBe('echo:hello');
    await expect(session.send('again')).resolves.toBe('echo:again');

    expect(calls).toEqual([
      {
        model: 'pcc',
        messages: [
          { role: 'system', content: 'Be concise' },
          { role: 'user', content: 'hello' },
        ],
      },
      {
        model: 'pcc',
        messages: [
          { role: 'system', content: 'Be concise' },
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'echo:hello' },
          { role: 'user', content: 'again' },
        ],
      },
    ]);
    await session.close();
  });

  it('removes a session through close()', async () => {
    const session = await createChatSession();
    expect(getSession(session.id)).toBeDefined();

    await session.close();
    expect(getSession(session.id)).toBeUndefined();
  });

  it('reports whether closeChatSession removed a session', async () => {
    const session = await createChatSession();

    expect(closeChatSession(session.id)).toBe(true);
    expect(closeChatSession(session.id)).toBe(false);
    await expect(session.send('hello')).rejects.toThrow(`Session ${session.id} not found`);
    expect(complete).not.toHaveBeenCalled();
  });

  it('propagates transport errors', async () => {
    complete.mockRejectedValue(new Error('No Foundation Models transport is available'));
    const session = await createChatSession({ model: 'system' });

    await expect(session.send('hello')).rejects.toThrow('No Foundation Models transport is available');
    await session.close();
  });
});
