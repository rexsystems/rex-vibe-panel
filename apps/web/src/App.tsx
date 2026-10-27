import { createContext, lazy, Suspense, useContext, useState, type ReactNode } from 'react';
import { Alert, Anchor, Button, Collapse, Group, Loader, SegmentedControl, Stack, Text, TextInput, Title, useMantineColorScheme } from '@mantine/core';
import {
  CloudIcon,
  Logout03Icon,
  Menu01Icon,
  ServerStack01Icon,
  Settings01Icon,
  UserIcon,
  Wifi01Icon,
  WifiOff01Icon,
  Wrench01Icon,
} from '@hugeicons/core-free-icons';
import { SecretInput as PasswordInput } from './fields';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { api, online, useAction } from './api';
import { Icon } from './Icon';
import { useLanguage } from './i18n';
const Providers = lazy(() => import('./Providers').then(m => ({ default: m.Providers })));
const Administration = lazy(() => import('./Administration').then(m => ({ default: m.Administration })));
const ServerPage = lazy(() => import('./ServerPage').then(m => ({ default: m.ServerPage })));
const NodeSetup = lazy(() => import('./NodeSetup').then(m => ({ default: m.NodeSetup })));

type User = { id: string; email: string; role: string };
const UserContext = createContext<User>(null!);
export const useUser = () => useContext(UserContext);
export function QueryState({ query, children }: { query: { isPending: boolean; isError: boolean; error: Error | null; refetch: () => unknown }; children: ReactNode }) {
  const { t } = useLanguage();
  if (query.isPending) return <Group role="status" py="lg"><Loader size="sm" /><Text>{t('Loading…')}</Text></Group>;
  if (query.isError) return <Alert color="red" role="alert"><Stack gap="sm"><Text>{query.error?.message}</Text><Button variant="default" onClick={() => query.refetch()}>{t('Retry')}</Button></Stack></Alert>;
  return children;
}
export function Empty({ title, children }: { title: string; children: ReactNode }) {
  return <div className="empty"><div className="chat-empty-icon"><Icon icon={ServerStack01Icon} size={24} /></div><Stack align="flex-start" gap="sm"><Title order={2} size="h3">{title}</Title>{children}</Stack></div>;
}
export function App() {
  const me = useQuery<User>({ queryKey: ['me'], queryFn: () => api('/me') });
  const source = useQuery({ queryKey: ['source'], queryFn: () => api('/source') });
  const { t } = useLanguage();
  if (me.isPending) return <main className="page"><Group role="status"><Loader /><Text>{t('Loading…')}</Text></Group></main>;
  if (me.isError && (me.error as any).status !== 401) return <main className="page"><QueryState query={me}>{null}</QueryState></main>;
  return <>
    {me.data ? <UserContext.Provider value={me.data}><Navigation /><Shell><Suspense fallback={<Text role="status">{t('Loading…')}</Text>}>{me.data.role === 'admin' && <NodeSetup />}<Routes>
      <Route path="/" element={<Servers />} /><Route path="/servers/:id" element={<ServerPage />} />
      <Route path="/providers" element={<Providers />} /><Route path="/settings" element={<Settings />} />
      <Route path="/admin" element={me.data.role === 'admin' ? <Administration /> : <Navigate to="/" />} />
      <Route path="*" element={<Navigate to="/" />} />
    </Routes></Suspense></Shell></UserContext.Provider> : <Auth />}
    <footer className="footer"><span>REX Vibe Panel · AGPL-3.0</span><Anchor href={source.data?.url || 'https://github.com/rexsystems/rex-vibe-panel'} target="_blank" rel="noreferrer">GitHub</Anchor></footer>
  </>;
}
function Shell({ children }: { children: ReactNode }) {
  const location = useLocation();
  const wide = location.pathname.startsWith('/servers/');
  return <main className={wide ? 'page page-wide' : 'page'}>{children}</main>;
}
function Navigation() {
  const user = useUser(), { t } = useLanguage(); const [opened, setOpened] = useState(false);
  const links = [
    ['/', 'Servers', ServerStack01Icon],
    ['/providers', 'Providers', CloudIcon],
    ['/settings', 'Settings', Settings01Icon],
    ...(user.role === 'admin' ? [['/admin', 'Administration', Wrench01Icon] as const] : []),
  ] as const;
  return <header className="topbar"><div className="topbar-inner"><Link to="/" className="brand">REX<span>Vibe Panel</span></Link><nav className="desktop-nav" aria-label="Main">{links.map(([path, label, icon]) => <NavLink end={path === '/'} key={path} to={path} className="nav-link"><Icon icon={icon} size={18} />{t(label)}</NavLink>)}</nav><Button className="mobile-nav" variant="default" aria-expanded={opened} aria-controls="mobile-navigation" leftSection={<Icon icon={Menu01Icon} size={18} />} onClick={() => setOpened(!opened)}>{t('Menu')}</Button></div><Collapse in={opened}><nav id="mobile-navigation" className="mobile-links" aria-label="Mobile">{links.map(([path, label, icon]) => <NavLink end={path === '/'} key={path} to={path} className="nav-link" onClick={() => setOpened(false)}><Icon icon={icon} size={18} />{t(label)}</NavLink>)}</nav></Collapse></header>;
}
function Auth() {
  const { t } = useLanguage(); const [register, setRegister] = useState(false);
  const [email, setEmail] = useState(''), [password, setPassword] = useState('');
  const status = useQuery({ queryKey: ['auth-status'], queryFn: () => api('/auth/status') });
  const client = useQueryClient(), navigate = useNavigate();
  const setup = status.data?.setupRequired; const mode = setup ? 'setup' : register ? 'register' : 'login';
  const submit = useAction(() => api(`/auth/${mode}`, { email, password }), user => { client.setQueryData(['me'], user); setPassword(''); navigate('/'); });
  return <main className="auth"><Stack gap="xl"><div><div className="auth-mark"><Icon icon={ServerStack01Icon} size={24} /></div><Title order={1}>REX Vibe Panel</Title><Text mt="xs">{t('Minecraft server administration.')}</Text></div><QueryState query={status}><div className="auth-card"><form onSubmit={e => { e.preventDefault(); submit.mutate(); }}><Stack>
    <Title order={2} size="h3">{t(setup ? 'Set up REX' : register ? 'Create account' : 'Sign in')}</Title>
    <TextInput label={t('Email')} type="email" required maxLength={254} value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" />
    <PasswordInput label={t('Password')} description={t('At least 8 characters')} required minLength={8} maxLength={128} value={password} onChange={e => setPassword(e.target.value)} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
    {submit.error && <Alert color="red" role="alert">{submit.error.message}</Alert>}
    <Button type="submit" loading={submit.isPending}>{t(setup ? 'Set up REX' : register ? 'Create account' : 'Sign in')}</Button>
    {!setup && (status.data?.registrationEnabled ? <Button variant="subtle" onClick={() => { setRegister(!register); submit.reset(); }}>{t(register ? 'Sign in' : 'Create account')}</Button> : <Text size="sm">{t('Registration is disabled. Contact the administrator.')}</Text>)}
  </Stack></form></div></QueryState></Stack></main>;
}
function Servers() {
  const user = useUser(), { t } = useLanguage();
  const servers = useQuery<any[]>({ queryKey: ['servers'], queryFn: () => api('/servers'), refetchInterval: 10000 });
  return <Stack gap="xl"><Group justify="space-between" align="flex-start"><div><Title order={1}>{t('Your Minecraft servers')}</Title><Text mt="xs">{t('Choose a server to work with REX.')}</Text></div>{user.role === 'admin' && <Button component={Link} to="/admin" leftSection={<Icon icon={Wrench01Icon} size={16} />}>{t('Allocate server')}</Button>}</Group>
    <QueryState query={servers}>{!servers.data?.length ? <Empty title={t('No servers assigned')}><Text>{t('Ask your administrator to allocate a Minecraft server to your account.')}</Text>{user.role === 'admin' && <Button variant="default" component={Link} to="/admin">{t('Manage nodes')}</Button>}</Empty> : <div className="server-list">{servers.data.map(s => {
      const isOnline = online(s);
      return <article className="server-row" key={s.id}><div className="server-row-head"><div className="server-icon"><Icon icon={ServerStack01Icon} size={22} /></div><Stack gap={8} className="wrap"><Title order={2} size="h3">{s.name}</Title><div className="server-meta"><span>{s.config.edition} {s.config.version}</span><span>{s.config.memoryMb} MiB RAM</span><span>{s.address}:{s.config.port}</span><span className={`status-chip ${isOnline ? 'online' : 'offline'}`}><Icon icon={isOnline ? Wifi01Icon : WifiOff01Icon} size={14} />{t(isOnline ? 'Node online' : 'Node offline')}</span></div></Stack></div><Button variant="default" component={Link} to={`/servers/${s.id}`} leftSection={<Icon icon={ServerStack01Icon} size={16} />}>{t('Open server')}</Button></article>;
    })}</div>}</QueryState>
  </Stack>;
}
function Settings() {
  const user = useUser(), { t, language, setLanguage } = useLanguage(), { colorScheme, setColorScheme } = useMantineColorScheme();
  const client = useQueryClient(); const logout = useAction(() => api('/auth/logout', {}), () => { client.clear(); window.location.assign('/'); });
  return <Stack gap="xl" maw={600}><Title order={1}>{t('Settings')}</Title><Stack><Title order={2} size="h3">{t('Appearance')}</Title><SegmentedControl aria-label={t('Appearance')} value={colorScheme} onChange={v => setColorScheme(v as 'light' | 'dark' | 'auto')} data={[{ value: 'light', label: t('Light') }, { value: 'dark', label: t('Dark') }, { value: 'auto', label: t('System') }]} /></Stack><Stack><Title order={2} size="h3">{t('Language')}</Title><SegmentedControl aria-label={t('Language')} value={language} onChange={setLanguage} data={[{ value: 'en', label: 'English' }, { value: 'ro', label: 'Română' }]} /></Stack><Stack align="flex-start"><Title order={2} size="h3">{t('Account')}</Title><Group gap="sm"><Icon icon={UserIcon} size={18} /><Text className="wrap">{user.email}</Text></Group><Button variant="default" leftSection={<Icon icon={Logout03Icon} size={16} />} loading={logout.isPending} onClick={() => logout.mutate()}>{t('Sign out')}</Button></Stack></Stack>;
}
