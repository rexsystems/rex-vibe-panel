import { z } from 'zod';

export const editionSchema = z.enum(['vanilla', 'paper', 'fabric', 'forge', 'neoforge', 'bedrock']);
export const providerKindSchema = z.enum(['openai', 'ollama', 'bedrock-runtime', 'bedrock-mantle', 'gemini', 'anthropic']);
export const credentialsSchema = z.object({ email: z.email().max(254), password: z.string().min(8).max(128) });
export const serverInputSchema = z.object({
  name: z.string().trim().min(1).max(80), ownerId: z.uuid(), nodeId: z.uuid(),
  edition: editionSchema, version: z.string().regex(/^[a-zA-Z0-9._+-]+$/).max(80),
  memoryMb: z.number().int().min(512).max(262144), cpu: z.number().min(0.25).max(128),
  diskMb: z.number().int().min(1024).max(1048576), port: z.number().int().min(1024).max(65535),
  eulaAccepted: z.literal(true),
});
export const providerInputSchema = z.object({
  name: z.string().trim().min(1).max(80), kind: providerKindSchema,
  baseUrl: z.url().max(1000), model: z.string().trim().min(1).max(200),
  region: z.string().regex(/^[a-z0-9-]+$/).default('us-east-1'),
  apiKey: z.string().max(8192).optional(), accessKeyId: z.string().max(256).optional(),
  secretAccessKey: z.string().max(256).optional(), sessionToken: z.string().max(8192).optional(),
});
export type ProviderInput = z.infer<typeof providerInputSchema>;
export type ServerInput = z.infer<typeof serverInputSchema>;
export type ServerSpec = ServerInput & { id: string };
export const operationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('status') }),
  z.object({ type: z.literal('install') }),
  z.object({ type: z.literal('power'), action: z.enum(['start', 'stop', 'restart', 'kill']) }),
  z.object({ type: z.literal('logs'), tail: z.number().int().min(1).max(1000).default(150) }),
  z.object({ type: z.literal('console'), command: z.string().min(1).max(4096) }),
  z.object({ type: z.literal('shell'), command: z.string().min(1).max(16000), timeoutSeconds: z.number().int().min(1).max(120).default(60) }),
  z.object({ type: z.literal('list'), path: z.string().max(1000).default('.') }),
  z.object({ type: z.literal('read'), path: z.string().max(1000) }),
  z.object({ type: z.literal('file-download'), path: z.string().max(1000), offset: z.number().int().min(0).default(0) }),
  z.object({ type: z.literal('write'), path: z.string().max(1000), content: z.string().max(2_000_000) }),
  z.object({ type: z.literal('upload'), path: z.string().max(1000), base64: z.string().max(14_000_000) }),
  z.object({ type: z.literal('remove'), path: z.string().max(1000) }),
  z.object({ type: z.literal('download'), url: z.url().max(2000), path: z.string().max(1000), sha512: z.string().regex(/^[a-f0-9]{128}$/).optional() }),
  z.object({ type: z.literal('backups') }),
  z.object({ type: z.literal('backup') }),
  z.object({ type: z.literal('restore'), backupId: z.string().regex(/^[a-zA-Z0-9-]+$/) }),
  z.object({ type: z.literal('backup-download'), backupId: z.string().regex(/^[a-zA-Z0-9-]+$/), offset: z.number().int().min(0).default(0) }),
]);
export type Operation = z.infer<typeof operationSchema>;
export type ToolDefinition = { name: string; description: string; parameters: Record<string, unknown> };
export type ChatMessage = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; toolCalls?: ToolCall[]; toolCallId?: string; providerData?: Record<string, any> };
export type ToolCall = { id: string; name: string; arguments: string; metadata?: Record<string, unknown> };
export type AgentRequest = { type: 'request'; id: string; server: ServerSpec; operation: Operation };
export type AgentResponse = { type: 'response'; id: string; result?: unknown; error?: string };
export const readOperations = new Set(['status', 'logs', 'list', 'read', 'file-download', 'backups', 'backup-download']);
