import 'dotenv/config';
import WebSocket from 'ws';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { z } from 'zod';
import { operationSchema, serverInputSchema, readOperations } from '../../packages/shared/contracts.js';
import { performOperation, nodeCapacity } from './runtime.js';

const directory = resolve(process.env.AGENT_DATA_DIR || './data/agent'); await mkdir(directory, { recursive: true });
const credentialPath = join(directory, 'identity.json');
let identity: { token: string; nodeId: string } | undefined;
try { identity = JSON.parse(await readFile(credentialPath, 'utf8')); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
const panelUrl = process.env.AGENT_PANEL_URL || 'ws://localhost:3000/api/v1/agent/connect';
if (!identity && !process.env.AGENT_ENROLLMENT_TOKEN) throw new Error('Set AGENT_ENROLLMENT_TOKEN from the panel Administration page.');
if (!panelUrl.startsWith('wss://') && !['localhost', '127.0.0.1', 'panel'].includes(new URL(panelUrl).hostname)) throw new Error('Remote node connections require WSS.');
let stopped = false; let socket: WebSocket; let retry = 1000;
const operations = new Map<string, AbortController>();
const processed = new Map<string, unknown>();
const servers = new Map<string, any>();
const mutationTails = new Map<string, Promise<void>>();
async function exclusive<T>(serverId: string, fn: () => Promise<T>): Promise<T> {
  const previous = mutationTails.get(serverId) || Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  const tail = previous.then(() => current); mutationTails.set(serverId, tail);
  await previous;
  try { return await fn(); }
  finally { release(); if (mutationTails.get(serverId) === tail) mutationTails.delete(serverId); }
}
const registryPath = join(directory, 'servers.json');
try { for (const spec of JSON.parse(await readFile(registryPath, 'utf8'))) servers.set(spec.id, spec); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
let saveRegistry = Promise.resolve();
async function connect() {
  if (stopped) return;
  socket = new WebSocket(panelUrl, { maxPayload: 16 * 1024 * 1024 });
  const send = (data: unknown) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(data)); };
  const heartbeat = setInterval(() => { nodeCapacity().then(capacity => send({ type: 'heartbeat', capacity })).catch(() => {}); }, 5000);
  const quota = setInterval(async () => { for (const server of servers.values()) await performOperation(server, { type: 'status' }).catch(() => {}); }, 15000);
  socket.on('open', () => send({ type: 'auth', token: identity?.token || process.env.AGENT_ENROLLMENT_TOKEN, enroll: !identity }));
  socket.on('message', async raw => {
    let requestId: string | undefined;
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'enrolled') {
        identity = { token: z.string().parse(msg.token), nodeId: z.uuid().parse(msg.nodeId) };
        await writeFile(`${credentialPath}.tmp`, JSON.stringify(identity), { mode: 0o600 }); await rename(`${credentialPath}.tmp`, credentialPath);
      }
      if (msg.type === 'ready') { retry = 1000; send({ type: 'heartbeat', capacity: await nodeCapacity() }); console.log('REX agent connected.'); }
      if (msg.type === 'cancel') operations.get(msg.id)?.abort();
      if (msg.type === 'request') {
        const id = z.uuid().parse(msg.id); requestId = id;
        if (processed.has(id)) { send(processed.get(id)); return; }
        if (operations.has(id)) return;
        z.uuid().parse(msg.server.id); serverInputSchema.parse(msg.server);
        if (msg.server.nodeId !== identity?.nodeId) throw new Error('Request belongs to a different node.');
        const operation = operationSchema.parse(msg.operation);
        servers.set(msg.server.id, msg.server);
        saveRegistry = saveRegistry.then(async () => { await writeFile(`${registryPath}.tmp`, JSON.stringify([...servers.values()]), { mode: 0o600 }); await rename(`${registryPath}.tmp`, registryPath); });
        await saveRegistry;
        const controller = new AbortController(); operations.set(id, controller);
        let response: unknown;
        try {
          const execute = () => { controller.signal.throwIfAborted(); return performOperation(msg.server, operation, controller.signal); };
          response = { type: 'response', id, result: await (readOperations.has(operation.type) ? execute() : exclusive(msg.server.id, execute)) };
        }
        catch (error: any) { response = { type: 'response', id, error: String(error.message).slice(0, 4000) }; }
        finally { operations.delete(id); }
        processed.set(id, response); if (processed.size > 1000) processed.delete(processed.keys().next().value!); send(response);
      }
    } catch { if (requestId) send({ type: 'response', id: requestId, error: 'Agent rejected an invalid server operation or could not persist its registry.' }); else console.error('Agent rejected an invalid request.'); }
  });
  socket.on('error', () => console.error('Panel connection failed. Check AGENT_PANEL_URL and TLS configuration.'));
  socket.on('close', () => {
    clearInterval(heartbeat); clearInterval(quota);
    for (const controller of operations.values()) controller.abort();
    if (!stopped) setTimeout(connect, retry); retry = Math.min(retry * 2, 30000);
  });
}
for (const event of ['SIGINT', 'SIGTERM']) process.on(event, () => { stopped = true; for (const controller of operations.values()) controller.abort(); socket?.close(); });
await connect();
