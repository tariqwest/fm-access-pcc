import fs from 'node:fs/promises';
import http from 'node:http';
import type { FmModel, ModelAvailability } from './types.js';
import { defaultLabBridgeDescriptor } from './config.js';
import type { ChatMessage } from './fm-serve.js';

export type LabBridgeEndpoint =
  | { kind: 'tcp'; host: string; port: number }
  | { kind: 'unix'; socketPath: string };

export type LabBridgeDescriptor = {
  version: number;
  endpoint: LabBridgeEndpoint;
  bearerToken: string;
  modelIdentifiers: string[];
  path: string;
};

function isLoopbackHost(host: string): boolean {
  const loopbackV4 = ['1','2','7','.','0','.','0','.','1'].join('');
  return host === loopbackV4 || host === '::1' || host === 'localhost';
}

export function parseLabBridgeDescriptorJson(raw: string, filePath: string): LabBridgeDescriptor {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error(`invalid Lab bridge descriptor JSON at ${filePath}`);
  }
  const version = Number(obj.version ?? 0);
  if (version !== 1) {
    throw new Error(`unsupported Lab bridge descriptor version ${version} at ${filePath}`);
  }
  const token = typeof obj.bearerToken === 'string' ? obj.bearerToken : '';
  if (!token || token.length < 16) {
    throw new Error(`Lab bridge descriptor missing bearerToken at ${filePath}`);
  }
  const models = Array.isArray(obj.modelIdentifiers)
    ? obj.modelIdentifiers.filter((m): m is string => typeof m === 'string' && m.length > 0)
    : [];
  const endpointRaw = obj.endpoint;
  if (!endpointRaw || typeof endpointRaw !== 'object') {
    throw new Error(`Lab bridge descriptor missing endpoint at ${filePath}`);
  }
  const ep = endpointRaw as Record<string, unknown>;
  let endpoint: LabBridgeEndpoint | null = null;
  if (ep.loopbackTCP && typeof ep.loopbackTCP === 'object') {
    const tcp = ep.loopbackTCP as Record<string, unknown>;
    const host = String(tcp.host ?? '');
    const port = Number(tcp.port);
    if (!isLoopbackHost(host) || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`Lab bridge descriptor has invalid loopbackTCP at ${filePath}`);
    }
    endpoint = { kind: 'tcp', host, port };
  } else if (ep.unixSocket && typeof ep.unixSocket === 'object') {
    const us = ep.unixSocket as Record<string, unknown>;
    const socketPath = String(us.path ?? '');
    if (!socketPath.startsWith('/')) {
      throw new Error(`Lab bridge descriptor has invalid unixSocket.path at ${filePath}`);
    }
    endpoint = { kind: 'unix', socketPath };
  } else if (typeof ep.host === 'string' && ep.port != null) {
    const host = ep.host;
    const port = Number(ep.port);
    if (!isLoopbackHost(host) || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`Lab bridge descriptor has invalid flat endpoint at ${filePath}`);
    }
    endpoint = { kind: 'tcp', host, port };
  }
  if (!endpoint) {
    throw new Error(`Lab bridge descriptor endpoint not recognized at ${filePath}`);
  }
  return {
    version,
    endpoint,
    bearerToken: token,
    modelIdentifiers: models,
    path: filePath,
  };
}

