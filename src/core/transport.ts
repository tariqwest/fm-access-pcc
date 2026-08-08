import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultFmServeSocket,
  LAB_BRIDGE_ENABLED_ENV,
  readEnvBoolDefaultTrue,
  resolveFmBin,
  SERVE_SOCK_ENV,
} from './config.js';
import { fmServeAvailable, fmServeChatCompletion, fmServeHealth, type ChatMessage } from './fm-serve.js';
import { labBridgeAvailable, labBridgeChatCompletion } from './lab-bridge.js';
import { ensureFmServe } from './serve-bootstrap.js';
import type { FmModel, ModelAvailability, RespondOptions, RespondResult } from './types.js';

export type TransportBackend = 'fm-serve' | 'fm' | 'lab-bridge';

export type TransportRespondResult = RespondResult & { backend: TransportBackend };

function attachAbort(kill: () => void, signal?: AbortSignal): () => void {
  if (!signal) return () => undefined;
  const onAbort = () => kill();
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });
  return () => signal.removeEventListener('abort', onAbort);
}

export function buildRespondArgs(prompt: string, opts: RespondOptions, fmBinIgnored = false): string[] {
  void fmBinIgnored;
  const args: string[] = ['respond'];
  if (opts.model) args.push('--model', opts.model);
  if (opts.instructions) args.push('--instructions', opts.instructions);
  if (opts.greedy) args.push('--greedy');
  if (opts.image) args.push('--image', opts.image);
  for (const img of opts.images ?? []) {
    args.push('--image', img.path);
    if (img.label) args.push('--label', img.label);
  }
  if (opts.schema) {
    const schemaPath =
      typeof opts.schema === 'string' ? opts.schema : writeTempSchema(opts.schema);
    args.push('--schema', schemaPath);
  }
  if (opts.transcript) args.push('--resume', opts.transcript);
  if (opts.saveTranscript) args.push('--save-transcript', opts.saveTranscript);
  if (opts.stream === false) args.push('--no-stream');
  if (opts.useCase) args.push('--use-case', opts.useCase);
  if (opts.guardrails) args.push('--guardrails', opts.guardrails);
  args.push(prompt);
  return args;
}

function writeTempSchema(schema: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'fm-schema-'));
  const path = join(dir, 'schema.json');
  writeFileSync(path, JSON.stringify(schema));
  return path;
}

function needsDirectCliFeatures(opts: RespondOptions): boolean {
  return Boolean(
    opts.schema ||
      opts.image ||
      (opts.images && opts.images.length > 0) ||
      opts.saveTranscript ||
      opts.transcript ||
      opts.useCase ||
      opts.guardrails,
  );
}

export function optionsToMessages(prompt: string, opts: RespondOptions): ChatMessage[] {
  const messages: ChatMessage[] = [];
  if (opts.instructions) messages.push({ role: 'system', content: opts.instructions });
  if (opts.history?.length) {
    for (const h of opts.history) {
      if (h.role === 'system' || h.role === 'user' || h.role === 'assistant') {
        messages.push({ role: h.role, content: h.content });
      }
    }
  }
  messages.push({ role: 'user', content: prompt });
  return messages;
}

async function ensureServeSocket(signal?: AbortSignal): Promise<string | null> {
  const sock = defaultFmServeSocket();
  let health = await fmServeHealth(sock, signal);
  if (health) return sock;
  const boot = await ensureFmServe({ socketPath: sock });
  if (boot.status === 'started') {
    console.error(`[fm-access-pcc] auto-started fm serve via ${boot.method} at ${boot.socketPath}`);
  } else if (boot.status === 'failed') {
    console.error(`[fm-access-pcc] fm serve auto-start failed: ${boot.reason}`);
  }
  health = await fmServeHealth(sock, signal);
  return health ? sock : null;
}

async function directFmRespond(
  prompt: string,
  opts: RespondOptions,
): Promise<TransportRespondResult> {
  const fmBin = resolveFmBin();
  const args = buildRespondArgs(prompt, opts).slice(1); // drop 'respond' for spawn with bin path... keep full
  const fullArgs = buildRespondArgs(prompt, opts);
  const child = spawn(fmBin, fullArgs) as ChildProcessWithoutNullStreams;
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d: Buffer) => {
    stdout += d.toString();
  });
  child.stderr.on('data', (d: Buffer) => {
    stderr += d.toString();
  });
  const detach = attachAbort(() => {
    child.kill('SIGTERM');
    setTimeout(() => {
      if (!child.killed) child.kill('SIGKILL');
    }, 1500).unref();
  }, opts.signal);

  return new Promise((resolve, reject) => {
    child.on('error', (err) => {
      detach();
      reject(err);
    });
    child.on('close', (code) => {
      detach();
      if (opts.signal?.aborted) {
        reject(new Error('cancelled'));
        return;
      }
      if (code !== 0) {
        reject(new Error(stderr.trim() || `fm exited with code ${code}`));
      } else {
        resolve({ text: stdout.trim(), backend: 'fm' });
      }
    });
  });
}

