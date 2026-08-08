import { describe, it, expect } from 'vitest';
import { ensureCuaDriver, cuaDriverCandidatePaths } from './cua-driver.js';

describe('cuaDriverCandidatePaths', () => {
  it('includes well-known locations', () => {
    const paths = cuaDriverCandidatePaths({ HOME: '/Users/test' });
    expect(paths.some((p) => p.includes('.local/bin/cua-driver'))).toBe(true);
  });
});

describe('ensureCuaDriver', () => {
  it('returns present when resolver finds bin', async () => {
    const r = await ensureCuaDriver({
      resolveBin: () => '/tmp/cua-driver',
      allowInstall: false,
    });
    expect(r).toEqual({ status: 'present', bin: '/tmp/cua-driver' });
  });

  it('skips install when disabled and missing', async () => {
    const r = await ensureCuaDriver({
      resolveBin: () => null,
      allowInstall: false,
    });
    expect(r.status).toBe('skipped');
  });
});