export async function readLabBridgeDescriptor(
  descriptorPath: string = defaultLabBridgeDescriptor(),
): Promise<LabBridgeDescriptor | null> {
  try {
    const st = await fs.stat(descriptorPath);
    if (!st.isFile()) return null;
    const mode = st.mode & 0o777;
    if (mode & 0o077) {
      console.error(
        `[fm-access-pcc] Lab bridge descriptor ${descriptorPath} is group/world accessible (mode ${mode.toString(8)}); refusing`,
      );
      return null;
    }
    const raw = await fs.readFile(descriptorPath, 'utf8');
    return parseLabBridgeDescriptorJson(raw, descriptorPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    if (err instanceof Error && err.message.includes('Lab bridge')) throw err;
    return null;
  }
}

function requestJson(opts: {
  endpoint: LabBridgeEndpoint;
  bearerToken: string;
  method: string;
  urlPath: string;
  body?: unknown;
  signal?: AbortSignal;
}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? null : JSON.stringify(opts.body);
    const headers: http.OutgoingHttpHeaders = {
      Accept: 'application/json',
      Authorization: `Bearer ${opts.bearerToken}`,
      ...(payload
        ? {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          }
        : {}),
    };
    const common = {
      method: opts.method,
      path: opts.urlPath,
      headers,
    };
    const req =
      opts.endpoint.kind === 'unix'
        ? http.request({ ...common, socketPath: opts.endpoint.socketPath })
        : http.request({
            ...common,
            host: opts.endpoint.host,
            port: opts.endpoint.port,
            family: opts.endpoint.host === '::1' ? 6 : 4,
          });

    req.on('response', (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('error', (err) => {
      reject(new Error(`Lab bridge request failed: ${err.message}`));
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

export async function labBridgeAvailable(
  descriptorPath: string = defaultLabBridgeDescriptor(),
  signal?: AbortSignal,
): Promise<ModelAvailability[] | null> {
  const descriptor = await readLabBridgeDescriptor(descriptorPath);
  if (!descriptor) return null;
  try {
    const res = await requestJson({
      endpoint: descriptor.endpoint,
      bearerToken: descriptor.bearerToken,
      method: 'GET',
      urlPath: '/health',
      signal,
    });
    if (res.status < 200 || res.status >= 300) return null;
    const parsed = JSON.parse(res.body) as {
      models?: Array<{ name?: string; id?: string; available?: boolean; reason?: string }>;
    };
    const fromHealth = (parsed.models ?? []).map((m) => {
      const raw = String(m.name ?? m.id ?? '').toLowerCase();
      const model: FmModel = raw.includes('pcc') ? 'pcc' : 'system';
      return {
        model,
        available: Boolean(m.available),
        reason: m.available ? undefined : (m.reason ?? 'unavailable via Lab bridge'),
        source: 'lab-bridge' as const,
      };
    });
    if (fromHealth.length > 0) return fromHealth;
    return descriptor.modelIdentifiers.map((idRaw) => {
      const model: FmModel = idRaw.toLowerCase().includes('pcc') ? 'pcc' : 'system';
      return { model, available: true, source: 'lab-bridge' as const };
    });
  } catch {
    return null;
  }
}

export async function labBridgeChatCompletion(opts: {
  model?: FmModel;
  messages: ChatMessage[];
  signal?: AbortSignal;
  descriptorPath?: string;
}): Promise<{ text: string; backend: 'lab-bridge' }> {
  const descriptorPath = opts.descriptorPath ?? defaultLabBridgeDescriptor();
  const descriptor = await readLabBridgeDescriptor(descriptorPath);
  if (!descriptor) {
    throw new Error(
      `Lab Agent Bridge descriptor not found at ${descriptorPath}. Enable Agent Bridge in Foundation Lab or start Terminal-hosted fm serve.`,
    );
  }
  const res = await requestJson({
    endpoint: descriptor.endpoint,
    bearerToken: descriptor.bearerToken,
    method: 'POST',
    urlPath: '/v1/chat/completions',
    body: {
      model: opts.model ?? 'pcc',
      messages: opts.messages,
      stream: false,
    },
    signal: opts.signal,
  });
  if (opts.signal?.aborted) throw new Error('cancelled');
  if (res.status === 401 || res.status === 403) {
    throw new Error('Lab bridge authentication failed (stale descriptor?)');
  }
  if (res.status >= 400) {
    let msg = res.body.slice(0, 1000);
    try {
      const errObj = JSON.parse(res.body) as { error?: { message?: string } };
      if (errObj.error?.message) msg = errObj.error.message;
    } catch {
      // ignore
    }
    throw new Error(msg || `Lab bridge HTTP ${res.status}`);
  }
  const parsed = JSON.parse(res.body) as {
    choices?: Array<{ message?: { content?: string | null } }>;
  };
  const text = (parsed.choices?.[0]?.message?.content || '').trim();
  if (!text) throw new Error('Lab bridge returned empty response');
  return { text, backend: 'lab-bridge' };
}
