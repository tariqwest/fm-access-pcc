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
      if (code !== 0) reject(new Error(stderr.trim() || `fm exited with code ${code}`));
      else resolve(stdout.trim());
    });
  });
}

/** Report availability from Terminal-hosted fm serve. */
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
