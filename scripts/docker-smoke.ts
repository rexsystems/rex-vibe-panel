import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { performOperation } from '../apps/agent/runtime.js';
import type { ServerSpec } from '../packages/shared/contracts.js';

if (process.env.REX_SMOKE_EULA !== 'true') throw new Error('Accept the Minecraft EULA first, then set REX_SMOKE_EULA=true for this isolated smoke test.');
const server: ServerSpec & { address: string } = { id: randomUUID(), name: 'REX isolated smoke test', ownerId: randomUUID(), nodeId: randomUUID(), edition: (process.env.REX_SMOKE_EDITION || 'paper') as ServerSpec['edition'], version: process.env.REX_SMOKE_VERSION || '1.21.11', memoryMb: 2048, cpu: 1, diskMb: 10240, port: Number(process.env.REX_SMOKE_PORT || 25575), address: process.env.REX_SMOKE_ADDRESS || '127.0.0.1', eulaAccepted: true };
console.log(`Isolated smoke server: ${server.id}. Data is retained for inspection.`);
await performOperation(server, { type: 'install' });
await performOperation(server, { type: 'write', path: 'rex-smoke.txt', content: 'REX smoke test' });
const read = await performOperation(server, { type: 'read', path: 'rex-smoke.txt' }) as any;
if (read.content !== 'REX smoke test') throw new Error('File round trip failed.');
await performOperation(server, { type: 'power', action: 'start' });
try {
  let ready = false;
  for (let n = 0; n < 120; n++) {
    const logs = await performOperation(server, { type: 'logs', tail: 100 }) as any;
    if (logs.content.includes('Done (') || logs.content.includes('Server started.')) { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  if (!ready) throw new Error('Minecraft did not report ready within ten minutes. Inspect its logs.');
  const backup = await performOperation(server, { type: 'backup' }) as any;
  await performOperation(server, { type: 'write', path: 'rex-smoke.txt', content: 'changed' });
  await performOperation(server, { type: 'restore', backupId: backup.id });
  const restored = await performOperation(server, { type: 'read', path: 'rex-smoke.txt' }) as any;
  if (restored.content !== 'REX smoke test') throw new Error('Backup restoration failed.');
  console.log('Install, startup, files, logs, backup and restore passed.');
} finally { await performOperation(server, { type: 'power', action: 'stop' }).catch(() => {}); }
