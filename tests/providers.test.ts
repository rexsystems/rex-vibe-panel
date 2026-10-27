import { afterAll, beforeAll, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { generate, listModels } from '../packages/ai/providers.js';
import type { ProviderInput, ToolDefinition } from '../packages/shared/contracts.js';

let server: ReturnType<typeof createServer>, origin: string;
const requests: any[] = [];
const tools: ToolDefinition[] = [{ name: 'status', description: 'Read status', parameters: { type: 'object', properties: {} } }];
beforeAll(async () => {
  server = createServer(async (req, res) => {
    if (req.url === '/v1/models') { requests.push({ path: req.url, headers: req.headers }); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'qwen.qwen3-coder-next' }] })); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push({ path: req.url, body, headers: req.headers });
    if (req.url?.startsWith('/ollama/')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ message: { content: '', tool_calls: [{ function: { name: 'status', arguments: {} } }] } })); }
    else if (req.url?.startsWith('/anthropic/')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ content: [{ type: 'text', text: 'Checking.' }, { type: 'tool_use', id: 'native-call', name: 'status', input: {} }] })); }
    else if (req.url?.startsWith('/gemini/')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name: 'status', args: {} }, thoughtSignature: 'opaque-provider-signature' }] } }] })); }
    else if (req.url?.startsWith('/failure/')) { res.writeHead(401); res.end(JSON.stringify({ error: 'secret-should-not-be-exposed' })); }
    else {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'opaque-reasoning', tool_calls: [{ index: 0, id: 'stream-call', function: { name: 'status', arguments: '{' } }] } }] })}\n\n`);
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '}' } }] } }] })}\n\ndata: [DONE]\n\n`);
    }
  }).listen(0, '127.0.0.1'); await once(server, 'listening'); origin = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(async () => { await new Promise<void>(r => server.close(() => r())); });
const provider = (kind: ProviderInput['kind'], path: string): ProviderInput => ({ kind, name: 'Protocol test', baseUrl: `${origin}/${path}`, model: 'test', region: 'us-east-1', apiKey: 'test-key' });
const options = () => ({ trustedOrigins: [origin] });
it('assembles streamed OpenAI tool arguments and preserves DeepSeek reasoning for the next turn', async () => {
  const first = await generate(provider('openai', 'openai'), [{ role: 'user', content: 'Status?' }], tools, options());
  expect(first.toolCalls).toEqual([{ id: 'stream-call', name: 'status', arguments: '{}' }]);
  await generate(provider('openai', 'openai'), [{ role: 'user', content: 'Status?' }, { role: 'assistant', content: first.content, toolCalls: first.toolCalls, providerData: first.providerData }, { role: 'tool', content: 'running', toolCallId: 'stream-call' }], tools, options());
  expect(requests.at(-1).body.messages[1].reasoning_content).toBe('opaque-reasoning');
});
it('uses native Ollama tool call shapes', async () => {
  const result = await generate(provider('ollama', 'ollama'), [{ role: 'user', content: 'Status?' }], tools, options()); expect(result.toolCalls[0].name).toBe('status'); expect(requests.at(-1).path).toBe('/ollama/api/chat');
});
it('maps Anthropic tools and merges successive tool result messages', async () => {
  const result = await generate(provider('anthropic', 'anthropic'), [{ role: 'system', content: 'Server only' }, { role: 'user', content: 'Status?' }, { role: 'assistant', content: '', toolCalls: [{ id: 'one', name: 'status', arguments: '{}' }, { id: 'two', name: 'status', arguments: '{}' }] }, { role: 'tool', content: 'running', toolCallId: 'one' }, { role: 'tool', content: 'running', toolCallId: 'two' }], tools, options());
  expect(result.content).toBe('Checking.'); expect(requests.at(-1).body.messages.at(-1).content).toHaveLength(2); expect(requests.at(-1).headers['x-api-key']).toBe('test-key');
});
it('preserves Gemini thought signatures during tool execution', async () => {
  const p = provider('gemini', 'gemini'); const result = await generate(p, [{ role: 'user', content: 'Status?' }], tools, options());
  await generate(p, [{ role: 'user', content: 'Status?' }, { role: 'assistant', content: result.content, toolCalls: result.toolCalls, providerData: result.providerData }, { role: 'tool', toolCallId: result.toolCalls[0].id, content: 'running' }], tools, options());
  expect(requests.at(-1).body.contents[1].parts[0].thoughtSignature).toBe('opaque-provider-signature'); expect(requests.at(-1).headers['x-goog-api-key']).toBe('test-key');
  expect(requests.at(-1).body.tools[0].functionDeclarations[0].parametersJsonSchema.type).toBe('object');
});
it('never falls back to panel AWS credentials', async () => {
  await expect(generate({ ...provider('bedrock-runtime', 'bedrock'), apiKey: '' }, [{ role: 'user', content: 'Status?' }], tools, options())).rejects.toThrow('Provide your Bedrock API key');
});
it('discovers Mantle models on /v1 even when inference uses /openai/v1', async () => {
  const models = await listModels({ ...provider('bedrock-mantle', 'openai/v1') }, [origin]);
  expect(models).toEqual(['qwen.qwen3-coder-next']); expect(requests.at(-1).path).toBe('/v1/models');
});
it('reports provider failures without including the raw response or secret', async () => {
  await expect(generate(provider('openai', 'failure'), [{ role: 'user', content: 'Status?' }], tools, options())).rejects.toThrow('HTTP 401');
});
