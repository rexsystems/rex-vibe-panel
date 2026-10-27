import EmbeddedPostgres from 'embedded-postgres';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';

const directory = await mkdtemp(join(tmpdir(), 'rex-browser-'));
const listener = createServer().listen(0, '127.0.0.1'); await once(listener, 'listening'); const dbPort = (listener.address() as any).port; await new Promise<void>(r => listener.close(() => r()));
const pg = new EmbeddedPostgres({ databaseDir: join(directory, 'pg'), port: dbPort, user: 'rex', password: 'browser-test', persistent: false, initdbFlags: ['--locale=C', '--encoding=UTF8'], onLog: () => {}, onError: () => {} });
await pg.initialise(); await pg.start(); await pg.createDatabase('rex');
process.env.DATABASE_URL = `postgres://rex:browser-test@localhost:${dbPort}/rex`;
process.env.ENCRYPTION_KEY = 'ef'.repeat(32); process.env.APP_ORIGIN = 'http://127.0.0.1:3301';
process.env.DEFAULT_AI_PROVIDER = '';
const { sql } = await import('../packages/db/index.js'); await sql.unsafe(await readFile('packages/db/001_initial.sql', 'utf8')); await sql.unsafe(await readFile('packages/db/002_node_setup.sql', 'utf8')); await sql.unsafe(await readFile('packages/db/003_chats.sql', 'utf8'));
const provider = createHttpServer(async (req, res) => {
  if (req.url?.endsWith('/models')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'simulated-model' }, { id: 'simulated-model-2' }] })); return; }
  let raw = ''; for await (const b of req) raw += b; const body = JSON.parse(raw);
  const testing = body.messages?.some((m: any) => m.content?.includes('Connection test.'));
  if (body.messages?.some((m: any) => m.content?.includes('long-running-test'))) await new Promise(resolve => setTimeout(resolve, 5000));
  const done = body.messages?.some((m: any) => m.role === 'tool');
  const delta = testing ? { tool_calls: [{ index: 0, id: 'test', function: { name: 'rex_connection_test', arguments: '{"ok":true}' } }] } : done ? { content: 'Simulated node reports that the server is running. Status verified.' } : { tool_calls: [{ index: 0, id: 'status', function: { name: 'server_operation', arguments: '{"operation":{"type":"status"}}' } }] };
  res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`);
}).listen(0, '127.0.0.1'); await once(provider, 'listening');
const providerOrigin = `http://127.0.0.1:${(provider.address() as any).port}`;
const { buildApp } = await import('../apps/api/app.js'); const app = await buildApp({ logger: false, localNodeInstaller: {
  inspect: async () => ({ available: true, reason: null, suggestedName: 'Simulated local node', suggestedAddress: '127.0.0.1' }),
  install: async input => { await input.progress('launching', 'Starting and enrolling the REX agent.'); await enrollAgent(input.enrollmentToken); },
} });
const files = new Map<string, string>([['server.properties', 'motd=Simulated test server\n']]);
const backups: any[] = []; let state = 'not-installed'; const agents: WebSocket[] = [];
async function enrollAgent(token: string) {
  const agent = new WebSocket('ws://127.0.0.1:3301/api/v1/agent/connect'); agents.push(agent); await once(agent, 'open');
  agent.on('message', raw => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'ready') agent.send(JSON.stringify({ type: 'heartbeat', capacity: { memoryMb: 16384, cpus: 8, diskMb: 100000 } }));
    if (msg.type === 'request') {
      const op = msg.operation; let result: unknown = { ok: true };
      if (op.type === 'status') result = { state, memoryBytes: 1024 * 1024, diskBytes: 500 };
      if (op.type === 'install') { state = 'created'; result = { installed: true }; }
      if (op.type === 'power') { state = ['start', 'restart'].includes(op.action) ? 'running' : 'exited'; result = { state }; }
      if (op.type === 'logs') result = { content: 'Simulated console: test fixture, not a real Minecraft process.' };
      if (op.type === 'list') {
        const prefix = op.path === '.' ? '' : `${op.path}/`; const entries = new Map<string, boolean>();
        for (const path of files.keys()) if (path.startsWith(prefix)) { const relative = path.slice(prefix.length), name = relative.split('/')[0]; entries.set(name, relative.includes('/')); }
        result = [...entries].map(([name, directory]) => ({ name, directory }));
      }
      if (op.type === 'read') result = { content: files.get(op.path) || '' };
      if (op.type === 'write') files.set(op.path, op.content);
      if (op.type === 'upload') files.set(op.path, Buffer.from(op.base64, 'base64').toString());
      if (op.type === 'remove') files.delete(op.path);
      if (op.type === 'shell') result = { stdout: 'simulated-shell-output', stderr: '', exitCode: 0 };
      if (op.type === 'backups') result = backups;
      if (op.type === 'backup') { const backup = { id: crypto.randomUUID(), size: 512, createdAt: new Date().toISOString() }; backups.push(backup); result = backup; }
      if (op.type === 'backup-download' || op.type === 'file-download') result = { base64: op.offset ? '' : Buffer.from('simulated-download').toString('base64') };
      agent.send(JSON.stringify({ type: 'response', id: msg.id, result }));
    }
  });
  agent.send(JSON.stringify({ type: 'auth', enroll: true, token }));
}
app.post('/__test/enroll', async req => { await enrollAgent((req.body as any).token); return { ok: true }; });
app.get('/__test/config', async () => ({ providerOrigin }));
const heartbeat = setInterval(() => { for (const agent of agents) if (agent.readyState === 1) agent.send(JSON.stringify({ type: 'heartbeat', capacity: { memoryMb: 16384, cpus: 8, diskMb: 100000 } })); }, 5000);
await app.listen({ port: 3301, host: '127.0.0.1' });
const worker = spawn(process.execPath, ['--import', 'tsx', 'apps/worker/index.ts'], { env: process.env, stdio: 'inherit' });
console.log('REX browser fixture ready: http://127.0.0.1:3301');
let closing = false;
for (const event of ['SIGTERM', 'SIGINT']) process.on(event, async () => {
  if (closing) return; closing = true; clearInterval(heartbeat); for (const agent of agents) agent.close(); worker.kill('SIGTERM');
  await Promise.race([once(worker, 'exit'), new Promise(r => setTimeout(r, 3000))]); worker.kill('SIGKILL');
  await app.close(); await sql.end(); provider.close(); await pg.stop(); await rm(directory, { recursive: true, force: true }); process.exit(0);
});
