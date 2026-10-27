import Docker from 'dockerode';
import { hostname, networkInterfaces } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import type { Readable } from 'node:stream';

export type LocalNodeEnvironment = { available: boolean; reason: string | null; suggestedName: string; suggestedAddress: string };
export type InstallLocalNode = {
  nodeId: string; enrollmentToken: string; panelOrigin: string;
  signal: AbortSignal; progress: (status: string, message: string) => Promise<void>;
};
export interface LocalNodeInstaller {
  inspect(): Promise<LocalNodeEnvironment>;
  install(input: InstallLocalNode): Promise<void>;
}
const socketPath = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
export const localNodeInstaller: LocalNodeInstaller = {
  async inspect() {
    const suggestedAddress = Object.values(networkInterfaces()).flat().find(address => address?.family === 'IPv4' && !address.internal && !address.address.startsWith('172.17.'))?.address || '127.0.0.1';
    const base = { suggestedName: hostname(), suggestedAddress };
    if (process.platform !== 'linux') return { ...base, available: false, reason: 'Automatic local setup requires Linux.' };
    try {
      await new Docker({ socketPath, timeout: 2000 }).ping();
      return { ...base, available: true, reason: null };
    } catch (error: any) {
      if (['ENOENT', 'ECONNREFUSED'].includes(error.code)) return { ...base, available: false, reason: 'Docker Engine is installed but is not running. Start the Docker service and check again.' };
      if (['EACCES', 'EPERM'].includes(error.code)) return { ...base, available: false, reason: 'Docker is running, but the panel cannot access its socket. Grant the panel user Docker access and restart the panel.' };
      return { ...base, available: false, reason: 'Docker Engine is not available to the panel. Install and start Docker, then grant the panel access to its Docker socket and retry.' };
    }
  },
  async install(input) {
    const docker = new Docker({ socketPath });
    input.signal.throwIfAborted();
    const hostRoot = process.env.REX_DATA_DIR || '/var/lib/rex';
    if (!isAbsolute(hostRoot) || hostRoot.includes(':')) throw new Error('REX_DATA_DIR must be an absolute host path without colons.');
    let panelContainer: Docker.ContainerInspectInfo | undefined;
    try { panelContainer = await docker.getContainer(hostname()).inspect(); } catch { /* Native installations have no panel container. */ }
    let image = process.env.LOCAL_AGENT_IMAGE || panelContainer?.Image || 'rex-vibe-panel:local';
    try { await docker.getImage(image).inspect(); }
    catch {
      if (process.env.LOCAL_AGENT_IMAGE) throw new Error('LOCAL_AGENT_IMAGE is not installed on this Docker host. Pull or build it, then retry.');
      const context = resolve('.');
      const src = ['package.json', 'pnpm-lock.yaml', 'Dockerfile', '.dockerignore', '.env.example', '.env.agent.example', 'compose.yaml', 'compose.agent.yaml', 'tsconfig.json', 'tsconfig.server.json', 'vite.config.ts', 'vitest.config.ts', 'playwright.config.ts', 'postcss.config.cjs', 'LICENSE', 'README.md', 'DESIGN.md', '.github', 'apps', 'packages', 'scripts', 'tests', 'docs'];
      if (src.some(file => !existsSync(join(context, file)))) throw new Error('Agent image is missing and the panel source checkout is incomplete. Set LOCAL_AGENT_IMAGE to an installed REX image.');
      await input.progress('building', 'Building the REX agent image. This may take several minutes.');
      const stream = await docker.buildImage({ context, src }, { t: image }) as Readable;
      const cancel = () => stream.destroy(new Error('Node setup stopped.'));
      input.signal.addEventListener('abort', cancel, { once: true });
      try { await new Promise<void>((res, rej) => docker.modem.followProgress(stream, error => error ? rej(new Error('Agent image build failed. Check the Docker daemon and network, then retry.')) : res())); }
      finally { input.signal.removeEventListener('abort', cancel); }
    }
    input.signal.throwIfAborted();
    const networks = Object.keys(panelContainer?.NetworkSettings.Networks || {});
    const network = networks[0] || 'host';
    const panelUrl = process.env.LOCAL_AGENT_PANEL_URL || (panelContainer
      ? `ws://${panelContainer.Id.slice(0, 12)}:${process.env.PORT || 3000}/api/v1/agent/connect`
      : `ws://127.0.0.1:${process.env.PORT || 3000}/api/v1/agent/connect`);
    if (panelContainer && !process.env.LOCAL_AGENT_PANEL_URL) throw new Error('Set LOCAL_AGENT_PANEL_URL to the panel service address on its Docker network.');
    const name = `rex-agent-${input.nodeId}`;
    const dataRoot = join(hostRoot, 'nodes', input.nodeId);
    const previous = docker.getContainer(name);
    let previousInfo: Docker.ContainerInspectInfo | undefined;
    try { previousInfo = await previous.inspect(); } catch (error: any) { if (error.statusCode !== 404) throw error; }
    if (previousInfo) { if (previousInfo.State.Running) await previous.stop({ t: 10 }); await previous.remove(); }
    input.signal.throwIfAborted();
    await input.progress('launching', 'Starting and enrolling the REX agent.');
    const agent = await docker.createContainer({ name, Image: image, User: '0',
      Cmd: ['node', 'dist/server/apps/agent/index.js'],
      Labels: { 'rex.managed': 'true', 'rex.node': input.nodeId, 'rex.kind': 'agent' },
      Env: [`AGENT_PANEL_URL=${panelUrl}`, `AGENT_ENROLLMENT_TOKEN=${input.enrollmentToken}`, 'AGENT_DATA_DIR=/var/lib/rex', `AGENT_HOST_DATA_DIR=${dataRoot}`, 'DOCKER_SOCKET=/var/run/docker.sock'],
      HostConfig: { Binds: [`${socketPath}:/var/run/docker.sock`, `${dataRoot}:/var/lib/rex:z`], SecurityOpt: ['label=disable'], NetworkMode: network, RestartPolicy: { Name: 'unless-stopped' }, LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '3' } } },
    });
    input.signal.throwIfAborted(); await agent.start();
  },
};
