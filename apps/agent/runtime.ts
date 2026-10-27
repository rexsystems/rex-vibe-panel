import Docker from 'dockerode';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, stat, open, rename, unlink } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { resolve, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { PassThrough, Readable } from 'node:stream';
import { checkedFetch } from '../../packages/security/network.js';
import type { Operation, ServerSpec } from '../../packages/shared/contracts.js';

const docker = new Docker({ socketPath: process.env.DOCKER_SOCKET || '/var/run/docker.sock' });
const root = resolve(process.env.AGENT_DATA_DIR || './data/agent');
const hostRoot = process.env.AGENT_HOST_DATA_DIR || root;
const pulled = new Set<string>();
export const helperImage = 'node:24-alpine';
export function gameImage(server: ServerSpec) {
  if (server.edition === 'bedrock') return 'itzg/minecraft-bedrock-server:stable';
  const [major, minor, patch = 0] = server.version.split('.').map(Number);
  const java = major === 1 && minor <= 16 ? 8 : major === 1 && (minor < 20 || (minor === 20 && patch < 5)) ? 17 : 21;
  return `itzg/minecraft-server:java${java}`;
}
export function validateRelativePath(path: string) {
  if (!path || path.includes('\0') || path.includes('\\') || path.startsWith('/') || path.split('/').includes('..')) throw new Error('Use a relative path inside the server directory.');
  return path;
}
async function pull(image: string) {
  if (pulled.has(image)) return;
  try { await docker.getImage(image).inspect(); }
  catch { await new Promise<void>((res, rej) => docker.pull(image, (error: any, stream: any) => { if (error) return rej(error); docker.modem.followProgress(stream, (e: any) => e ? rej(e) : res()); })); }
  pulled.add(image);
}
async function inspect(container: Docker.Container) { try { return await container.inspect(); } catch (e: any) { if (e.statusCode === 404) return null; throw e; } }
export function buildContainerOptions(server: ServerSpec & { address?: string }, bindRoot: string): Docker.ContainerCreateOptions {
  const bedrock = server.edition === 'bedrock';
  const bindings: Record<string, { HostPort: string }[]> = {};
  if (bedrock) {
    bindings['19132/tcp'] = [{ HostPort: String(server.port) }];
    for (let n = 1; n <= 16; n++) bindings[`${server.port + n}/udp`] = [{ HostPort: String(server.port + n) }];
  } else bindings['25565/tcp'] = [{ HostPort: String(server.port) }];
  return {
    name: `rex-${server.id}`, Image: gameImage(server),
    Labels: { 'rex.managed': 'true', 'rex.server': server.id, 'rex.kind': 'game' },
    Env: ['EULA=TRUE', `VERSION=${server.version}`, 'UID=1000', 'GID=1000',
      ...(bedrock ? ['SERVER_PORT=19132', `SERVER_UDP_PORTS=${server.address}:${server.port + 1}-${server.port + 16}:${server.port + 1}-${server.port + 16}`] : [`TYPE=${server.edition.toUpperCase()}`, `MEMORY=${Math.floor(server.memoryMb * 0.75)}M`, 'ENABLE_RCON=false', 'ENABLE_ROLLING_LOGS=true']),
    ],
    ExposedPorts: Object.fromEntries(Object.keys(bindings).map(p => [p, {}])),
    OpenStdin: true, StdinOnce: false, AttachStdin: false, Tty: false,
    HostConfig: {
      Binds: [`${join(bindRoot, 'servers', server.id)}:/data:z`], Memory: server.memoryMb * 1024 * 1024,
      MemorySwap: server.memoryMb * 1024 * 1024, NanoCpus: Math.floor(server.cpu * 1e9), PidsLimit: 512,
      CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'],
      // The image entrypoint drops to UID 1000 after preparing /data.
      CapAdd: ['CHOWN', 'SETUID', 'SETGID', 'DAC_OVERRIDE', 'FOWNER'],
      PortBindings: bindings, RestartPolicy: { Name: 'no' },
      LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '3' } },
    },
  };
}
const helperJobs = new Map<string, Promise<Docker.Container>>();
async function helper(server: ServerSpec) {
  if (helperJobs.has(server.id)) return helperJobs.get(server.id)!;
  const job = createHelper(server); helperJobs.set(server.id, job);
  try { return await job; } finally { helperJobs.delete(server.id); }
}
async function createHelper(server: ServerSpec) {
  await mkdir(join(root, 'servers', server.id), { recursive: true });
  await pull(helperImage);
  let container = docker.getContainer(`rex-files-${server.id}`), info = await inspect(container);
  if (!info) {
    container = await docker.createContainer({ name: `rex-files-${server.id}`, Image: helperImage,
      Labels: { 'rex.managed': 'true', 'rex.server': server.id, 'rex.kind': 'files' },
      Cmd: ['node', '-e', 'setInterval(()=>{},2147483647)'], User: '0',
      HostConfig: { Binds: [`${join(hostRoot, 'servers', server.id)}:/data:z`], NetworkMode: 'none', ReadonlyRootfs: true,
        CapDrop: ['ALL'], CapAdd: ['DAC_OVERRIDE', 'CHOWN', 'FOWNER'], SecurityOpt: ['no-new-privileges:true'], Memory: 512 * 1024 * 1024, NanoCpus: 250_000_000, PidsLimit: 32, RestartPolicy: { Name: 'unless-stopped' } },
    }); info = await container.inspect();
  }
  if (!info.State.Running) await container.start();
  return container;
}
async function exec(container: Docker.Container, cmd: string[], signal?: AbortSignal, seconds = 60, cap = 2_100_000) {
  const run = await container.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true, Tty: false, WorkingDir: '/data' });
  const stream = await run.start({ hijack: true, stdin: false });
  const stdout = new PassThrough(), stderr = new PassThrough();
  let output = '', error = '', size = 0;
  const collect = (kind: 'out' | 'err', chunk: Buffer) => { size += chunk.length; if (size > cap) { stream.destroy(new Error('Command output exceeds limit.')); return; } if (kind === 'out') output += chunk.toString(); else error += chunk.toString(); };
  stdout.on('data', b => collect('out', b)); stderr.on('data', b => collect('err', b));
  docker.modem.demuxStream(stream, stdout, stderr);
  const abort = () => stream.destroy(new Error('Command cancelled.'));
  signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => stream.destroy(new Error('Command timed out.')), seconds * 1000);
  try {
    await new Promise<void>((res, rej) => { stream.on('end', res); stream.on('error', rej); });
    const state = await run.inspect();
    return { stdout: output, stderr: error, exitCode: state.ExitCode };
  } catch (e) {
    // Docker has no exec kill API; stopping the container terminates timed-out processes.
    await container.stop({ t: 0 }).catch(() => {}); throw e;
  } finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort); }
}
const fileScript = `
const fs=require('node:fs/promises'),path=require('node:path');
async function main(){const action=process.argv[1],relative=process.argv[2]||'.',extra=process.argv[3]||'';
if(relative.startsWith('/')||relative.includes('\\\\')||relative.split('/').includes('..'))throw Error('Invalid path');
const target=path.resolve('/data',relative);if(target!='/data'&&!target.startsWith('/data/'))throw Error('Invalid path');
let cursor=target;while(true){try{const real=await fs.realpath(cursor);if(real!='/data'&&!real.startsWith('/data/'))throw Error('Symlink escapes server directory');break}catch(e){if(e.code!=='ENOENT')throw e;cursor=path.dirname(cursor)}}
if(action==='list'){const entries=await fs.readdir(target,{withFileTypes:true});return entries.map(e=>({name:e.name,directory:e.isDirectory(),symlink:e.isSymbolicLink()}))}
if(action==='read'){const stat=await fs.stat(target);if(stat.size>2000000)throw Error('Use a smaller file (maximum 2 MB)');return{content:await fs.readFile(target,'utf8')}}
if(action==='file-download'){const h=await fs.open(target,'r');try{const b=Buffer.alloc(524288);const r=await h.read(b,0,b.length,Number(extra));return{base64:b.subarray(0,r.bytesRead).toString('base64')}}finally{await h.close()}}
if(action==='write'||action==='upload'){await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,Buffer.from(extra,'base64'));return{ok:true}}
if(action==='remove'){if(target==='/data')throw Error('Cannot remove server root');await fs.rm(target,{recursive:true});return{ok:true}}
if(action==='usage'){async function size(dir){let total=0;for(const e of await fs.readdir(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())total+=await size(p);else if(e.isFile())total+=(await fs.stat(p)).size}return total}return{bytes:await size('/data')}}
}main().then(v=>process.stdout.write(JSON.stringify(v))).catch(e=>{console.error(e.message);process.exit(1)});
`;
async function files(server: ServerSpec, action: string, path = '.', content = '', signal?: AbortSignal) {
  validateRelativePath(path);
  if (action === 'write' || action === 'upload') {
    const tar = await import('tar-stream'), archive = tar.pack(), data = Buffer.from(content, 'base64');
    archive.entry({ name: path, size: data.length, mode: 0o644, uid: 1000, gid: 1000 }, data); archive.finalize();
    await (await helper(server)).putArchive(archive as unknown as NodeJS.ReadableStream, { path: '/data' }); return { ok: true };
  }
  const result = await exec(await helper(server), ['node', '-e', fileScript, action, path, content], signal, 60, 14_000_000);
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || 'File operation failed.');
  return JSON.parse(result.stdout);
}
async function checkSpace(server: ServerSpec, additional = 0) {
  const usage = await files(server, 'usage');
  if (usage.bytes + additional > server.diskMb * 1024 * 1024) throw new Error('Server disk allocation is full. Remove files or ask the administrator for more space.');
}
async function stopGame(server: ServerSpec) {
  const container = docker.getContainer(`rex-${server.id}`), info = await inspect(container);
  const running = !!info?.State.Running;
  if (running) await container.stop({ t: 30 });
  return { container, running };
}
async function backup(server: ServerSpec, signal?: AbortSignal) {
  const { container, running } = await stopGame(server);
  const backupId = randomUUID(); const directory = join(root, 'backups', server.id); await mkdir(directory, { recursive: true });
  const output = join(directory, `${backupId}.tar`), temporary = `${output}.partial`;
  try {
    await pipeline(await (await helper(server)).getArchive({ path: '/data' }), createWriteStream(temporary, { flags: 'wx', mode: 0o600 }), { signal });
    await rename(temporary, output); return { id: backupId, size: (await stat(output)).size };
  } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
  finally { if (running) await container.start(); }
}
export async function performOperation(server: ServerSpec & { address?: string }, operation: Operation, signal?: AbortSignal): Promise<unknown> {
  signal?.throwIfAborted();
  const container = docker.getContainer(`rex-${server.id}`);
  switch (operation.type) {
    case 'status': {
      const info = await inspect(container); const usage = await files(server, 'usage');
      if (usage.bytes > server.diskMb * 1024 * 1024 && info?.State.Running) { await container.stop({ t: 0 }); return { state: 'disk-limit', diskBytes: usage.bytes }; }
      if (!info) return { state: 'not-installed', diskBytes: usage.bytes };
      const metrics = info.State.Running ? await container.stats({ stream: false }) : null;
      return { state: info.State.Status, health: info.State.Health?.Status || null, memoryBytes: metrics?.memory_stats?.usage || 0, diskBytes: usage.bytes, cpuTotal: metrics?.cpu_stats?.cpu_usage?.total_usage || 0, cpuSystem: metrics?.cpu_stats?.system_cpu_usage || 0, onlineCpus: metrics?.cpu_stats?.online_cpus || 1, oomKilled: info.State.OOMKilled };
    }
    case 'install': {
      const info = await inspect(container);
      if (info) { await backup(server, signal); signal?.throwIfAborted(); const current = await inspect(container); if (current?.State.Running) await container.stop({ t: 30 }); await container.remove(); }
      await helper(server); await pull(gameImage(server));
      signal?.throwIfAborted();
      await docker.createContainer(buildContainerOptions(server, hostRoot));
      return { installed: true, image: gameImage(server), message: 'Container prepared. Start the server to download and launch Minecraft.' };
    }
    case 'power': {
      if (!await inspect(container)) throw new Error('Install the server first.');
      if (operation.action === 'start') { await checkSpace(server); await container.start(); }
      if (operation.action === 'stop') await container.stop({ t: 30 });
      if (operation.action === 'restart') { await checkSpace(server); await container.restart({ t: 30 }); }
      if (operation.action === 'kill') await container.kill();
      return { state: (await container.inspect()).State.Status };
    }
    case 'logs': {
      if (!await inspect(container)) return { content: 'Server is not installed. Ask REX to install it.' };
      const buffer = await container.logs({ stdout: true, stderr: true, tail: operation.tail, timestamps: true });
      const out = new PassThrough(), err = new PassThrough(); let content = '';
      out.on('data', b => { content += b.toString(); }); err.on('data', b => { content += b.toString(); });
      docker.modem.demuxStream(Readable.from([buffer]), out, err);
      await new Promise<void>(r => setImmediate(r)); return { content: content.slice(-200000) };
    }
    case 'console': {
      if (!(await inspect(container))?.State.Running) throw new Error('Start the server before sending a console command.');
      const stream = await container.attach({ stream: true, stdin: true, stdout: false, stderr: false, hijack: true });
      stream.write(`${operation.command}\n`); stream.end(); return { sent: true };
    }
    case 'shell': {
      if (!(await inspect(container))?.State.Running) throw new Error('Start the game container before running shell commands. File operations work while it is stopped.');
      return exec(container, ['sh', '-lc', operation.command], signal, operation.timeoutSeconds);
    }
    case 'list': return files(server, 'list', operation.path, '', signal);
    case 'read': return files(server, 'read', operation.path, '', signal);
    case 'file-download': return files(server, 'file-download', operation.path, String(operation.offset), signal);
    case 'write': await checkSpace(server, Buffer.byteLength(operation.content)); return files(server, 'write', operation.path, Buffer.from(operation.content).toString('base64'), signal);
    case 'upload': await checkSpace(server, Buffer.from(operation.base64, 'base64').length); return files(server, 'upload', operation.path, operation.base64, signal);
    case 'remove': return files(server, 'remove', operation.path, '', signal);
    case 'download': {
      validateRelativePath(operation.path); await checkSpace(server);
      const response = await checkedFetch(operation.url, { signal, maxBytes: Math.min(server.diskMb * 1024 * 1024, 256 * 1024 * 1024), headers: { 'User-Agent': 'REX-Vibe-Panel/0.1.0' } });
      if (!response.ok) throw new Error(`Download returned HTTP ${response.status}.`);
      const bytes = Buffer.from(await response.arrayBuffer()); await checkSpace(server, bytes.length);
      if (operation.sha512 && createHash('sha512').update(bytes).digest('hex') !== operation.sha512) throw new Error('Download checksum does not match. File was not installed.');
      // Container archive upload avoids passing large downloads as exec arguments.
      const tar = await import('tar-stream'); const archive = tar.pack();
      const name = validateRelativePath(operation.path);
      archive.entry({ name, size: bytes.length, mode: 0o644, uid: 1000, gid: 1000 }, bytes); archive.finalize();
      await (await helper(server)).putArchive(archive as unknown as NodeJS.ReadableStream, { path: '/data' }); return { path: name, bytes: bytes.length };
    }
    case 'backups': {
      const dir = join(root, 'backups', server.id); await mkdir(dir, { recursive: true });
      return Promise.all((await readdir(dir)).filter(f => f.endsWith('.tar')).map(async name => { const info = await stat(join(dir, name)); return { id: name.slice(0, -4), size: info.size, createdAt: info.mtime.toISOString() }; }));
    }
    case 'backup': return backup(server, signal);
    case 'restore': {
      const path = join(root, 'backups', server.id, `${operation.backupId}.tar`); await stat(path);
      const recovery = await backup(server, signal);
      const { container: game, running } = await stopGame(server);
      let restored = false;
      try {
        const helperContainer = await helper(server);
        const result = await exec(helperContainer, ['node', '-e', "const fs=require('fs');for(const name of fs.readdirSync('/data'))fs.rmSync('/data/'+name,{recursive:true,force:true})"], signal);
        if (result.exitCode) throw new Error(result.stderr);
        await helperContainer.putArchive(createReadStream(path), { path: '/' });
        restored = true;
        return { restored: operation.backupId, recoveryBackup: recovery.id };
      } catch { throw new Error(`Restore failed. Server remains stopped. Recovery backup: ${recovery.id}.`); }
      finally { if (running && restored) await game.start(); }
    }
    case 'backup-download': {
      const handle = await open(join(root, 'backups', server.id, `${operation.backupId}.tar`), 'r');
      try { const buffer = Buffer.alloc(512 * 1024); const { bytesRead } = await handle.read(buffer, 0, buffer.length, operation.offset); return { base64: buffer.subarray(0, bytesRead).toString('base64') }; }
      finally { await handle.close(); }
    }
  }
}
export async function nodeCapacity() {
  await docker.ping();
  const os = await import('node:os'); const fs = await import('node:fs/promises'); await mkdir(root, { recursive: true });
  const disk = await fs.statfs(root); return { memoryMb: Math.floor(os.totalmem() / 1024 / 1024 * 0.85), cpus: os.availableParallelism(), diskMb: Math.floor(disk.bavail * disk.bsize / 1024 / 1024 * 0.9) };
}
