import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as pty from 'node-pty';
import { writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { RespondOptions, RespondResult } from './types.js';

export function buildRespondArgs(prompt: string, opts: RespondOptions): string[] {
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
    const schemaPath = typeof opts.schema === 'string'
      ? opts.schema
      : writeTempSchema(opts.schema);
    args.push('--schema', schemaPath);
  }
  // Current macOS fm CLI uses --resume (not --load-transcript).
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

function attachAbort(
  kill: () => void,
  signal?: AbortSignal,
): () => void {
  if (!signal) return () => undefined;
  const onAbort = () => kill();
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });
  return () => signal.removeEventListener('abort', onAbort);
}

export function respond(prompt: string, options?: RespondOptions & { stream: true }): AsyncIterable<RespondResult>;
export function respond(prompt: string, options?: RespondOptions): Promise<RespondResult>;
export function respond(prompt: string, options: RespondOptions = {}): Promise<RespondResult> | AsyncIterable<RespondResult> {
  const args = buildRespondArgs(prompt, options);
  const usePty = options.model === 'pcc';
  const signal = options.signal;

  if (options.stream) {
    return usePty ? ptyStreamRespond(args, signal) : streamRespond(args, signal);
  }
  return usePty ? ptyBufferedRespond(args, signal) : bufferedRespond(args, signal);
}

// -- Standard spawn (for on-device / system model) --

async function bufferedRespond(args: string[], signal?: AbortSignal): Promise<RespondResult> {
  const child = spawn('fm', args) as ChildProcessWithoutNullStreams;
  let stdout = '';
  let stderr = '';

  child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
  child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

  const detach = attachAbort(() => {
    child.kill('SIGTERM');
    setTimeout(() => { if (!child.killed) child.kill('SIGKILL'); }, 1500).unref();
  }, signal);

  return new Promise<RespondResult>((resolve, reject) => {
    child.on('error', (err) => {
      detach();
      reject(err);
    });
    child.on('close', (code) => {
      detach();
      if (signal?.aborted) {
        reject(new Error('cancelled'));
        return;
      }
      if (code !== 0) {
        reject(new Error(stderr.trim() || `fm exited with code ${code}`));
      } else {
        resolve({ text: stdout.trim() });
      }
    });
  });
}

async function* streamRespond(args: string[], signal?: AbortSignal): AsyncIterable<RespondResult> {
  const child = spawn('fm', args) as ChildProcessWithoutNullStreams;
  const detach = attachAbort(() => {
    child.kill('SIGTERM');
    setTimeout(() => { if (!child.killed) child.kill('SIGKILL'); }, 1500).unref();
  }, signal);

  try {
    for await (const chunk of child.stdout) {
      if (signal?.aborted) break;
      yield { text: chunk.toString() };
    }
  } finally {
    detach();
  }
}

// -- PTY-based spawn (for PCC model — requires terminal context) --

const FM_PATH = '/usr/bin/fm';

/** Strip ANSI escape sequences from PTY output */
function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

async function ptyBufferedRespond(args: string[], signal?: AbortSignal): Promise<RespondResult> {
  return new Promise<RespondResult>((resolve, reject) => {
    let output = '';
    const proc = pty.spawn(FM_PATH, args, {
      name: 'xterm-color',
      cols: 200,
      rows: 24,
      cwd: process.env.HOME,
      env: process.env as Record<string, string>,
    });

    const detach = attachAbort(() => {
      try { proc.kill(); } catch { /* ignore */ }
    }, signal);

    proc.onData((data: string) => {
      output += data;
    });

    proc.onExit(({ exitCode }) => {
      detach();
      if (signal?.aborted) {
        reject(new Error('cancelled'));
        return;
      }
      const cleaned = stripAnsi(output).trim();
      // fm may exit 0 while printing PCC context errors into the PTY stream
      if (/Private Cloud Compute is not available/i.test(cleaned) ||
          /Please use the Terminal app/i.test(cleaned)) {
        reject(new Error(cleaned));
        return;
      }
      if (exitCode !== 0) {
        reject(new Error(cleaned || `fm exited with code ${exitCode}`));
      } else {
        resolve({ text: cleaned });
      }
    });
  });
}

async function* ptyStreamRespond(args: string[], signal?: AbortSignal): AsyncIterable<RespondResult> {
  const proc = pty.spawn(FM_PATH, args, {
    name: 'xterm-color',
    cols: 200,
    rows: 24,
    cwd: process.env.HOME,
    env: process.env as Record<string, string>,
  });

  let done = false;
  let pendingResolve: ((value: IteratorResult<RespondResult>) => void) | null = null;
  const queue: string[] = [];

  const detach = attachAbort(() => {
    try { proc.kill(); } catch { /* ignore */ }
  }, signal);

  proc.onData((data: string) => {
    const cleaned = stripAnsi(data);
    if (cleaned) {
      if (pendingResolve) {
        const resolve = pendingResolve;
        pendingResolve = null;
        resolve({ value: { text: cleaned }, done: false });
      } else {
        queue.push(cleaned);
      }
    }
  });

  proc.onExit(() => {
    done = true;
    detach();
    if (pendingResolve) {
      const resolve = pendingResolve;
      pendingResolve = null;
      resolve({ value: undefined as unknown as RespondResult, done: true });
    }
  });

  try {
    while (!done || queue.length > 0) {
      if (signal?.aborted) break;
      if (queue.length > 0) {
        yield { text: queue.shift()! };
      } else if (!done) {
        const result = await new Promise<IteratorResult<RespondResult>>((resolve) => {
          pendingResolve = resolve;
        });
        if (result.done) break;
        yield result.value;
      }
    }
  } finally {
    detach();
  }
}
