import { spawn } from 'node:child_process';
import { resolveFmBin } from './config.js';
import { transportGetAvailableModels } from './transport.js';
import type { FmModel, ModelAvailability, QuotaUsage } from './types.js';

function runFmCommand(args: string[]): Promise<string> {
  const fmBin = resolveFmBin();
  const child = spawn(fmBin, args);
  let stdout = '';
  let stderr = '';

  child.stdout.on('data', (d: Buffer) => {
    stdout += d.toString();
  });
  child.stderr.on('data', (d: Buffer) => {
    stderr += d.toString();
  });

  return new Promise((resolve, reject) => {
    child.on('close', (code) => {
      const hasModelResults = args[0] === 'models' && code === 1 && parseAvailability(stdout).length > 0;
      if (code !== 0 && !hasModelResults) reject(new Error(stderr.trim() || `fm exited with code ${code}`));
      else resolve(stdout.trim());
    });
  });
}

/** Direct `fm models` parse (current process context; usually no PCC). */
export async function getAvailableModelsDirect(model?: FmModel): Promise<ModelAvailability[]> {
  const output = await runFmCommand(['models']);
  const models = parseAvailability(output);
  return model ? models.filter((entry) => entry.model === model) : models;
}

function parseAvailability(output: string): ModelAvailability[] {
  const results: ModelAvailability[] = [];
  for (const line of output.split('\n')) {
    const match = line.match(/^\s*([✓✗])\s+(system|pcc)\b/);
    if (match) {
      results.push({
        model: match[2] as FmModel,
        available: match[1] === '✓',
        source: 'fm',
      });
    }
  }
  return results;
}

/** Prefer Terminal-hosted fm serve health; fall back to direct fm models. */
export async function getAvailableModels(model?: FmModel): Promise<ModelAvailability[]> {
  return transportGetAvailableModels(model);
}

export async function getQuotaUsage(model?: FmModel): Promise<QuotaUsage[]> {
  const args = ['quota-usage'];
  if (model) args.push('--model', model);
  const output = await runFmCommand(args);
  return parseQuotaUsage(output);
}

function parseQuotaUsage(output: string): QuotaUsage[] {
  const results: QuotaUsage[] = [];
  for (const line of output.split('\n')) {
    const match = line.match(/^\s*(system|pcc):\s*(.+)$/i);
    if (match) {
      results.push({
        model: match[1].toLowerCase() as FmModel,
        usage: match[2].trim(),
      });
    }
  }
  return results;
}
