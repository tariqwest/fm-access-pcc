import { defaultFmServeSocket, SERVE_SOCK_ENV } from './config.js';
import { fmServeAvailable, fmServeChatCompletion, fmServeHealth, type ChatMessage } from './fm-serve.js';
import { ensureFmServe } from './serve-bootstrap.js';
import type { FmModel, ModelAvailability, RespondOptions, RespondResult } from './types.js';

export type TransportBackend = 'fm-serve';

export type TransportRespondResult = RespondResult & { backend: TransportBackend };

function optionsToMessages(prompt: string, opts: RespondOptions): ChatMessage[] {
  const messages: ChatMessage[] = [];
  if (opts.instructions) messages.push({ role: 'system', content: opts.instructions });
  if (opts.history) {
    for (const entry of opts.history) {
      messages.push({ role: entry.role, content: entry.content });
    }
  }
  messages.push({ role: 'user', content: prompt });
  return messages;
}

async function ensureServeSocket(signal?: AbortSignal): Promise<string | null> {
  const socketPath = defaultFmServeSocket();
  let health = await fmServeHealth(socketPath, signal);
  if (health) return socketPath;

  const bootstrap = await ensureFmServe({ socketPath });
  if (bootstrap.status === 'started') {
    console.error(
      `[fm-access-pcc] auto-started fm serve via ${bootstrap.method} at ${bootstrap.socketPath}`,
    );
  } else if (bootstrap.status === 'failed') {
    console.error(`[fm-access-pcc] fm serve auto-start failed: ${bootstrap.reason}`);
  }

  health = await fmServeHealth(socketPath, signal);
  return health ? socketPath : null;
}

async function completeBuffered(
  model: FmModel,
  messages: ChatMessage[],
  signal?: AbortSignal,
): Promise<TransportRespondResult> {
  const socketPath = await ensureServeSocket(signal);
  if (!socketPath) {
    throw new Error(
      `Terminal-hosted fm serve is not reachable (set ${SERVE_SOCK_ENV} or enable auto-serve).`,
    );
  }

  const result = await fmServeChatCompletion(socketPath, {
    model,
    messages,
    stream: false,
    signal,
  });
  return { text: result.text, backend: 'fm-serve' };
}

/** Generate a single response through Terminal-hosted fm serve. */
export function transportRespond(
  prompt: string,
  options?: RespondOptions & { stream: true },
): AsyncIterable<RespondResult>;
export function transportRespond(
  prompt: string,
  options?: RespondOptions,
): Promise<TransportRespondResult>;
export function transportRespond(
  prompt: string,
  options: RespondOptions = {},
): Promise<TransportRespondResult> | AsyncIterable<RespondResult> {
  if (options.stream) return transportRespondStream(prompt, options);
  return completeBuffered(options.model ?? 'pcc', optionsToMessages(prompt, options), options.signal);
}

async function* transportRespondStream(
  prompt: string,
  opts: RespondOptions,
): AsyncIterable<RespondResult> {
  const model = opts.model ?? 'pcc';
  let socketPath: string | null;

  try {
    socketPath = await ensureServeSocket(opts.signal);
  } catch (error) {
    if (opts.signal?.aborted) throw error;
    throw new Error(
      `Streaming requires Terminal-hosted fm serve. fm-serve: ${(error as Error).message}`,
    );
  }

  if (!socketPath) {
    throw new Error(
      `Streaming requires Terminal-hosted fm serve (set ${SERVE_SOCK_ENV} or enable auto-serve).`,
    );
  }

  const queue: string[] = [];
  let done = false;
  let streamError: Error | undefined;
  let wake: (() => void) | undefined;
  const notify = () => {
    wake?.();
    wake = undefined;
  };

  void fmServeChatCompletion(socketPath, {
    model,
    messages: optionsToMessages(prompt, opts),
    stream: true,
    signal: opts.signal,
    onText: (chunk) => {
      queue.push(chunk);
      notify();
    },
  })
    .then(() => {
      done = true;
      notify();
    })
    .catch((error) => {
      streamError = error instanceof Error ? error : new Error(String(error));
      done = true;
      notify();
    });

  while (!done || queue.length > 0) {
    if (queue.length > 0) {
      yield { text: queue.shift()!, backend: 'fm-serve' };
    } else {
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  }

  if (streamError) throw streamError;
}

export async function transportGetAvailableModels(
  model?: FmModel,
  signal?: AbortSignal,
): Promise<ModelAvailability[]> {
  try {
    const socketPath = await ensureServeSocket(signal);
    if (socketPath) {
      const availability = await fmServeAvailable(socketPath, signal);
      if (availability?.length) {
        return model ? availability.filter((entry) => entry.model === model) : availability;
      }
    }
  } catch (error) {
    if (signal?.aborted) throw error;
  }

  const unavailable: ModelAvailability[] = [
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
  ];
  return model ? unavailable.filter((entry) => entry.model === model) : unavailable;
}

export async function transportChatCompletion(opts: {
  model?: FmModel;
  messages: ChatMessage[];
  signal?: AbortSignal;
}): Promise<TransportRespondResult> {
  return completeBuffered(opts.model ?? 'pcc', opts.messages, opts.signal);
}
