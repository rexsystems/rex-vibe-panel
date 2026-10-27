import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import EmbeddedPostgres from 'embedded-postgres';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { createServer as httpServer } from 'node:http';
import { once } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import WebSocket from 'ws';

let pg: EmbeddedPostgres, directory: string, app: Awaited<ReturnType<typeof import('../apps/api/app.js').buildApp>>, sql: typeof import('../packages/db/index.js').sql;
let adminCookie: string, userCookie: string, otherCookie: string, userId: string, nodeId: string, serverId: string, providerId: string, agent: WebSocket, worker: ChildProcess;
let fakeProvider: ReturnType<typeof httpServer>, providerOrigin: string;
let localInstallCalls = 0, localInstallFailure = false, localDockerAvailable = true;
const headers = (cookie?: string) => ({ 'x-rex-request': '1', ...(cookie ? { cookie } : {}) });
async function call(method: string, path: string, payload?: unknown, cookie?: string) {
  return app.inject({ method: method as any, url: `/api/v1${path}`, headers: headers(cookie), ...(payload !== undefined ? { payload } : {}) });
}
const cookieOf = (response: any) => { const value = response.headers['set-cookie']; return (Array.isArray(value) ? value[0] : value).split(';')[0]; };
async function waitUntil(fn: () => Promise<boolean>, ms = 15000) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await new Promise(r => setTimeout(r, 100)); } throw new Error('Timed out waiting for condition'); }

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'rex-test-'));
  const listener = createServer().listen(0, '127.0.0.1'); await once(listener, 'listening'); const port = (listener.address() as any).port; await new Promise<void>(r => listener.close(() => r()));
  pg = new EmbeddedPostgres({ databaseDir: join(directory, 'pg'), port, user: 'rex', password: 'test-password', persistent: false, initdbFlags: ['--locale=C', '--encoding=UTF8'], onLog: () => {}, onError: () => {} });
  await pg.initialise(); await pg.start(); await pg.createDatabase('rex');
  process.env.DATABASE_URL = `postgres://rex:test-password@localhost:${port}/rex`; process.env.ENCRYPTION_KEY = 'cd'.repeat(32);
  process.env.DEFAULT_AI_PROVIDER = '';
  ({ sql } = await import('../packages/db/index.js')); await sql.unsafe(await readFile('packages/db/001_initial.sql', 'utf8')); await sql.unsafe(await readFile('packages/db/002_node_setup.sql', 'utf8')); await sql.unsafe(await readFile('packages/db/003_chats.sql', 'utf8'));
  const { buildApp } = await import('../apps/api/app.js'); app = await buildApp({ logger: false, serveStatic: false, localNodeInstaller: {
    inspect: async () => ({ available: localDockerAvailable, reason: localDockerAvailable ? null : 'Docker fixture unavailable.', suggestedName: 'Fixture local node', suggestedAddress: '127.0.0.1' }),
    install: async input => { localInstallCalls++; if (localInstallFailure) throw new Error('Fixture agent startup failed.'); await input.progress('launching', 'Starting fixture agent.'); await sql`UPDATE nodes SET last_seen=now(),capacity=${sql.json({ memoryMb: 8192, cpus: 8, diskMb: 100000 })} WHERE id=${input.nodeId}`; },
  } });
  await app.listen({ host: '127.0.0.1', port: 0 }); process.env.APP_ORIGIN = `http://127.0.0.1:${(app.server.address() as any).port}`;
  fakeProvider = httpServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk; const body = JSON.parse(raw || '{}');
    if (req.url === '/v1/models') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'test-model' }] })); return; }
    const test = body.messages?.some((m: any) => m.content?.includes('Connection test.'));
    const usedTool = body.messages?.some((m: any) => m.role === 'tool');
    const delta = test ? { tool_calls: [{ index: 0, id: 'connection-test', function: { name: 'rex_connection_test', arguments: '{"ok":true}' } }] } : usedTool ? { content: 'The server is running. Verified using the status tool.' } : { tool_calls: [{ index: 0, id: 'status-call', function: { name: 'server_operation', arguments: '{"operation":{"type":"status"}}' } }] };
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`);
  }).listen(0, '127.0.0.1'); await once(fakeProvider, 'listening'); providerOrigin = `http://127.0.0.1:${(fakeProvider.address() as any).port}`;
});
afterAll(async () => {
  agent?.close(); if (worker && worker.exitCode === null) { worker.kill('SIGTERM'); await Promise.race([once(worker, 'exit'), new Promise(r => setTimeout(r, 5000))]); if (worker.exitCode === null) worker.kill('SIGKILL'); }
  await app?.close(); await sql?.end(); if (fakeProvider) await new Promise<void>(r => fakeProvider.close(() => r())); await pg?.stop(); if (directory) await rm(directory, { recursive: true, force: true });
});
describe.sequential('real PostgreSQL API and worker with simulated node/provider', () => {
  it('accepts eight-character passwords without a setup token and prevents a second setup', async () => {
    expect((await call('POST', '/auth/setup', { email: 'admin@example.com', password: 'seven77' })).statusCode).toBe(400);
    const response = await call('POST', '/auth/setup', { email: 'admin@example.com', password: 'test1234' });
    expect(response.statusCode, response.body).toBe(200); adminCookie = cookieOf(response); expect(response.json().role).toBe('admin');
    expect((await call('POST', '/auth/setup', { email: 'x@example.com', password: 'test1234' })).statusCode).toBe(409);
    expect((await call('POST', '/auth/login', { email: 'admin@example.com', password: 'test1234' })).statusCode).toBe(200);
  });
  it('creates normal users with no resource access or admin privilege', async () => {
    expect((await call('POST', '/auth/register', { email: 'short@example.com', password: 'seven77' })).statusCode).toBe(400);
    const response = await call('POST', '/auth/register', { email: 'user@example.com', password: 'test1234' }); userCookie = cookieOf(response); userId = response.json().id;
    expect((await call('POST', '/auth/login', { email: 'user@example.com', password: 'test1234' })).statusCode).toBe(200);
    const other = await call('POST', '/auth/register', { email: 'other@example.com', password: 'test-password-long' }); otherCookie = cookieOf(other);
    expect((await call('GET', '/servers', undefined, userCookie)).json()).toEqual([]);
    expect((await call('GET', '/admin/nodes', undefined, userCookie)).statusCode).toBe(403);
    expect((await call('GET', '/servers')).statusCode).toBe(401);
  });
  it('bootstraps one private Mantle default for the first admin without sharing it', async () => {
    const { bootstrapDefaultProvider } = await import('../packages/ai/bootstrap.js');
    const { decrypt } = await import('../packages/security/index.js');
    const owner = (await sql`SELECT id FROM users WHERE role='admin'`)[0];
    const previous = { enabled: process.env.DEFAULT_AI_PROVIDER, key: process.env.BEDROCK_MANTLE_API_KEY, model: process.env.BEDROCK_MANTLE_MODEL, region: process.env.BEDROCK_MANTLE_REGION };
    Object.assign(process.env, { DEFAULT_AI_PROVIDER: 'bedrock-mantle', BEDROCK_MANTLE_API_KEY: 'fixture-mantle-key', BEDROCK_MANTLE_MODEL: 'qwen.qwen3-coder-next', BEDROCK_MANTLE_REGION: 'us-east-1' });
    try {
      await bootstrapDefaultProvider(userId);
      expect((await call('GET', '/providers', undefined, userCookie)).json()).toEqual([]);
      await Promise.all([bootstrapDefaultProvider(owner.id), bootstrapDefaultProvider(owner.id)]);
      const list = await call('GET', '/providers', undefined, adminCookie);
      expect(list.json()).toHaveLength(1); expect(list.json()[0]).toMatchObject({ kind: 'bedrock-mantle', model: 'qwen.qwen3-coder-next', isDefault: true, toolCapable: false, baseUrl: 'https://bedrock-mantle.us-east-1.api.aws/v1' });
      expect(list.body).not.toContain('fixture-mantle-key');
      const [stored] = await sql`SELECT secret FROM providers WHERE owner_id=${owner.id}`;
      expect(stored.secret).not.toContain('fixture-mantle-key'); expect(decrypt<any>(stored.secret).apiKey).toBe('fixture-mantle-key');
      const deletion = await call('DELETE', `/providers/${list.json()[0].id}`, undefined, adminCookie); expect(deletion.statusCode).toBe(200);
      await bootstrapDefaultProvider(owner.id);
      expect((await call('GET', '/providers', undefined, adminCookie)).json()).toEqual([]);
    } finally {
      process.env.DEFAULT_AI_PROVIDER = previous.enabled || '';
      for (const [key, value] of Object.entries({ BEDROCK_MANTLE_API_KEY: previous.key, BEDROCK_MANTLE_MODEL: previous.model, BEDROCK_MANTLE_REGION: previous.region })) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  });
  it('rejects cross-origin writes and incorrect credentials', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { 'x-rex-request': '1', origin: 'https://evil.example' }, payload: { email: 'user@example.com', password: 'test-password-long' } });
    expect(response.statusCode).toBe(403);
    expect((await call('POST', '/auth/login', { email: 'user@example.com', password: 'wrong-password-long' })).statusCode).toBe(401);
  });
  it('offers optional local-node setup to admins and handles Docker preflight', async () => {
    expect((await call('GET', '/admin/onboarding', undefined, userCookie)).statusCode).toBe(403);
    expect((await call('POST', '/admin/nodes/local', { name: 'Forbidden', address: '127.0.0.1' }, userCookie)).statusCode).toBe(403);
    expect((await call('GET', '/admin/onboarding', undefined, adminCookie)).json().needsChoice).toBe(true);
    localDockerAvailable = false;
    expect((await call('POST', '/admin/nodes/local', { name: 'Local node', address: '127.0.0.1' }, adminCookie)).statusCode).toBe(422);
    expect(await sql`SELECT id FROM nodes`).toHaveLength(0);
    localDockerAvailable = true;
    expect((await call('POST', '/admin/onboarding/skip', {}, adminCookie)).statusCode).toBe(200);
    expect((await call('GET', '/admin/onboarding', undefined, adminCookie)).json().needsChoice).toBe(false);
  });
  it('sets up one local node, deduplicates requests and retries with the same node', async () => {
    const [first, second] = await Promise.all([call('POST', '/admin/nodes/local', { name: 'Local fixture', address: '127.0.0.1' }, adminCookie), call('POST', '/admin/nodes/local', { name: 'Local fixture', address: '127.0.0.1' }, adminCookie)]);
    expect(first.statusCode, first.body).toBe(200); expect(second.statusCode, second.body).toBe(200);
    const nodeId = first.json().node_id;
    expect(second.json().node_id).toBe(nodeId); expect(first.body).not.toContain('enrollmentToken');
    await waitUntil(async () => (await sql`SELECT status FROM node_setup_jobs WHERE id=${first.json().id}`)[0]?.status === 'complete');
    expect(await sql`SELECT id FROM nodes`).toHaveLength(1); expect(localInstallCalls).toBe(1);
    const existing = await call('POST', '/admin/nodes/local', { name: 'Local fixture', address: '127.0.0.1' }, adminCookie); expect(existing.json().status).toBe('complete'); expect(localInstallCalls).toBe(1);
    await sql`UPDATE nodes SET last_seen=NULL WHERE id=${nodeId}`;
    localInstallFailure = true;
    const failed = await call('POST', '/admin/nodes/local', { name: 'Local fixture', address: '127.0.0.1' }, adminCookie);
    await waitUntil(async () => (await sql`SELECT status FROM node_setup_jobs WHERE id=${failed.json().id}`)[0]?.status === 'failed');
    localInstallFailure = false;
    const retry = await call('POST', '/admin/nodes/local', { name: 'Local fixture', address: '127.0.0.1' }, adminCookie); expect(retry.json().node_id).toBe(nodeId);
    await waitUntil(async () => (await sql`SELECT status FROM node_setup_jobs WHERE id=${retry.json().id}`)[0]?.status === 'complete');
    expect(await sql`SELECT id FROM nodes`).toHaveLength(1);
  });
  it('enrolls a node and allocates a server while preventing overlapping ports', async () => {
    const response = await call('POST', '/admin/nodes', { name: 'Integration node', address: '203.0.113.20' }, adminCookie);
    expect(response.statusCode, response.body).toBe(200); nodeId = response.json().id;
    agent = new WebSocket(`${process.env.APP_ORIGIN!.replace('http:', 'ws:')}/api/v1/agent/connect`); await once(agent, 'open');
    let ready = false;
    agent.on('message', raw => { const msg = JSON.parse(raw.toString()); if (msg.type === 'ready') { ready = true; agent.send(JSON.stringify({ type: 'heartbeat', capacity: { memoryMb: 8192, cpus: 8, diskMb: 100000 } })); } if (msg.type === 'request') agent.send(JSON.stringify({ type: 'response', id: msg.id, result: { state: 'running', memoryBytes: 1000000, diskBytes: 1000 } })); });
    agent.send(JSON.stringify({ type: 'auth', enroll: true, token: response.json().enrollmentToken }));
    await waitUntil(async () => ready && !!(await sql`SELECT last_seen FROM nodes WHERE id=${nodeId}`)[0]?.last_seen);
    const input = { name: 'Integration Minecraft', nodeId, ownerId: userId, edition: 'paper', version: '1.21.11', memoryMb: 2048, cpu: 1, diskMb: 10240, port: 25565, eulaAccepted: true };
    const created = await call('POST', '/admin/servers', input, adminCookie); expect(created.statusCode, created.body).toBe(200); serverId = created.json().id;
    expect((await call('POST', '/admin/servers', input, adminCookie)).statusCode).toBe(409);
    expect((await call('POST', '/admin/servers', { ...input, port: 25566, memoryMb: 20000 }, adminCookie)).statusCode).toBe(409);
    expect((await call('GET', `/servers/${serverId}`, undefined, otherCookie)).statusCode).toBe(404);
  });
  it('encrypts provider keys, requires private origin approval, and verifies tool calling', async () => {
    const response = await call('POST', '/providers', { name: 'Test provider', kind: 'openai', baseUrl: `${providerOrigin}/v1`, model: 'test-model', apiKey: 'never-expose-this' }, userCookie);
    expect(response.statusCode, response.body).toBe(200); providerId = response.json().id; expect(response.body).not.toContain('never-expose-this');
    const row = (await sql`SELECT secret FROM providers WHERE id=${providerId}`)[0]; expect(row.secret).not.toContain('never-expose-this');
    expect((await call('PUT', `/providers/${providerId}/default`, {}, userCookie)).statusCode).toBe(200);
    expect((await call('GET', '/providers', undefined, userCookie)).json()[0].isDefault).toBe(true);
    expect((await call('PUT', `/providers/${providerId}/default`, {}, otherCookie)).statusCode).toBe(404);
    expect((await call('POST', `/providers/${providerId}/test`, {}, userCookie)).statusCode).toBe(422);
    expect((await call('PUT', '/admin/settings', { trustedProviderOrigins: [providerOrigin] }, adminCookie)).statusCode).toBe(200);
    const tested = await call('POST', `/providers/${providerId}/test`, {}, userCookie); expect(tested.statusCode, tested.body).toBe(200); expect(tested.json().toolCapable).toBe(true);
    expect((await call('GET', `/providers/${providerId}/models`, undefined, userCookie)).json()).toEqual(['test-model']);
    expect((await call('POST', `/providers/${providerId}/test`, {}, otherCookie)).statusCode).toBe(404);
    const updated = await call('PUT', `/providers/${providerId}`, { name: 'Renamed test provider', kind: 'openai', baseUrl: `${providerOrigin}/v1`, model: 'test-model', apiKey: '' }, userCookie);
    expect(updated.statusCode, updated.body).toBe(200); expect(updated.body).not.toContain('never-expose-this'); expect(updated.json().toolCapable).toBe(false);
    const { decrypt } = await import('../packages/security/index.js'); expect(decrypt<any>((await sql`SELECT secret FROM providers WHERE id=${providerId}`)[0].secret).apiKey).toBe('never-expose-this');
    expect((await call('POST', `/providers/${providerId}/test`, {}, userCookie)).json().toolCapable).toBe(true);
  });
  it('executes a durable AI run through real worker and node transport', async () => {
    worker = spawn(process.execPath, ['--import', 'tsx', 'apps/worker/index.ts'], { env: process.env, stdio: 'pipe' });
    let errors = ''; worker.stderr?.on('data', b => { errors += b; });
    const response = await call('POST', `/servers/${serverId}/chat`, { prompt: 'Check server status.', providerId }, userCookie);
    expect(response.statusCode, response.body).toBe(200);
    const runId = response.json().id;
    await waitUntil(async () => (await sql`SELECT status FROM runs WHERE id=${runId}`)[0]?.status === 'completed').catch(error => { throw new Error(`${error.message}: ${errors}`); });
    const events = (await call('GET', `/servers/${serverId}/events`, undefined, userCookie)).json();
    expect(events.some((e: any) => e.type === 'tool.completed' && e.data.result.state === 'running')).toBe(true);
    expect((await call('GET', `/servers/${serverId}/messages`, undefined, userCookie)).body).toContain('Verified using the status tool');
  });
  it('prevents concurrent mutations while allowing read operations', async () => {
    const { acquireLock } = await import('../packages/db/index.js'); await acquireLock(serverId, 'test-lock');
    expect((await call('POST', `/servers/${serverId}/operations`, { type: 'power', action: 'stop' }, userCookie)).statusCode).toBe(409);
    expect((await call('POST', `/servers/${serverId}/operations`, { type: 'status' }, userCookie)).statusCode).toBe(200);
    await sql`DELETE FROM server_locks WHERE server_id=${serverId}`;
    expect((await call('POST', `/servers/${serverId}/operations`, { type: 'shell', command: 'pwd' }, userCookie)).statusCode).toBe(200);
  });
  it('stops a queued run before any tool runs', async () => {
    const [chat] = await sql`INSERT INTO chats (server_id,user_id,title) VALUES (${serverId},${userId},'Stop chat') RETURNING id`;
    const [run] = await sql`INSERT INTO runs (server_id,user_id,provider_id,prompt,cancel_requested,chat_id) VALUES (${serverId},${userId},${providerId},'Do not execute this cancelled request',true,${chat.id}) RETURNING id`;
    await waitUntil(async () => (await sql`SELECT status FROM runs WHERE id=${run.id}`)[0]?.status === 'stopped');
    expect((await sql`SELECT id FROM agent_requests WHERE run_id=${run.id}`)).toHaveLength(0);
  });
  it('marks abandoned runs interrupted without replaying their tool requests', async () => {
    const [chat] = await sql`INSERT INTO chats (server_id,user_id,title) VALUES (${serverId},${userId},'Abandoned chat') RETURNING id`;
    const [run] = await sql`INSERT INTO runs (server_id,user_id,provider_id,prompt,status,worker_id,heartbeat_at,chat_id) VALUES (${serverId},${userId},${providerId},'abandoned request','running','dead-worker',now()-interval '2 minutes',${chat.id}) RETURNING id`;
    await waitUntil(async () => (await sql`SELECT status FROM runs WHERE id=${run.id}`)[0]?.status === 'interrupted', 20000);
    expect((await sql`SELECT id FROM agent_requests WHERE run_id=${run.id}`)).toHaveLength(0);
  });
  it('creates a separate chat thread with New chat', async () => {
    const first = await call('GET', `/servers/${serverId}/chats`, undefined, userCookie);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().length).toBeGreaterThan(0);
    const created = await call('POST', `/servers/${serverId}/chats`, {}, userCookie);
    expect(created.statusCode, created.body).toBe(200);
    expect(created.json().title).toBe('New chat');
    const empty = await call('GET', `/servers/${serverId}/messages?chatId=${created.json().id}`, undefined, userCookie);
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual([]);
    const listed = await call('GET', `/servers/${serverId}/chats`, undefined, userCookie);
    expect(listed.json().some((c: any) => c.id === created.json().id)).toBe(true);
  });
  it('ships corresponding source and revokes a session on logout', async () => {
    const source = await call('GET', '/source/archive'); expect(source.statusCode).toBe(200); expect(source.headers['content-type']).toContain('application/x-tar'); expect(source.rawPayload.includes(Buffer.from('AGPL-3.0-only'))).toBe(true);
    expect((await call('POST', '/auth/logout', {}, otherCookie)).statusCode).toBe(200);
    expect((await call('GET', '/me', undefined, otherCookie)).statusCode).toBe(401);
  });
});
