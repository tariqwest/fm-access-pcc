import { v4 as uuidv4 } from 'uuid';
import { transportChatCompletion } from './transport.js';
import type { ChatMessage } from './fm-serve.js';
import type { ChatSession, ChatSessionOptions, FmModel } from './types.js';

interface InternalSession {
  model?: FmModel;
  instructions?: string;
  usePty: boolean;
  messages: ChatMessage[];
  pty?: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    proc: any;
    pendingResolve: ((output: string) => void) | null;
    buffer: string;
  };
}

const sessions = new Map<string, InternalSession>();

export async function createChatSession(options: ChatSessionOptions = {}): Promise<ChatSession> {
  const id = uuidv4();
  const usePty = options.transport === 'pty-chat';

  if (usePty) {
    return createPtyChatSession(id, options);
  }

  const messages: ChatMessage[] = [];
  if (options.instructions) {
    messages.push({ role: 'system', content: options.instructions });
  }

  sessions.set(id, {
    model: options.model,
    instructions: options.instructions,
    usePty: false,
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

async function createPtyChatSession(
  id: string,
  options: ChatSessionOptions,
): Promise<ChatSession> {
  const pty = await import('node-pty');
  const PROMPT_PATTERN = />>>|User:/;
  const BOOT_TIMEOUT_MS = 2000;

  const args: string[] = ['chat'];
  if (options.model) args.push('--model', options.model);
  if (options.instructions) args.push('--instructions', options.instructions);
  if (options.resume) args.push('--resume', options.resume);

  const ptyProcess = pty.spawn('fm', args, {
    name: 'xterm-color',
    cols: 80,
    rows: 24,
    cwd: process.env.HOME,
    env: process.env as Record<string, string>,
  });

  const internal: InternalSession = {
    model: options.model,
    instructions: options.instructions,
    usePty: true,
    messages: [],
    pty: {
      proc: ptyProcess,
      pendingResolve: null,
      buffer: '',
    },
  };
  sessions.set(id, internal);

  ptyProcess.onData((data: string) => {
    const p = internal.pty!;
    p.buffer += data;
    if (p.pendingResolve && PROMPT_PATTERN.test(p.buffer)) {
      const resolve = p.pendingResolve;
      p.pendingResolve = null;
      const output = p.buffer;
      p.buffer = '';
      resolve(output);
    }
  });

  await new Promise<string>((resolve) => {
    internal.pty!.pendingResolve = resolve;
    setTimeout(() => {
      if (internal.pty?.pendingResolve) {
        internal.pty.pendingResolve = null;
        internal.pty.buffer = '';
        resolve('');
      }
    }, BOOT_TIMEOUT_MS);
  });

  return {
    id,
    async send(message: string): Promise<string> {
      const s = sessions.get(id);
      if (!s?.pty) throw new Error(`Session ${id} not found`);
      const responsePromise = new Promise<string>((resolve) => {
        s.pty!.pendingResolve = resolve;
      });
      s.pty.proc.write(`${message}\n`);
      const rawOutput = await responsePromise;
      return rawOutput
        .replace(message, '')
        .replace(/>>>/g, '')
        .replace(/User:/g, '')
        .trim();
    },
    async close(): Promise<void> {
      const s = sessions.get(id);
      if (s?.pty) {
        s.pty.proc.kill();
        sessions.delete(id);
      }
    },
  };
}

export function closeChatSession(id: string): boolean {
  const s = sessions.get(id);
  if (!s) return false;
  if (s.pty) {
    try {
      s.pty.proc.kill();
    } catch {
      // ignore
    }
  }
  sessions.delete(id);
  return true;
}

export function getSession(id: string): InternalSession | undefined {
  return sessions.get(id);
}
