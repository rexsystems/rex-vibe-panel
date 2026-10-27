import { mkdir, readdir, copyFile } from 'node:fs/promises';

await mkdir('dist/server/packages/db', { recursive: true });
for (const file of await readdir('packages/db')) if (file.endsWith('.sql')) await copyFile(`packages/db/${file}`, `dist/server/packages/db/${file}`);
