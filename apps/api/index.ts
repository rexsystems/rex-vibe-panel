import 'dotenv/config';
import { buildApp } from './app.js';
import { encrypt } from '../../packages/security/index.js';
import { sql } from '../../packages/db/index.js';

encrypt({ startup: true });
const app = await buildApp();
await app.listen({ port: Number(process.env.PORT || 3000), host: process.env.HOST || '0.0.0.0' });
for (const event of ['SIGINT', 'SIGTERM']) process.on(event, async () => { await app.close(); await sql.end(); process.exit(0); });
