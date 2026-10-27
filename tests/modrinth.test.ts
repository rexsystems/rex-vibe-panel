import { expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ versions: {} as Record<string, any>, projects: {} as Record<string, any> }));
vi.mock('../packages/security/network.js', () => ({ checkedFetch: async (input: string) => {
  const url = new URL(input), parts = url.pathname.split('/');
  const data = parts[2] === 'version' ? Object.values(fixture.versions).flat().find((v: any) => v.id === parts[3]) : parts[4] === 'version' ? fixture.versions[parts[3]] || [] : fixture.projects[parts[3]];
  return new Response(JSON.stringify(data), { status: data ? 200 : 404 });
} }));
import { resolveModrinth } from '../packages/ai/tools.js';
const server = { id: 'server', name: 'test', nodeId: 'node', ownerId: 'user', edition: 'fabric' as const, version: '1.21.11', memoryMb: 2048, diskMb: 10000, cpu: 1, port: 25565, eulaAccepted: true as const };
const version = (project: string, dependencies: any[] = []) => ({ id: `${project}1`, project_id: project, game_versions: ['1.21.11'], loaders: ['fabric'], dependencies, files: [{ primary: true, filename: `${project}.jar`, url: `https://cdn.modrinth.com/${project}.jar`, hashes: { sha512: 'a'.repeat(128) } }] });
it('resolves required dependencies before downloading and retains hashes', async () => {
  fixture.versions = { mod: [version('mod', [{ dependency_type: 'required', project_id: 'dependency' }])], dependency: [version('dependency')] };
  fixture.projects = { mod: { title: 'Test mod', server_side: 'required' }, dependency: { title: 'Dependency', server_side: 'required' } };
  const files = await resolveModrinth(server, 'mod'); expect(files.map(f => f.project)).toEqual(['dependency', 'mod']); expect(files[0].sha512).toBe('a'.repeat(128));
});
it('rejects incompatible versions before installation', async () => {
  fixture.versions = { mod: [{ ...version('mod'), game_versions: ['1.20.1'] }] }; await expect(resolveModrinth(server, 'mod')).rejects.toThrow('No compatible');
});
it('rejects client-only projects and unsupported external dependencies', async () => {
  fixture.versions = { mod: [version('mod')] }; fixture.projects = { mod: { title: 'Client mod', server_side: 'unsupported' } };
  await expect(resolveModrinth(server, 'mod')).rejects.toThrow('client-only');
  fixture.projects.mod.server_side = 'required'; fixture.versions.mod[0].dependencies = [{ dependency_type: 'required' }]; await expect(resolveModrinth(server, 'mod')).rejects.toThrow('external dependency');
});
