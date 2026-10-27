import { useEffect, useRef, useState } from 'react';
import { Alert, Anchor, Button, FileButton, Group, Modal, Select, Stack, Switch, Tabs, Text, Textarea, TextInput, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  Activity01Icon,
  Alert02Icon,
  ArrowLeft01Icon,
  Attachment01Icon,
  BotIcon,
  BubbleChatIcon,
  ChatAdd01Icon,
  CheckmarkCircle02Icon,
  ChipIcon,
  ComputerTerminal01Icon,
  CpuIcon,
  FilterIcon,
  Folder01Icon,
  HardDriveIcon,
  RefreshIcon,
  SentIcon,
  ServerStack01Icon,
  SquareStopIcon,
  TestTubeIcon,
  Upload01Icon,
  UserIcon,
  Wifi01Icon,
  WifiOff01Icon,
  Wrench01Icon,
} from '@hugeicons/core-free-icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import { api, bytes, online, useAction } from './api';
import { Icon } from './Icon';
import { useLanguage } from './i18n';
import { Empty, QueryState } from './App';

export function ServerPage() {
  const { id } = useParams();
  return <ServerWorkspace key={id} id={id!} />;
}
function ServerWorkspace({ id }: { id: string }) {
  const { t } = useLanguage(), client = useQueryClient();
  const [tab, setTab] = useState<string | null>('chat'), [chatId, setChatId] = useState<string | null>(null), [provider, setProvider] = useState<string | null>(null), [model, setModel] = useState(''), [toolsOnly, setToolsOnly] = useState(true), [prompt, setPrompt] = useState(''), [stream, setStream] = useState(''), [connected, setConnected] = useState(false);
  const lastEvent = useRef(0), bottom = useRef<HTMLDivElement>(null), chatIdRef = useRef<string | null>(null);
  chatIdRef.current = chatId;
  const server = useQuery({ queryKey: ['server', id], queryFn: () => api(`/servers/${id}`), refetchInterval: 10000 });
  const providers = useQuery<any[]>({ queryKey: ['providers'], queryFn: () => api('/providers') });
  const selectedProvider = providers.data?.find(p => p.id === provider);
  const models = useQuery<string[]>({ queryKey: ['provider-models', provider], queryFn: () => api(`/providers/${provider}/models`), enabled: !!provider, retry: false });
  const chats = useQuery<any[]>({ queryKey: ['chats', id], queryFn: () => api(`/servers/${id}/chats`) });
  const messages = useQuery<any[]>({ queryKey: ['messages', id, chatId], queryFn: () => api(`/servers/${id}/messages?chatId=${chatId}`), enabled: !!chatId });
  const events = useQuery<any[]>({ queryKey: ['events', id], queryFn: () => api(`/servers/${id}/events`) });
  const runs = useQuery<any[]>({ queryKey: ['runs', id, chatId], queryFn: () => api(`/servers/${id}/runs?chatId=${chatId}`), enabled: !!chatId, refetchInterval: 5000 });
  const active = runs.data?.find(r => ['queued', 'running'].includes(r.status));
  const nodeOnline = online(server.data);
  const status = useQuery({ queryKey: ['status', id], queryFn: () => api(`/servers/${id}/operations`, { type: 'status' }), enabled: !!nodeOnline, refetchInterval: 10000 });
  const send = useAction(() => api(`/servers/${id}/chat`, { prompt, providerId: provider, chatId }), () => { setPrompt(''); void client.invalidateQueries({ queryKey: ['chats', id] }); });
  const attach = useAction(async (file: File) => { const body = new FormData(); body.append('file', file); const path = `uploads/${file.name}`; await api(`/servers/${id}/upload?path=${encodeURIComponent(path)}`, body); return { path }; }, result => setPrompt(old => `${old}${old ? '\n' : ''}${t('Attached file')}: ${result.path}`));
  const stop = useAction(() => api(`/servers/${id}/runs/${active?.id}/stop`, {}));
  const createChat = useAction(() => api(`/servers/${id}/chats`, {}), chat => {
    setStream('');
    setPrompt('');
    setChatId(chat.id);
    void client.invalidateQueries({ queryKey: ['chats', id] });
  });
  const applyModel = useAction(async (next: string) => {
    await api(`/providers/${provider}/model`, { model: next }, 'PATCH');
    return api(`/providers/${provider}/test`, {});
  }, result => {
    void client.invalidateQueries({ queryKey: ['providers'] });
    notifications.show({ title: selectedProvider?.name || t('Model'), message: result.message, color: result.toolCapable ? 'green' : 'yellow' });
  });
  const testProvider = useAction(() => api(`/providers/${provider}/test`, {}), result => {
    void client.invalidateQueries({ queryKey: ['providers'] });
    notifications.show({ title: selectedProvider?.name || t('Select provider'), message: result.message, color: result.toolCapable ? 'green' : 'yellow' });
  });
  const streamStarted = useRef(false);
  const visibleProviders = (providers.data || []).filter(p => !toolsOnly || p.toolCapable);
  const modelOptions = Array.from(new Set([...(models.data || []), model, selectedProvider?.model].filter(Boolean) as string[]));
  const providerLabel = (p: { name: string; model: string; toolCapable?: boolean }) => {
    const status = p.toolCapable ? t('Tools verified') : t('Chat only / untested');
    return p.name + ' · ' + p.model + ' · ' + status;
  };
  const runHint = active
    ? t('Working…') + ' (' + active.status + ')'
    : runs.data?.[0]
      ? t('Run status') + ': ' + runs.data[0].status
      : 'Ctrl / ⌘ + Enter';
  useEffect(() => {
    if (!chats.data?.length) return;
    if (chatId && chats.data.some(c => c.id === chatId)) return;
    setChatId(chats.data[0].id);
  }, [chats.data, chatId]);
  useEffect(() => {
    if (!providers.data?.length) { setProvider(null); return; }
    const pool = providers.data.filter(p => !toolsOnly || p.toolCapable);
    if (toolsOnly && !pool.length) { setProvider(null); return; }
    if (provider && pool.some(p => p.id === provider)) return;
    const selected = pool.find(p => p.isDefault) || pool[0] || null;
    setProvider(selected?.id || null);
  }, [provider, providers.data, toolsOnly]);
  useEffect(() => {
    setModel(selectedProvider?.model || '');
  }, [selectedProvider?.id, selectedProvider?.model]);
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'nearest' }); }, [messages.data?.length, stream]);
  useEffect(() => { setStream(''); }, [chatId]);
  useEffect(() => {
    if (!events.data || server.isPending || server.isError) return;
    lastEvent.current = Math.max(lastEvent.current, ...events.data.map(e => Number(e.id)), 0);
    let socket: WebSocket, timer: ReturnType<typeof setTimeout>, closed = false;
    function forCurrentChat(data: any) {
      return !data?.chatId || !chatIdRef.current || data.chatId === chatIdRef.current;
    }
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
        if (event.type === 'assistant.delta' && forCurrentChat(event.data)) { streamStarted.current = true; setStream(old => old + event.data.text); }
        if (event.type === 'assistant.message' && forCurrentChat(event.data)) { streamStarted.current = false; setStream(''); void client.invalidateQueries({ queryKey: ['messages', id, chatIdRef.current] }); void client.invalidateQueries({ queryKey: ['chats', id] }); }
        if (event.type.startsWith('run.')) {
          void client.invalidateQueries({ queryKey: ['runs', id] });
          if (['run.completed', 'run.failed', 'run.stopped', 'run.interrupted'].includes(event.type) && forCurrentChat(event.data)) {
            setStream('');
            void client.invalidateQueries({ queryKey: ['messages', id, chatIdRef.current] });
            void client.invalidateQueries({ queryKey: ['chats', id] });
          }
        }
      };
      socket.onclose = () => { setConnected(false); if (!closed) timer = setTimeout(connect, 2500); };
      socket.onerror = () => socket.close();
    }
    connect();
    return () => { closed = true; clearTimeout(timer); socket?.close(); };
  }, [id, !!events.data, server.isPending, server.isError, client]);
  return <QueryState query={server}>{server.data && <div className="workspace-shell">
    <div className="workspace-header">
      <Anchor component={Link} to="/" size="sm" className="back-link"><Icon icon={ArrowLeft01Icon} size={16} />{t('Servers')}</Anchor>
      <div className="workspace-title-row">
        <div className="wrap">
          <Group gap="sm" wrap="nowrap" align="flex-start">
            <div className="server-icon"><Icon icon={ServerStack01Icon} size={22} /></div>
            <div>
              <Title order={1}>{server.data.name}</Title>
              <Text size="sm" mt={6} c="dimmed">{server.data.config.edition} {server.data.config.version} · {server.data.address}:{server.data.config.port}</Text>
            </div>
          </Group>
        </div>
        <div className="workspace-status" role="status">
          <span className={`status-chip ${nodeOnline ? 'online' : 'offline'}`}><Icon icon={nodeOnline ? Wifi01Icon : WifiOff01Icon} size={14} />{t(nodeOnline ? 'Node online' : 'Node offline')}</span>
          <span className={`status-chip ${connected ? 'live' : 'dead'}`}><Icon icon={connected ? Wifi01Icon : WifiOff01Icon} size={14} />{t(connected ? 'Live' : 'Disconnected. Reconnecting…')}</span>
        </div>
      </div>
    </div>
    {!nodeOnline && <Alert color="yellow" mb="md">{t('Node offline')}. Reconnect the REX agent to manage this server.</Alert>}
    <Tabs className="rex-tabs" value={tab} onChange={setTab}>
      <Tabs.List>
        <Tabs.Tab value="chat" leftSection={<Icon icon={BubbleChatIcon} size={16} />}>{t('Chat')}</Tabs.Tab>
        <Tabs.Tab value="advanced" leftSection={<Icon icon={Wrench01Icon} size={16} />}>{t('Advanced')}</Tabs.Tab>
        <Tabs.Tab value="activity" leftSection={<Icon icon={Activity01Icon} size={16} />}>{t('Activity')}</Tabs.Tab>
      </Tabs.List>
      <Tabs.Panel value="chat">
        <div className="workspace">
          <section className="chat" aria-label={t('Chat')}>
            <div className="chat-toolbar">
              <QueryState query={chats}>
                <Select
                  className="chat-picker"
                  aria-label={t('Chats')}
                  data={(chats.data || []).map(c => ({ value: c.id, label: c.title || t('New chat') }))}
                  value={chatId}
                  onChange={value => { if (value) setChatId(value); }}
                  searchable
                  allowDeselect={false}
                />
              </QueryState>
              <Button variant="default" leftSection={<Icon icon={ChatAdd01Icon} size={16} />} loading={createChat.isPending} onClick={() => createChat.mutate()}>{t('New chat')}</Button>
            </div>
            <QueryState query={messages}>
              <div className="messages" aria-live="polite" aria-relevant="additions text">
                {!messages.data?.length && !stream && (
                  <div className="chat-empty">
                    <div className="chat-empty-icon"><Icon icon={BubbleChatIcon} size={26} /></div>
                    <Title order={2} size="h3">REX</Title>
                    <Text mt="sm">{t('Ask REX to install your server, add mods, change settings, or investigate a crash.')}</Text>
                  </div>
                )}
                {messages.data?.map(m => (
                  <article className={`message ${m.role}`} key={m.id}>
                    <div className="message-avatar"><Icon icon={m.role === 'user' ? UserIcon : BotIcon} size={18} /></div>
                    <div className="message-body">
                      <Text className="message-role" size="xs" fw={700}>{m.role === 'user' ? server.data.owner_id === m.user_id ? 'You' : 'Admin' : 'REX'}</Text>
                      <ReactMarkdown>{m.content}</ReactMarkdown>
                    </div>
                  </article>
                ))}
                {stream && (
                  <article className="message assistant streaming">
                    <div className="message-avatar"><Icon icon={BotIcon} size={18} /></div>
                    <div className="message-body">
                      <Text className="message-role" size="xs" fw={700}>REX</Text>
                      <ReactMarkdown>{stream}</ReactMarkdown>
                    </div>
                  </article>
                )}
                <div ref={bottom} />
              </div>
            </QueryState>
            <form className="composer" onSubmit={e => { e.preventDefault(); if (provider && prompt.trim() && chatId && !active) send.mutate(); }}>
              <Stack gap="sm">
                <QueryState query={providers}>
                  {providers.data?.length ? <>
                    <div className="composer-model-row">
                      <Select
                        className="composer-provider"
                        label={t('Select provider')}
                        data={visibleProviders.map(p => ({ value: p.id, label: providerLabel(p) }))}
                        value={provider}
                        onChange={setProvider}
                        searchable
                        required
                        nothingFoundMessage={toolsOnly ? t('No tool-capable providers yet. Turn off the filter or test a provider.') : t('No providers configured')}
                      />
                      {models.isError || (!models.isFetching && !(models.data || []).length) ? (
                        <TextInput
                          className="composer-model"
                          label={t('Model')}
                          value={model}
                          onChange={e => setModel(e.target.value)}
                          disabled={!provider || applyModel.isPending}
                          description={models.isError ? t('Could not list models. Type a model ID.') : t('This provider does not list models. Enter a model ID manually.')}
                          rightSection={model && model !== selectedProvider?.model ? (
                            <Button size="compact-sm" variant="subtle" loading={applyModel.isPending} onClick={() => applyModel.mutate(model)}>{t('Use model')}</Button>
                          ) : undefined}
                          rightSectionWidth={model && model !== selectedProvider?.model ? 96 : undefined}
                        />
                      ) : (
                        <Select
                          className="composer-model"
                          label={t('Model')}
                          data={modelOptions}
                          value={model || null}
                          onChange={value => {
                            if (!value || !provider || value === selectedProvider?.model) { setModel(value || ''); return; }
                            setModel(value);
                            applyModel.mutate(value);
                          }}
                          searchable
                          disabled={!provider || applyModel.isPending || models.isFetching}
                          nothingFoundMessage={models.isFetching ? t('Loading…') : t('No models found')}
                        />
                      )}
                    </div>
                    <Group justify="space-between" align="center" gap="sm" wrap="wrap">
                      <Switch
                        checked={toolsOnly}
                        onChange={e => setToolsOnly(e.currentTarget.checked)}
                        label={<Group gap={6}><Icon icon={FilterIcon} size={16} /><span>{t('Tools only')}</span></Group>}
                        aria-label={t('Tools only')}
                      />
                      <Group gap="sm" wrap="wrap">
                        <span className={'status-chip ' + (selectedProvider?.toolCapable ? 'online' : 'warn')} role="status">
                          <Icon icon={selectedProvider?.toolCapable ? CheckmarkCircle02Icon : Alert02Icon} size={14} />
                          {t(selectedProvider?.toolCapable ? 'Tools verified' : 'Chat only / untested')}
                        </span>
                        <Button
                          variant="default"
                          size="compact-md"
                          leftSection={<Icon icon={TestTubeIcon} size={16} />}
                          disabled={!provider || !!active}
                          loading={testProvider.isPending || applyModel.isPending}
                          onClick={() => testProvider.mutate()}
                        >{t('Test connection')}</Button>
                      </Group>
                    </Group>
                    {toolsOnly && !providers.data.some(p => p.toolCapable) && (
                      <Alert color="yellow" icon={<Icon icon={Alert02Icon} size={16} />}>
                        {t('No tool-capable providers yet. Test a provider, or turn off Tools only to chat without actions.')}{' '}
                        <Anchor component={Link} to="/providers">{t('Providers')}</Anchor>
                      </Alert>
                    )}
                    {selectedProvider && !selectedProvider.toolCapable && (
                      <Alert color="yellow" icon={<Icon icon={Alert02Icon} size={16} />}>
                        {t('This model cannot run server actions until tool calling passes. Use Test connection, or pick a tools-verified provider.')}
                      </Alert>
                    )}
                  </> : <Alert><Anchor component={Link} to="/providers">{t('Add a provider before chatting with REX.')}</Anchor></Alert>}
                </QueryState>
                <Textarea
                  label={t('What should REX do?')}
                  value={prompt}
                  onChange={e => setPrompt(e.target.value)}
                  autosize
                  minRows={3}
                  maxRows={8}
                  maxLength={16000}
                  required
                  onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && provider && prompt.trim() && chatId && !active) { e.preventDefault(); send.mutate(); } }}
                />
                <div className="composer-tools">
                  <Text size="sm" role="status" className="composer-hint">{runHint}</Text>
                  <div className="composer-actions">
                    <FileButton onChange={file => { if (file) attach.mutate(file); }}>
                      {props => <Button {...props} variant="default" leftSection={<Icon icon={Attachment01Icon} size={16} />} disabled={!nodeOnline || !!active} loading={attach.isPending}>{t('Attach file')}</Button>}
                    </FileButton>
                    {active
                      ? <Button color="red" variant="default" leftSection={<Icon icon={SquareStopIcon} size={16} />} loading={stop.isPending} disabled={active.cancel_requested} onClick={() => stop.mutate()}>{t('Stop execution')}</Button>
                      : <Button type="submit" leftSection={<Icon icon={SentIcon} size={16} />} disabled={!provider || !prompt.trim() || !chatId || attach.isPending || applyModel.isPending} loading={send.isPending}>{t('Send')}</Button>}
                  </div>
                </div>
              </Stack>
            </form>
          </section>
          <aside className="side-panel">
            <Stack gap="lg">
              <div>
                <Title order={2} size="h4">{t('Server state')}</Title>
                <div className="metric-list">
                  <div className="metric">
                    <div className="metric-icon"><Icon icon={ServerStack01Icon} size={16} /></div>
                    <div>
                      <div className="metric-label">{t('Server state')}</div>
                      <div className="metric-value">{status.data?.state || (nodeOnline ? t('Loading…') : t('Unknown'))}{status.data?.health ? ` · ${status.data.health}` : ''}</div>
                      {status.error && <Text size="sm" c="red">{status.error.message}</Text>}
                    </div>
                  </div>
                  <div className="metric">
                    <div className="metric-icon"><Icon icon={ChipIcon} size={16} /></div>
                    <div>
                      <div className="metric-label">{t('RAM')}</div>
                      <div className="metric-value">{status.data ? bytes(status.data.memoryBytes || 0) : '…'} / {server.data.config.memoryMb} MiB</div>
                    </div>
                  </div>
                  <div className="metric">
                    <div className="metric-icon"><Icon icon={HardDriveIcon} size={16} /></div>
                    <div>
                      <div className="metric-label">{t('Disk')}</div>
                      <div className="metric-value">{status.data ? bytes(status.data.diskBytes || 0) : '…'} / {server.data.config.diskMb} MiB</div>
                    </div>
                  </div>
                  <div className="metric">
                    <div className="metric-icon"><Icon icon={CpuIcon} size={16} /></div>
                    <div>
                      <div className="metric-label">CPU</div>
                      <div className="metric-value">{server.data.config.cpu}</div>
                    </div>
                  </div>
                </div>
              </div>
              <Console id={id} nodeOnline={!!nodeOnline} compact />
              <Button variant="default" leftSection={<Icon icon={Wrench01Icon} size={16} />} onClick={() => setTab('advanced')}>{t('Advanced')}</Button>
            </Stack>
          </aside>
        </div>
      </Tabs.Panel>
      <Tabs.Panel value="advanced" pt="lg">{tab === 'advanced' && <Advanced id={id} nodeOnline={!!nodeOnline} installed={status.data?.state !== 'not-installed'} />}</Tabs.Panel>
      <Tabs.Panel value="activity" pt="lg">
        <QueryState query={events}>
          {!events.data?.filter(e => e.type !== 'assistant.delta').length
            ? <Empty title={t('No activity yet')}><Text>{t('Actions and their results will appear here.')}</Text></Empty>
            : <Stack>{events.data?.filter(e => e.type !== 'assistant.delta').slice().reverse().map(e => <details className="surface surface-pad" key={e.id}><summary style={{ cursor: 'pointer', minHeight: 32 }}>{e.type} · {new Date(e.created_at).toLocaleTimeString()}</summary><pre className="event-json">{JSON.stringify(e.data, null, 2)}</pre></details>)}</Stack>}
        </QueryState>
      </Tabs.Panel>
    </Tabs>
  </div>}</QueryState>;
}
function Console({ id, nodeOnline, compact = false }: { id: string; nodeOnline: boolean; compact?: boolean }) {
  const { t } = useLanguage(); const [command, setCommand] = useState('');
  const logs = useQuery({ queryKey: ['logs', id], queryFn: () => api(`/servers/${id}/operations`, { type: 'logs', tail: compact ? 40 : 150 }), enabled: nodeOnline, refetchInterval: nodeOnline ? 5000 : false });
  const send = useAction(() => api(`/servers/${id}/operations`, { type: 'console', command }), () => setCommand(''));
  return <Stack gap="sm">
    <Group justify="space-between">
      <Group gap="xs"><Icon icon={ComputerTerminal01Icon} size={18} /><Title order={2} size="h4">{t('Console')}</Title></Group>
      {!compact && <Button variant="subtle" leftSection={<Icon icon={RefreshIcon} size={16} />} disabled={!nodeOnline} onClick={() => logs.refetch()}>{t('Refresh')}</Button>}
    </Group>
    {!nodeOnline ? <Text size="sm">{t('Node offline')}</Text> : <QueryState query={logs}><pre className={`console ${compact ? '' : 'large'}`} tabIndex={0} aria-label={t('Console')}>{logs.data?.content || 'No console output yet.'}</pre></QueryState>}
    {!compact && <form onSubmit={e => { e.preventDefault(); send.mutate(); }}><Group align="end"><TextInput style={{ flex: 1 }} label={t('Console command')} required value={command} onChange={e => setCommand(e.target.value)} /><Button type="submit" leftSection={<Icon icon={SentIcon} size={16} />} disabled={!nodeOnline || !command.trim()} loading={send.isPending}>{t('Send command')}</Button></Group></form>}
  </Stack>;
}
function Advanced({ id, nodeOnline, installed }: { id: string; nodeOnline: boolean; installed: boolean }) {
  const { t } = useLanguage(); const [tab, setTab] = useState<string | null>('console'), [confirm, setConfirm] = useState(false), [shell, setShell] = useState(''), [result, setResult] = useState('');
  const operation = useAction((op: any) => api(`/servers/${id}/operations`, op));
  const install = useAction(() => api(`/servers/${id}/operations`, { type: 'install' }), () => setConfirm(false));
  const runShell = useAction(() => api(`/servers/${id}/operations`, { type: 'shell', command: shell }), output => setResult(JSON.stringify(output, null, 2)));
  return <Stack gap="lg">
    <Group>
      <Button variant="default" disabled={!nodeOnline} loading={install.isPending} onClick={() => installed ? setConfirm(true) : install.mutate()}>{t('Install')}</Button>
      {(['start', 'stop', 'restart', 'kill'] as const).map(action => <Button key={action} variant="default" color={action === 'kill' ? 'red' : undefined} disabled={!nodeOnline || operation.isPending} onClick={() => operation.mutate({ type: 'power', action })}>{t(action[0].toUpperCase() + action.slice(1))}</Button>)}
    </Group>
    <Tabs className="rex-tabs" value={tab} onChange={setTab}>
      <Tabs.List>
        <Tabs.Tab value="console" leftSection={<Icon icon={ComputerTerminal01Icon} size={16} />}>{t('Console')}</Tabs.Tab>
        <Tabs.Tab value="files" leftSection={<Icon icon={Folder01Icon} size={16} />}>{t('Files')}</Tabs.Tab>
        <Tabs.Tab value="backups" leftSection={<Icon icon={HardDriveIcon} size={16} />}>{t('Backups')}</Tabs.Tab>
        <Tabs.Tab value="shell" leftSection={<Icon icon={ComputerTerminal01Icon} size={16} />}>Shell</Tabs.Tab>
      </Tabs.List>
      <Tabs.Panel value="console" pt="lg"><Console id={id} nodeOnline={nodeOnline} /></Tabs.Panel>
      <Tabs.Panel value="files" pt="lg">{tab === 'files' && <Files id={id} nodeOnline={nodeOnline} />}</Tabs.Panel>
      <Tabs.Panel value="backups" pt="lg">{tab === 'backups' && <Backups id={id} nodeOnline={nodeOnline} />}</Tabs.Panel>
      <Tabs.Panel value="shell" pt="lg">
        <form onSubmit={e => { e.preventDefault(); runShell.mutate(); }}>
          <Stack>
            <Textarea label="Shell command (inside game container)" value={shell} onChange={e => setShell(e.target.value)} required minRows={3} />
            <Button type="submit" leftSection={<Icon icon={SentIcon} size={16} />} loading={runShell.isPending} disabled={!nodeOnline || !shell.trim()} style={{ alignSelf: 'flex-start' }}>{t('Send command')}</Button>
            {result && <pre className="console" tabIndex={0}>{result}</pre>}
          </Stack>
        </form>
      </Tabs.Panel>
    </Tabs>
    <Modal opened={confirm} onClose={() => setConfirm(false)} title={t('Reinstall the server? A backup will be created first.')} centered>
      <Group justify="flex-end"><Button variant="default" onClick={() => setConfirm(false)}>{t('Cancel')}</Button><Button loading={install.isPending} onClick={() => install.mutate()}>{t('Confirm')}</Button></Group>
    </Modal>
  </Stack>;
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
  return <Stack>
    <Group justify="space-between">
      <Text className="wrap">/{directory === '.' ? '' : directory}</Text>
      <Group>
        <Button variant="default" disabled={directory === '.'} onClick={() => setDirectory(directory.includes('/') ? directory.slice(0, directory.lastIndexOf('/')) : '.')}>{t('Parent directory')}</Button>
        <FileButton onChange={file => { if (file) upload.mutate(file); }}>{props => <Button {...props} variant="default" leftSection={<Icon icon={Upload01Icon} size={16} />} loading={upload.isPending}>{t('Upload')}</Button>}</FileButton>
        <Button variant="default" leftSection={<Icon icon={RefreshIcon} size={16} />} onClick={() => files.refetch()}>{t('Refresh')}</Button>
      </Group>
    </Group>
    <QueryState query={files}>
      <div className="file-list">
        {files.data?.length
          ? files.data.map(file => <div key={file.name} className="file-entry"><Button variant="subtle" color="gray" style={{ flex: 1, justifyContent: 'flex-start' }} onClick={() => { const target = child(file.name); if (file.directory) setDirectory(target); else { setPath(target); read.mutate(target); } }}>{file.directory ? `${file.name}/` : file.name}{file.symlink ? ' (link)' : ''}</Button>{!file.directory && <Button variant="subtle" component="a" href={`/api/v1/servers/${id}/files/download?path=${encodeURIComponent(child(file.name))}`}>{t('Download')}</Button>}</div>)
          : <Text>{t('No files in this directory')}</Text>}
      </div>
    </QueryState>
    <form onSubmit={e => { e.preventDefault(); read.mutate(path); }}>
      <Group align="end">
        <TextInput style={{ flex: 1 }} label={t('File path')} required value={path} onChange={e => { setPath(e.target.value); setContent(null); }} />
        <Button type="submit" variant="default" disabled={!path || read.isPending}>{t('Open')}</Button>
        <Button variant="default" disabled={!path} onClick={() => setContent('')}>New file</Button>
      </Group>
    </form>
    {content !== null && <Stack>
      <Textarea label={t('File content')} value={content} onChange={e => setContent(e.target.value)} minRows={12} autosize maxRows={30} styles={{ input: { fontFamily: 'ui-monospace, monospace' } }} />
      <Group>
        <Button disabled={!path} loading={write.isPending} onClick={() => write.mutate()}>{t('Save file')}</Button>
        <Button color="red" variant="subtle" onClick={() => setConfirm(true)}>{t('Delete file')}</Button>
      </Group>
    </Stack>}
    <Modal opened={confirm} onClose={() => setConfirm(false)} title={t('Delete this file?')} centered>
      <Text mb="md" className="wrap">{path}</Text>
      <Group justify="flex-end"><Button variant="default" onClick={() => setConfirm(false)}>{t('Cancel')}</Button><Button color="red" loading={remove.isPending} onClick={() => remove.mutate()}>{t('Delete')}</Button></Group>
    </Modal>
  </Stack>;
}
function Backups({ id, nodeOnline }: { id: string; nodeOnline: boolean }) {
  const { t } = useLanguage(); const [restoreId, setRestoreId] = useState('');
  const backups = useQuery<any[]>({ queryKey: ['backups', id], queryFn: () => api(`/servers/${id}/operations`, { type: 'backups' }), enabled: nodeOnline });
  const create = useAction(() => api(`/servers/${id}/operations`, { type: 'backup' }));
  const restore = useAction(() => api(`/servers/${id}/operations`, { type: 'restore', backupId: restoreId }), () => setRestoreId(''));
  if (!nodeOnline) return <Text>{t('Node offline')}</Text>;
  return <Stack>
    <Text size="sm">{t('Backups stop the server briefly for a consistent copy, then restart it if it was running.')}</Text>
    <Button onClick={() => create.mutate()} loading={create.isPending} style={{ alignSelf: 'flex-start' }}>{t('Create backup')}</Button>
    <QueryState query={backups}>
      {backups.data?.length
        ? backups.data.map(b => <Group key={b.id} justify="space-between" className="surface surface-pad"><div className="wrap"><Text size="sm">{new Date(b.createdAt).toLocaleString()}</Text><Text size="xs">{b.id} · {bytes(b.size)}</Text></div><Group><Button variant="default" component="a" href={`/api/v1/servers/${id}/backup/${b.id}`}>{t('Download')}</Button><Button variant="default" onClick={() => setRestoreId(b.id)}>{t('Restore')}</Button></Group></Group>)
        : <Text>{t('No backups yet')}</Text>}
    </QueryState>
    <Modal opened={!!restoreId} onClose={() => setRestoreId('')} title={t('Restore this backup? A recovery backup will be created first.')} centered>
      <Group justify="flex-end"><Button variant="default" onClick={() => setRestoreId('')}>{t('Cancel')}</Button><Button loading={restore.isPending} onClick={() => restore.mutate()}>{t('Restore')}</Button></Group>
    </Modal>
  </Stack>;
}
