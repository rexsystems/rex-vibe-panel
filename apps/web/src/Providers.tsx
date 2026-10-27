import { useState } from 'react';
import { Alert, Button, Group, Modal, Select, Stack, Text, TextInput, Title } from '@mantine/core';
import { SecretInput as PasswordInput } from './fields';
import { notifications } from '@mantine/notifications';
import { useQuery } from '@tanstack/react-query';
import { api, useAction } from './api';
import { useLanguage } from './i18n';
import { Empty, QueryState } from './App';

type ProviderFields = { name: string; kind: string; baseUrl: string; model: string; region: string; apiKey: string; accessKeyId: string; secretAccessKey: string; sessionToken: string };

export function Providers() {
  const { t } = useLanguage(); const [opened, setOpened] = useState(false);
  const providers = useQuery<any[]>({ queryKey: ['providers'], queryFn: () => api('/providers') });
  return <Stack gap="xl"><Group justify="space-between"><div><Title order={1}>{t('Providers')}</Title><Text mt="xs">{t('Your keys stay on this installation. Free tiers and model access depend on the provider.')}</Text></div><Button onClick={() => setOpened(true)}>{t('Add provider')}</Button></Group><QueryState query={providers}>{providers.data?.length ? providers.data.map(p => <ProviderRow key={p.id} provider={p} />) : <Empty title={t('No providers configured')}><Text>{t('Connect a local model or bring your own cloud API key.')}</Text></Empty>}</QueryState><Modal opened={opened} onClose={() => setOpened(false)} title={t('Add provider')} centered>{opened && <ProviderForm close={() => setOpened(false)} />}</Modal></Stack>;
}
function ProviderRow({ provider: p }: { provider: any }) {
  const { t } = useLanguage(); const [confirm, setConfirm] = useState(false), [editing, setEditing] = useState(false), [models, setModels] = useState<string[]>([]), [model, setModel] = useState(p.model);
  const test = useAction(() => api(`/providers/${p.id}/test`, {}), result => notifications.show({ title: p.name, message: result.message, color: result.toolCapable ? 'green' : 'yellow' }));
  const list = useAction(() => api(`/providers/${p.id}/models`), result => { setModels(result); if (!result.length) notifications.show({ message: 'This provider does not list models. Enter a model ID manually.' }); });
  const update = useAction(() => api(`/providers/${p.id}/model`, { model }, 'PATCH'), () => notifications.show({ message: t('Saved') }));
  const makeDefault = useAction(() => api(`/providers/${p.id}/default`, {}, 'PUT'));
  const remove = useAction(() => api(`/providers/${p.id}`, undefined, 'DELETE'), () => setConfirm(false));
  return <article className="provider-row"><Stack gap="md"><Group justify="space-between" align="flex-start"><div className="wrap"><Title order={2} size="h3">{p.name}</Title><Text size="sm" mt={4}>{p.model}</Text><Text size="sm" className="wrap">{p.baseUrl}</Text></div><Text size="sm" fw={600}>{t(p.toolCapable ? 'Tools verified' : 'Chat only / untested')}</Text></Group><Group><Button variant="default" loading={test.isPending} onClick={() => test.mutate()}>{t('Test connection')}</Button><Button variant="default" loading={list.isPending} onClick={() => list.mutate()}>{t('List models')}</Button><Button variant="default" disabled={p.isDefault} loading={makeDefault.isPending} onClick={() => makeDefault.mutate()}>{t(p.isDefault ? 'Default provider' : 'Use by default')}</Button><Button variant="default" onClick={() => setEditing(true)}>{t('Edit provider')}</Button><Button color="red" variant="subtle" onClick={() => setConfirm(true)}>{t('Delete')}</Button></Group><Group align="end">{models.length ? <Select label={t('Model')} value={model} onChange={v => setModel(v || '')} data={models} searchable /> : <TextInput label={t('Model')} value={model} onChange={e => setModel(e.target.value)} />}<Button variant="default" disabled={!model || model === p.model} loading={update.isPending} onClick={() => update.mutate()}>{t('Update model')}</Button></Group></Stack><Modal opened={editing} onClose={() => setEditing(false)} title={t('Edit provider')} centered>{editing && <ProviderForm provider={p} close={() => { setEditing(false); setModel(p.model); }} />}</Modal><Modal opened={confirm} onClose={() => setConfirm(false)} title={t('Delete this provider?')} centered><Group justify="flex-end"><Button variant="default" onClick={() => setConfirm(false)}>{t('Cancel')}</Button><Button color="red" loading={remove.isPending} onClick={() => remove.mutate()}>{t('Delete')}</Button></Group></Modal></article>;
}
function ProviderForm({ close, provider }: { close: () => void; provider?: any }) {
  const { t } = useLanguage(); const presets = useQuery<any[]>({ queryKey: ['presets'], queryFn: () => api('/providers/presets') });
  const [preset, setPreset] = useState<string | null>(null);
  const [form, setForm] = useState<ProviderFields>({ name: '', kind: 'openai', baseUrl: '', model: '', region: 'us-east-1', ...provider, apiKey: '', accessKeyId: '', secretAccessKey: '', sessionToken: '' });
  const change = (key: keyof ProviderFields, value: string) => setForm(f => ({ ...f, [key]: value }));
  const save = useAction(() => api(provider ? `/providers/${provider.id}` : '/providers', form, provider ? 'PUT' : 'POST'), close);
  return <QueryState query={presets}><form onSubmit={e => { e.preventDefault(); save.mutate(); }}><Stack><Select label={t('Preset')} placeholder={t('Add provider')} data={(presets.data || []).map(p => p.name)} value={preset} onChange={value => { setPreset(value); const selected = presets.data?.find(p => p.name === value); if (selected) setForm((f: any) => ({ ...f, ...selected, apiKey: '', secretAccessKey: '', accessKeyId: '', sessionToken: '' })); }} required={!provider} />
    <TextInput label={t('Name')} required maxLength={80} value={form.name} onChange={e => change('name', e.target.value)} />
    <TextInput label={t('Endpoint URL')} type="url" required value={form.baseUrl} onChange={e => change('baseUrl', e.target.value)} />
    <TextInput label={t('Model')} required value={form.model} onChange={e => change('model', e.target.value)} />
    {form.kind.startsWith('bedrock') && <TextInput label={t('AWS region')} required value={form.region} onChange={e => change('region', e.target.value)} />}
    <PasswordInput label={t('API key')} description={provider ? t('Leave secrets blank to keep existing values.') : undefined} value={form.apiKey} onChange={e => change('apiKey', e.target.value)} autoComplete="off" />
    {form.kind === 'bedrock-runtime' && <><TextInput label={t('Access key ID')} value={form.accessKeyId} onChange={e => change('accessKeyId', e.target.value)} /><PasswordInput label={t('Secret access key')} value={form.secretAccessKey} onChange={e => change('secretAccessKey', e.target.value)} /><PasswordInput label={t('Session token')} value={form.sessionToken} onChange={e => change('sessionToken', e.target.value)} /></>}
    <Text size="sm">{t('Private endpoints such as Ollama must be approved by an administrator in Settings.')}</Text>
    {save.error && <Alert color="red">{save.error.message}</Alert>}<Button type="submit" loading={save.isPending}>{t('Save')}</Button>
  </Stack></form></QueryState>;
}
