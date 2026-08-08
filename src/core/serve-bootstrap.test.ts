import { describe, it, expect } from 'vitest';
import {
  buildServeLauncherScript,
  buildCuaDriverLaunchArgs,
  ensureFmServe,
} from './serve-bootstrap.js';

describe('buildServeLauncherScript', () => {
  it('execs fm serve --socket', () => {
    const body = buildServeLauncherScript('/tmp/fm.sock', '/usr/bin/fm');
    expect(body).toContain("SOCK='/tmp/fm.sock'");
    expect(body).toContain('serve --socket');
    expect(body.startsWith('#!/bin/zsh')).toBe(true);
  });
});

describe('buildCuaDriverLaunchArgs', () => {
  it('uses Terminal bundle and additional_arguments', () => {
    const args = buildCuaDriverLaunchArgs('/tmp/start.command');
    expect(args[0]).toBe('call');
    expect(args[1]).toBe('launch_app');
    const payload = JSON.parse(args[2]);
    expect(payload.bundle_id).toBe('com.apple.Terminal');
    expect(payload.additional_arguments).toEqual(['/tmp/start.command']);
    expect(payload.creates_new_application_instance).toBe(true);
  });
});

describe('ensureFmServe', () => {
  it('returns already_running when health ok', async () => {
    const r = await ensureFmServe({
      socketPath: '/tmp/x.sock',
      healthFn: async () => ({ status: 'ok', models: [] }),
      auto: true,
    });
    expect(r.status).toBe('already_running');
  });

  it('declines when auto disabled and not running', async () => {
    const r = await ensureFmServe({
      socketPath: '/tmp/x.sock',
      healthFn: async () => null,
      auto: false,
    });
    expect(r.status).toBe('declined');
  });
});
