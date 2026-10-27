import { randomUUID } from 'node:crypto';
import { BedrockRuntimeClient, ConverseCommand, type Message, type ContentBlock } from '@aws-sdk/client-bedrock-runtime';
import { checkedFetch } from '../security/network.js';
import type { ChatMessage, ProviderInput, ToolCall, ToolDefinition } from '../shared/contracts.js';

export const presets = [
  { name: 'Ollama', kind: 'ollama', baseUrl: 'http://localhost:11434', model: '' },
  { name: 'Custom OpenAI-compatible', kind: 'openai', baseUrl: '', model: '' },
  { name: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1', model: '' },
  { name: 'DeepSeek', kind: 'openai', baseUrl: 'https://api.deepseek.com/v1', model: '' },
  { name: 'OpenRouter', kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1', model: '' },
  { name: 'Groq', kind: 'openai', baseUrl: 'https://api.groq.com/openai/v1', model: '' },
  { name: 'Gemini', kind: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: '' },
  { name: 'Anthropic', kind: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', model: '' },
  { name: 'Amazon Bedrock Runtime', kind: 'bedrock-runtime', baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com', model: '' },
  { name: 'Amazon Bedrock Mantle', kind: 'bedrock-mantle', baseUrl: 'https://bedrock-mantle.us-east-1.api.aws/v1', model: 'qwen.qwen3-coder-next' },
];
type Result = { content: string; toolCalls: ToolCall[]; providerData?: Record<string, any> };
type Options = { signal?: AbortSignal; onText?: (text: string) => Promise<void>; trustedOrigins?: string[] };
const parseArgs = (input: string) => { try { return JSON.parse(input); } catch { throw new Error('Model returned invalid tool arguments.'); } };
const join = (base: string, path: string) => `${base.replace(/\/$/, '')}/${path}`;

async function json(response: Response) {
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Provider returned HTTP ${response.status}. Check the endpoint, credentials, model access and quota.`);
  }
  return response.json() as Promise<any>;
}
async function* sse(response: Response) {
  if (!response.ok) { await json(response); return; }
  if (!response.body) throw new Error('Provider returned an empty stream.');
  const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, '\n');
      let end;
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const data = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
        if (data && data !== '[DONE]') yield JSON.parse(data);
      }
      if (done) break;
    }
  } finally { reader.releaseLock(); }
}
export async function generate(provider: ProviderInput, messages: ChatMessage[], tools: ToolDefinition[], options: Options = {}): Promise<Result> {
  const call = (url: string, body: unknown, headers: Record<string, string> = {}) => checkedFetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
    signal: options.signal, trustedOrigins: options.trustedOrigins,
  });
  if (provider.kind === 'bedrock-runtime') {
    if (!provider.apiKey && !(provider.accessKeyId && provider.secretAccessKey)) throw new Error('Provide your Bedrock API key or AWS access key and secret.');
    const expected = `https://bedrock-runtime.${provider.region}.amazonaws.com`;
    if (new URL(provider.baseUrl).origin !== expected) throw new Error('Bedrock Runtime must use its regional AWS endpoint.');
    const client = new BedrockRuntimeClient({ region: provider.region, authSchemePreference: [provider.apiKey ? 'smithy.api#httpBearerAuth' : 'aws.auth#sigv4'], maxAttempts: 1,
      ...(provider.apiKey ? { token: { token: provider.apiKey } } : {}),
      ...(provider.accessKeyId && provider.secretAccessKey ? { credentials: { accessKeyId: provider.accessKeyId, secretAccessKey: provider.secretAccessKey, sessionToken: provider.sessionToken } } : {}),
    });
    const history: Message[] = messages.filter(m => m.role !== 'system').map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.providerData?.bedrockBlocks || (m.role === 'tool' ? [{ toolResult: { toolUseId: m.toolCallId!, content: [{ text: m.content }] } }] : [
        ...(m.content ? [{ text: m.content }] : []),
        ...(m.toolCalls || []).map(t => ({ toolUse: { toolUseId: t.id, name: t.name, input: parseArgs(t.arguments) } })),
      ]) as ContentBlock[],
    }));
    const merged: Message[] = [];
    for (const message of history) {
      if (merged.at(-1)?.role === message.role) merged.at(-1)!.content!.push(...message.content!);
      else merged.push(message);
    }
    try {
      const output = await client.send(new ConverseCommand({ modelId: provider.model, system: messages.filter(m => m.role === 'system').map(m => ({ text: m.content })), messages: merged,
        inferenceConfig: { maxTokens: 4096 }, toolConfig: tools.length ? { tools: tools.map(t => ({ toolSpec: { name: t.name, description: t.description, inputSchema: { json: t.parameters as any } } })) } : undefined,
      }), { abortSignal: options.signal });
      const blocks = output.output?.message?.content || [];
      const content = blocks.map(b => b.text || '').join(''); if (content) await options.onText?.(content);
      return { content, toolCalls: blocks.filter(b => b.toolUse).map(b => ({ id: b.toolUse!.toolUseId!, name: b.toolUse!.name!, arguments: JSON.stringify(b.toolUse!.input) })), providerData: { bedrockBlocks: blocks } };
    } catch (error) { if (options.signal?.aborted) throw error; throw new Error('Bedrock request failed. Check AWS region, credentials, model access and quotas.'); }
    finally { client.destroy(); }
  }
  if (provider.kind === 'ollama') {
    const data = await json(await call(join(provider.baseUrl, 'api/chat'), { model: provider.model, stream: false,
      messages: messages.map(m => ({ role: m.role, content: m.content, ...(m.toolCalls ? { tool_calls: m.toolCalls.map(t => ({ function: { name: t.name, arguments: parseArgs(t.arguments) } })) } : {}), ...(m.toolCallId ? { tool_name: messages.flatMap(x => x.toolCalls || []).find(t => t.id === m.toolCallId)?.name } : {}) })),
      tools: tools.map(t => ({ type: 'function', function: t })),
    }));
    const content = data.message?.content || ''; if (content) await options.onText?.(content);
    return { content, toolCalls: (data.message?.tool_calls || []).map((t: any) => ({ id: randomUUID(), name: t.function.name, arguments: JSON.stringify(t.function.arguments) })) };
  }
  if (provider.kind === 'anthropic') {
    const history: any[] = [];
    for (const m of messages.filter(m => m.role !== 'system')) {
      const role = m.role === 'assistant' ? 'assistant' : 'user';
      const content: any[] = m.role === 'tool' ? [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }] : [
        ...(m.content ? [{ type: 'text', text: m.content }] : []), ...(m.toolCalls || []).map(t => ({ type: 'tool_use', id: t.id, name: t.name, input: parseArgs(t.arguments) })),
      ];
      if (history.at(-1)?.role === role) history.at(-1).content.push(...content); else history.push({ role, content });
    }
    const data = await json(await call(join(provider.baseUrl, 'messages'), { model: provider.model, max_tokens: 4096, system: messages.filter(m => m.role === 'system').map(m => m.content).join('\n'), messages: history, tools: tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters })) }, { 'x-api-key': provider.apiKey || '', 'anthropic-version': '2023-06-01' }));
    const content = (data.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join(''); if (content) await options.onText?.(content);
    return { content, toolCalls: (data.content || []).filter((b: any) => b.type === 'tool_use').map((b: any) => ({ id: b.id, name: b.name, arguments: JSON.stringify(b.input) })) };
  }
  if (provider.kind === 'gemini') {
    const contents = messages.filter(m => m.role !== 'system').map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: m.providerData?.geminiParts || (m.role === 'tool' ? [{ functionResponse: { name: messages.flatMap(x => x.toolCalls || []).find(t => t.id === m.toolCallId)?.name, response: { result: m.content } } }] : [ ...(m.content ? [{ text: m.content }] : []), ...(m.toolCalls || []).map(t => ({ functionCall: { name: t.name, args: parseArgs(t.arguments) } })) ]) }));
    const data = await json(await call(join(provider.baseUrl, `models/${encodeURIComponent(provider.model)}:generateContent`), { systemInstruction: { parts: messages.filter(m => m.role === 'system').map(m => ({ text: m.content })) }, contents,
      tools: tools.length ? [{ functionDeclarations: tools.map(t => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters })) }] : undefined,
    }, { 'x-goog-api-key': provider.apiKey || '' }));
    const parts = data.candidates?.[0]?.content?.parts || [];
    const content = parts.filter((p: any) => !p.thought).map((p: any) => p.text || '').join(''); if (content) await options.onText?.(content);
    return { content, toolCalls: parts.filter((p: any) => p.functionCall).map((p: any) => ({ id: randomUUID(), name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args) })), providerData: { geminiParts: parts } };
  }
  const response = await call(join(provider.baseUrl, 'chat/completions'), { model: provider.model, stream: true,
    messages: messages.map(m => ({ role: m.role, content: m.content || null, ...(m.providerData?.reasoningContent ? { reasoning_content: m.providerData.reasoningContent } : {}), ...(m.toolCalls ? { tool_calls: m.toolCalls.map(t => ({ id: t.id, type: 'function', function: { name: t.name, arguments: t.arguments } })) } : {}), ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}) })),
    tools: tools.length ? tools.map(t => ({ type: 'function', function: t })) : undefined,
  }, { Authorization: `Bearer ${provider.apiKey || ''}` });
  let content = '', reasoningContent = ''; const toolCalls: ToolCall[] = [];
  for await (const data of sse(response)) {
    if (data.error) throw new Error('Provider stream failed. Check model access and quota.');
    const delta = data.choices?.[0]?.delta; if (!delta) continue;
    if (delta.content) { content += delta.content; await options.onText?.(delta.content); }
    if (delta.reasoning_content) reasoningContent += delta.reasoning_content;
    for (const t of delta.tool_calls || []) {
      const index = t.index ?? 0;
      toolCalls[index] ||= { id: '', name: '', arguments: '' };
      if (t.id) toolCalls[index].id = t.id;
      if (t.function?.name) toolCalls[index].name += t.function.name;
      if (t.function?.arguments) toolCalls[index].arguments += t.function.arguments;
    }
  }
  return { content, toolCalls: toolCalls.filter(Boolean), ...(reasoningContent ? { providerData: { reasoningContent } } : {}) };
}
export async function listModels(provider: ProviderInput, trustedOrigins: string[]) {
  if (provider.kind === 'bedrock-runtime') return [];
  const path = provider.kind === 'ollama' ? 'api/tags' : 'models';
  const headers: Record<string, string> = provider.kind === 'gemini' ? { 'x-goog-api-key': provider.apiKey || '' } : provider.kind === 'anthropic' ? { 'x-api-key': provider.apiKey || '', 'anthropic-version': '2023-06-01' } : { Authorization: `Bearer ${provider.apiKey || ''}` };
  const modelUrl = provider.kind === 'bedrock-mantle' ? new URL('/v1/models', provider.baseUrl).href : join(provider.baseUrl, path);
  const data = await json(await checkedFetch(modelUrl, { headers, trustedOrigins }));
  return (data.data || data.models || []).map((m: any) => m.id || (provider.kind === 'gemini' ? m.name?.replace(/^models\//, '') : m.name)).filter(Boolean);
}
