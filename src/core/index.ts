// Core library public API
export { respond } from './respond.js';
export { createChatSession, closeChatSession, getSession } from './chat.js';
export { getAvailableModels, getQuotaUsage } from './models.js';
export { countTokens } from './tokens.js';
export { ensureFmServe } from './serve-bootstrap.js';
export { fmServeHealth, fmServeAvailable } from './fm-serve.js';
export { defaultFmServeSocket, configBaseDir } from './config.js';
export {
  transportRespond,
  transportChatCompletion,
  transportGetAvailableModels,
} from './transport.js';

export type {
  FmModel,
  RespondOptions,
  RespondResult,
  ChatSession,
  ChatSessionOptions,
  ModelAvailability,
  QuotaUsage,
  TokenCountOptions,
  TokenCountResult,
} from './types.js';

export type { TransportBackend, TransportRespondResult } from './transport.js';
export type { ServeBootstrapResult } from './serve-bootstrap.js';
export type { ChatMessage } from './fm-serve.js';

export {
  FmModelSchema,
  RespondOptionsSchema,
  RespondResultSchema,
  ChatSessionOptionsSchema,
  ModelAvailabilitySchema,
  QuotaUsageSchema,
  TokenCountOptionsSchema,
  TokenCountResultSchema,
} from './types.js';
