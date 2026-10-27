import { sql } from '../db/index.js';
import { encrypt } from '../security/index.js';
import { providerInputSchema } from '../shared/contracts.js';

export function configuredMantle(env: NodeJS.ProcessEnv = process.env) {
  if (env.DEFAULT_AI_PROVIDER !== 'bedrock-mantle' || !env.BEDROCK_MANTLE_API_KEY) return null;
  const region = env.BEDROCK_MANTLE_REGION || 'us-east-1';
  const model = env.BEDROCK_MANTLE_MODEL || 'qwen.qwen3-coder-next';
  const prefix = /^(openai\.(?!gpt-oss)|google\.gemma)/.test(model) ? 'openai/v1' : 'v1';
  return providerInputSchema.parse({
    name: 'Amazon Bedrock Mantle', kind: 'bedrock-mantle', region, model,
    baseUrl: `https://bedrock-mantle.${region}.api.aws/${prefix}`, apiKey: env.BEDROCK_MANTLE_API_KEY,
  });
}

export async function bootstrapDefaultProvider(userId: string) {
  const provider = configuredMantle();
  if (!provider) return;
  await sql.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(7743203)`;
    const [owner] = await tx`SELECT id FROM users WHERE role='admin' ORDER BY created_at,id LIMIT 1`;
    if (owner?.id !== userId) return;
    if ((await tx`SELECT 1 FROM settings WHERE key='environment_provider_bootstrapped'`).length) return;
    const { apiKey, name, kind, ...config } = provider;
    const [row] = await tx`INSERT INTO providers (owner_id,name,kind,config,secret) VALUES (${userId},${name},${kind},${tx.json(config)},${encrypt({ apiKey })}) RETURNING id`;
    await tx`INSERT INTO settings (key,value) VALUES (${`default_provider:${userId}`},${tx.json(row.id)}) ON CONFLICT (key) DO UPDATE SET value=excluded.value`;
    await tx`INSERT INTO settings (key,value) VALUES ('environment_provider_bootstrapped',${tx.json(row.id)})`;
  });
}
