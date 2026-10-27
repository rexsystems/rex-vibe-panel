import React from 'react';
import ReactDOM from 'react-dom/client';
import { MantineProvider, Modal, Notification, createTheme } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import '@mantine/core/styles.css';
import '@mantine/notifications/styles.css';
import './style.css';
import { LanguageProvider } from './i18n';
import { App } from './App';

const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 5000, refetchOnWindowFocus: true } } });
const theme = createTheme({ autoContrast: true, primaryColor: 'green', primaryShade: { light: 9, dark: 5 }, defaultRadius: 'sm', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', headings: { fontWeight: '650' }, focusRing: 'always', components: { Modal: Modal.extend({ defaultProps: { closeButtonProps: { 'aria-label': 'Close dialog' } } }), Notification: Notification.extend({ defaultProps: { closeButtonProps: { 'aria-label': 'Dismiss notification' } } }) }, colors: { green: ['#ebfbee', '#d3f9d8', '#b2f2bb', '#8ce99a', '#69db7c', '#51cf66', '#40c057', '#2f9e44', '#2b8a3e', '#237032'] } });
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><MantineProvider theme={theme} defaultColorScheme="auto"><Notifications position="top-right" /><QueryClientProvider client={client}><LanguageProvider><BrowserRouter><App /></BrowserRouter></LanguageProvider></QueryClientProvider></MantineProvider></React.StrictMode>);
