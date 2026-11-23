import { Hono } from 'hono';
import {
  respond,
  createChatSession,
  closeChatSession,
  getAvailableModels,
  getQuotaUsage,
  countTokens,
} from '../../core/index.js';
import type { FmModel } from '../../core/index.js';
import { defaultFmServeSocket } from '../../core/config.js';
import { fmServeHealth } from '../../core/fm-serve.js';

export const nativeRoutes = new Hono();

nativeRoutes.get('/health', async (c) => {
  const socketPath = defaultFmServeSocket();
  const serve = await fmServeHealth(socketPath);
  return c.json({
    status: 'ok',
    serve: {
      socketPath,
      running: Boolean(serve),
      health: serve,
    },
  });
});

nativeRoutes.post('/fm/respond', async (c) => {
  const { prompt, ...options } = await c.req.json();
  if (!prompt) {
    return c.json({ error: 'Prompt is required' }, 400);
  }

  try {
    if (options.stream) {
      return new Response(
        new ReadableStream({
          async start(controller) {
            const encoder = new TextEncoder();
            try {
              for await (const chunk of respond(prompt, { ...options, stream: true })) {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
              }
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              controller.close();
            } catch (err: any) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: err.message })}\n\n`));
              controller.close();
            }
          },
        }),
        {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          },
        },
      );
    } else {
      const result = await respond(prompt, options);
      return c.json(result);
    }
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

nativeRoutes.post('/fm/chat', async (c) => {
  const { prompt, model, instructions } = await c.req.json();
  if (!prompt) {
    return c.json({ error: 'Prompt is required' }, 400);
  }

  try {
    const session = await createChatSession({ model, instructions });
    const response = await session.send(prompt);
    return c.json({ session_id: session.id, response });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

nativeRoutes.delete('/fm/chat/:session_id', (c) => {
  const sessionId = c.req.param('session_id');
  const closed = closeChatSession(sessionId);
  if (closed) {
    return c.json({ status: 'closed' });
  } else {
    return c.json({ error: 'Session not found' }, 404);
  }
});

nativeRoutes.get('/fm/models/available', async (c) => {
  try {
    const model = c.req.query('model') as FmModel | undefined;
    const result = await getAvailableModels(model);
    return c.json(result);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

nativeRoutes.get('/fm/quota', async (c) => {
  try {
    const model = c.req.query('model') as FmModel | undefined;
    const result = await getQuotaUsage(model);
    return c.json(result);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

nativeRoutes.post('/fm/token-count', async (c) => {
  const { prompt, instructions, image, transcript } = await c.req.json();
  if (!prompt) {
    return c.json({ error: 'Prompt is required' }, 400);
  }

  try {
    const options: Record<string, string> = {};
    if (instructions) options.instructions = instructions;
    if (image) options.image = image;
    if (transcript) options.transcript = transcript;
    const result = await countTokens(prompt, options);
    return c.json(result);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});
