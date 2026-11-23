import { describe, expect, it } from 'vitest';
import {
  ChatSessionOptionsSchema,
  FmModelSchema,
  ModelAvailabilitySchema,
  QuotaUsageSchema,
  RespondOptionsSchema,
  RespondResultSchema,
  TokenCountOptionsSchema,
  TokenCountResultSchema,
} from './types.js';

describe('FmModelSchema', () => {
  it.each(['system', 'pcc'])('accepts %s', (model) => {
    expect(FmModelSchema.parse(model)).toBe(model);
  });

  it('rejects unknown models', () => {
    expect(() => FmModelSchema.parse('gpt-4')).toThrow();
  });
});

describe('RespondOptionsSchema', () => {
  it('accepts retained response options and history', () => {
    expect(RespondOptionsSchema.parse({
      model: 'pcc',
      instructions: 'Be concise',
      stream: true,
      history: [
        { role: 'system', content: 'System context' },
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi' },
      ],
    })).toEqual({
      model: 'pcc',
      instructions: 'Be concise',
      stream: true,
      history: [
        { role: 'system', content: 'System context' },
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi' },
      ],
    });
  });

  it('strips obsolete direct CLI options', () => {
    expect(RespondOptionsSchema.parse({
      model: 'system',
      greedy: true,
      image: '/tmp/image.png',
      schema: '/tmp/schema.json',
      transcript: '/tmp/chat.json',
      saveTranscript: 'chat',
      useCase: 'general',
      guardrails: 'default',
    })).toEqual({ model: 'system' });
  });

  it('rejects invalid history roles', () => {
    expect(() => RespondOptionsSchema.parse({
      history: [{ role: 'tool', content: 'result' }],
    })).toThrow();
  });
});

describe('RespondResultSchema', () => {
  it('accepts the fm-serve backend', () => {
    expect(RespondResultSchema.parse({ text: 'ok', backend: 'fm-serve' })).toEqual({
      text: 'ok',
      backend: 'fm-serve',
    });
  });

  it.each(['fm', 'lab-bridge'])('rejects the removed %s backend', (backend) => {
    expect(() => RespondResultSchema.parse({ text: 'ok', backend })).toThrow();
  });
});

describe('ChatSessionOptionsSchema', () => {
  it('accepts model and instructions', () => {
    expect(ChatSessionOptionsSchema.parse({ model: 'pcc', instructions: 'Be concise' })).toEqual({
      model: 'pcc',
      instructions: 'Be concise',
    });
  });

  it('strips removed PTY and resume options', () => {
    expect(ChatSessionOptionsSchema.parse({
      model: 'system',
      resume: 'saved-chat',
      transport: 'pty-chat',
    })).toEqual({ model: 'system' });
  });
});

describe('ModelAvailabilitySchema', () => {
  it.each(['fm-serve', 'none'])('accepts the %s source', (source) => {
    expect(ModelAvailabilitySchema.parse({ model: 'pcc', available: true, source }).source).toBe(source);
  });

  it.each(['fm', 'lab-bridge'])('rejects the removed %s source', (source) => {
    expect(() => ModelAvailabilitySchema.parse({
      model: 'system',
      available: true,
      source,
    })).toThrow();
  });
});

describe('QuotaUsageSchema', () => {
  it('validates quota results', () => {
    expect(QuotaUsageSchema.parse({ model: 'pcc', usage: '10%' })).toEqual({
      model: 'pcc',
      usage: '10%',
    });
  });
});

describe('Token count schemas', () => {
  it('preserves standalone CLI image and transcript options', () => {
    expect(TokenCountOptionsSchema.parse({
      instructions: 'Count accurately',
      image: '/tmp/image.png',
      transcript: '/tmp/chat.json',
    })).toEqual({
      instructions: 'Count accurately',
      image: '/tmp/image.png',
      transcript: '/tmp/chat.json',
    });
  });

  it('validates token count results', () => {
    expect(TokenCountResultSchema.parse({ count: 42 })).toEqual({ count: 42 });
  });
});
