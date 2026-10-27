import Fastify, { LogController, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import multipart from '@fastify/multipart';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import staticFiles from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z, ZodError } from 'zod';
import { sql, emit, agentCall, withLock } from '../../packages/db/index.js';
import { credentialsSchema, operationSchema, providerInputSchema, readOperations, serverInputSchema } from '../../packages/shared/contracts.js';
import { decrypt, encrypt, hashPassword, hashToken, token, verifyPassword } from '../../packages/security/index.js';
import { generate, listModels, presets } from '../../packages/ai/providers.js';
import { bootstrapDefaultProvider } from '../../packages/ai/bootstrap.js';
import { localNodeInstaller, type LocalNodeInstaller } from './local-node.js';
import { nodeSetupService } from './node-setup.js';
import type { ProviderInput } from '../../packages/shared/contracts.js';

type User = { id: string; email: string; role: string };
declare module 'fastify' { interface FastifyRequest { user: User } }
const fail = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const uuid = (value: unknown) => z.uuid().parse(value);
const param = (req: FastifyRequest, name: string) => (req.params as Record<string, string>)[name];
const safeProvider = (p: any) => ({ id: p.id, name: p.name, kind: p.kind, ...p.config, toolCapable: p.tool_capable, testedAt: p.tested_at, isDefault: p.is_default === true });
export const trustedOrigins = async (): Promise<string[]> => (await sql`SELECT value FROM settings WHERE key='trusted_provider_origins'`)[0]?.value || [];
export const loadProvider = (row: any): ProviderInput => ({ name: row.name, kind: row.kind, ...row.config, ...decrypt<object>(row.secret) });

