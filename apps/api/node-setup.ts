import { sql } from '../../packages/db/index.js';
import { hashToken, token } from '../../packages/security/index.js';
import type { LocalNodeInstaller } from './local-node.js';

export function nodeSetupService(installer: LocalNodeInstaller) {
  const controllers = new Map<string, AbortController>();
  async function progress(id: string, status: string, message: string) {
    await sql`UPDATE node_setup_jobs SET status=${status},message=${message},updated_at=now() WHERE id=${id} AND status IN ('starting','building','launching','waiting')`;
  }
  async function launch(job: any, enrollmentToken: string, panelOrigin: string) {
    const controller = new AbortController(); controllers.set(job.id, controller);
    const timeout = setTimeout(() => controller.abort(), 20 * 60_000);
    const heartbeat = setInterval(async () => {
      try {
        const rows = await sql`UPDATE node_setup_jobs SET updated_at=now() WHERE id=${job.id} AND status IN ('starting','building','launching','waiting') RETURNING id`;
        if (!rows.length) controller.abort();
      } catch { controller.abort(); }
    }, 5000);
    try {
      await installer.install({ nodeId: job.node_id, enrollmentToken, panelOrigin, signal: controller.signal, progress: (status, message) => progress(job.id, status, message) });
      await progress(job.id, 'waiting', 'Waiting for the agent to connect.');
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        controller.signal.throwIfAborted();
        const [node] = await sql`SELECT last_seen FROM nodes WHERE id=${job.node_id}`;
        if (node?.last_seen && Date.now() - new Date(node.last_seen).getTime() < 30_000) { await progress(job.id, 'complete', 'The node is connected and ready for server allocation.'); return; }
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      throw new Error('The agent started but did not connect. Check the agent container logs and panel address, then retry.');
    } catch (error: any) {
      await progress(job.id, 'failed', controller.signal.aborted ? 'Node setup was interrupted. Retry to continue with the same node.' : String(error.message).slice(0, 1000));
    } finally { clearTimeout(timeout); clearInterval(heartbeat); controllers.delete(job.id); }
  }
  return {
    async status(userId: string) {
      await sql`UPDATE node_setup_jobs SET status='failed',message='Node setup was interrupted. Retry to continue with the same node.',updated_at=now() WHERE status IN ('starting','building','launching','waiting') AND updated_at<now()-interval '1 minute'`;
      const [dismissed] = await sql`SELECT value FROM settings WHERE key=${`node_setup_dismissed:${userId}`}`;
      const [job] = await sql`SELECT id,node_id,status,message,updated_at FROM node_setup_jobs ORDER BY created_at DESC LIMIT 1`;
      const hasNodes = (await sql`SELECT 1 FROM nodes LIMIT 1`).length > 0;
      return { ...(await installer.inspect()), needsChoice: !dismissed && !hasNodes, job: job || null };
    },
    async dismiss(userId: string) {
      await sql`INSERT INTO settings (key,value) VALUES (${`node_setup_dismissed:${userId}`},'true') ON CONFLICT (key) DO UPDATE SET value='true'`;
    },
    async start(userId: string, name: string, address: string, panelOrigin: string) {
      const environment = await installer.inspect();
      if (!environment.available) throw Object.assign(new Error(environment.reason || 'Docker is not available.'), { statusCode: 422 });
      const secret = token();
      const result = await sql.begin(async tx => {
        await tx`SELECT pg_advisory_xact_lock(7743204)`;
        await tx`UPDATE node_setup_jobs SET status='failed',message='Node setup was interrupted. Retry to continue with the same node.',updated_at=now() WHERE status IN ('starting','building','launching','waiting') AND updated_at<now()-interval '1 minute'`;
        const [active] = await tx`SELECT * FROM node_setup_jobs WHERE status IN ('starting','building','launching','waiting') LIMIT 1`;
        if (active) return { job: active, started: false };
        const [setting] = await tx`SELECT value FROM settings WHERE key='local_node_id'`;
        let nodeId = setting?.value as string | undefined;
        if (nodeId) {
          const [node] = await tx`SELECT id,last_seen FROM nodes WHERE id=${nodeId}`;
          if (!node) nodeId = undefined;
          else if (node.last_seen && Date.now() - new Date(node.last_seen).getTime() < 30_000) {
            const [job] = await tx`INSERT INTO node_setup_jobs (node_id,owner_id,status,message) VALUES (${nodeId},${userId},'complete','The local node is already connected.') RETURNING *`;
            return { job, started: false };
          }
        }
        if (!nodeId) {
          const [node] = await tx`INSERT INTO nodes (name,address) VALUES (${name},${address}) RETURNING id`; nodeId = node.id;
          await tx`INSERT INTO settings (key,value) VALUES ('local_node_id',${tx.json(nodeId!)}) ON CONFLICT (key) DO UPDATE SET value=excluded.value`;
        } else await tx`UPDATE nodes SET name=${name},address=${address} WHERE id=${nodeId}`;
        await tx`INSERT INTO enrollment_tokens (token_hash,node_id,expires_at) VALUES (${hashToken(secret)},${nodeId!},now()+interval '1 hour')`;
        const [job] = await tx`INSERT INTO node_setup_jobs (node_id,owner_id) VALUES (${nodeId!},${userId}) RETURNING *`;
        return { job, started: true };
      });
      if (result.started) void launch(result.job, secret, panelOrigin).catch(() => {});
      const { id, node_id, status, message } = result.job;
      return { id, node_id, status, message };
    },
    async close() {
      for (const controller of controllers.values()) controller.abort();
      for (const id of controllers.keys()) await progress(id, 'failed', 'Panel restarted during node setup. Retry to continue with the same node.');
    },
  };
}
