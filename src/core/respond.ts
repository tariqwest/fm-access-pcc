import {
  buildRespondArgs,
  transportRespond,
  type TransportRespondResult,
} from './transport.js';
import type { RespondOptions, RespondResult } from './types.js';

export { buildRespondArgs };

export function respond(prompt: string, options?: RespondOptions & { stream: true }): AsyncIterable<RespondResult>;
export function respond(prompt: string, options?: RespondOptions): Promise<TransportRespondResult>;
export function respond(
  prompt: string,
  options: RespondOptions = {},
): Promise<TransportRespondResult> | AsyncIterable<RespondResult> {
  return transportRespond(prompt, options);
}