export async function buildApp(options: { logger?: boolean; serveStatic?: boolean; localNodeInstaller?: LocalNodeInstaller } = {}) {
  const app = Fastify({ logger: options.logger ?? true, bodyLimit: 3 * 1024 * 1024, logController: new LogController({ disableRequestLogging: true }), ajv: { customOptions: { useDefaults: false, removeAdditional: false } } });
  await app.register(cookie);
  await app.register(rateLimit, { max: Number(process.env.API_RATE_LIMIT || 1200), timeWindow: '1 minute', allowList: req => !req.url.startsWith('/api/v1/') });
  await app.register(websocket, { options: { maxPayload: 16 * 1024 * 1024 } });
  const nodeSetup = nodeSetupService(options.localNodeInstaller || localNodeInstaller);
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 1 } });
  await app.register(swagger, { openapi: { info: { title: 'REX Vibe Panel', version: '0.1.0', license: { name: 'AGPL-3.0-only', url: 'https://www.gnu.org/licenses/agpl-3.0.html' } }, components: { securitySchemes: { session: { type: 'apiKey', in: 'cookie', name: 'rex_session' } } } } });
  await app.register(swaggerUi, { routePrefix: '/api/docs', uiConfig: { requestInterceptor: (request: any) => { request.headers['x-rex-request'] = '1'; return request; } } });
  const bodySchemas: Record<string, z.ZodType> = {
    'POST /api/v1/providers': providerInputSchema,
    'PUT /api/v1/providers/:id': providerInputSchema,
    'PATCH /api/v1/providers/:id/model': z.object({ model: z.string().min(1).max(200) }),
    'POST /api/v1/servers/:id/chat': z.object({ prompt: z.string().min(1).max(16000), providerId: z.uuid(), chatId: z.uuid().optional() }),
    'POST /api/v1/servers/:id/chats': z.object({ title: z.string().trim().min(1).max(120).optional() }),
    'POST /api/v1/admin/nodes': z.object({ name: z.string().min(1).max(80), address: z.string().min(1).max(253) }),
    'POST /api/v1/admin/nodes/local': z.object({ name: z.string().trim().min(1).max(80), address: z.string().trim().min(1).max(253) }),
    'POST /api/v1/admin/servers': serverInputSchema,
    'PUT /api/v1/admin/settings': z.object({ trustedProviderOrigins: z.array(z.url()).max(30) }),
  };
  app.addHook('onRoute', route => {
    if (!route.url.startsWith('/api/v1/')) return;
    const schema = route.schema ||= {};
    const body = bodySchemas[`${route.method} ${route.url}`];
    if (body && !schema.body) schema.body = z.toJSONSchema(body, { target: 'draft-7', io: 'input' });
    schema.tags ||= [route.url.includes('/admin/') ? 'Administration' : route.url.split('/')[3]];
    if (!route.url.includes('/auth/') && !['health','source','agent'].includes(route.url.split('/')[3])) schema.security = [{ session: [] }];
  });
  app.decorateRequest('user');
  app.setErrorHandler((error: any, _req, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ error: error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') });
    if (error.code === '23505') return reply.code(409).send({ error: 'This email, port, or active operation already exists.' });
    if (error.code === '23503') return reply.code(409).send({ error: 'A referenced resource does not exist or is still in use.' });
    if (!error.statusCode || error.statusCode >= 500) app.log.error({ name: error.name, code: error.code, message: error.message }, 'Request failed');
    reply.code(error.statusCode || 500).send({ error: error.statusCode ? error.message : 'The operation failed. Check panel service logs and node connectivity.' });
  });
  app.addHook('onRequest', async (req) => {
    if (req.url.startsWith('/api/v1/') && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const expected = new URL(process.env.APP_ORIGIN || 'http://localhost:5173').origin;
      if (req.headers['x-rex-request'] !== '1' || (req.headers.origin && req.headers.origin !== expected)) throw fail('Request origin rejected.', 403);
    }
  });
  const auth = async (req: FastifyRequest) => {
    if (req.headers.upgrade && req.headers.origin !== new URL(process.env.APP_ORIGIN || 'http://localhost:5173').origin) throw fail('WebSocket origin rejected.', 403);
    const session = req.cookies.rex_session;
    if (!session) throw fail('Sign in to continue.', 401);
    const [user] = await sql`SELECT u.id,u.email,u.role FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token_hash=${hashToken(session)} AND s.expires_at>now()`;
    if (!user) throw fail('Session expired. Sign in again.', 401);
    req.user = user as User;
  };
  const admin = async (req: FastifyRequest) => { await auth(req); if (req.user.role !== 'admin') throw fail('Administrator access required.', 403); };
  const serverFor = async (req: FastifyRequest) => {
    const [row] = await sql`SELECT s.*, n.address, n.last_seen FROM servers s JOIN nodes n ON n.id=s.node_id WHERE s.id=${uuid(param(req, 'id'))}`;
    if (!row || (req.user.role !== 'admin' && row.owner_id !== req.user.id)) throw fail('Server not found.', 404);
    return row;
  };
  const providerFor = async (req: FastifyRequest) => {
    const [row] = await sql`SELECT * FROM providers WHERE id=${uuid(param(req, 'id'))} AND owner_id=${req.user.id}`;
    if (!row) throw fail('Provider not found.', 404);
    return row;
  };
  app.get('/api/v1/health', async () => { await sql`SELECT 1`; return { ok: true }; });
  app.get('/api/v1/auth/status', async () => ({ setupRequired: !(await sql`SELECT 1 FROM users WHERE role='admin' LIMIT 1`).length, registrationEnabled: process.env.REGISTRATION_ENABLED !== 'false' }));
  app.get('/api/v1/source', async () => ({ license: 'AGPL-3.0-only', url: process.env.SOURCE_URL || null }));
  app.get('/api/v1/source/archive', async (_req, reply) => {
    const { pack } = await import('tar-stream');
    const { readdir, readFile, lstat } = await import('node:fs/promises');
    const archive = pack(), root = resolve(process.env.SOURCE_DIR || '.');
    const roots = ['apps', 'packages', 'tests', 'scripts', 'docs', '.github', 'package.json', 'pnpm-lock.yaml', 'tsconfig.json', 'tsconfig.server.json', 'vite.config.ts', 'vitest.config.ts', 'playwright.config.ts', 'postcss.config.cjs', 'Dockerfile', 'compose.yaml', 'compose.agent.yaml', 'LICENSE', 'README.md', 'DESIGN.md', '.env.example', '.env.agent.example', '.dockerignore'];
    async function add(relative: string): Promise<void> {
      const path = resolve(root, relative);
      if (!existsSync(path)) return;
      const info = await lstat(path);
      if (info.isSymbolicLink()) return;
      if (info.isDirectory()) { for (const name of await readdir(path)) await add(`${relative}/${name}`); return; }
      const buffer = await readFile(path);
      await new Promise<void>((res, rej) => archive.entry({ name: `rex-vibe-panel/${relative}`, size: buffer.length, mode: 0o644 }, buffer, error => error ? rej(error) : res()));
    }
    void (async () => { try { for (const item of roots) await add(item); archive.finalize(); } catch (e: any) { archive.destroy(e); } })();
    reply.header('Content-Disposition', 'attachment; filename="rex-vibe-panel-source.tar"').type('application/x-tar'); return reply.send(archive);
  });
  app.get('/api/v1/me', { preHandler: auth }, async req => req.user);
  for (const mode of ['setup', 'register', 'login'] as const) {
    app.post(`/api/v1/auth/${mode}`, { config: { rateLimit: { max: 10, timeWindow: '1 minute' } }, schema: { body: { type: 'object', required: ['email', 'password'], properties: { email: { type: 'string' }, password: { type: 'string', minLength: 8, maxLength: 128 } } } } }, async (req, reply) => {
      const input = credentialsSchema.parse(req.body), email = input.email.toLowerCase(); let user: any;
      if (mode === 'login') {
        [user] = await sql`SELECT * FROM users WHERE email=${email}`;
        if (!user || !await verifyPassword(input.password, user.password_hash)) throw fail('Email or password is incorrect.', 401);
      } else {
        if (mode === 'register' && process.env.REGISTRATION_ENABLED === 'false') throw fail('Registration is disabled.', 403);
        const passwordHash = await hashPassword(input.password);
        user = await sql.begin(async tx => {
          await tx`SELECT pg_advisory_xact_lock(7743202)`;
          const admins = await tx`SELECT 1 FROM users WHERE role='admin' LIMIT 1`;
          if (mode === 'setup' && admins.length) throw fail('Setup has already been completed.', 409);
          if (mode === 'register' && !admins.length) throw fail('An administrator must finish setup first.', 403);
          const [created] = await tx`INSERT INTO users (email,password_hash,role) VALUES (${email},${passwordHash},${mode === 'setup' ? 'admin' : 'user'}) RETURNING id,email,role`;
          return created;
        });
      }
      if (user.role === 'admin') await bootstrapDefaultProvider(user.id);
      const secret = token();
      await sql`INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (${hashToken(secret)},${user.id},now()+interval '7 days')`;
      reply.setCookie('rex_session', secret, { path: '/', httpOnly: true, sameSite: 'strict', secure: process.env.COOKIE_SECURE === 'true', maxAge: 604800 });
      return { id: user.id, email: user.email, role: user.role };
    });
  }
  app.post('/api/v1/auth/logout', { preHandler: auth }, async (req, reply) => {
    await sql`DELETE FROM sessions WHERE token_hash=${hashToken(req.cookies.rex_session!)}`;
    reply.clearCookie('rex_session', { path: '/' }); return { ok: true };
  });
  app.get('/api/v1/providers/presets', { preHandler: auth }, async () => presets);
  app.get('/api/v1/providers', { preHandler: auth }, async req => (await sql`SELECT p.*,COALESCE(p.id::text=(SELECT value #>> '{}' FROM settings WHERE key=${`default_provider:${req.user.id}`}),false) AS is_default FROM providers p WHERE p.owner_id=${req.user.id} ORDER BY name`).map(safeProvider));
  app.put('/api/v1/providers/:id/default', { preHandler: auth }, async req => {
    const row = await providerFor(req);
    await sql`INSERT INTO settings (key,value) VALUES (${`default_provider:${req.user.id}`},${sql.json(row.id)}) ON CONFLICT (key) DO UPDATE SET value=excluded.value`;
    return { ok: true };
  });
  app.post('/api/v1/providers', { preHandler: auth }, async req => {
    const { apiKey, accessKeyId, secretAccessKey, sessionToken, name, kind, ...config } = providerInputSchema.parse(req.body);
    if (kind === 'bedrock-runtime' && !apiKey && !(accessKeyId && secretAccessKey)) throw fail('Supply your Bedrock API key or your AWS access key and secret.');
    const [row] = await sql`INSERT INTO providers (owner_id,name,kind,config,secret) VALUES (${req.user.id},${name},${kind},${sql.json(config)},${encrypt({ apiKey, accessKeyId, secretAccessKey, sessionToken })}) RETURNING *`;
    return safeProvider(row);
  });
  app.put('/api/v1/providers/:id', { preHandler: auth }, async req => {
    const existing = await providerFor(req);
    const { apiKey, accessKeyId, secretAccessKey, sessionToken, name, kind, ...config } = providerInputSchema.parse(req.body);
    const old = existing.kind === kind ? decrypt<Record<string, string>>(existing.secret) : {};
    const secrets = { apiKey: apiKey || old.apiKey, accessKeyId: accessKeyId || old.accessKeyId, secretAccessKey: secretAccessKey || old.secretAccessKey, sessionToken: sessionToken || old.sessionToken };
    if (kind === 'bedrock-runtime' && !secrets.apiKey && !(secrets.accessKeyId && secrets.secretAccessKey)) throw fail('Supply your Bedrock API key or your AWS access key and secret.');
    const [row] = await sql`UPDATE providers SET name=${name},kind=${kind},config=${sql.json(config)},secret=${encrypt(secrets)},tool_capable=false,tested_at=NULL WHERE id=${existing.id} RETURNING *`;
    return safeProvider(row);
  });
  app.delete('/api/v1/providers/:id', { preHandler: auth }, async req => {
    const row = await providerFor(req);
    if ((await sql`SELECT 1 FROM runs WHERE provider_id=${row.id} AND status IN ('queued','running')`).length) throw fail('Stop active runs before deleting this provider.', 409);
    await sql.begin(async tx => {
      await tx`UPDATE runs SET provider_id=NULL WHERE provider_id=${row.id}`;
      await tx`DELETE FROM providers WHERE id=${row.id}`;
      await tx`DELETE FROM settings WHERE key=${`default_provider:${req.user.id}`} AND value=${tx.json(row.id)}`;
    }); return { ok: true };
  });
  app.post('/api/v1/providers/:id/test', { preHandler: auth }, async req => {
    const row = await providerFor(req); const provider = loadProvider(row);
    try {
      const result = await generate(provider, [{ role: 'user', content: 'Connection test. Call rex_connection_test with {"ok":true}. Do not answer in prose.' }], [{ name: 'rex_connection_test', description: 'Test tool calling without modifying anything.', parameters: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } }], { trustedOrigins: await trustedOrigins(), signal: AbortSignal.timeout(90_000) });
      const capable = result.toolCalls.some(t => t.name === 'rex_connection_test' && (() => { try { return JSON.parse(t.arguments).ok === true; } catch { return false; } })());
      await sql`UPDATE providers SET tested_at=now(),tool_capable=${capable} WHERE id=${row.id}`;
      return { ok: true, toolCapable: capable, message: capable ? 'Connected. Tool calling works.' : 'Connected, but the model did not pass the tool calling test. Chat only.' };
    } catch (error: any) { await sql`UPDATE providers SET tested_at=now(),tool_capable=false WHERE id=${row.id}`; throw fail(error.message, 422); }
  });
  app.get('/api/v1/providers/:id/models', { preHandler: auth }, async req => {
    try { return await listModels(loadProvider(await providerFor(req)), await trustedOrigins()); } catch (error: any) { throw fail(error.message, 422); }
  });
  app.patch('/api/v1/providers/:id/model', { preHandler: auth }, async req => {
    const row = await providerFor(req), { model } = z.object({ model: z.string().min(1).max(200) }).parse(req.body);
    const [updated] = await sql`UPDATE providers SET config=${sql.json({ ...row.config, model })},tool_capable=false,tested_at=NULL WHERE id=${row.id} RETURNING *`;
    return safeProvider(updated);
  });
  app.get('/api/v1/servers', { preHandler: auth }, async req => req.user.role === 'admin'
    ? sql`SELECT s.*, n.name AS node_name,n.address,n.last_seen FROM servers s JOIN nodes n ON n.id=s.node_id ORDER BY s.created_at`
    : sql`SELECT s.*, n.name AS node_name,n.address,n.last_seen FROM servers s JOIN nodes n ON n.id=s.node_id WHERE s.owner_id=${req.user.id} ORDER BY s.created_at`);
  app.get('/api/v1/servers/:id', { preHandler: auth }, serverFor);
  const resolveChat = async (serverId: string, userId: string, chatId?: string) => {
    if (chatId) {
      const [chat] = await sql`SELECT * FROM chats WHERE id=${chatId} AND server_id=${serverId}`;
      if (!chat) throw fail('Chat not found.', 404);
      return chat;
    }
    const [latest] = await sql`SELECT * FROM chats WHERE server_id=${serverId} ORDER BY updated_at DESC LIMIT 1`;
    if (latest) return latest;
    const [created] = await sql`INSERT INTO chats (server_id,user_id,title) VALUES (${serverId},${userId},'New chat') RETURNING *`;
    return created;
  };
  app.get('/api/v1/servers/:id/chats', { preHandler: auth }, async req => {
    const server = await serverFor(req);
    const existing = await sql`SELECT * FROM chats WHERE server_id=${server.id} ORDER BY updated_at DESC`;
    if (existing.length) return existing;
    const [created] = await sql`INSERT INTO chats (server_id,user_id,title) VALUES (${server.id},${req.user.id},'New chat') RETURNING *`;
    return [created];
  });
  app.post('/api/v1/servers/:id/chats', { preHandler: auth }, async req => {
    const server = await serverFor(req);
    const input = z.object({ title: z.string().trim().min(1).max(120).optional() }).parse(req.body || {});
    const [created] = await sql`INSERT INTO chats (server_id,user_id,title) VALUES (${server.id},${req.user.id},${input.title || 'New chat'}) RETURNING *`;
    return created;
  });
  app.get('/api/v1/servers/:id/messages', { preHandler: auth }, async req => {
    const server = await serverFor(req);
    const chatId = z.uuid().optional().parse((req.query as any).chatId);
    const chat = await resolveChat(server.id, req.user.id, chatId);
    return sql`SELECT * FROM messages WHERE chat_id=${chat.id} ORDER BY id`;
  });
  app.get('/api/v1/servers/:id/runs', { preHandler: auth }, async req => {
    const server = await serverFor(req);
    const chatId = z.uuid().optional().parse((req.query as any).chatId);
    if (chatId) {
      const chat = await resolveChat(server.id, req.user.id, chatId);
      return sql`SELECT id,status,cancel_requested,chat_id,created_at,finished_at FROM runs WHERE chat_id=${chat.id} ORDER BY created_at DESC LIMIT 30`;
    }
    return sql`SELECT id,status,cancel_requested,chat_id,created_at,finished_at FROM runs WHERE server_id=${server.id} ORDER BY created_at DESC LIMIT 30`;
  });
  app.get('/api/v1/servers/:id/events', { preHandler: auth }, async req => {
    const s = await serverFor(req), after = z.coerce.number().int().min(0).default(0).parse((req.query as any).after);
    return sql`SELECT * FROM events WHERE server_id=${s.id} AND id>${after} ORDER BY id LIMIT 1000`;
  });
  app.post('/api/v1/servers/:id/chat', { preHandler: auth }, async req => {
    const server = await serverFor(req), input = z.object({ prompt: z.string().trim().min(1).max(16000), providerId: z.uuid(), chatId: z.uuid().optional() }).parse(req.body);
    const [provider] = await sql`SELECT * FROM providers WHERE id=${input.providerId} AND owner_id=${req.user.id}`;
    if (!provider) throw fail('Select one of your providers.', 404);
    const chat = await resolveChat(server.id, req.user.id, input.chatId);
    const title = chat.title === 'New chat' || chat.title === 'Chat' ? input.prompt.slice(0, 80) : chat.title;
    const run = await sql.begin(async tx => {
      await tx`UPDATE chats SET title=${title}, updated_at=now() WHERE id=${chat.id}`;
      const [created] = await tx`INSERT INTO runs (server_id,user_id,provider_id,prompt,chat_id) VALUES (${server.id},${req.user.id},${provider.id},${input.prompt},${chat.id}) RETURNING *`;
      await tx`INSERT INTO messages (server_id,user_id,role,content,chat_id) VALUES (${server.id},${req.user.id},'user',${input.prompt},${chat.id})`;
      return created;
    });
    await emit(server.id, 'run.queued', { id: run.id, chatId: chat.id }, run.id); return { id: run.id, chatId: chat.id };
  });
  app.post('/api/v1/servers/:id/runs/:runId/stop', { preHandler: auth }, async req => {
    const s = await serverFor(req);
    await sql`UPDATE runs SET cancel_requested=true WHERE id=${uuid(param(req, 'runId'))} AND server_id=${s.id} AND status IN ('queued','running')`;
    return { ok: true };
  });
  const perform = async (req: FastifyRequest, operation: unknown) => {
    const server = await serverFor(req), op = operationSchema.parse(operation);
    if (!server.last_seen || Date.now() - new Date(server.last_seen).getTime() > 30_000) throw fail('Node is offline. Reconnect the REX agent.', 503);
    if (readOperations.has(op.type)) {
      try { return await agentCall(server, op); } catch (error: any) { throw fail(error.message, 422); }
    }
    const execute = async () => {
      await emit(server.id, 'manual.started', { userId: req.user.id, operation: { ...op, ...('content' in op ? { content: '[file content]' } : {}), ...('base64' in op ? { base64: '[uploaded file]' } : {}) } });
      try { const result = await agentCall(server, op); await emit(server.id, 'manual.completed', { operation: op.type }); return result; }
      catch (error: any) { await emit(server.id, 'manual.failed', { operation: op.type, error: error.message }); throw fail(error.message, 422); }
    };
    return withLock(server.id, `manual:${randomUUID()}`, execute).catch((e: any) => { throw fail(e.message, 409); });
  };
  app.post('/api/v1/servers/:id/operations', { preHandler: auth, schema: { body: z.toJSONSchema(operationSchema, { unrepresentable: 'any', target: 'draft-7', io: 'input' }) as any } }, async req => perform(req, req.body));
  app.post('/api/v1/servers/:id/upload', { preHandler: auth }, async req => {
    await serverFor(req); const file = await req.file(); if (!file) throw fail('Choose a file to upload.');
    const buffer = await file.toBuffer(); const path = String((req.query as any).path || file.filename);
    return perform(req, { type: 'upload', path, base64: buffer.toString('base64') });
  });
  app.get('/api/v1/servers/:id/backup/:backupId', { preHandler: auth }, async (req, reply) => {
    const server = await serverFor(req), backupId = z.string().regex(/^[a-zA-Z0-9-]+$/).parse(param(req, 'backupId'));
    const { Readable } = await import('node:stream');
    async function* chunks() {
      let offset = 0;
      while (true) { const result = await agentCall(server, { type: 'backup-download', backupId, offset }); if (!result.base64) break; const b = Buffer.from(result.base64, 'base64'); offset += b.length; yield b; }
    }
    reply.header('Content-Disposition', `attachment; filename="rex-${backupId}.tar"`).type('application/x-tar'); return reply.send(Readable.from(chunks()));
  });
  app.get('/api/v1/servers/:id/files/download', { preHandler: auth }, async (req, reply) => {
    const server = await serverFor(req), path = z.string().min(1).max(1000).parse((req.query as any).path);
    const { Readable } = await import('node:stream');
    async function* chunks() {
      let offset = 0;
      while (true) { const result = await agentCall(server, { type: 'file-download', path, offset }); if (!result.base64) break; const b = Buffer.from(result.base64, 'base64'); offset += b.length; yield b; }
    }
    reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(path.split('/').at(-1) || 'file')}`).type('application/octet-stream'); return reply.send(Readable.from(chunks()));
  });
  app.get('/api/v1/servers/:id/live', { websocket: true, preValidation: auth }, async (socket, req) => {
    let timer: ReturnType<typeof setInterval>;
    let closed = false, busy = false, after = z.coerce.number().int().min(0).default(0).parse((req.query as any).after), count = 0;
    socket.on('close', () => { closed = true; clearInterval(timer); });
    const server = await serverFor(req);
    const tick = async () => {
      if (closed || busy) return; busy = true;
      try {
        await auth(req);
        const rows = await sql`SELECT * FROM events WHERE server_id=${server.id} AND id>${after} ORDER BY id LIMIT 200`;
        for (const row of rows) { if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'event', event: row })); after = Number(row.id); }
        if (++count % 5 === 0 && (await sql`SELECT 1 FROM nodes WHERE id=${server.node_id} AND last_seen>now()-interval '30 seconds'`).length) {
          const status = await agentCall(server, { type: 'status' }); if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'status', status }));
          const logs = await agentCall(server, { type: 'logs', tail: 150 }); if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'logs', logs }));
        }
      } catch { if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'connection-error', message: 'Live connection unavailable. Reconnecting…' })); }
      finally { busy = false; }
    };
    timer = setInterval(() => { void tick(); }, 1000); void tick();
  });
  app.get('/api/v1/admin/users', { preHandler: admin }, async () => sql`SELECT id,email,role,created_at FROM users ORDER BY created_at`);
  app.get('/api/v1/admin/nodes', { preHandler: admin }, async () => sql`SELECT id,name,address,last_seen,capacity FROM nodes ORDER BY created_at`);
  app.get('/api/v1/admin/onboarding', { preHandler: admin }, async req => nodeSetup.status(req.user.id));
  app.post('/api/v1/admin/onboarding/skip', { preHandler: admin }, async req => { await nodeSetup.dismiss(req.user.id); return { ok: true }; });
  app.post('/api/v1/admin/nodes/local', { preHandler: admin }, async req => {
    const input = z.object({ name: z.string().trim().min(1).max(80), address: z.string().trim().min(1).max(253) }).parse(req.body);
    return nodeSetup.start(req.user.id, input.name, input.address, process.env.APP_ORIGIN || 'http://localhost:3000');
  });
  app.post('/api/v1/admin/nodes', { preHandler: admin }, async req => {
    const input = z.object({ name: z.string().trim().min(1).max(80), address: z.string().trim().min(1).max(253) }).parse(req.body);
    const secret = token();
    const [node] = await sql`INSERT INTO nodes (name,address) VALUES (${input.name},${input.address}) RETURNING id,name,address`;
    await sql`INSERT INTO enrollment_tokens (token_hash,node_id,expires_at) VALUES (${hashToken(secret)},${node.id},now()+interval '1 hour')`;
    return { ...node, enrollmentToken: secret };
  });
  app.post('/api/v1/admin/nodes/:id/token', { preHandler: admin }, async req => {
    const secret = token(); await sql`INSERT INTO enrollment_tokens (token_hash,node_id,expires_at) VALUES (${hashToken(secret)},${uuid(param(req, 'id'))},now()+interval '1 hour')`; return { enrollmentToken: secret };
  });
  app.get('/api/v1/admin/settings', { preHandler: admin }, async () => ({ trustedProviderOrigins: await trustedOrigins() }));
  app.put('/api/v1/admin/settings', { preHandler: admin }, async req => {
    const input = z.object({ trustedProviderOrigins: z.array(z.url()).max(30) }).parse(req.body);
    const origins = input.trustedProviderOrigins.map(s => { const url = new URL(s); if (!['http:', 'https:'].includes(url.protocol)) throw fail('Provider origins must use HTTP or HTTPS.'); return url.origin; });
    await sql`INSERT INTO settings (key,value) VALUES ('trusted_provider_origins',${sql.json(origins)}) ON CONFLICT (key) DO UPDATE SET value=excluded.value`; return { ok: true };
  });
  app.post('/api/v1/admin/servers', { preHandler: admin }, async req => {
    const input = serverInputSchema.parse(req.body);
    const row = await sql.begin(async tx => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${input.nodeId}))`;
      const [node] = await tx`SELECT * FROM nodes WHERE id=${input.nodeId}`; if (!node) throw fail('Node not found.', 404);
      const existing = await tx`SELECT config FROM servers WHERE node_id=${input.nodeId}`;
      if (input.edition === 'bedrock' && (!z.ipv4().safeParse(node.address).success || input.port > 65519)) throw fail('Bedrock needs a node IPv4 address and 16 free UDP ports following the TCP port.');
      const end = input.port + (input.edition === 'bedrock' ? 16 : 0);
      if (existing.some(s => input.port <= Number(s.config.port) + (s.config.edition === 'bedrock' ? 16 : 0) && end >= Number(s.config.port))) throw fail('Port allocation overlaps another server.', 409);
      const allocated = existing.reduce((a, s) => ({ memory: a.memory + s.config.memoryMb, cpu: a.cpu + s.config.cpu, disk: a.disk + s.config.diskMb }), { memory: 0, cpu: 0, disk: 0 });
      if (!node.last_seen || Date.now() - new Date(node.last_seen).getTime() > 30_000) throw fail('Connect the node before allocating servers.', 409);
      if (allocated.memory + input.memoryMb > node.capacity.memoryMb || allocated.cpu + input.cpu > node.capacity.cpus || allocated.disk + input.diskMb > node.capacity.diskMb) throw fail('The node has insufficient unallocated resources.', 409);
      const { name, nodeId, ownerId, ...config } = input;
      const [created] = await tx`INSERT INTO servers (name,node_id,owner_id,config) VALUES (${name},${nodeId},${ownerId},${sql.json(config)}) RETURNING *`; return created;
    });
    return row;
  });
  const connections = new Map<string, import('ws').WebSocket>();
  app.get('/api/v1/agent/connect', { websocket: true }, (socket, req) => {
    let nodeId: string | undefined, processing = false, authenticated = false;
    const timeout = setTimeout(() => socket.close(1008, 'Authentication required'), 10_000);
    socket.on('message', async raw => {
      try {
        const msg = JSON.parse(raw.toString());
        if (!authenticated) {
          if (processing || msg.type !== 'auth') return socket.close(1008, 'Authentication required'); processing = true;
          const supplied = z.string().min(32).max(256).parse(msg.token);
          if (msg.enroll) {
            const secret = token();
            const result = await sql.begin(async tx => {
              const [enrollment] = await tx`DELETE FROM enrollment_tokens WHERE token_hash=${hashToken(supplied)} AND expires_at>now() RETURNING node_id`;
              if (!enrollment) return null;
              await tx`UPDATE nodes SET token_hash=${hashToken(secret)} WHERE id=${enrollment.node_id}`; return enrollment.node_id as string;
            });
            if (!result) return socket.close(1008, 'Invalid enrollment token'); nodeId = result;
            socket.send(JSON.stringify({ type: 'enrolled', token: secret, nodeId }));
          } else {
            const [node] = await sql`SELECT id FROM nodes WHERE token_hash=${hashToken(supplied)}`;
            if (!node) return socket.close(1008, 'Invalid agent token'); nodeId = node.id;
          }
          const previous = connections.get(nodeId!);
          if (previous) {
            await sql`UPDATE agent_requests SET status='interrupted',error='Agent connection was replaced. Inspect the server before retrying.' WHERE node_id=${nodeId!} AND status='sent'`;
            previous.close(1012, 'Agent replaced');
          }
          connections.set(nodeId!, socket);
          authenticated = true; clearTimeout(timeout); socket.send(JSON.stringify({ type: 'ready', nodeId })); return;
        }
        if (msg.type === 'heartbeat') {
          const capacity = z.object({ memoryMb: z.number().positive(), cpus: z.number().positive(), diskMb: z.number().positive() }).parse(msg.capacity);
          await sql`UPDATE nodes SET last_seen=now(),capacity=${sql.json(capacity)} WHERE id=${nodeId!}`;
        }
        if (msg.type === 'response') {
          await sql`UPDATE agent_requests SET status=${msg.error ? 'error' : 'done'},result=${sql.json(msg.result ?? null)},error=${msg.error ? String(msg.error).slice(0, 4000) : null} WHERE id=${uuid(msg.id)} AND node_id=${nodeId!} AND status='sent'`;
        }
      } catch (error: any) { app.log.warn({ name: error.name, code: error.code, message: error.message, stack: error.stack }, 'Agent protocol error'); socket.close(1008, 'Invalid agent message'); }
    });
    socket.on('close', () => { clearTimeout(timeout); if (nodeId && connections.get(nodeId) === socket) { connections.delete(nodeId); void sql`UPDATE agent_requests SET status='interrupted',error='Agent disconnected. Inspect the server before retrying.' WHERE node_id=${nodeId} AND status='sent'`; } });
  });
  let dispatching = false;
  const dispatch = setInterval(async () => {
    if (dispatching) return; dispatching = true;
    try {
      await sql`UPDATE agent_requests SET status='error',error='Node operation expired.' WHERE status='pending' AND expires_at<now()`;
      for (const [nodeId, socket] of connections) {
        if (socket.readyState !== 1) continue;
        const pending = await sql`SELECT a.*,s.config,s.name,s.owner_id,s.node_id,n.address FROM agent_requests a JOIN servers s ON s.id=a.server_id JOIN nodes n ON n.id=s.node_id WHERE a.node_id=${nodeId} AND a.status='pending' ORDER BY a.created_at LIMIT 10`;
        for (const row of pending) {
          const updated = await sql`UPDATE agent_requests SET status='sent' WHERE id=${row.id} AND status='pending' RETURNING id`;
          if (updated.length && socket.readyState === 1) socket.send(JSON.stringify({ type: 'request', id: row.id, server: { ...row.config, id: row.server_id, name: row.name, ownerId: row.owner_id, nodeId: row.node_id, address: row.address }, operation: row.operation }));
        }
        const cancelled = await sql`SELECT id FROM agent_requests WHERE node_id=${nodeId} AND status='cancelled' AND expires_at>now()`;
        for (const row of cancelled) socket.send(JSON.stringify({ type: 'cancel', id: row.id }));
      }
    } catch { app.log.error('Agent dispatch unavailable'); } finally { dispatching = false; }
  }, 250);
  app.addHook('onClose', async () => { clearInterval(dispatch); await nodeSetup.close(); for (const socket of connections.values()) socket.close(1001, 'Panel shutting down'); });
  if (options.serveStatic !== false && existsSync(resolve('dist/web/index.html'))) {
    await app.register(staticFiles, { root: resolve('dist/web') });
    app.setNotFoundHandler((req, reply) => req.url.startsWith('/api/') ? reply.code(404).send({ error: 'API route not found.' }) : reply.sendFile('index.html'));
  }
  return app;
}
