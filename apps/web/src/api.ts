import { notifications } from '@mantine/notifications';
import { useMutation, useQueryClient } from '@tanstack/react-query';

export async function api<T = any>(path: string, body?: unknown, method?: string): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    method: method || (body === undefined ? 'GET' : 'POST'), credentials: 'same-origin',
    headers: { 'x-rex-request': '1', ...(body !== undefined && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: body instanceof FormData ? body : JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error || `HTTP ${response.status}`), { status: response.status });
  return data;
}
export function useAction<T>(fn: (input: T) => Promise<any>, onSuccess?: (result: any) => void) {
  const client = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: result => { void client.invalidateQueries(); onSuccess?.(result); }, onError: (error: Error) => notifications.show({ color: 'red', title: 'REX', message: error.message, autoClose: false }) });
}
export const online = (node: any) => node?.last_seen && Date.now() - new Date(node.last_seen).getTime() < 30_000;
export const bytes = (n: number) => n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GiB` : `${Math.round(n / 1024 ** 2)} MiB`;
