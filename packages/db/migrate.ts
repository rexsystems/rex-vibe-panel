import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { sql } from './index.js';

try {
  await sql.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(7743201)`;
    await tx`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`;
    const directory = new URL('./', import.meta.url);
    for (const name of (await readdir(directory)).filter(f => /^\d+.*\.sql$/.test(f)).sort()) {
      const source = await readFile(new URL(name, directory), 'utf8');
      const checksum = createHash('sha256').update(source).digest('hex');
      const [existing] = await tx`SELECT checksum FROM schema_migrations WHERE name=${name}`;
      if (existing && existing.checksum !== checksum) throw new Error(`Applied migration ${name} changed. Restore it and add a new migration.`);
      if (!existing) { await tx.unsafe(source); await tx`INSERT INTO schema_migrations (name,checksum) VALUES (${name},${checksum})`; }
    }
  });
  console.log('Database schema is ready.');
} finally { await sql.end(); }
