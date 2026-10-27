import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';

const blocked = new BlockList();
const blocked6 = new BlockList();
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) blocked.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [['::', 128], ['::1', 128], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) blocked6.addSubnet(address, prefix, 'ipv6');
export function publicAddress(address: string) { const family = isIP(address); return family !== 0 && !(family === 6 ? blocked6.check(address, 'ipv6') : blocked.check(address, 'ipv4')); }
export async function checkedFetch(input: string, init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal; trustedOrigins?: string[]; maxBytes?: number } = {}, redirects = 0): Promise<Response> {
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Only HTTP(S) URLs without embedded credentials are supported.');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = await lookup(hostname, { all: true });
  if (!addresses.length) throw new Error('Endpoint has no DNS address.');
  const trusted = init.trustedOrigins?.includes(url.origin);
  if (!trusted && addresses.some(item => !publicAddress(item.address))) throw new Error('Private network endpoint requires administrator approval in Settings.');
  if (!trusted && url.protocol !== 'https:') throw new Error('Public endpoints must use HTTPS.');
  const address = addresses[0];
  const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(url, {
      method: init.method || 'GET', headers: init.headers, signal: init.signal,
      lookup: ((_host: unknown, options: any, callback: any) => options.all ? callback(null, [address]) : callback(null, address.address, address.family)) as any,
    }, resolve);
    req.on('error', reject); req.setTimeout(120_000, () => req.destroy(new Error('Endpoint timed out.')));
    req.end(init.body);
  });
  if ([301, 302, 303, 307, 308].includes(response.statusCode || 0)) {
    response.resume();
    if (redirects >= 5 || !response.headers.location) throw new Error('Too many redirects.');
    const destination = new URL(response.headers.location, url);
    if (init.method && init.method !== 'GET') throw new Error('Provider endpoints must not redirect POST requests.');
    const headers = { ...init.headers };
    if (destination.origin !== url.origin) { delete headers.Authorization; delete headers.authorization; }
    return checkedFetch(destination.href, { ...init, headers }, redirects + 1);
  }
  const limit = init.maxBytes ?? 16 * 1024 * 1024;
  let bytes = 0;
  async function* limited() {
    for await (const chunk of response) {
      bytes += chunk.length;
      if (bytes > limit) { response.destroy(); throw new Error('Response exceeds the size limit.'); }
      yield chunk;
    }
  }
  const headers = new Headers();
  for (const [name, value] of Object.entries(response.headers)) if (value) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  return new Response(Readable.toWeb(Readable.from(limited())) as ReadableStream, { status: response.statusCode || 502, headers });
}
