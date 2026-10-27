import 'dotenv/config';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema.js';

export const sql = postgres(process.env.DATABASE_URL || 'postgres://rex:rex@localhost:5432/rex', { max: 12 });
// Drizzle changes postgres-js serializers; keep its client separate from tagged SQL.
export const db = drizzle({ connection: { url: process.env.DATABASE_URL || 'postgres://rex:rex@localhost:5432/rex', max: 2 }, schema });
export async function emit(serverId: string, type: string, data: unknown, runId?: string) {
  await sql`INSERT INTO events (server_id,run_id,type,data) VALUES (${serverId},${runId ?? null},${type},${sql.json(data as never)})`;
}
export async function acquireLock(serverId: string, owner: string) {
  const rows = await sql`INSERT INTO server_locks (server_id,owner,expires_at) VALUES (${serverId},${owner},now()+interval '45 seconds')
    ON CONFLICT (server_id) DO UPDATE SET owner=excluded.owner, expires_at=excluded.expires_at
    WHERE server_locks.expires_at < now() OR server_locks.owner=excluded.owner RETURNING owner`;
  return rows.length > 0;
}
export async function withLock<T>(serverId: string, owner: string, fn: () => Promise<T>): Promise<T> {
  if (!await acquireLock(serverId, owner)) throw new Error('Server is busy. Wait for the current operation or stop the AI run.');
  let lost = false;
  const heartbeat = setInterval(() => { acquireLock(serverId, owner).then(ok => { if (!ok) lost = true; }).catch(() => { lost = true; }); }, 10_000);
  try { const result = await fn(); if (lost) throw new Error('Server lock was lost. Inspect the operation before retrying.'); return result; }
  finally { clearInterval(heartbeat); await sql`DELETE FROM server_locks WHERE server_id=${serverId} AND owner=${owner}`; }
}
export async function agentCall(server: Record<string, any>, operation: unknown, signal?: AbortSignal): Promise<any> {
  if (!(await sql`SELECT 1 FROM nodes WHERE id=${server.node_id} AND last_seen>now()-interval '30 seconds'`).length) throw new Error('Node is offline. Reconnect the REX agent.');
  const [request] = await sql`INSERT INTO agent_requests (node_id,server_id,run_id,operation) VALUES (${server.node_id},${server.id},${server.run_id ?? null},${sql.json(operation as never)}) RETURNING id`;
  const deadline = Date.now() + (['status','logs','list','read','file-download','backups','backup-download'].includes((operation as any).type) ? 15_000 : 590_000);
  while (Date.now() < deadline) {
    if (signal?.aborted) {
      await sql`UPDATE agent_requests SET status='cancelled' WHERE id=${request.id} AND status IN ('pending','sent')`;
      throw new Error('Operation cancelled. Inspect the server for changes already made.');
    }
    const [row] = await sql`SELECT status,result,error FROM agent_requests WHERE id=${request.id}`;
    if (row.status === 'done') return row.result;
    if (row.status === 'error' || row.status === 'interrupted') throw new Error(row.error || 'Agent disconnected; inspect server before retrying.');
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  await sql`UPDATE agent_requests SET status='cancelled' WHERE id=${request.id} AND status IN ('pending','sent')`;
  throw new Error('Node operation timed out. Inspect the server before retrying.');
}
