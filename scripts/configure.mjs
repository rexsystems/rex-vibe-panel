import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

try { await readFile('.env'); console.error('.env already exists. Edit it directly to preserve your encryption key.'); process.exitCode = 1; }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  const template = await readFile('.env.example', 'utf8');
  const configured = template.replace(/^ENCRYPTION_KEY=$/m, `ENCRYPTION_KEY=${randomBytes(32).toString('hex')}`)
    .replace(/^POSTGRES_PASSWORD=$/m, `POSTGRES_PASSWORD=${randomBytes(24).toString('hex')}`)
    .replace(/^APP_ORIGIN=.*$/m, 'APP_ORIGIN=http://localhost:3000');
  await writeFile('.env', configured, { flag: 'wx', mode: 0o600 });
  console.log('Created .env. Open the panel to create the first administrator. Configure APP_ORIGIN before exposing REX.');
}
