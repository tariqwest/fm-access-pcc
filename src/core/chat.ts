import { v4 as uuidv4 } from 'uuid';
import { transportChatCompletion } from './transport.js';
import type { ChatMessage } from './fm-serve.js';
import type { ChatSession, ChatSessionOptions, FmModel } from './types.js';

interface InternalSession {
  model?: FmModel;
  messages: ChatMessage[];
}

const sessions = new Map<string, InternalSession>();

export async function createChatSession(options: ChatSessionOptions = {}): Promise<ChatSession> {
  const id = uuidv4();
  const messages: ChatMessage[] = [];
  if (options.instructions) {
    messages.push({ role: 'system', content: options.instructions });
  }

  sessions.set(id, {
    model: options.model,
    messages,
  });

  return {
    id,
    async send(message: string): Promise<string> {
      const s = sessions.get(id);
      if (!s) throw new Error(`Session ${id} not found`);
      s.messages.push({ role: 'user', content: message });
      const result = await transportChatCompletion({
        model: s.model,
        messages: s.messages,
      });
      s.messages.push({ role: 'assistant', content: result.text });
      return result.text;
    },
    async close(): Promise<void> {
      sessions.delete(id);
    },
  };
}

export function closeChatSession(id: string): boolean {
  return sessions.delete(id);
}

export function getSession(id: string): InternalSession | undefined {
  return sessions.get(id);
}
