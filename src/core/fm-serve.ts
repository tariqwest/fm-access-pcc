import http from 'node:http';
import type { FmModel, ModelAvailability } from './types.js';
import { defaultFmServeSocket } from './config.js';

export type FmServeHealth = {
  status?: string;
  models?: Array<{ name: string; available: boolean; reason?: string }>;
};

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export type FmServeCompletionOptions = {
  model?: FmModel;
  messages: ChatMessage[];
  stream?: boolean;
  signal?: AbortSignal;
  onText?: (chunk: string) => void | Promise<void>;
};

function requestJson(opts: {
  socketPath: string;
  method: string;
  urlPath: string;
  body?: unknown;
  signal?: AbortSignal;
  accept?: string;
}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? null : JSON.stringify(opts.body);
    const req = http.request(
      {
        socketPath: opts.socketPath,
        path: opts.urlPath,
        method: opts.method,
        headers: {
          Accept: opts.accept ?? 'application/json',
          ...(payload
            ? {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
              }
            : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', (err) => {
      reject(new Error(`fm serve request failed: ${err.message}`));
    });
    const onAbort = () => {
      req.destroy(new Error('cancelled'));
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    req.on('close', () => {
      opts.signal?.removeEventListener('abort', onAbort);
    });
    if (payload) req.write(payload);
    req.end();
  });
}

export async function fmServeHealth(
  socketPath: string = defaultFmServeSocket(),
  signal?: AbortSignal,
): Promise<FmServeHealth | null> {
  try {
    const res = await requestJson({
      socketPath,
      method: 'GET',
      urlPath: '/health',
      signal,
    });
    if (res.status < 200 || res.status >= 300) return null;
    return JSON.parse(res.body) as FmServeHealth;
  } catch {
    return null;
  }
}

export async function fmServeAvailable(
  socketPath: string = defaultFmServeSocket(),
  signal?: AbortSignal,
): Promise<ModelAvailability[] | null> {
  const health = await fmServeHealth(socketPath, signal);
  if (!health?.models?.length) return null;
  return health.models.map((m) => {
    const model: FmModel = m.name === 'pcc' ? 'pcc' : 'system';
    return {
      model,
      available: Boolean(m.available),
      reason: m.available ? undefined : (m.reason ?? 'unavailable via fm serve'),
      source: 'fm-serve' as const,
    };
  });
}

/** Parse OpenAI-style SSE stream body into concatenated assistant text. */
export function parseChatCompletionSse(raw: string): string {
  let out = '';
  for (const block of raw.split(/\n\n/)) {
    const lines = block.split(/\r?\n/);
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const data = t.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const obj = JSON.parse(data) as {
          choices?: Array<{ delta?: { content?: string | null }; message?: { content?: string | null } }>;
        };
        const choice = obj.choices?.[0];
        const piece = choice?.delta?.content ?? choice?.message?.content;
        if (typeof piece === 'string' && piece) out += piece;
      } catch {
        // ignore malformed SSE chunks
      }
    }
  }
  return out;
}

export async function fmServeChatCompletion(
  socketPath: string,
  opts: FmServeCompletionOptions,
): Promise<{ text: string; backend: 'fm-serve' }> {
  const stream = Boolean(opts.stream && opts.onText);
  const body = {
    model: opts.model ?? 'pcc',
    messages: opts.messages,
    stream,
  };

  if (!stream) {
    const res = await requestJson({
      socketPath,
      method: 'POST',
      urlPath: '/v1/chat/completions',
      body,
      signal: opts.signal,
    });
    if (res.status === 503 || res.status >= 400) {
      let msg = res.body.slice(0, 1000);
      try {
        const errObj = JSON.parse(res.body) as { error?: { message?: string } };
        if (errObj.error?.message) msg = errObj.error.message;
      } catch {
        // ignore
      }
      throw new Error(msg || `fm serve HTTP ${res.status}`);
    }
    const parsed = JSON.parse(res.body) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = parsed.choices?.[0]?.message?.content ?? '';
    if (!text) throw new Error('fm serve returned empty response');
    await opts.onText?.(text);
    return { text, backend: 'fm-serve' };
  }

  const text = await new Promise<string>((resolve, reject) => {
    let settled = false;
    let buffer = '';
    let assembled = '';
    const payload = JSON.stringify(body);
    const httpReq = http.request(
      {
        socketPath,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          Accept: 'text/event-stream',
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        if ((res.statusCode ?? 0) >= 400) {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
          res.on('end', () => {
            if (settled) return;
            settled = true;
            let msg = Buffer.concat(chunks).toString('utf8').slice(0, 1000);
            try {
              const errObj = JSON.parse(msg) as { error?: { message?: string } };
              if (errObj.error?.message) msg = errObj.error.message;
            } catch {
              // ignore
            }
            reject(new Error(msg || `fm serve HTTP ${res.statusCode}`));
          });
          return;
        }

        res.setEncoding('utf8');
        let chain: Promise<void> = Promise.resolve();
        res.on('data', (chunk: string) => {
          buffer += chunk;
          const parts = buffer.split(/\n\n/);
          buffer = parts.pop() ?? '';
          for (const part of parts) {
            const piece = parseChatCompletionSse(part + '\n\n');
            if (!piece) continue;
            assembled += piece;
            if (opts.onText) {
              chain = chain.then(() => opts.onText!(piece));
            }
          }
        });
        res.on('end', () => {
          void chain
            .then(() => {
              if (buffer.trim()) {
                const piece = parseChatCompletionSse(buffer + '\n\n');
                if (piece) {
                  assembled += piece;
                  return opts.onText?.(piece);
                }
              }
            })
            .then(() => {
              if (settled) return;
              settled = true;
              if (!assembled) {
                reject(new Error('fm serve returned empty stream'));
                return;
              }
              resolve(assembled);
            })
            .catch((err) => {
              if (settled) return;
              settled = true;
              reject(err instanceof Error ? err : new Error(String(err)));
            });
        });
      },
    );

    httpReq.on('error', (err) => {
      if (settled) return;
      settled = true;
      if (opts.signal?.aborted) {
        reject(new Error('cancelled'));
        return;
      }
      reject(new Error(`fm serve stream failed: ${err.message}`));
    });

    const onAbort = () => {
      httpReq.destroy(new Error('cancelled'));
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    httpReq.on('close', () => opts.signal?.removeEventListener('abort', onAbort));
    httpReq.write(payload);
    httpReq.end();
  });

  return { text, backend: 'fm-serve' };
}
