import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { nativeRoutes } from './routes/native.js';
import { openaiRoutes } from './routes/openai.js';
import { ensureFmServe } from '../core/serve-bootstrap.js';
import { defaultFmServeSocket } from '../core/config.js';
import { fmServeHealth } from '../core/fm-serve.js';

export interface ServerOptions {
  port?: number;
  /** Auto-start Terminal-hosted fm serve (default true). */
  autoServe?: boolean;
}

export function createApp() {
  const app = new Hono();
  app.use('*', logger());
  app.route('/', nativeRoutes);
  app.route('/', openaiRoutes);
  return app;
}

export function createServer(options: ServerOptions = {}) {
  const port = options.port ?? 8000;
  const app = createApp();

  return {
    app,
    port,
    async start() {
      if (options.autoServe !== false) {
        const boot = await ensureFmServe();
        if (boot.status === 'started') {
          console.error(`[fm-access-pcc] auto-started fm serve via ${boot.method}`);
        } else if (boot.status === 'failed') {
          console.error(`[fm-access-pcc] fm serve auto-start failed: ${boot.reason}`);
        } else if (boot.status === 'declined') {
          console.error(`[fm-access-pcc] ${boot.reason}`);
        }
      }
      return Bun.serve({
        fetch: app.fetch,
        port,
      });
    },
  };
}

export async function getServeHealthSummary() {
  const socketPath = defaultFmServeSocket();
  const health = await fmServeHealth(socketPath);
  return { socketPath, health };
}
