import { useEffect, useRef, useState } from 'react';
import { Alert, Anchor, Button, FileButton, Group, Modal, Select, Stack, Tabs, Text, Textarea, TextInput, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import { api, bytes, online, useAction } from './api';
import { useLanguage } from './i18n';
import { Empty, QueryState } from './App';

export function ServerPage() {
  const { id } = useParams();
  return <ServerWorkspace key={id} id={id!} />;
}
function ServerWorkspace({ id }: { id: string }) {
  const { t } = useLanguage(), client = useQueryClient();
  const [tab, setTab] = useState<string | null>('chat'), [provider, setProvider] = useState<string | null>(null), [prompt, setPrompt] = useState(''), [stream, setStream] = useState(''), [connected, setConnected] = useState(false);
  const lastEvent = useRef(0), bottom = useRef<HTMLDivElement>(null);
  const server = useQuery({ queryKey: ['server', id], queryFn: () => api(`/servers/${id}`), refetchInterval: 10000 });
  const providers = useQuery<any[]>({ queryKey: ['providers'], queryFn: () => api('/providers') });
  const messages = useQuery<any[]>({ queryKey: ['messages', id], queryFn: () => api(`/servers/${id}/messages`) });
  const events = useQuery<any[]>({ queryKey: ['events', id], queryFn: () => api(`/servers/${id}/events`) });
  const runs = useQuery<any[]>({ queryKey: ['runs', id], queryFn: () => api(`/servers/${id}/runs`), refetchInterval: 5000 });
  const active = runs.data?.find(r => ['queued', 'running'].includes(r.status));
  const nodeOnline = online(server.data);
  const status = useQuery({ queryKey: ['status', id], queryFn: () => api(`/servers/${id}/operations`, { type: 'status' }), enabled: !!nodeOnline, refetchInterval: 10000 });
  const send = useAction(() => api(`/servers/${id}/chat`, { prompt, providerId: provider }), () => setPrompt(''));
  const attach = useAction(async (file: File) => { const body = new FormData(); body.append('file', file); const path = `uploads/${file.name}`; await api(`/servers/${id}/upload?path=${encodeURIComponent(path)}`, body); return { path }; }, result => setPrompt(old => `${old}${old ? '\n' : ''}${t('Attached file')}: ${result.path}`));
  const stop = useAction(() => api(`/servers/${id}/runs/${active?.id}/stop`, {}));
  const streamStarted = useRef(false);
  useEffect(() => {
    if (provider && providers.data?.some(p => p.id === provider)) return;
    const selected = providers.data?.find(p => p.isDefault) || (providers.data?.length === 1 ? providers.data[0] : null);
    setProvider(selected?.id || null);
  }, [provider, providers.data]);
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'nearest' }); }, [messages.data?.length, stream]);
  useEffect(() => {
    if (!events.data || server.isPending || server.isError) return;
    lastEvent.current = Math.max(lastEvent.current, ...events.data.map(e => Number(e.id)), 0);
    let socket: WebSocket, timer: ReturnType<typeof setTimeout>, closed = false;
    function connect() {
      socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/v1/servers/${id}/live?after=${lastEvent.current}`);
      socket.onopen = () => setConnected(true);
      socket.onmessage = raw => {
        const message = JSON.parse(raw.data);
        if (message.type === 'status') { client.setQueryData(['status', id], message.status); return; }
        if (message.type === 'logs') { client.setQueryData(['logs', id], message.logs); return; }
        if (message.type !== 'event') return;
        const event = message.event;
        if (Number(event.id) <= lastEvent.current) return;
        lastEvent.current = Number(event.id);
        client.setQueryData<any[]>(['events', id], old => [...(old || []), event]);
        if (event.type === 'assistant.delta') { streamStarted.current = true; setStream(old => old + event.data.text); }
        if (event.type === 'assistant.message') { streamStarted.current = false; setStream(''); void client.invalidateQueries({ queryKey: ['messages', id] }); }
        if (event.type.startsWith('run.')) { void client.invalidateQueries({ queryKey: ['runs', id] }); if (['run.completed', 'run.failed', 'run.stopped', 'run.interrupted'].includes(event.type)) { setStream(''); void client.invalidateQueries({ queryKey: ['messages', id] }); } }
      };
      socket.onclose = () => { setConnected(false); if (!closed) timer = setTimeout(connect, 2500); };
      socket.onerror = () => socket.close();
    }
    connect();
    return () => { closed = true; clearTimeout(timer); socket?.close(); };
  }, [id, !!events.data, server.isPending, server.isError, client]);
  return <QueryState query={server}>{server.data && <Stack gap="lg"><Anchor component={Link} to="/" size="sm">{t('Servers')}</Anchor><Group justify="space-between" align="flex-start"><div className="wrap"><Title order={1}>{server.data.name}</Title><Text size="sm" mt={6}>{server.data.config.edition} {server.data.config.version} · {server.data.address}:{server.data.config.port}</Text></div><Text size="sm" role="status">{t(nodeOnline ? 'Node online' : 'Node offline')} · {t(connected ? 'Live' : 'Disconnected. Reconnecting…')}</Text></Group>
    {!nodeOnline && <Alert color="yellow">{t('Node offline')}. Reconnect the REX agent to manage this server.</Alert>}
    <Tabs value={tab} onChange={setTab}><Tabs.List><Tabs.Tab value="chat">{t('Chat')}</Tabs.Tab><Tabs.Tab value="advanced">{t('Advanced')}</Tabs.Tab><Tabs.Tab value="activity">{t('Activity')}</Tabs.Tab></Tabs.List>
      <Tabs.Panel value="chat"><div className="workspace"><section className="chat" aria-label={t('Chat')}><QueryState query={messages}><div className="messages" aria-live="polite" aria-relevant="additions text">{!messages.data?.length && <Empty title="REX"><Text>{t('Ask REX to install your server, add mods, change settings, or investigate a crash.')}</Text></Empty>}{messages.data?.map(m => <article className={`message ${m.role}`} key={m.id}><Text size="xs" fw={700}>{m.role === 'user' ? server.data.owner_id === m.user_id ? 'You' : 'Admin' : 'REX'}</Text><ReactMarkdown>{m.content}</ReactMarkdown></article>)}{stream && <article className="message"><Text size="xs" fw={700}>REX</Text><ReactMarkdown>{stream}</ReactMarkdown></article>}<div ref={bottom} /></div></QueryState>
        <form className="composer" onSubmit={e => { e.preventDefault(); if (provider && prompt.trim() && !active) send.mutate(); }}><Stack gap="sm"><QueryState query={providers}>{providers.data?.length ? <Select label={t('Select provider')} data={providers.data.map(p => ({ value: p.id, label: `${p.name} · ${p.model}` }))} value={provider} onChange={setProvider} searchable required /> : <Alert><Anchor component={Link} to="/providers">{t('Add a provider before chatting with REX.')}</Anchor></Alert>}</QueryState><Textarea label={t('What should REX do?')} value={prompt} onChange={e => setPrompt(e.target.value)} autosize minRows={3} maxRows={8} maxLength={16000} required onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && provider && prompt.trim() && !active) { e.preventDefault(); send.mutate(); } }} /><Group justify="space-between"><Text size="sm" role="status">{active ? `${t('Working…')} (${active.status})` : runs.data?.[0] ? `${t('Run status')}: ${runs.data[0].status}` : 'Ctrl / ⌘ + Enter'}</Text><Group><FileButton onChange={file => { if (file) attach.mutate(file); }}>{props => <Button {...props} variant="default" disabled={!nodeOnline || !!active} loading={attach.isPending}>{t('Attach file')}</Button>}</FileButton>{active ? <Button color="red" variant="default" loading={stop.isPending} disabled={active.cancel_requested} onClick={() => stop.mutate()}>{t('Stop execution')}</Button> : <Button type="submit" disabled={!provider || !prompt.trim() || attach.isPending} loading={send.isPending}>{t('Send')}</Button>}</Group></Group></Stack></form>
      </section><aside><Stack gap="lg"><div><Title order={2} size="h4">{t('Server state')}</Title><Text size="sm" mt={8}>{status.data?.state || (nodeOnline ? t('Loading…') : t('Unknown'))}{status.data?.health ? ` · ${status.data.health}` : ''}</Text>{status.error && <Text size="sm" c="red">{status.error.message}</Text>}<Text size="sm" mt={8}>{t('RAM')}: {status.data ? bytes(status.data.memoryBytes || 0) : '…'} / {server.data.config.memoryMb} MiB</Text><Text size="sm">{t('Disk')}: {status.data ? bytes(status.data.diskBytes || 0) : '…'} / {server.data.config.diskMb} MiB</Text><Text size="sm">CPU: {server.data.config.cpu}</Text></div><Console id={id} nodeOnline={!!nodeOnline} compact /><Button variant="default" onClick={() => setTab('advanced')}>{t('Advanced')}</Button></Stack></aside></div></Tabs.Panel>
      <Tabs.Panel value="advanced" pt="lg">{tab === 'advanced' && <Advanced id={id} nodeOnline={!!nodeOnline} installed={status.data?.state !== 'not-installed'} />}</Tabs.Panel>
      <Tabs.Panel value="activity" pt="lg"><QueryState query={events}>{!events.data?.filter(e => e.type !== 'assistant.delta').length ? <Empty title={t('No activity yet')}><Text>{t('Actions and their results will appear here.')}</Text></Empty> : <Stack>{events.data?.filter(e => e.type !== 'assistant.delta').slice().reverse().map(e => <details className="surface" style={{ padding: 14 }} key={e.id}><summary style={{ cursor: 'pointer', minHeight: 32 }}>{e.type} · {new Date(e.created_at).toLocaleTimeString()}</summary><pre className="event-json">{JSON.stringify(e.data, null, 2)}</pre></details>)}</Stack>}</QueryState></Tabs.Panel>
    </Tabs>
  </Stack>}</QueryState>;
}
function Console({ id, nodeOnline, compact = false }: { id: string; nodeOnline: boolean; compact?: boolean }) {
  const { t } = useLanguage(); const [command, setCommand] = useState('');
  const logs = useQuery({ queryKey: ['logs', id], queryFn: () => api(`/servers/${id}/operations`, { type: 'logs', tail: compact ? 40 : 150 }), enabled: nodeOnline, refetchInterval: nodeOnline ? 5000 : false });
  const send = useAction(() => api(`/servers/${id}/operations`, { type: 'console', command }), () => setCommand(''));
  return <Stack gap="sm"><Group justify="space-between"><Title order={2} size="h4">{t('Console')}</Title>{!compact && <Button variant="subtle" disabled={!nodeOnline} onClick={() => logs.refetch()}>{t('Refresh')}</Button>}</Group>{!nodeOnline ? <Text size="sm">{t('Node offline')}</Text> : <QueryState query={logs}><pre className={`console ${compact ? '' : 'large'}`} tabIndex={0} aria-label={t('Console')}>{logs.data?.content || 'No console output yet.'}</pre></QueryState>}{!compact && <form onSubmit={e => { e.preventDefault(); send.mutate(); }}><Group align="end"><TextInput style={{ flex: 1 }} label={t('Console command')} required value={command} onChange={e => setCommand(e.target.value)} /><Button type="submit" disabled={!nodeOnline || !command.trim()} loading={send.isPending}>{t('Send command')}</Button></Group></form>}</Stack>;
}
function Advanced({ id, nodeOnline, installed }: { id: string; nodeOnline: boolean; installed: boolean }) {
  const { t } = useLanguage(); const [tab, setTab] = useState<string | null>('console'), [confirm, setConfirm] = useState(false), [shell, setShell] = useState(''), [result, setResult] = useState('');
  const operation = useAction((op: any) => api(`/servers/${id}/operations`, op));
  const install = useAction(() => api(`/servers/${id}/operations`, { type: 'install' }), () => setConfirm(false));
  const runShell = useAction(() => api(`/servers/${id}/operations`, { type: 'shell', command: shell }), output => setResult(JSON.stringify(output, null, 2)));
  return <Stack gap="lg"><Group><Button variant="default" disabled={!nodeOnline} loading={install.isPending} onClick={() => installed ? setConfirm(true) : install.mutate()}>{t('Install')}</Button>{(['start', 'stop', 'restart', 'kill'] as const).map(action => <Button key={action} variant="default" color={action === 'kill' ? 'red' : undefined} disabled={!nodeOnline || operation.isPending} onClick={() => operation.mutate({ type: 'power', action })}>{t(action[0].toUpperCase() + action.slice(1))}</Button>)}</Group><Tabs value={tab} onChange={setTab}><Tabs.List><Tabs.Tab value="console">{t('Console')}</Tabs.Tab><Tabs.Tab value="files">{t('Files')}</Tabs.Tab><Tabs.Tab value="backups">{t('Backups')}</Tabs.Tab><Tabs.Tab value="shell">Shell</Tabs.Tab></Tabs.List><Tabs.Panel value="console" pt="lg"><Console id={id} nodeOnline={nodeOnline} /></Tabs.Panel><Tabs.Panel value="files" pt="lg">{tab === 'files' && <Files id={id} nodeOnline={nodeOnline} />}</Tabs.Panel><Tabs.Panel value="backups" pt="lg">{tab === 'backups' && <Backups id={id} nodeOnline={nodeOnline} />}</Tabs.Panel><Tabs.Panel value="shell" pt="lg"><form onSubmit={e => { e.preventDefault(); runShell.mutate(); }}><Stack><Textarea label="Shell command (inside game container)" value={shell} onChange={e => setShell(e.target.value)} required minRows={3} /><Button type="submit" loading={runShell.isPending} disabled={!nodeOnline || !shell.trim()} style={{ alignSelf: 'flex-start' }}>{t('Send command')}</Button>{result && <pre className="console" tabIndex={0}>{result}</pre>}</Stack></form></Tabs.Panel></Tabs><Modal opened={confirm} onClose={() => setConfirm(false)} title={t('Reinstall the server? A backup will be created first.')} centered><Group justify="flex-end"><Button variant="default" onClick={() => setConfirm(false)}>{t('Cancel')}</Button><Button loading={install.isPending} onClick={() => install.mutate()}>{t('Confirm')}</Button></Group></Modal></Stack>;
}
function Files({ id, nodeOnline }: { id: string; nodeOnline: boolean }) {
  const { t } = useLanguage(); const [directory, setDirectory] = useState('.'), [path, setPath] = useState(''), [content, setContent] = useState<string | null>(null), [confirm, setConfirm] = useState(false);
  const files = useQuery<any[]>({ queryKey: ['files', id, directory], queryFn: () => api(`/servers/${id}/operations`, { type: 'list', path: directory }), enabled: nodeOnline });
  const read = useAction((target: string) => api(`/servers/${id}/operations`, { type: 'read', path: target }), result => setContent(result.content));
  const write = useAction(() => api(`/servers/${id}/operations`, { type: 'write', path, content }), () => notifications.show({ message: t('Saved') }));
  const remove = useAction(() => api(`/servers/${id}/operations`, { type: 'remove', path }), () => { setConfirm(false); setContent(null); setPath(''); });
  const upload = useAction((file: File) => { const body = new FormData(); body.append('file', file); return api(`/servers/${id}/upload?path=${encodeURIComponent(directory === '.' ? file.name : `${directory}/${file.name}`)}`, body); });
  if (!nodeOnline) return <Text>{t('Node offline')}</Text>;
  const child = (name: string) => directory === '.' ? name : `${directory}/${name}`;
  return <Stack><Group justify="space-between"><Text className="wrap">/{directory === '.' ? '' : directory}</Text><Group><Button variant="default" disabled={directory === '.'} onClick={() => setDirectory(directory.includes('/') ? directory.slice(0, directory.lastIndexOf('/')) : '.')}>{t('Parent directory')}</Button><FileButton onChange={file => { if (file) upload.mutate(file); }}>{props => <Button {...props} variant="default" loading={upload.isPending}>{t('Upload')}</Button>}</FileButton><Button variant="default" onClick={() => files.refetch()}>{t('Refresh')}</Button></Group></Group><QueryState query={files}><div className="file-list">{files.data?.length ? files.data.map(file => <div key={file.name} className="file-entry"><Button variant="subtle" color="gray" style={{ flex: 1, justifyContent: 'flex-start' }} onClick={() => { const target = child(file.name); if (file.directory) setDirectory(target); else { setPath(target); read.mutate(target); } }}>{file.directory ? `${file.name}/` : file.name}{file.symlink ? ' (link)' : ''}</Button>{!file.directory && <Button variant="subtle" component="a" href={`/api/v1/servers/${id}/files/download?path=${encodeURIComponent(child(file.name))}`}>{t('Download')}</Button>}</div>) : <Text>{t('No files in this directory')}</Text>}</div></QueryState><form onSubmit={e => { e.preventDefault(); read.mutate(path); }}><Group align="end"><TextInput style={{ flex: 1 }} label={t('File path')} required value={path} onChange={e => { setPath(e.target.value); setContent(null); }} /><Button type="submit" variant="default" disabled={!path || read.isPending}>{t('Open')}</Button><Button variant="default" disabled={!path} onClick={() => setContent('')}>New file</Button></Group></form>{content !== null && <Stack><Textarea label={t('File content')} value={content} onChange={e => setContent(e.target.value)} minRows={12} autosize maxRows={30} styles={{ input: { fontFamily: 'ui-monospace, monospace' } }} /><Group><Button disabled={!path} loading={write.isPending} onClick={() => write.mutate()}>{t('Save file')}</Button><Button color="red" variant="subtle" onClick={() => setConfirm(true)}>{t('Delete file')}</Button></Group></Stack>}<Modal opened={confirm} onClose={() => setConfirm(false)} title={t('Delete this file?')} centered><Text mb="md" className="wrap">{path}</Text><Group justify="flex-end"><Button variant="default" onClick={() => setConfirm(false)}>{t('Cancel')}</Button><Button color="red" loading={remove.isPending} onClick={() => remove.mutate()}>{t('Delete')}</Button></Group></Modal></Stack>;
}
function Backups({ id, nodeOnline }: { id: string; nodeOnline: boolean }) {
  const { t } = useLanguage(); const [restoreId, setRestoreId] = useState('');
  const backups = useQuery<any[]>({ queryKey: ['backups', id], queryFn: () => api(`/servers/${id}/operations`, { type: 'backups' }), enabled: nodeOnline });
  const create = useAction(() => api(`/servers/${id}/operations`, { type: 'backup' }));
  const restore = useAction(() => api(`/servers/${id}/operations`, { type: 'restore', backupId: restoreId }), () => setRestoreId(''));
  if (!nodeOnline) return <Text>{t('Node offline')}</Text>;
  return <Stack><Text size="sm">{t('Backups stop the server briefly for a consistent copy, then restart it if it was running.')}</Text><Button onClick={() => create.mutate()} loading={create.isPending} style={{ alignSelf: 'flex-start' }}>{t('Create backup')}</Button><QueryState query={backups}>{backups.data?.length ? backups.data.map(b => <Group key={b.id} justify="space-between" className="surface" p="md"><div className="wrap"><Text size="sm">{new Date(b.createdAt).toLocaleString()}</Text><Text size="xs">{b.id} · {bytes(b.size)}</Text></div><Group><Button variant="default" component="a" href={`/api/v1/servers/${id}/backup/${b.id}`}>{t('Download')}</Button><Button variant="default" onClick={() => setRestoreId(b.id)}>{t('Restore')}</Button></Group></Group>) : <Text>{t('No backups yet')}</Text>}</QueryState><Modal opened={!!restoreId} onClose={() => setRestoreId('')} title={t('Restore this backup? A recovery backup will be created first.')} centered><Group justify="flex-end"><Button variant="default" onClick={() => setRestoreId('')}>{t('Cancel')}</Button><Button loading={restore.isPending} onClick={() => restore.mutate()}>{t('Restore')}</Button></Group></Modal></Stack>;
}
