import os from 'node:os';
import path from 'node:path';

export const CONFIG_DIR_NAME = 'fm-access-pcc';

export const SERVE_SOCK_ENV = 'FM_ACCESS_PCC_SERVE_SOCK';
export const AUTO_SERVE_ENV = 'FM_ACCESS_PCC_AUTO_SERVE';
export const AUTO_SERVE_TIMEOUT_ENV = 'FM_ACCESS_PCC_AUTO_SERVE_TIMEOUT_MS';
export const SERVE_LAUNCHER_ENV = 'FM_ACCESS_PCC_SERVE_LAUNCHER';
export const LAB_BRIDGE_DESCRIPTOR_ENV = 'AFM_BRIDGE_DESCRIPTOR';
export const LAB_BRIDGE_BASE_ENV = 'AFM_BRIDGE_BASE';
export const LAB_BRIDGE_ENABLED_ENV = 'FM_ACCESS_PCC_LAB_BRIDGE';

export function configBaseDir(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME?.trim() || os.homedir();
  const xdg = env.XDG_CONFIG_HOME?.trim();
  const base = xdg || path.join(home, '.config');
  return path.join(base, CONFIG_DIR_NAME);
}

export function defaultFmServeSocket(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[SERVE_SOCK_ENV]?.trim();
  if (override) return override;
  return path.join(configBaseDir(env), 'fm.sock');
}

export function defaultServeLauncherPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[SERVE_LAUNCHER_ENV]?.trim();
  if (override) return override;
  return path.join(configBaseDir(env), 'start-fm-serve.command');
}

export function defaultLabBridgeDescriptor(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[LAB_BRIDGE_DESCRIPTOR_ENV]?.trim();
  if (override) return path.resolve(override);
  const base = env[LAB_BRIDGE_BASE_ENV]?.trim() || path.join(env.HOME?.trim() || os.homedir(), '.afm');
  return path.join(path.resolve(base), 'bridge', 'connection.json');
}

/** Default ON; set env=0/false/off to disable. */
export function readEnvBoolDefaultTrue(env: NodeJS.ProcessEnv, key: string): boolean {
  const v = env[key]?.trim().toLowerCase();
  if (v == null || v === '') return true;
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

export function readEnvInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function resolveFmBin(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.FM_BIN_PATH?.trim() || env.FM_BIN?.trim();
  if (fromEnv) return fromEnv;
  return '/usr/bin/fm';
}
