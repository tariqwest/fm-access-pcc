import { z } from 'zod';

// --- Model ---

export const FmModelSchema = z.enum(['system', 'pcc']);
export type FmModel = z.infer<typeof FmModelSchema>;

// --- Respond ---

export const RespondOptionsSchema = z.object({
  model: FmModelSchema.optional(),
  instructions: z.string().optional(),
  stream: z.boolean().optional(),
  history: z.array(z.object({
    role: z.enum(['system', 'user', 'assistant']),
    content: z.string(),
  })).optional(),
});
export type RespondOptions = z.infer<typeof RespondOptionsSchema> & {
  /** Abort an in-flight transport request (not part of the Zod JSON schema). */
  signal?: AbortSignal;
};

export const RespondResultSchema = z.object({
  text: z.string(),
  backend: z.literal('fm-serve').optional(),
});
export type RespondResult = z.infer<typeof RespondResultSchema>;

// --- Chat ---

export const ChatSessionOptionsSchema = z.object({
  model: FmModelSchema.optional(),
  instructions: z.string().optional(),
});
export type ChatSessionOptions = z.infer<typeof ChatSessionOptionsSchema>;

export interface ChatSession {
  id: string;
  send(message: string): Promise<string>;
  close(): Promise<void>;
}

// --- Models / Availability ---

export const ModelAvailabilitySchema = z.object({
  model: FmModelSchema,
  available: z.boolean(),
  reason: z.string().optional(),
  source: z.enum(['fm-serve', 'none']).optional(),
});
export type ModelAvailability = z.infer<typeof ModelAvailabilitySchema>;

export const QuotaUsageSchema = z.object({
  model: FmModelSchema,
  usage: z.string(),
});
export type QuotaUsage = z.infer<typeof QuotaUsageSchema>;

// --- Token Count ---

export const TokenCountOptionsSchema = z.object({
  instructions: z.string().optional(),
  image: z.string().optional(),
  transcript: z.string().optional(),
});
export type TokenCountOptions = z.infer<typeof TokenCountOptionsSchema>;

export const TokenCountResultSchema = z.object({
  count: z.number().int().nonnegative(),
});
export type TokenCountResult = z.infer<typeof TokenCountResultSchema>;
