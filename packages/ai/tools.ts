import { z } from 'zod';
import { checkedFetch } from '../security/network.js';
import { operationSchema, type ToolDefinition, type ServerSpec } from '../shared/contracts.js';

export const toolSchemas = {
  server_operation: z.object({ operation: operationSchema }),
  modrinth_search: z.object({ query: z.string().min(1).max(200) }),
  modrinth_install: z.object({ project: z.string().regex(/^[a-zA-Z0-9_-]+$/), versionId: z.string().regex(/^[a-zA-Z0-9]+$/).optional() }),
  minecraft_runtime: z.object({ edition: z.enum(['vanilla', 'paper', 'fabric', 'forge', 'neoforge', 'bedrock']), version: z.string().regex(/^[a-zA-Z0-9._+-]+$/).max(80) }),
};
const descriptions = {
  server_operation: 'Manage the selected Minecraft server: install, power, status, logs, shell, console, files, public URL downloads, backups, restore. All paths are relative to the server volume. install prepares the container; power start launches Minecraft. Shell requires a running game container. Server resources and the Linux host are outside your authority.',
  modrinth_search: 'Search Modrinth for projects compatible with the selected Minecraft version and loader.',
  modrinth_install: 'Install a compatible Modrinth project and its required dependencies. Supports Java mods and Paper plugins. Rejects incompatible projects and unresolved dependencies.',
  minecraft_runtime: 'Change the Minecraft edition/loader and version, backing up the existing server and preparing a replacement container. Does not start it. Only use when the user requests a runtime/version change. Crossing Java/Bedrock requires administrator reallocation.',
};
export const toolDefinitions: ToolDefinition[] = Object.entries(toolSchemas).map(([name, schema]) => ({ name, description: descriptions[name as keyof typeof descriptions], parameters: z.toJSONSchema(schema, { unrepresentable: 'any', io: 'input' }) }));
async function modrinth(path: string, signal?: AbortSignal) {
  const response = await checkedFetch(`https://api.modrinth.com/v2/${path}`, { signal, headers: { 'User-Agent': 'REX-Vibe-Panel/0.1.0' } });
  if (!response.ok) throw new Error(`Modrinth returned HTTP ${response.status}. Try again later.`);
  return response.json() as Promise<any>;
}
function loader(server: ServerSpec) {
  if (['bedrock', 'vanilla'].includes(server.edition)) throw new Error('Modrinth mods/plugins require Paper, Fabric, Forge or NeoForge. Bedrock uses behavior/resource packs.');
  return server.edition;
}
export async function searchModrinth(server: ServerSpec, query: string, signal?: AbortSignal) {
  const facets = JSON.stringify([[`versions:${server.version}`], [`categories:${loader(server)}`]]);
  const data = await modrinth(`search?query=${encodeURIComponent(query)}&facets=${encodeURIComponent(facets)}&limit=10`, signal);
  return data.hits.map((p: any) => ({ id: p.project_id, slug: p.slug, title: p.title, description: p.description, type: p.project_type }));
}
export async function resolveModrinth(server: ServerSpec, project: string, versionId?: string, signal?: AbortSignal) {
  const selectedLoader = loader(server); const seen = new Set<string>(); const files: { project: string; version: string; url: string; path: string; sha512: string }[] = [];
  async function visit(id: string, exact?: string) {
    if (seen.has(id)) return; seen.add(id);
    if (seen.size > 50) throw new Error('Dependency graph exceeds 50 projects. Install a smaller set.');
    const versions = exact ? [await modrinth(`version/${encodeURIComponent(exact)}`, signal)] : await modrinth(`project/${encodeURIComponent(id)}/version?loaders=${encodeURIComponent(JSON.stringify([selectedLoader]))}&game_versions=${encodeURIComponent(JSON.stringify([server.version]))}`, signal);
    const version = versions.find((v: any) => v.game_versions.includes(server.version) && v.loaders.includes(selectedLoader));
    if (!version) throw new Error(`No compatible ${selectedLoader} ${server.version} release exists for ${id}.`);
    const metadata = await modrinth(`project/${encodeURIComponent(version.project_id)}`, signal);
    if (metadata.server_side === 'unsupported') throw new Error(`${metadata.title} is client-only and cannot be installed on this server.`);
    const file = version.files.find((f: any) => f.primary) || version.files[0];
    if (!file || !/^[a-zA-Z0-9._+ -]+\.jar$/.test(file.filename) || !file.hashes?.sha512) throw new Error('This project is not a downloadable server JAR with a checksum.');
    for (const dependency of version.dependencies || []) {
      if (dependency.dependency_type !== 'required') continue;
      if (!dependency.project_id && !dependency.version_id) throw new Error('A required external dependency must be supplied by the user.');
      await visit(dependency.project_id || dependency.version_id, dependency.version_id || undefined);
    }
    if (!files.some(f => f.project === version.project_id)) files.push({ project: version.project_id, version: version.id, url: file.url, path: `${selectedLoader === 'paper' ? 'plugins' : 'mods'}/${file.filename}`, sha512: file.hashes.sha512 });
  }
  await visit(project, versionId); return files;
}
