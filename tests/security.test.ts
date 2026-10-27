import { beforeAll, describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword, encrypt, decrypt } from '../packages/security/index.js';
import { publicAddress, checkedFetch } from '../packages/security/network.js';
import { validateRelativePath, buildContainerOptions, gameImage } from '../apps/agent/runtime.js';
import { operationSchema } from '../packages/shared/contracts.js';

beforeAll(() => { process.env.ENCRYPTION_KEY = 'ab'.repeat(32); });
describe('credential storage', () => {
  it('uses salted password hashes and rejects a different password', async () => {
    const a = await hashPassword('a long test password'); const b = await hashPassword('a long test password');
    expect(a).not.toBe(b); expect(await verifyPassword('a long test password', a)).toBe(true); expect(await verifyPassword('wrong', a)).toBe(false);
  });
  it('encrypts provider secrets and rejects tampering', () => {
    const secret = encrypt({ apiKey: 'private-key' }); expect(secret).not.toContain('private-key'); expect(decrypt(secret)).toEqual({ apiKey: 'private-key' });
    const parts = secret.split('.'); parts[2] = Buffer.from('tampered').toString('base64url'); expect(() => decrypt(parts.join('.'))).toThrow();
  });
});
describe('network and filesystem boundaries', () => {
  it.each(['127.0.0.1', '10.4.1.1', '172.16.1.2', '192.168.1.1', '169.254.169.254', '::1', '::ffff:127.0.0.1', 'fc00::1234', 'fe80::1'])('blocks private address %s', address => expect(publicAddress(address)).toBe(false));
  it('permits public IPs', () => { expect(publicAddress('1.1.1.1')).toBe(true); expect(publicAddress('2606:4700:4700::1111')).toBe(true); });
  it('blocks metadata, local endpoints and embedded credentials', async () => {
    await expect(checkedFetch('http://169.254.169.254/latest/meta-data')).rejects.toThrow('Private network');
    await expect(checkedFetch('http://localhost:11434')).rejects.toThrow('Private network');
    await expect(checkedFetch('https://user:pass@example.com')).rejects.toThrow('embedded credentials');
  });
  it.each(['../etc/passwd', '/etc/passwd', 'plugins/../../identity.json', 'a\\b', 'a\0b'])('rejects escaping path %s', path => expect(() => validateRelativePath(path)).toThrow());
  it('allows nested server paths and rejects unknown operations', () => {
    expect(validateRelativePath('plugins/config.yml')).toBe('plugins/config.yml'); expect(operationSchema.safeParse({ type: 'host-shell', command: 'whoami' }).success).toBe(false);
  });
});
describe('Docker allocation', () => {
  const server = { id: 'test', nodeId: 'node', ownerId: 'owner', name: 'test', edition: 'paper' as const, version: '1.21.11', memoryMb: 2048, diskMb: 10240, cpu: 1, port: 25565, eulaAccepted: true as const };
  it('enforces CPU/RAM limits without host mounts or privileged mode', () => {
    const options = buildContainerOptions(server, '/var/lib/rex');
    expect(options.HostConfig?.Memory).toBe(2048 * 1024 * 1024); expect(options.HostConfig?.NanoCpus).toBe(1e9);
    expect(options.HostConfig?.Privileged).not.toBe(true); expect(options.HostConfig?.Binds).toEqual(['/var/lib/rex/servers/test:/data:z']); expect(options.HostConfig?.CapDrop).toEqual(['ALL']);
    expect(options.Env).toContain('ENABLE_RCON=false');
  });
  it('reserves NetherNet TCP and UDP gameplay ports for Bedrock', () => {
    const options = buildContainerOptions({ ...server, edition: 'bedrock', address: '203.0.113.1', port: 19132 }, '/data');
    expect(Object.keys(options.HostConfig!.PortBindings!)).toHaveLength(17); expect(options.Env).toContain('SERVER_UDP_PORTS=203.0.113.1:19133-19148:19133-19148');
  });
  it('selects compatible Java images for established release families', () => {
    expect(gameImage({ ...server, version: '1.16.5' })).toContain('java8'); expect(gameImage({ ...server, version: '1.20.4' })).toContain('java17'); expect(gameImage(server)).toContain('java21');
  });
});