async function* directFmStream(
  prompt: string,
  opts: RespondOptions,
): AsyncIterable<RespondResult> {
  const fmBin = resolveFmBin();
  const fullArgs = buildRespondArgs(prompt, { ...opts, stream: true });
  const child = spawn(fmBin, fullArgs) as ChildProcessWithoutNullStreams;
  const detach = attachAbort(() => {
    child.kill('SIGTERM');
    setTimeout(() => {
      if (!child.killed) child.kill('SIGKILL');
    }, 1500).unref();
  }, opts.signal);
  try {
    for await (const chunk of child.stdout) {
      if (opts.signal?.aborted) break;
      yield { text: chunk.toString(), backend: 'fm' };
    }
  } finally {
    detach();
  }
}

/**
 * Single-turn generation via preferred transport.
 * PCC uses Terminal-hosted fm serve (never PTY).
 */
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
  if (options.stream) {
    return transportRespondStream(prompt, options);
  }
  return transportRespondBuffered(prompt, options);
}

async function transportRespondBuffered(
  prompt: string,
  opts: RespondOptions,
): Promise<TransportRespondResult> {
  const model: FmModel = opts.model ?? 'pcc';
  const cliOnly = needsDirectCliFeatures(opts);

  if (cliOnly && model === 'pcc') {
    throw new Error(
      'schema/image/transcript options are not supported for pcc via fm serve yet. ' +
        'Use model: "system" for CLI-only features, or drop those options for pcc.',
    );
  }

  if (cliOnly && model === 'system') {
    return directFmRespond(prompt, opts);
  }

  const messages = optionsToMessages(prompt, opts);
  const errors: string[] = [];

  // 1) fm serve
  try {
    const sock = await ensureServeSocket(opts.signal);
    if (sock) {
      const result = await fmServeChatCompletion(sock, {
        model,
        messages,
        stream: false,
        signal: opts.signal,
      });
      return { text: result.text, backend: 'fm-serve' };
    }
    errors.push(`fm-serve: not reachable (set ${SERVE_SOCK_ENV} or enable auto-serve)`);
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    errors.push(`fm-serve: ${(err as Error).message}`);
  }

  // 2) Lab bridge (optional, default ON probe if descriptor exists)
  if (readEnvBoolDefaultTrue(process.env, LAB_BRIDGE_ENABLED_ENV)) {
    try {
      const result = await labBridgeChatCompletion({
        model,
        messages,
        signal: opts.signal,
      });
      return { text: result.text, backend: 'lab-bridge' };
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      const msg = (err as Error).message;
      if (!/descriptor not found/i.test(msg)) {
        errors.push(`lab-bridge: ${msg}`);
      }
    }
  }

  // 3) direct fm — system only (PCC will fail outside Terminal)
  if (model === 'system') {
    try {
      return await directFmRespond(prompt, opts);
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      errors.push(`fm: ${(err as Error).message}`);
    }
  } else {
    errors.push(
      'pcc requires Terminal-hosted `fm serve --socket` (PTY/direct fm respond cannot unlock PCC)',
    );
  }

  throw new Error(
    `${errors.join(' | ')}. Start: open -a Terminal ~/.config/fm-access-pcc/start-fm-serve.command`,
  );
}

