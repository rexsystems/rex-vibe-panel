import { useEffect, useState } from 'react';
import { Alert, Button, Group, Loader, Modal, Stack, Text, TextInput } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, useAction } from './api';
import { useLanguage } from './i18n';
import { QueryState } from './App';

export function NodeSetup({ opened, onClose }: { opened?: boolean; onClose?: () => void }) {
  const { t } = useLanguage(), client = useQueryClient();
  const [closed, setClosed] = useState(false), [observed, setObserved] = useState(false);
  const [name, setName] = useState<string>(), [address, setAddress] = useState<string>();
  const state = useQuery({ queryKey: ['node-onboarding'], queryFn: () => api('/admin/onboarding'), refetchInterval: query => {
    const job = query.state.data?.job;
    return job && !['complete', 'failed'].includes(job.status) ? 1000 : false;
  } });
  const job = state.data?.job;
  const busy = !!job && !['complete', 'failed'].includes(job.status);
  useEffect(() => { if (state.data?.needsChoice) setObserved(true); }, [state.data?.needsChoice]);
  useEffect(() => { if (job?.status === 'complete') void client.invalidateQueries({ queryKey: ['nodes'] }); }, [job?.status, client]);
  const dismiss = useAction(() => api('/admin/onboarding/skip', {}), () => { setClosed(true); onClose?.(); });
  const start = useAction(() => api('/admin/nodes/local', { name: name ?? state.data?.suggestedName ?? '', address: address ?? state.data?.suggestedAddress ?? '' }));
  const show = opened ?? (!closed && (observed || state.data?.needsChoice === true));
  return <Modal opened={show} onClose={() => dismiss.mutate()} title={t('Set up a node now?')} centered closeOnClickOutside={!busy}>
    <QueryState query={state}><Stack>
      <Text>{t('REX can configure a node on the same machine as this panel, enroll its agent and start it automatically.')}</Text>
      {job?.status === 'complete' ? <Alert color="green" role="status">{t(job.message)}</Alert> : <>
        {!state.data?.available && <Alert color="yellow" role="status"><Stack gap="xs"><Text size="sm">{t(state.data?.reason || 'Docker is not available.')}</Text><Button variant="default" onClick={() => state.refetch()}>{t('Check again')}</Button></Stack></Alert>}
        <form onSubmit={event => { event.preventDefault(); start.mutate(); }}><Stack>
          <TextInput label={t('Node name')} required maxLength={80} disabled={busy} value={name ?? state.data?.suggestedName ?? ''} onChange={event => setName(event.target.value)} />
          <TextInput label={t('Address players will use')} description={t('Use an IPv4 address for Bedrock.')} required maxLength={253} disabled={busy} value={address ?? state.data?.suggestedAddress ?? ''} onChange={event => setAddress(event.target.value)} />
          {busy && <Group role="status" wrap="nowrap"><Loader size="sm" /><Text size="sm">{t(job.message)}</Text></Group>}
          {job?.status === 'failed' && <Alert color="red" role="alert">{t(job.message)}</Alert>}
          {start.error && <Alert color="red" role="alert">{start.error.message}</Alert>}
          <Button type="submit" loading={start.isPending || busy} disabled={!state.data?.available}>{t(job?.status === 'failed' ? 'Retry node setup' : 'Set up local node')}</Button>
        </Stack></form>
      </>}
      <Button variant="default" loading={dismiss.isPending} onClick={() => dismiss.mutate()}>{t(job?.status === 'complete' ? 'Done' : busy ? 'Continue in background' : 'Later')}</Button>
    </Stack></QueryState>
  </Modal>;
}
