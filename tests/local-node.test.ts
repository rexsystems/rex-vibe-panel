import { expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ code: '' }));
vi.mock('dockerode', () => ({ default: class {
  async ping() { if (state.code) throw Object.assign(new Error('Docker probe failed'), { code: state.code }); return 'OK'; }
} }));
import { localNodeInstaller } from '../apps/api/local-node.js';

it.each(['ENOENT', 'ECONNREFUSED'])('explains a stopped Docker daemon for %s', async code => {
  state.code = code;
  const result = await localNodeInstaller.inspect();
  expect(result.available).toBe(false); expect(result.reason).toContain('Start the Docker service');
});
it.each(['EACCES', 'EPERM'])('explains missing panel permissions for %s', async code => {
  state.code = code;
  const result = await localNodeInstaller.inspect();
  expect(result.available).toBe(false); expect(result.reason).toContain('restart the panel');
});
it('accepts an accessible Docker daemon', async () => {
  state.code = '';
  const result = await localNodeInstaller.inspect();
  expect(result.available).toBe(true); expect(result.reason).toBeNull();
});