async function* transportRespondStream(
  prompt: string,
  opts: RespondOptions,
): AsyncIterable<RespondResult> {
  const model: FmModel = opts.model ?? 'pcc';
  const cliOnly = needsDirectCliFeatures(opts);

  if (cliOnly && model === 'pcc') {
    throw new Error(
      'schema/image/transcript options are not supported for pcc via fm serve yet.',
    );
  }

  if (cliOnly && model === 'system') {
    yield* directFmStream(prompt, opts);
    return;
  }

  const messages = optionsToMessages(prompt, opts);

  try {
    const sock = await ensureServeSocket(opts.signal);
    if (sock) {
      const queue: string[] = [];
      let done = false;
      let pending: ((v: IteratorResult<RespondResult>) => void) | null = null;
      let rejectPending: ((e: Error) => void) | null = null;
      let streamError: Error | null = null;

      const push = (text: string) => {
        if (pending) {
          const r = pending;
          pending = null;
          rejectPending = null;
          r({ value: { text, backend: 'fm-serve' }, done: false });
        } else {
          queue.push(text);
        }
      };

      const finish = (err?: Error) => {
        done = true;
        if (err) streamError = err;
        if (pending) {
          const r = pending;
          const rej = rejectPending;
          pending = null;
          rejectPending = null;
          if (err && rej) rej(err);
          else r({ value: undefined as unknown as RespondResult, done: true });
        }
      };

      void fmServeChatCompletion(sock, {
        model,
        messages,
        stream: true,
        signal: opts.signal,
        onText: async (chunk) => {
          push(chunk);
        },
      })
        .then(() => finish())
        .catch((err) => finish(err instanceof Error ? err : new Error(String(err))));

      while (!done || queue.length > 0) {
        if (opts.signal?.aborted) break;
        if (queue.length > 0) {
          yield { text: queue.shift()!, backend: 'fm-serve' };
        } else if (!done) {
          const result = await new Promise<IteratorResult<RespondResult>>((resolve, reject) => {
            pending = resolve;
            rejectPending = reject;
          });
          if (result.done) break;
          yield result.value;
        }
      }
      if (streamError) throw streamError;
      return;
    }
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    if (model === 'pcc') throw err;
    // fall through to direct for system
  }

  if (model === 'system') {
    yield* directFmStream(prompt, opts);
    return;
  }

  throw new Error(
    'pcc streaming requires Terminal-hosted fm serve --socket. ' +
      'Start: open -a Terminal ~/.config/fm-access-pcc/start-fm-serve.command',
  );
}

export async function transportGetAvailableModels(
  model?: FmModel,
  signal?: AbortSignal,
): Promise<ModelAvailability[]> {
  const sock = await ensureServeSocket(signal);
  if (sock) {
    const fromServe = await fmServeAvailable(sock, signal);
    if (fromServe?.length) {
      return model ? fromServe.filter((m) => m.model === model) : fromServe;
    }
  }

  if (readEnvBoolDefaultTrue(process.env, LAB_BRIDGE_ENABLED_ENV)) {
    const fromBridge = await labBridgeAvailable(undefined, signal);
    if (fromBridge?.length) {
      return model ? fromBridge.filter((m) => m.model === model) : fromBridge;
    }
  }

  // Fall back: advertise system-only when serve is down (caller can still try direct fm).
  return [
    { model: 'system' as const, available: true, source: 'fm' as const },
    {
      model: 'pcc' as const,
      available: false,
      reason: 'Start Terminal-hosted fm serve --socket for PCC',
      source: 'none' as const,
    },
  ].filter((m) => !model || m.model === model);
}

export async function transportChatCompletion(opts: {
  model?: FmModel;
  messages: ChatMessage[];
  stream?: boolean;
  signal?: AbortSignal;
  onText?: (chunk: string) => void | Promise<void>;
}): Promise<TransportRespondResult> {
  const model = opts.model ?? 'pcc';
  const errors: string[] = [];

  try {
    const sock = await ensureServeSocket(opts.signal);
    if (sock) {
      const result = await fmServeChatCompletion(sock, {
        model,
        messages: opts.messages,
        stream: opts.stream,
        signal: opts.signal,
        onText: opts.onText,
      });
      return { text: result.text, backend: 'fm-serve' };
    }
    errors.push('fm-serve not reachable');
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    errors.push(`fm-serve: ${(err as Error).message}`);
  }

  if (readEnvBoolDefaultTrue(process.env, LAB_BRIDGE_ENABLED_ENV) && !opts.stream) {
    try {
      const result = await labBridgeChatCompletion({
        model,
        messages: opts.messages,
        signal: opts.signal,
      });
      await opts.onText?.(result.text);
      return { text: result.text, backend: 'lab-bridge' };
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      const msg = (err as Error).message;
      if (!/descriptor not found/i.test(msg)) errors.push(`lab-bridge: ${msg}`);
    }
  }

  if (model === 'system' && !opts.stream) {
    const lastUser = [...opts.messages].reverse().find((m) => m.role === 'user');
    const system = opts.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    if (lastUser) {
      return directFmRespond(lastUser.content, {
        model: 'system',
        instructions: system || undefined,
        signal: opts.signal,
      });
    }
  }

  throw new Error(
    `${errors.join(' | ') || 'no transport'}. Start Terminal-hosted fm serve for PCC.`,
  );
}
